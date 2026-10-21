/**
 * Geomodel tab: species range maps, species richness and location species
 * lists with 48-week phenology from the BirdNET Geomodel.
 *
 * The basemap is a bundled Natural Earth outline, so the tab needs no tile
 * server. Cells are square in Web Mercator screen space (16 px) and aligned
 * to a global grid per zoom level; each cell's embedding and richness counts
 * are cached per week, so switching species, scrubbing weeks and panning
 * back reuse earlier work.
 */
import { CONFIG, csvField, downloadFile, esc, fmtNumber, fmtPct, monthNames, shared, t, toast, weekFromDate, weekLabel } from './core.js';
import { geo, RICHNESS_THRESHOLDS } from './geo-service.js';
import { INFERNO } from './spec-view.js';
import { catalog, CLASS_INFO, classLabel } from './species.js';
import { imageUrl } from './taxonomy.js';

const CELL = 16;
const BATCH = 384;
const MAX_LAT = 84;
const FEATURED = [
  'Hirundo rustica', 'Sterna paradisaea', 'Cuculus canorus', 'Archilochus colubris', 'Merops apiaster',
  'Ciconia ciconia', 'Setophaga striata', 'Parus major', 'Cardinalis cardinalis', 'Malurus cyaneus',
  'Fratercula arctica', 'Thalassarche melanophris', 'Strix aluco', 'Bubo virginianus', 'Caprimulgus europaeus',
  'Lithobates catesbeianus', 'Vulpes vulpes', 'Magicicada septendecim',
];

const $ = id => document.getElementById(id);

const lonOf = (x, world) => x / world * 360 - 180;
const latOf = (y, world) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - 2 * y / world)));

function colorAt(v) {
  const i = Math.max(0, Math.min(255, Math.round(v * 255))) * 3;
  return [INFERNO[i], INFERNO[i + 1], INFERNO[i + 2]];
}

class CellStore {
  constructor(D, countStride) {
    this.D = D;
    this.stride = countStride;
    this.slots = new Map();
    this.cap = 0;
    this.size = 0;
    this.feat = new Uint16Array(0);
    this.counts = new Uint16Array(0);
  }
  ensure(n) {
    if (this.size + n <= this.cap) return;
    const cap = Math.max(1024, (this.size + n) * 2);
    const f = new Uint16Array(cap * this.D); f.set(this.feat);
    const c = new Uint16Array(cap * this.stride); c.set(this.counts);
    this.feat = f; this.counts = c; this.cap = cap;
  }
  put(id, feat, counts, k) {
    if (this.slots.has(id)) return;
    this.ensure(1);
    const slot = this.size++;
    this.feat.set(feat.subarray(k * this.D, (k + 1) * this.D), slot * this.D);
    this.counts.set(counts.subarray(k * this.stride, (k + 1) * this.stride), slot * this.stride);
    this.slots.set(id, slot);
  }
}

export class GeoTab {
  constructor() {
    this.visible = false;
    this.mode = 'richness';
    this.species = null;
    this.week = weekFromDate(new Date());
    this.stores = new Map();     // `${zoom}:${week}` -> CellStore
    this.gen = 0;
    this.pickMode = null;
    this.richMax = 0;
    this.richKey = '';
  }

  init() {
    this.started = false;
  }

  async show() {
    this.visible = true;
    if (!this.started) {
      this.started = true;
      this._build();
      this._load();
    } else {
      this.map.invalidateSize();
      this._schedule();
    }
  }

  hide() {
    this.visible = false;
    this._stopPlay();
  }

  /** Called by the shell when the V3.0/BirdBox tab asks for a location. */
  startPick(returnTab) {
    this.pickMode = returnTab;
    $('geo-pick-banner').hidden = false;
  }

  _build() {
    const L = window.L;
    $('geo-week').value = this.week;
    this._renderWeek();
    this.map = L.map('geo-map', {
      center: [28, 8], zoom: 2, minZoom: 1, maxZoom: 7, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 120,
      zoomAnimation: false, markerZoomAnimation: false,
      worldCopyJump: false, maxBounds: [[-88, -230], [88, 230]], maxBoundsViscosity: 0.8, attributionControl: true,
      zoomControl: true, preferCanvas: true,
    });
    this.map.attributionControl.setPrefix(false);
    this.map.attributionControl.addAttribution(`<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>`);
    for (const [name, z] of [['land', 250], ['heat', 300], ['borders', 350]]) this.map.createPane(name).style.zIndex = z;
    this.map.getPane('heat').style.pointerEvents = 'none';
    this.map.getPane('borders').style.pointerEvents = 'none';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'geo-heat';
    this.map.getPane('heat').appendChild(this.canvas);
    this.offscreen = document.createElement('canvas');

    fetch(CONFIG.basemap).then(r => r.json()).then(world => {
      L.geoJSON(world, { pane: 'land', renderer: L.canvas({ pane: 'land', padding: 0.3 }), interactive: false, style: { stroke: false, fillColor: '#232b3a', fillOpacity: 1 } }).addTo(this.map);
      L.geoJSON(world, { pane: 'borders', renderer: L.canvas({ pane: 'borders', padding: 0.3 }), interactive: false, style: { color: '#5b6b85', weight: 0.6, opacity: 0.85, fill: false } }).addTo(this.map);
    }).catch(err => console.error(err));

    this._fitWorld(true);
    this.map.on('resize', () => this._fitWorld(false));
    this.map.on('moveend zoomend resize', () => { this._paint(); this._schedule(); });
    this.map.on('click', e => this._onClick(e.latlng));
    this._bind();
  }

  /** Smallest zoom at which the world fills the map width. */
  _fitWorld(initial) {
    const width = this.map.getSize().x;
    const fill = Math.ceil(Math.log2(Math.max(256, width) / 256) * 4) / 4;
    this.map.setMinZoom(fill);
    if (initial || this.map.getZoom() < fill) this.map.setView([30, 10], fill, { animate: false });
  }

  async _load() {
    const busy = $('geo-loading');
    busy.hidden = false;
    try {
      await geo.ensure(p => {
        $('geo-loading-text').textContent = p.cached
          ? t('demo.geo.cached', 'Loading geomodel from your browser cache…')
          : t('demo.geo.downloadingModel', 'Downloading geomodel: {pct}', { pct: fmtPct(p.loaded / p.total, 0) });
      });
      await catalog.load();
      this.stride = RICHNESS_THRESHOLDS.length * (catalog.classes.length + 1);
      this._initSpecies();
      busy.hidden = true;
      this._schedule();
    } catch (err) {
      console.error(err);
      $('geo-loading-text').textContent = t('demo.geo.loadError', 'The geomodel could not be loaded: {message}', { message: err.message });
    }
  }

  _bind() {
    document.querySelectorAll('#geo-mode [data-mode]').forEach(btn => btn.addEventListener('click', () => this._setMode(btn.dataset.mode)));
    const week = $('geo-week');
    week.addEventListener('input', () => { this._dismissHowto(); this.week = +week.value; this._renderWeek(); this._paint(); this._schedule(); this._refreshPanel(); });
    $('geo-play').addEventListener('click', () => { this._dismissHowto(); this.playing ? this._stopPlay() : this._startPlay(); });
    // Species group and minimum probability are one setting for the richness map and the species list
    for (const [a, b] of [['geo-rich-taxa', 'geo-panel-taxa'], ['geo-rich-thr', 'geo-panel-thr']]) {
      const sync = (from, to) => $(from).addEventListener('change', () => { $(to).value = $(from).value; this._paint(); this._refreshPanel(); });
      sync(a, b);
      sync(b, a);
    }
    $('geo-csv').addEventListener('click', () => this._exportMapCsv());
    $('geo-panel-csv').addEventListener('click', () => this._exportPanelCsv());
    $('geo-pick-cancel').addEventListener('click', () => this._endPick(false));
    $('geo-panel-close').addEventListener('click', () => this._closePanel());
    $('geo-use-location').addEventListener('click', () => {
      if (!this.point) return;
      shared.setLocation({ ...(shared.location || {}), from: null, enabled: true, lat: +this.point.lat.toFixed(4), lon: +this.point.lon.toFixed(4), date: (shared.location?.date) || new Date().toISOString().slice(0, 10) });
      toast(t('demo.geo.locationSet', 'Location set for the audio analysis filter.'), 'success');
    });
    $('geo-panel').addEventListener('click', e => {
      const row = e.target.closest('[data-species]');
      if (row) {
        this._selectSpecies(+row.dataset.species);
        this._setMode('range');
        document.querySelector('.geo-viewer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      const more = e.target.closest('[data-more]');
      if (more) { this.panelLimit += 60; this._renderPanel(); }
    });

    const search = $('geo-search'), results = $('geo-search-results');
    let active = -1;
    const showResults = () => {
      const q = search.value.trim();
      const ids = q ? catalog.search(q, 30) : FEATURED.map(s => catalog.bySci?.get(s)).filter(i => i != null);
      results.innerHTML = (q ? '' : `<div class="geo-sr-head">${esc(t('demo.geo.featured', 'Featured species'))}</div>`)
        + ids.map((i, k) => `<button type="button" class="geo-sr-item${k === active ? ' active' : ''}" data-i="${i}"><i class="fa-solid ${CLASS_INFO[catalog.className(i)]?.icon || 'fa-dove'} me-2 text-muted"></i>${esc(catalog.name(i))} <span class="geo-sr-sci">${esc(catalog.sci[i])}</span></button>`).join('')
        || `<div class="geo-sr-head">${esc(t('demo.geo.noMatch', 'No matching species'))}</div>`;
      results.hidden = false;
    };
    search.addEventListener('focus', () => { if (catalog.count) showResults(); });
    search.addEventListener('input', () => { active = -1; showResults(); });
    search.addEventListener('keydown', e => {
      const items = results.querySelectorAll('.geo-sr-item');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(0, Math.min(items.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
        items.forEach((el, k) => el.classList.toggle('active', k === active));
        items[active]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        (items[active] || items[0])?.click();
      } else if (e.key === 'Escape') results.hidden = true;
    });
    results.addEventListener('click', e => {
      const item = e.target.closest('[data-i]');
      if (!item) return;
      this._dismissHowto();
      this._selectSpecies(+item.dataset.i);
      if (this.mode !== 'range') this._setMode('range');
      search.value = '';
      search.blur();
      results.hidden = true;
    });
    document.addEventListener('click', e => { if (!e.target.closest('.geo-search')) results.hidden = true; });
    catalog.addEventListener('names', () => { this._renderSpeciesLabel(); this._renderPanel(); this._initTaxa(); });
  }

  _initSpecies() {
    this._initTaxa();
    const swallow = catalog.bySci.get('Hirundo rustica');
    this._selectSpecies(swallow ?? 0);
  }

  _initTaxa() {
    for (const sel of [$('geo-rich-taxa'), $('geo-panel-taxa')]) {
    const cur = sel.value || 'all';
    sel.innerHTML = `<option value="all">${esc(t('demo.geo.allTaxa', 'All species'))}</option>`
      + catalog.classes.map(c => `<option value="${c}">${esc(classLabel(c))}</option>`).join('');
    sel.value = cur;
    }
  }

  _selectSpecies(i) {
    this.species = i;
    this._renderSpeciesLabel();
    this._markCurrentRow();
    this._paint();
    this._schedule();
  }

  _renderSpeciesLabel() {
    if (this.species == null || !catalog.count) return;
    $('geo-species-name').textContent = catalog.name(this.species);
    $('geo-species-sci').textContent = catalog.sci[this.species];
    const img = $('geo-species-img');
    img.parentNode.classList.remove('no-img');
    img.src = imageUrl(catalog.sci[this.species]);
    img.onerror = () => img.parentNode.classList.add('no-img');
  }

  /** The 1-2-3 cards are only an introduction; they go once the map is in use. */
  _dismissHowto() {
    const howto = $('geo-howto');
    if (howto && !howto.hidden) howto.hidden = true;
  }

  _setMode(mode) {
    this._dismissHowto();
    this.mode = mode;
    document.querySelectorAll('#geo-mode [data-mode]').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });
    $('geo-species-ctrl').hidden = mode !== 'range';
    $('geo-rich-ctrl').hidden = mode !== 'richness';
    this.richKey = '';
    this._markCurrentRow();
    this._paint();
    this._schedule();
  }

  /** In the species list, mark the species whose range map is on screen. */
  _markCurrentRow() {
    document.querySelectorAll('#geo-panel-list .geo-row').forEach(row => {
      row.classList.toggle('is-current', this.mode === 'range' && +row.dataset.species === this.species);
    });
  }

  _renderWeek() {
    $('geo-week-label').textContent = weekLabel(this.week);
    const months = monthNames('short');
    const ticks = $('geo-week-ticks');
    if (!ticks.childElementCount) ticks.innerHTML = months.map(m => `<span>${esc(m)}</span>`).join('');
  }

  /* ---------------- grid ---------------- */

  _store(zoom, week, cell = CELL) {
    const key = `${zoom}:${cell}:${week}`;
    let s = this.stores.get(key);
    if (!s) {
      s = new CellStore(geo.D, this.stride);
      this.stores.set(key, s);
      if (this.stores.size > 160) this.stores.delete(this.stores.keys().next().value);
    }
    return s;
  }

  /**
   * Visible cells on the global grid of the integer zoom level below the
   * current (possibly fractional) zoom; cells are drawn scaled by `scale`.
   */
  _viewCells(cell = this.playing ? CELL * 2 : CELL) {
    const z = this.map.getZoom(), zoom = Math.floor(z + 1e-6), scale = Math.pow(2, z - zoom);
    const world = 256 * Math.pow(2, zoom), cols = Math.round(world / cell);
    const pb = this.map.getPixelBounds();
    const x0 = pb.min.x / scale, x1 = pb.max.x / scale, y0 = pb.min.y / scale, y1 = pb.max.y / scale;
    const i0 = Math.max(0, Math.floor(x0 / cell) - 1), i1 = Math.min(cols - 1, Math.floor(x1 / cell) + 1);
    const yMin = (1 - Math.log(Math.tan(Math.PI / 4 + MAX_LAT * Math.PI / 360)) / Math.PI) / 2 * world;
    const yMax = world - yMin;
    const j0 = Math.max(Math.floor(yMin / cell), Math.floor(y0 / cell) - 1), j1 = Math.min(Math.ceil(yMax / cell) - 1, Math.floor(y1 / cell) + 1);
    return { zoom, scale, cell, world, cols, i0, i1, j0, j1, pb };
  }

  _missing(view, week) {
    const store = this._store(view.zoom, week, view.cell), out = [];
    const ci = (view.i0 + view.i1) / 2, cj = (view.j0 + view.j1) / 2;
    for (let j = view.j0; j <= view.j1; j++) for (let i = view.i0; i <= view.i1; i++) {
      const id = j * view.cols + i;
      if (!store.slots.has(id)) out.push([id, i, j, (i - ci) ** 2 + (j - cj) ** 2]);
    }
    return out.sort((a, b) => a[3] - b[3]);
  }

  /** Compute missing cells for the view; resolves when the given week is complete. */
  async _compute(week, gen, priority = 0) {
    const tag = `map-${gen}`;
    const view = this._viewCells(), missing = this._missing(view, week);
    if (!missing.length) return true;
    const store = this._store(view.zoom, week, view.cell);
    const jobs = [];
    for (let k = 0; k < missing.length; k += BATCH) {
      const part = missing.slice(k, k + BATCH), inputs = new Float32Array(part.length * 3);
      part.forEach(([, i, j], r) => inputs.set([latOf((j + 0.5) * view.cell, view.world), lonOf((i + 0.5) * view.cell, view.world), week], r * 3));
      jobs.push(geo.grid(inputs, { gen: tag, priority }).then(res => {
        part.forEach(([id], r) => store.put(id, res.features, res.counts, r));
        if (week === this.week && gen === this.gen) this._paintSoon();
      }));
    }
    this._busy(true);
    try {
      await Promise.all(jobs);
      return true;
    } catch (err) {
      if (!err.cancelled) console.error(err);
      return false;
    } finally {
      if (gen === this.gen) this._busy(false);
    }
  }

  _schedule() {
    if (!this.visible || !geo.pool?.readyCount || !this.stride) return;
    geo.pool.cancel(`map-${this.gen}`);
    const gen = ++this.gen;
    this._compute(this.week, gen, 1).then(done => {
      if (done && this.playing) this._prefetch();
    });
  }

  _prefetch() {
    const gen = this.gen;
    for (let k = 1; k <= 3; k++) this._compute(((this.week - 1 + k) % 48) + 1, gen, 0);
  }

  _busy(on) {
    $('geo-busy').hidden = !on;
  }

  _paintSoon() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._paint(); });
  }

  /* ---------------- painting ---------------- */

  _cellValues(view, store) {
    const nI = view.i1 - view.i0 + 1, nJ = view.j1 - view.j0 + 1;
    const values = new Float32Array(nI * nJ).fill(NaN);
    const ids = [], pos = [];
    for (let j = view.j0; j <= view.j1; j++) for (let i = view.i0; i <= view.i1; i++) {
      const slot = store.slots.get(j * view.cols + i);
      if (slot != null) { ids.push(slot); pos.push((j - view.j0) * nI + (i - view.i0)); }
    }
    if (this.mode === 'range') {
      if (this.species == null) return { values, nI, nJ };
      const feats = new Uint16Array(ids.length * geo.D);
      ids.forEach((slot, k) => feats.set(store.feat.subarray(slot * geo.D, (slot + 1) * geo.D), k * geo.D));
      const scores = geo.scoreCells(feats, ids.length, this.species);
      pos.forEach((p, k) => { values[p] = scores[k]; });
    } else {
      const thr = +$('geo-rich-thr').value, taxa = $('geo-rich-taxa').value;
      const col = thr * (catalog.classes.length + 1) + (taxa === 'all' ? 0 : catalog.classes.indexOf(taxa) + 1);
      ids.forEach((slot, k) => { values[pos[k]] = store.counts[slot * this.stride + col]; });
    }
    return { values, nI, nJ };
  }

  _paint() {
    if (!this.map || !this.stride) return;
    const size = this.map.getSize(), dpr = window.devicePixelRatio || 1;
    let view = this._viewCells(), store = this._store(view.zoom, this.week, view.cell);
    // While one grid is still computing, show the other one if it is complete
    if (this._missing(view, this.week).length) {
      const other = this._viewCells(view.cell === CELL ? CELL * 2 : CELL);
      if (!this._missing(other, this.week).length) { view = other; store = this._store(other.zoom, this.week, other.cell); }
    }
    const { values, nI, nJ } = this._cellValues(view, store);
    const off = this.offscreen;
    off.width = nI; off.height = nJ;
    const octx = off.getContext('2d'), img = octx.createImageData(nI, nJ), px = img.data;
    let scale = 1;
    if (this.mode === 'richness') {
      const key = `${view.zoom}:${$('geo-rich-thr').value}:${$('geo-rich-taxa').value}`;
      if (key !== this.richKey) { this.richKey = key; this.richMax = 0; }
      for (const v of values) if (v > this.richMax) this.richMax = v;
      scale = Math.max(1, this.richMax);
    }
    for (let k = 0; k < values.length; k++) {
      const raw = values[k];
      if (!(raw > 0)) continue;
      const v = this.mode === 'range' ? raw : raw / scale;
      if (this.mode === 'range' && v < 0.005) continue;
      const g = Math.pow(Math.min(1, v), 0.6);
      const [r, gg, b] = colorAt(0.12 + 0.88 * g);
      const o = k * 4;
      px[o] = r; px[o + 1] = gg; px[o + 2] = b;
      px[o + 3] = Math.round(255 * Math.min(0.92, this.mode === 'range' ? 0.15 + 2.2 * Math.sqrt(v) : 1.5 * g));
    }
    octx.putImageData(img, 0, 0);
    const canvas = this.canvas;
    canvas.width = Math.round(size.x * dpr);
    canvas.height = Math.round(size.y * dpr);
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    window.L.DomUtil.setPosition(canvas, this.map.containerPointToLayerPoint([0, 0]));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const cellPx = view.cell * view.scale;
    ctx.drawImage(off, view.i0 * cellPx - view.pb.min.x, view.j0 * cellPx - view.pb.min.y, nI * cellPx, nJ * cellPx);
    this._renderLegend(scale);
    this.lastPaint = { view, values, nI, nJ };
  }

  _renderLegend(scale) {
    const stops = [];
    for (let k = 0; k <= 10; k++) { const [r, g, b] = colorAt(0.12 + 0.88 * Math.pow(k / 10, 0.6)); stops.push(`rgb(${r},${g},${b}) ${k * 10}%`); }
    const ticks = this.mode === 'range'
      ? [0, 0.25, 0.5, 1].map(v => `<span style="left:${v * 100}%">${fmtPct(v, 0)}</span>`)
      : [0, 0.5, 1].map(v => `<span style="left:${v * 100}%">${fmtNumber(Math.round(v * scale))}</span>`);
    const title = this.mode === 'range'
      ? t('demo.geo.legendRange', 'Occurrence probability')
      : t('demo.geo.legendRichness', 'Species above {thr}', { thr: fmtPct(RICHNESS_THRESHOLDS[+$('geo-rich-thr').value], 0) });
    $('geo-legend').innerHTML = `<div class="geo-legend-title">${esc(title)}</div><div class="geo-legend-bar" style="background:linear-gradient(90deg,${stops.join(',')})"></div><div class="geo-legend-ticks">${ticks.join('')}</div>`;
  }

  /* ---------------- animation ---------------- */

  _startPlay() {
    this.playing = true;
    $('geo-play').innerHTML = '<i class="bi bi-pause-fill"></i>';
    $('geo-play').setAttribute('aria-label', t('demo.player.pause', 'Pause'));
    const step = async () => {
      if (!this.playing) return;
      const next = (this.week % 48) + 1;
      const t0 = performance.now();
      await this._compute(next, this.gen, 1);
      if (!this.playing) return;
      this.week = next;
      $('geo-week').value = next;
      this._renderWeek();
      this._paint();
      this._refreshPanel();
      this._prefetch();
      this.playTimer = setTimeout(step, Math.max(0, 260 - (performance.now() - t0)));
    };
    step();
  }

  _stopPlay() {
    const was = this.playing;
    this.playing = false;
    clearTimeout(this.playTimer);
    if (was) { this._paint(); this._schedule(); }
    const btn = $('geo-play');
    if (btn) { btn.innerHTML = '<i class="bi bi-play-fill"></i>'; btn.setAttribute('aria-label', t('demo.geo.playYear', 'Play through the year')); }
  }

  /* ---------------- location panel ---------------- */

  async _onClick(latlng) {
    const lat = Math.max(-90, Math.min(90, latlng.lat)), lon = ((latlng.lng + 540) % 360) - 180;
    if (this.pickMode) {
      shared.setLocation({ ...(shared.location || {}), from: null, enabled: true, lat: +lat.toFixed(4), lon: +lon.toFixed(4), date: shared.location?.date || new Date().toISOString().slice(0, 10) });
      this._endPick(true);
      return;
    }
    if (!geo.pool?.readyCount) return;
    this._dismissHowto();
    this.point = { lat, lon };
    if (!this.marker) this.marker = window.L.circleMarker(latlng, { radius: 7, color: '#fff', weight: 2, fillColor: '#3584e4', fillOpacity: 1 }).addTo(this.map);
    else this.marker.setLatLng(latlng);
    $('geo-panel').hidden = false;
    $('geo-panel-coords').textContent = `${fmtNumber(lat, 3)}°, ${fmtNumber(lon, 3)}°`;
    $('geo-panel-list').innerHTML = `<div class="text-muted small py-3"><span class="spinner-border spinner-border-sm me-2"></span>${esc(t('demo.geo.predicting', 'Predicting species for 48 weeks…'))}</div>`;
    this.panelLimit = 60;
    const token = (this.panelToken = (this.panelToken || 0) + 1);
    try {
      const year = await geo.predictYear(lat, lon);
      if (token !== this.panelToken) return;
      this.year = year;
      this._renderPanel();
      $('geo-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      console.error(err);
    }
  }

  _endPick(done) {
    const back = this.pickMode;
    this.pickMode = null;
    $('geo-pick-banner').hidden = true;
    if (done) toast(t('demo.geo.locationSet', 'Location set for the audio analysis filter.'), 'success');
    if (back) window.dispatchEvent(new CustomEvent('demo:show-tab', { detail: back }));
  }

  _closePanel() {
    $('geo-panel').hidden = true;
    this.point = null;
    this.year = null;
    if (this.marker) { this.marker.remove(); this.marker = null; }
  }

  _refreshPanel() { if (this.year) this._renderPanel(); }

  _panelThreshold() { return RICHNESS_THRESHOLDS[+$('geo-panel-thr').value]; }

  _renderPanel() {
    if (!this.year || !catalog.count) return;
    const S = geo.S, w = this.week - 1, thr = this._panelThreshold(), taxa = $('geo-panel-taxa').value;
    const rows = [];
    for (let g = 0; g < S; g++) {
      const p = this.year[w * S + g], v = geo.v3Index[g];
      if (p < thr || v < 0) continue;
      if (taxa !== 'all' && catalog.className(v) !== taxa) continue;
      rows.push([g, v, p]);
    }
    rows.sort((a, b) => b[2] - a[2]);
    $('geo-panel-summary').textContent = t('demo.geo.panelSummary', '{n} species above {thr} · {week}', { n: fmtNumber(rows.length), thr: fmtPct(thr, 0), week: weekLabel(this.week) });
    const html = rows.slice(0, this.panelLimit).map(([g, v, p]) => {
      let bars = '';
      for (let k = 0; k < 48; k++) {
        const q = this.year[k * S + g];
        bars += `<i style="height:${Math.max(4, Math.round(q * 100))}%"${k === w ? ' class="now"' : ''}></i>`;
      }
      return `<button type="button" class="geo-row${this.mode === 'range' && v === this.species ? ' is-current' : ''}" data-species="${v}" title="${esc(t('demo.geo.showRange', 'Show range map'))}">
        <span class="geo-row-img"><img loading="lazy" alt="" src="${imageUrl(catalog.sci[v])}" onerror="this.parentNode.classList.add('no-img');this.remove()"><i class="fa-solid ${CLASS_INFO[catalog.className(v)]?.icon || 'fa-dove'}"></i></span>
        <span class="geo-row-name"><span class="text-truncate d-block">${esc(catalog.name(v))}</span><i class="text-truncate d-block">${esc(catalog.sci[v])}</i></span>
        <span class="geo-row-pheno" aria-hidden="true">${bars}</span>
        <span class="geo-row-p">${fmtPct(p, 0)}</span>
        <i class="bi bi-map geo-row-go" aria-hidden="true"></i>
      </button>`;
    }).join('');
    const more = rows.length > this.panelLimit ? `<button type="button" class="btn btn-sm btn-light w-100 mt-2" data-more>${esc(t('demo.v3.more', 'Show {n} more species', { n: rows.length - this.panelLimit }))}</button>` : '';
    $('geo-panel-list').innerHTML = html ? `${html}${more}` : `<div class="text-muted small py-3">${esc(t('demo.geo.panelNone', 'No species expected above this threshold in this week.'))}</div>`;
  }

  /* ---------------- export ---------------- */

  /** Species list at the clicked location: probabilities for all 48 weeks. */
  _exportPanelCsv() {
    if (!this.year) return;
    const S = geo.S, w = this.week - 1, thr = this._panelThreshold(), taxa = $('geo-panel-taxa').value;
    const lines = [['rank', 'scientific_name', 'common_name', 'class', ...Array.from({ length: 48 }, (_, k) => `week_${k + 1}`)].join(',')];
    const rows = [];
    for (let g = 0; g < S; g++) {
      const v = geo.v3Index[g];
      if (this.year[w * S + g] >= thr && v >= 0 && (taxa === 'all' || catalog.className(v) === taxa)) rows.push(g);
    }
    rows.sort((a, b) => this.year[w * S + b] - this.year[w * S + a]);
    rows.forEach((g, k) => {
      const v = geo.v3Index[g];
      lines.push([k + 1, csvField(catalog.sci[v]), csvField(catalog.name(v)), catalog.className(v), ...Array.from({ length: 48 }, (_, q) => this.year[q * S + g].toFixed(6))].join(','));
    });
    downloadFile(`BirdNET_Geomodel_${this.point.lat.toFixed(3)}_${this.point.lon.toFixed(3)}_week${this.week}.csv`, `${lines.join('\n')}\n`, 'text/csv;charset=utf-8');
  }

  /** Visible map cells of the current product. */
  _exportMapCsv() {
    const p = this.lastPaint;
    if (!p) return;
    const lines = [this.mode === 'range' ? 'latitude,longitude,probability' : 'latitude,longitude,species_count'];
    for (let j = 0; j < p.nJ; j++) for (let i = 0; i < p.nI; i++) {
      const v = p.values[j * p.nI + i];
      if (!(v >= 0) || (this.mode === 'range' && v < 0.001)) continue;
      const lat = latOf((p.view.j0 + j + 0.5) * p.view.cell, p.view.world), lon = lonOf((p.view.i0 + i + 0.5) * p.view.cell, p.view.world);
      lines.push(`${lat.toFixed(4)},${lon.toFixed(4)},${this.mode === 'range' ? v.toFixed(6) : v}`);
    }
    const name = this.mode === 'range' ? `range_${catalog.sci[this.species].replace(/\s+/g, '_')}` : 'richness';
    downloadFile(`BirdNET_Geomodel_${name}_week${this.week}.csv`, `${lines.join('\n')}\n`, 'text/csv;charset=utf-8');
  }
}
