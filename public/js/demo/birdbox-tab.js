/**
 * BirdBox tab: bird vocalization bounding boxes with the BirdBox Just-Bird
 * ONNX graph (PCEN, YOLO and NMS run inside the model).
 *
 * The graph runs once per recording at the lowest confidence and returns its
 * per-window boxes. birdbox-fusion.js merges them exactly like the graph's
 * window fusion for any (confidence, phrase gap) setting, so both sliders
 * update instantly. BirdNET V3.0 suggests a species for every box; the
 * boxes export as Xeno-canto Annota-JSON.
 *
 * On the spectrogram, the selected box can be moved and resized and new
 * boxes can be drawn; changed and new boxes get fresh species suggestions.
 */
import { AudioSource, parseXcNumber } from './audio-source.js';
import { fuseBoxes } from './birdbox-fusion.js';
import { csvField, debounce, downloadFile, esc, fmtBytes, fmtNumber, fmtPct, fmtTime, shared, statLine, t, toast } from './core.js';
import { activeMask, LocationFilter } from './location-filter.js';
import { fetchAsset, getManifest, isCached } from './model-store.js';
import { OrtPool } from './ort-pool.js';
import { player } from './player.js';
import { SpecView } from './spec-view.js';
import { pickSpecies } from './picker.js';
import { catalog } from './species.js';
import { SR, v3 } from './v3-service.js';
import { streamSpectrogram, thumb } from './v3-tab.js';

const RAW_CONF = 0.05;        // lowest slider value
const SOUND_TYPES = ['song', 'call', 'alarm call', 'flight call', 'begging call', 'dawn song', 'subsong', 'drumming', 'duet'];
const MS_PER_CLIP_KEY = 'birdnet-demo-birdbox-ms';
const HELP_KEY = 'birdnet-demo-birdbox-help-seen';
const ANNOTATOR_KEY = 'birdnet-demo-annotator';   // the person's details, for the next export
const ANNOTATOR_FIELDS = { name: 'bb-annotator', xcId: 'bb-xcid', license: 'bb-license' };
const AVES = -1;
const SPECIES_MIN = 0.35;     // weaker suggestions leave a box unidentified; they stay in its species list
const FREQ_MAX = 15000;       // top of the spectrogram and of any box
const MIN_DUR = 0.05;         // smallest box: seconds
const MIN_BAND = 100;         // smallest box: Hz

const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 3 s V3.0 windows covering a box (centered for short boxes). */
function suggestionWindows(t0, t1, duration) {
  const W = 3, maxStart = Math.max(0, duration - W);
  if (t1 - t0 <= W) {
    const s = Math.min(maxStart, Math.max(0, (t0 + t1) / 2 - W / 2));
    return [[s, s + W]];
  }
  const out = [];
  for (let s = t0; ; s += 1.5) {
    const start = Math.min(maxStart, s);
    out.push([start, start + W]);
    if (start + W >= t1 || start >= maxStart) break;
  }
  return out;
}

/** Xeno-canto contributor ID from the ID itself or a xeno-canto.org/contributor/… link. */
const xcContributor = v => v.trim().replace(/^.*\/contributor\//i, '').replace(/[/?#].*$/, '');

/** Detector boxes keep their identity through slider changes by their geometry. */
const boxKey = b => `${b.t0.toFixed(4)}|${b.t1.toFixed(4)}|${b.flo}|${b.fhi}`;
/** Species suggestions depend only on the time span (the windows cover all frequencies). */
const timeKey = g => `${g.t0.toFixed(3)}|${g.t1.toFixed(3)}`;
const geomOf = g => ({ t0: g.t0, t1: g.t1, flo: g.flo, fhi: g.fhi });

class BirdBoxService {
  constructor() { this.ready = null; this.pool = null; this.busy = null; }
  ensure(onProgress) {
    if (!this.ready) {
      this.ready = (async () => {
        const m = (await getManifest()).birdbox;
        this.manifest = m;
        const model = await fetchAsset(m.model, onProgress);
        this.pool = new OrtPool({ name: 'birdbox', size: 1 });
        await this.pool.start(model, { output: m.output });
        return this;
      })();
      this.ready.catch(() => { this.ready = null; });
    }
    return this.ready;
  }

  /** One graph run over the whole recording; the graph walks it in 60 s segments. */
  async detect(audio) {
    const pool = this.busy = this.pool;
    try {
      // song_gap only feeds the graph's fusion step, which this run skips
      return await pool.run('birdbox', { audio, conf: RAW_CONF, songGap: 0 }, [audio.buffer]);
    } finally {
      if (this.busy === pool) this.busy = null;
    }
  }

  /** Stop a run in progress (it cannot be interrupted); the next run starts a fresh worker. */
  abort() {
    if (!this.busy) return;
    this.busy.terminate();
    this.busy = this.pool = this.ready = null;
  }
}
const birdbox = new BirdBoxService();

export class BirdBoxTab {
  constructor() {
    this.visible = false;
    this.pendingRun = false;
    this.raw = null;
    this.songs = [];               // detector boxes at the current sliders
    this.userBoxes = [];           // boxes drawn by the user
    this.boxes = [];               // both, ordered by start time
    this.suggestions = new Map();  // timeKey -> [{ s, p }]
    this.edits = new Map();        // box id -> { species?, soundType?, include?, geom? }
    this.selectedId = null;
    this.hoverId = null;
    this.drawMode = false;
    this.gesture = null;           // move, resize or draw in progress
    this.live = null;              // { id, g }: geometry while dragging
    this.draft = null;             // box being drawn
    this.userSeq = 0;
    this.runToken = 0;
    this.suggestToken = 0;        // invalidates suggestion results after audio or filter changes
    this.inflight = new Set();
    this.suggestSoon = debounce(() => this._suggest(), 250);
  }

  init() {
    this.source = new AudioSource($('bb-source'));
    this.location = new LocationFilter($('bb-location'));
    this.spec = new SpecView($('bb-spec'), {
      height: 300, kind: 'stft', axis: { type: 'linear', fMin: 0, fMax: FREQ_MAX },
      toolbar: document.querySelector('#pane-birdbox .spec-tools-host'),
    });
    this.spec.overlay = (ctx, h) => this._drawBoxes(ctx, h);
    this.spec.minimapOverlay = (ctx, h) => {
      ctx.fillStyle = '#22d3ee';
      for (const b of this.boxes) {
        const g = this._geom(b);
        ctx.fillRect(h.timeToX(g.t0), h.height - 4, Math.max(1, h.timeToX(g.t1) - h.timeToX(g.t0)), 4);
      }
    };
    this.spec.editor = {
      cursor: p => this._editCursor(p),
      down: p => this._editDown(p),
      move: p => this._editMove(p),
      up: (p, commit) => this._editUp(commit),
    };
    const drawLabel = esc(t('demo.bb.draw', 'Draw a box (B)')), helpLabel = esc(t('demo.bb.help.title', 'How to edit boxes'));
    this.spec.tools?.insertAdjacentHTML('afterbegin', `<button type="button" class="btn spec-tool" data-role="help" aria-expanded="false" aria-controls="bb-help" title="${helpLabel}" aria-label="${helpLabel}"><i class="bi bi-question-circle"></i></button><button type="button" class="btn spec-tool" data-role="draw" aria-pressed="false" title="${drawLabel}" aria-label="${drawLabel}"><i class="bi bi-bounding-box"></i></button>`);
    this.drawBtn = this.spec.tools?.querySelector('[data-role="draw"]');
    this.drawBtn?.addEventListener('click', e => { e.stopPropagation(); this._setDrawMode(!this.drawMode); });
    this.helpBtn = this.spec.tools?.querySelector('[data-role="help"]');
    this.helpBtn?.addEventListener('click', e => { e.stopPropagation(); this._showHelp($('bb-help').hidden); });
    $('bb-help').querySelector('[data-role="close"]').addEventListener('click', () => this._showHelp(false));
    let helpSeen = false;
    try { helpSeen = !!localStorage.getItem(HELP_KEY); } catch { /* storage blocked */ }
    this._showHelp(!helpSeen, false);
    $('bb-sound-default').innerHTML = `<option value="">${esc(t('demo.bb.choose', 'Choose…'))}</option>${SOUND_TYPES.map(s => `<option value="${s}">${esc(this._soundLabel(s))}</option>`).join('')}`;
    this._restoreAnnotator();
    this._bind();
    getManifest().then(m => { this.manifest = m; return isCached(m.birdbox.model); }).then(c => { this.modelCached = c; this._renderChip(); }).catch(() => {});
    this._renderChip();
    if (shared.audio) this._onAudio();
  }

  _startSpec() {
    this.specPending = false;
    streamSpectrogram(this.spec, this.pcm, 'stft', this.duration);
  }

  show() {
    this.visible = true;
    this.spec._resize();
    if (this.specPending) this._startSpec();
    if (this.pendingRun) this.run();
  }

  hide() { this.visible = false; }

  _soundLabel(s) { return t(`demo.bb.sound.${s.replace(/ /g, '_')}`, s); }

  _bind() {
    shared.addEventListener('audio', () => this._onAudio());
    const conf = $('bb-conf'), gap = $('bb-gap');
    const sync = () => {
      $('bb-conf-val').textContent = fmtNumber(+conf.value, 2);
      $('bb-gap-val').textContent = +gap.value > 0 ? `${fmtNumber(+gap.value, 2)} s` : t('demo.bb.gapOff', 'off');
    };
    sync();
    conf.addEventListener('input', () => { sync(); this._update(); });
    gap.addEventListener('input', () => { sync(); this._update(); });
    $('bb-suggest').addEventListener('change', () => this._update());
    this.location.addEventListener('change', () => { this._resetSuggestions(); this._update(); });
    const form = $('bb-xc');
    form.addEventListener('submit', e => { e.preventDefault(); this._exportXc(); });
    // A pasted profile link becomes the ID it ends in
    $('bb-xcid').addEventListener('change', e => { e.target.value = xcContributor(e.target.value); this._saveAnnotator(); });
    form.addEventListener('input', e => {
      e.target.classList.remove('is-invalid');
      if (Object.values(ANNOTATOR_FIELDS).includes(e.target.id)) this._saveAnnotator();
      if (!$('bb-xc-check').hidden) this._checkXc();
    });
    $('bb-export-csv').addEventListener('click', () => this._exportCsv());
    $('bb-export-raven').addEventListener('click', () => this._exportRaven());
    catalog.addEventListener('names', () => this._renderTable());

    player.addEventListener('time', e => {
      if (!this.visible) return;
      this.spec.setCursor(e.detail);
      if (player.playing) this.spec.follow(e.detail);
    });
    this.spec.addEventListener('toggleplay', () => player.toggle());
    this.spec.addEventListener('pick', e => {
      const { time, freq } = e.detail;
      const hit = freq != null ? this._boxAt(time, freq) : null;
      if (hit) { this._select(hit.id, { play: true }); return; }
      if (this.selectedId != null) this._select(null);
      player.play(time);
    });
    this.spec.addEventListener('hover', e => {
      const d = e.detail;
      const b = d && d.freq != null && !this.gesture && !this.drawMode ? this._boxAt(d.time, d.freq) : null;
      if ((b?.id ?? null) !== this.hoverId) { this.hoverId = b?.id ?? null; this.spec.render(); }
      if (!b) { this.spec.showTooltip(null); return; }
      const g = this._geom(b), sp = this._species(b), n = this.boxes.indexOf(b) + 1;
      const origin = b.manual
        ? `<div>${esc(t('demo.bb.drawn', 'Drawn by you'))}</div>`
        : `<div>${esc(t('demo.bb.boxConf', 'Box confidence'))} <b>${fmtNumber(b.avg, 2)}</b>${this._edit(b).verified ? ` · ${esc(t('demo.bb.verified', 'Verified by you'))}` : ''}</div>`;
      this.spec.showTooltip(`<div class="tt-time">#${n} · ${fmtTime(g.t0, 2)} – ${fmtTime(g.t1, 2)}</div><div>${fmtNumber(g.flo)}–${fmtNumber(g.fhi)} Hz</div>${origin}${sp.s !== AVES ? `<div class="tt-species mt-1">${thumb(sp.s, 'tt-img')}<span>${esc(catalog.name(sp.s))}${sp.p != null ? ` <b>${fmtPct(sp.p, 0)}</b>` : ''}</span></div>` : ''}`, d.x, d.y);
    });
    // Editing keys work anywhere on the tab except while typing in a field or a dialog
    document.addEventListener('keydown', e => {
      if (!this.visible || !this.raw || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest?.('input, select, textarea, [contenteditable], .modal')) return;
      if (e.key === 'Escape') {
        if (this.drawMode || this.gesture) this._setDrawMode(false);
        else if (this.selectedId != null) this._select(null);
        else return;
      } else if (e.key === 'b' || e.key === 'B') this._setDrawMode(!this.drawMode);
      else if ((e.key === 'v' || e.key === 'V') && this.selectedId != null) this._toggleVerified(this.boxes.find(b => b.id === this.selectedId));
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId != null) this._removeBox(this.boxes.find(b => b.id === this.selectedId));
      else return;
      e.preventDefault();
    });

    const table = $('bb-table');
    table.addEventListener('click', e => {
      const tr = e.target.closest('tr[data-i]');
      const b = tr ? this.boxes[+tr.dataset.i] : null;
      if (!b) return;
      if (e.target.closest('[data-play]')) { e.stopPropagation(); this._select(b.id, { play: true, scroll: true }); return; }
      if (e.target.closest('[data-act="toggle"]')) { e.stopPropagation(); this._removeBox(b); return; }
      if (e.target.closest('[data-act="verify"]')) { e.stopPropagation(); this._toggleVerified(b); return; }
      if (e.target.closest('[data-act="reset-geom"]')) {
        e.stopPropagation();
        this._override(b, { geom: undefined });
        this._refresh();
        return;
      }
      if (!e.target.closest('select, input, label, button')) this._select(b.id, { scroll: true });
    });
    table.addEventListener('change', async e => {
      const tr = e.target.closest('tr[data-i]');
      const b = tr ? this.boxes[+tr.dataset.i] : null;
      if (!b) return;
      if (e.target.dataset.field === 'species' && e.target.value === 'pick') {
        const target = await pickSpecies({
          title: t('demo.bb.pickTitle', 'Species for box {n}', { n: +tr.dataset.i + 1 }),
          suggestions: this.suggestions.get(timeKey(this._geom(b))) || [],
          filter: i => catalog.className(i) === 'Aves',
        });
        if (target != null) this._setSpecies(b, target);
        else this._renderTable();   // put the select back on the current species
        return;
      }
      if (e.target.dataset.field === 'species') { this._setSpecies(b, +e.target.value); return; }
      if (e.target.dataset.field === 'sound') {
        this._override(b, { soundType: e.target.value || undefined });
        e.target.classList.toggle('is-unset', !e.target.value);
      }
      this._renderSummary();
      this.spec.render();
      if (!$('bb-xc-check').hidden) this._checkXc();
    });
    $('bb-sound-default').addEventListener('change', () => this._renderTable());
  }

  _showHelp(show, remember = true) {
    $('bb-help').hidden = !show;
    this.helpBtn?.classList.toggle('active', show);
    this.helpBtn?.setAttribute('aria-expanded', String(show));
    if (!show && remember) try { localStorage.setItem(HELP_KEY, '1'); } catch { /* not persisted */ }
  }

  /** What the pointer does right now, under the spectrogram. */
  _renderHint() {
    const el = $('bb-edit-hint');
    if (!el) return;
    let text;
    if (!this.raw) text = t('demo.bb.hint.wait', 'Boxes appear here when detection is done.');
    else if (this.drawMode) text = t('demo.bb.hint.draw', 'Drag across a sound to draw a box · Esc cancels');
    else if (this.selectedId != null) text = t('demo.bb.hint.selected', 'Drag the box to move it, or its edges to resize · V verifies it · Delete removes it · Esc deselects');
    else text = t('demo.bb.hint.idle', 'Click a box to hear and select it · press B to draw a new one');
    el.textContent = text;
  }

  _restoreAnnotator() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(ANNOTATOR_KEY)) || {}; } catch { /* storage blocked */ }
    for (const [k, id] of Object.entries(ANNOTATOR_FIELDS)) {
      const el = $(id);
      // A license that is no longer offered falls back to the default
      if (typeof saved[k] === 'string' && (el.tagName !== 'SELECT' || [...el.options].some(o => o.value === saved[k]))) el.value = saved[k];
    }
  }

  _saveAnnotator() {
    const data = Object.fromEntries(Object.entries(ANNOTATOR_FIELDS).map(([k, id]) => [k, $(id).value.trim()]));
    try { localStorage.setItem(ANNOTATOR_KEY, JSON.stringify(data)); } catch { /* not persisted */ }
  }

  _renderChip() {
    const chip = $('bb-model-chip');
    if (!chip) return;
    if (birdbox.pool?.readyCount) { chip.className = 'demo-status is-ok'; chip.innerHTML = `<i class="bi bi-cpu me-1"></i>${esc(t('demo.bb.chip.ready', 'Model ready'))}`; }
    else if (this.modelCached) { chip.className = 'demo-status is-ok'; chip.innerHTML = `<i class="bi bi-hdd me-1"></i>${esc(t('demo.v3.chip.cached', 'Model cached'))}`; }
    else { chip.className = 'demo-status'; chip.innerHTML = ''; }
  }

  _setProgress(fraction, text, indeterminate = false) {
    const wrap = $('bb-progress');
    if (fraction == null) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const bar = wrap.querySelector('.progress-bar');
    bar.style.width = `${Math.round(Math.max(0.02, Math.min(1, fraction)) * 100)}%`;
    bar.classList.toggle('progress-bar-striped', indeterminate);
    bar.classList.toggle('progress-bar-animated', indeterminate);
    $('bb-progress-text').textContent = text || '';
  }

  _onAudio() {
    const audio = shared.audio;
    this.runToken++;
    birdbox.abort();
    this.raw = null;
    this.songs = [];
    this.userBoxes = [];
    this._resetSuggestions();
    this.edits.clear();
    this.selectedId = null;
    this.hoverId = null;
    this._setDrawMode(false);
    $('bb-howto').hidden = !!audio;
    $('bb-workspace').hidden = !audio;
    if (!audio) return;
    this.pcm = audio.pcm;
    this.duration = audio.duration;
    // A file named like XC1059662.wav is most likely that recording; the field stays editable
    const m = audio.name.match(/(?:^|[^A-Za-z0-9])XC[_-]?(\d+)/i);
    const nr = audio.xc || m?.[1];
    $('bb-xcnr').value = nr ? `XC${nr}` : '';
    $('bb-complete').value = '';
    $('bb-xc').querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));
    $('bb-xc-check').hidden = true;
    if (this.pcm.length < 3 * SR) {
      $('bb-error').hidden = false;
      $('bb-error').textContent = t('demo.bb.tooShort', 'BirdBox needs at least 3 seconds of audio.');
    } else $('bb-error').hidden = true;
    this.spec.clear();
    this.specPending = true;
    if (this.visible) this._startSpec();
    this.spec.setCursor(0);
    this._update();
    if (this.visible) this.run(); else this.pendingRun = true;
  }

  async run() {
    if (!this.pcm || this.pcm.length < 3 * SR) return;
    this.pendingRun = false;
    const token = ++this.runToken;
    this.raw = null;
    this._update();
    let ticker = null;
    try {
      this._setProgress(0.01, t('demo.bb.status.preparing', 'Preparing BirdBox…'));
      await birdbox.ensure(p => {
        this._setProgress(p.loaded / p.total * 0.3, p.cached
          ? t('demo.bb.status.cached', 'Loading BirdBox from your browser cache…')
          : t('demo.bb.status.downloading', 'Downloading BirdBox model: {done} of {total}', { done: fmtBytes(p.loaded), total: fmtBytes(p.total) }));
      });
      this.modelCached = true;
      this._renderChip();
      if (token !== this.runToken) return;
      const clips = Math.max(1, Math.ceil((this.duration - 3) / 1.5) + 1);
      let msPerClip = 280;
      try { msPerClip = +localStorage.getItem(MS_PER_CLIP_KEY) || msPerClip; } catch { /* storage blocked */ }
      const t0 = performance.now(), estimate = clips * msPerClip;
      // ONNX Runtime reports no progress inside one run; pace a counter on the clip grid.
      ticker = setInterval(() => {
        const elapsed = performance.now() - t0;
        if (elapsed > 0.95 * estimate) {
          // Slower than this device's last run: keep the bar creeping and say so instead of freezing
          const frac = 0.95 + 0.04 * (1 - 0.95 * estimate / elapsed);
          this._setProgress(0.3 + 0.7 * frac, t('demo.bb.status.overtime', 'Detecting vocalizations · taking longer than estimated, {time} so far', { time: fmtTime(elapsed / 1000) }));
          return;
        }
        const frac = elapsed / estimate, left = (estimate - elapsed) / 1000;
        let text = t('demo.bb.status.detecting', 'Detecting vocalizations · clip {n} of {total}', { n: Math.max(1, Math.min(clips, Math.round(frac * clips))), total: clips });
        if (left > 20) text += ` · ${t('demo.bb.status.left', 'about {time} left', { time: fmtTime(Math.ceil(left / 10) * 10) })}`;
        this._setProgress(0.3 + 0.7 * frac, text);
      }, 100);
      const res = await birdbox.detect(this.pcm.slice());
      const ms = performance.now() - t0;
      try { localStorage.setItem(MS_PER_CLIP_KEY, String(Math.round(ms / clips))); } catch { /* not persisted */ }
      if (token !== this.runToken) return;
      this.raw = { data: res.detections, rows: res.rows, ms };
      this._renderChip();
    } catch (err) {
      if (token !== this.runToken || err.cancelled) return;
      console.error(err);
      $('bb-error').hidden = false;
      $('bb-error').textContent = t('demo.bb.error', 'BirdBox failed: {message}', { message: err.message });
    } finally {
      clearInterval(ticker);
      if (token === this.runToken) {
        this._setProgress(null);
        this._update();
      }
    }
  }

  /* ---------------- boxes, edits + suggestions ---------------- */

  _update() {
    const conf = +$('bb-conf').value, gap = +$('bb-gap').value;
    this.songs = this.raw ? fuseBoxes(this.raw.data, this.raw.rows, conf, gap) : [];
    this.songs.forEach(b => { b.id = boxKey(b); });
    this._refresh();
  }

  /** Rebuild the combined box list and everything drawn from it. */
  _refresh() {
    this.boxes = [...this.songs, ...this.userBoxes].sort((a, b) => this._geom(a).t0 - this._geom(b).t0);
    if (this.selectedId != null && !this.boxes.some(b => b.id === this.selectedId)) this.selectedId = null;
    this.spec.main.classList.toggle('is-editing', this.drawMode || this.selectedId != null);
    this._renderSummary();
    this._renderTable();
    this._renderHint();
    this.spec.render();
    if (!$('bb-xc-check').hidden) this._checkXc();
    if (this.raw && $('bb-suggest').checked) this.suggestSoon();
  }

  /** Drop suggestions and ignore results of windows still being scored. */
  _resetSuggestions() {
    this.suggestToken++;
    this.suggestions.clear();
    this.inflight.clear();
    v3.cancel('birdbox');
  }

  async _suggest() {
    const token = this.suggestToken;
    const keys = [...new Set(this.boxes.map(b => timeKey(this._geom(b))))];
    const missing = keys.filter(k => !this.suggestions.has(k) && !this.inflight.has(k));
    if (!missing.length) return;
    missing.forEach(k => this.inflight.add(k));
    try {
      if (!v3.ready || !v3.workers) {
        $('bb-suggest-status').textContent = t('demo.bb.suggest.loading', 'Loading BirdNET V3.0 for species suggestions…');
      }
      await v3.ensure(p => {
        if (!p.cached) $('bb-suggest-status').textContent = t('demo.bb.suggest.downloading', 'Downloading BirdNET V3.0 for species suggestions: {pct}', { pct: fmtPct(p.loaded / p.total, 0) });
      });
      const mask = await activeMask();
      if (token !== this.suggestToken) return;
      $('bb-suggest-status').textContent = t('demo.bb.suggest.running', 'Identifying {n} boxes with BirdNET V3.0…', { n: missing.length });
      const S = catalog.count, aves = catalog.classes.indexOf('Aves'), len = 3 * SR;
      await Promise.all(missing.map(async key => {
        const [t0, t1] = key.split('|').map(Number);
        const windows = suggestionWindows(t0, t1, this.duration);
        const outs = await Promise.all(windows.map(([s, e]) => v3.scoreWindow(this.pcm, Math.round(s * SR), Math.round(e * SR), len, { gen: 'birdbox', priority: 5 })));
        if (token !== this.suggestToken) return;
        const pooled = new Float32Array(S);
        for (const o of outs) for (let i = 0; i < S; i++) if (o[i] > pooled[i]) pooled[i] = o[i];
        const cands = [];
        for (let i = 0; i < S; i++) {
          if (catalog.cls[i] !== aves || pooled[i] < 0.05) continue;
          if (mask && mask.scores[i] < mask.threshold) continue;
          cands.push({ s: i, p: pooled[i] });
        }
        cands.sort((x, y) => y.p - x.p);
        this.suggestions.set(key, cands.slice(0, 5));
        this.inflight.delete(key);
      }));
      if (token !== this.suggestToken) return;
      $('bb-suggest-status').textContent = '';
      this._renderTable();
      this._renderSummary();
      this.spec.render();
      this.suggestSoon(); // boxes may have moved meanwhile
    } catch (err) {
      if (token !== this.suggestToken || err.cancelled) return;
      missing.forEach(k => this.inflight.delete(k));
      console.error(err);
      $('bb-suggest-status').textContent = t('demo.bb.suggest.failed', 'Species suggestions are unavailable: {message}', { message: err.message });
    }
  }

  /** Box geometry with the user's changes (and the live one while dragging). */
  _geom(b) {
    if (this.live?.id === b.id) return this.live.g;
    return this.edits.get(b.id)?.geom || b;
  }

  /** Species, sound type and inclusion: the user's choices over the defaults. */
  _edit(b) {
    const o = this.edits.get(b.id) || {};
    const cands = $('bb-suggest').checked ? this.suggestions.get(timeKey(this._geom(b))) : null;
    const top = cands?.[0];
    return {
      species: o.species ?? (top && top.p >= SPECIES_MIN ? top.s : AVES),
      auto: o.species == null,
      soundType: o.soundType ?? $('bb-sound-default').value,
      include: o.include ?? true,
      verified: !!b.manual || !!o.verified,   // drawn boxes are the person's own
    };
  }

  /** A species the person picks is their judgment, so the box counts as verified. */
  _setSpecies(b, species) {
    this._override(b, { species, verified: true });
    this._refresh();
  }

  /** Verify a detected box (or take it back); drawn boxes always count as verified. */
  _toggleVerified(b) {
    if (!b || b.manual) return;
    this._override(b, { verified: !this._edit(b).verified || undefined, include: undefined });
    this._refresh();
  }

  _override(b, patch) {
    const next = { ...(this.edits.get(b.id) || {}), ...patch };
    Object.keys(next).forEach(k => { if (next[k] === undefined) delete next[k]; });
    this.edits.set(b.id, next);
  }

  _species(b) {
    const edit = this._edit(b), cands = this.suggestions.get(timeKey(this._geom(b))) || [];
    return { s: edit.species, p: cands.find(c => c.s === edit.species)?.p ?? null };
  }

  _sciName(s) { return s === AVES ? 'Aves' : catalog.xc[s] || catalog.sci[s]; }

  /** Drawn boxes are deleted (with undo); detected ones are toggled off and on. */
  _removeBox(b) {
    if (!b) return;
    if (!b.manual) {
      this._override(b, { include: !this._edit(b).include });
      this._refresh();
      return;
    }
    const n = this.boxes.indexOf(b) + 1;
    this.userBoxes = this.userBoxes.filter(x => x !== b);
    this._refresh();
    toast(t('demo.bb.deleted', 'Box {n} deleted.', { n }), 'info', {
      label: t('demo.edit.undo', 'Undo'),
      onClick: () => { this.userBoxes.push(b); this._refresh(); },
    });
  }

  /** Smallest box under a point; the selected one wins when it is there. */
  _boxAt(time, freq) {
    let best = null, bestArea = Infinity;
    for (const b of this.boxes) {
      const g = this._geom(b);
      if (time < g.t0 || time > g.t1 || freq < g.flo * 0.97 || freq > g.fhi * 1.03) continue;
      if (b.id === this.selectedId) return b;
      const area = (g.t1 - g.t0) * (g.fhi - g.flo);
      if (area < bestArea) { best = b; bestArea = area; }
    }
    return best;
  }

  /* ---------------- editing on the spectrogram ---------------- */

  _setDrawMode(on) {
    this.drawMode = on;
    this.gesture = null;
    this.draft = null;
    this.live = null;
    this.drawBtn?.classList.toggle('active', on);
    this.drawBtn?.setAttribute('aria-pressed', String(on));
    this.spec.main.classList.toggle('is-editing', on || this.selectedId != null);
    if (on) { this.hoverId = null; this.spec.showTooltip(null); }
    this._renderHint();
    this.spec.render();
  }

  /** Which part of the selected box is under the pointer: an edge, a corner or its body. */
  _handleAt(p) {
    const b = this.selectedId != null && this.boxes.find(x => x.id === this.selectedId);
    if (!b) return null;
    const g = this._geom(b), s = this.spec;
    const x0 = s.timeToX(g.t0), x1 = s.timeToX(g.t1), y0 = s.freqToY(g.fhi), y1 = s.freqToY(g.flo);
    const out = p.pointerType === 'mouse' ? 6 : 14;          // grab distance outside the box
    const inX = Math.min(out, Math.max(3, (x1 - x0) / 3));   // and inside, so small boxes stay movable
    const inY = Math.min(out, Math.max(3, (y1 - y0) / 3));
    if (p.x < x0 - out || p.x > x1 + out || p.y < y0 - out || p.y > y1 + out) return null;
    const edges = {
      l: p.x <= x0 + inX && p.x >= x0 - out,
      r: p.x >= x1 - inX && p.x <= x1 + out,
      t: p.y <= y0 + inY && p.y >= y0 - out,
      b: p.y >= y1 - inY && p.y <= y1 + out,
    };
    if (edges.l && edges.r) edges[p.x - x0 < x1 - p.x ? 'r' : 'l'] = false;
    if (edges.t && edges.b) edges[p.y - y0 < y1 - p.y ? 'b' : 't'] = false;
    const onEdge = edges.l || edges.r || edges.t || edges.b;
    const inside = p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    if (!onEdge && !inside) return null;
    return { b, g, edges, move: !onEdge };
  }

  _editCursor(p) {
    if (this.drawMode) return 'crosshair';
    const h = this._handleAt(p);
    if (h) {
      const { l, r, t: top, b: bottom } = h.edges;
      if ((l && top) || (r && bottom)) return 'nwse-resize';
      if ((r && top) || (l && bottom)) return 'nesw-resize';
      if (l || r) return 'ew-resize';
      if (top || bottom) return 'ns-resize';
      return 'move';
    }
    return this._boxAt(p.time, p.freq) ? 'pointer' : '';
  }

  _editDown(p) {
    if (!this.raw) return false;
    if (this.drawMode) {
      this.gesture = { type: 'draw', start: p };
      return true;
    }
    const h = this._handleAt(p);
    if (!h) return false;
    this.gesture = { type: h.move ? 'move' : 'resize', id: h.b.id, start: p, from: geomOf(h.g), edges: h.edges };
    this.hoverId = null;
    this.spec.showTooltip(null);
    return true;
  }

  _editMove(p) {
    const gs = this.gesture;
    if (!gs) return;
    const dur = this.duration, time = clamp(p.time, 0, dur), freq = clamp(p.freq, 0, FREQ_MAX);
    if (gs.type === 'draw') {
      const a = { time: clamp(gs.start.time, 0, dur), freq: clamp(gs.start.freq, 0, FREQ_MAX) };
      this.draft = { t0: Math.min(a.time, time), t1: Math.max(a.time, time), flo: Math.min(a.freq, freq), fhi: Math.max(a.freq, freq) };
    } else {
      let { t0, t1, flo, fhi } = gs.from;
      if (gs.type === 'move') {
        const dt = clamp(p.time - gs.start.time, -t0, dur - t1);
        const df = clamp(p.freq - gs.start.freq, -flo, FREQ_MAX - fhi);
        t0 += dt; t1 += dt; flo += df; fhi += df;
      } else {
        if (gs.edges.l) t0 = Math.min(time, t1 - MIN_DUR);
        if (gs.edges.r) t1 = Math.max(time, t0 + MIN_DUR);
        if (gs.edges.t) fhi = Math.max(freq, flo + MIN_BAND);
        if (gs.edges.b) flo = Math.min(freq, fhi - MIN_BAND);
      }
      this.live = { id: gs.id, g: { t0, t1, flo, fhi } };
    }
    this.spec.render();
  }

  _editUp(commit) {
    const gs = this.gesture, draft = this.draft, live = this.live;
    this.gesture = null;
    this.draft = null;
    this.live = null;
    if (!gs) return;
    if (gs.type === 'draw') {
      if (commit && draft && draft.t1 - draft.t0 >= MIN_DUR && draft.fhi - draft.flo >= MIN_BAND) {
        const box = { id: `user-${++this.userSeq}`, manual: true, ...draft };
        this.userBoxes.push(box);
        this.selectedId = box.id;
        this._setDrawMode(false);
        this._refresh();
      } else this.spec.render();
      return;
    }
    const b = this.boxes.find(x => x.id === gs.id);
    if (commit && live && b) {
      if (b.manual) Object.assign(b, live.g);
      else this._override(b, { geom: live.g, verified: true });   // adjusting a box is a human judgment
    }
    this._refresh();
  }

  /* ---------------- rendering ---------------- */

  _renderSummary() {
    const el = $('bb-summary');
    const ok = !!this.raw;
    ['bb-export-xc', 'bb-export-csv', 'bb-export-raven'].forEach(id => { $(id).disabled = !ok || !this.boxes.length; });
    if (!ok) { el.innerHTML = ''; return; }
    const included = this.boxes.filter(b => this._edit(b).include);
    const species = new Set(included.map(b => this._edit(b).species).filter(s => s !== AVES));
    const stats = [
      [this.boxes.length, t('demo.bb.sum.boxes', 'boxes')],
      [included.filter(b => this._edit(b).verified).length, t('demo.bb.sum.verified', 'verified by you')],
      [species.size, t('demo.bb.sum.species', 'suggested species')],
      [`${fmtNumber(this.raw.ms / 1000, 1)} s`, t('demo.bb.sum.time', 'detection')],
    ];
    el.innerHTML = statLine(stats);
  }

  _renderTable() {
    const tbody = $('bb-table').querySelector('tbody');
    $('bb-table-wrap').hidden = !this.raw;
    if (!this.raw) { tbody.innerHTML = ''; return; }
    if (!this.boxes.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-3">${esc(t('demo.bb.none', 'No bird vocalizations above this confidence. Try a lower threshold.'))}</td></tr>`;
      return;
    }
    const suggest = $('bb-suggest').checked;
    tbody.innerHTML = this.boxes.map((b, i) => {
      const g = this._geom(b), edit = this._edit(b), cands = this.suggestions.get(timeKey(g));
      let speciesCell;
      if (suggest && !cands) speciesCell = `<span class="text-muted small"><span class="spinner-border spinner-border-sm me-1"></span>${esc(t('demo.bb.identifying', 'Identifying…'))}</span>`;
      else {
        const opts = (cands || []).map(c => `<option value="${c.s}"${c.s === edit.species ? ' selected' : ''}>${esc(catalog.name(c.s))} (${fmtPct(c.p, 0)})</option>`);
        if (edit.species !== AVES && !(cands || []).some(c => c.s === edit.species)) opts.unshift(`<option value="${edit.species}" selected>${esc(catalog.name(edit.species))}</option>`);
        opts.push(`<option value="${AVES}"${edit.species === AVES ? ' selected' : ''}>${esc(t('demo.bb.aves', 'Bird (unidentified) · Aves'))}</option>`);
        opts.push(`<option value="pick">${esc(t('demo.bb.otherSpecies', 'Other species…'))}</option>`);
        speciesCell = `${edit.species !== AVES ? thumb(edit.species, 'bb-thumb') : '<span class="bb-thumb"><i class="fa-solid fa-dove"></i></span>'}<select class="form-select form-select-sm bb-select" data-field="species" aria-label="${esc(t('demo.bb.col.species', 'Species'))}">${opts.join('')}</select>`;
      }
      const sound = (edit.soundType ? '' : `<option value="" selected>${esc(t('demo.bb.choose', 'Choose…'))}</option>`)
        + SOUND_TYPES.map(s => `<option value="${s}"${s === edit.soundType ? ' selected' : ''}>${esc(this._soundLabel(s))}</option>`).join('');
      const drawn = esc(t('demo.bb.drawn', 'Drawn by you')), reset = esc(t('demo.bb.resetBox', 'Restore the detected box'));
      const mark = b.manual
        ? `<i class="bi bi-pencil-fill bb-mark" title="${drawn}" aria-label="${drawn}"></i>`
        : this.edits.get(b.id)?.geom ? `<button type="button" class="bb-mark bb-reset" data-act="reset-geom" title="${reset}" aria-label="${reset}"><i class="bi bi-arrow-counterclockwise"></i></button>` : '';
      const removeLabel = esc(b.manual ? t('demo.bb.deleteBox', 'Delete box') : edit.include ? t('demo.bb.remove', 'Remove box') : t('demo.bb.restore', 'Restore box'));
      const removeIcon = b.manual ? 'bi-trash3' : edit.include ? 'bi-x-lg' : 'bi-arrow-counterclockwise';
      const verifyLabel = esc(edit.verified ? t('demo.bb.unverify', 'Verified by you · click to undo') : t('demo.bb.verify', 'Verify box (V)'));
      const verify = b.manual
        ? `<span class="bb-verify is-on is-drawn" title="${drawn}"><i class="bi bi-check-circle-fill"></i></span>`
        : `<button type="button" class="bb-verify${edit.verified ? ' is-on' : ''}" data-act="verify" aria-pressed="${edit.verified}" title="${verifyLabel}" aria-label="${verifyLabel}"><i class="bi ${edit.verified ? 'bi-check-circle-fill' : 'bi-check-circle'}"></i></button>`;
      return `<tr data-i="${i}" class="${b.id === this.selectedId ? 'is-selected' : ''}${edit.include ? '' : ' is-excluded'}">
        <td class="bb-c-play"><button type="button" class="bb-play${b.manual ? ' is-manual' : ''}" data-play="${i}" aria-label="${esc(t('demo.results.playSegment', 'Play segment'))} ${i + 1}"><i class="bi bi-play-fill"></i>${i + 1}</button></td>
        <td class="bb-c-time">${fmtTime(g.t0, 2)}–${fmtTime(g.t1, 2)}<span>${fmtNumber(g.flo / 1000, 1)}–${fmtNumber(g.fhi / 1000, 1)} kHz${mark}</span></td>
        <td class="bb-c-conf"${b.manual ? ` title="${drawn}"` : ` title="max ${fmtNumber(b.max, 2)} · ${b.n}×"`}>${b.manual ? '–' : fmtNumber(b.avg, 2)}</td>
        <td class="bb-c-species"><div class="bb-species-wrap">${speciesCell}</div></td>
        <td class="bb-c-sound"><select class="form-select form-select-sm bb-select${edit.soundType ? '' : ' is-unset'}" data-field="sound" aria-label="${esc(t('demo.bb.col.sound', 'Sound type'))}">${sound}</select></td>
        <td class="bb-c-toggle">${verify}<button type="button" class="bb-toggle" data-act="toggle" title="${removeLabel}" aria-label="${removeLabel}"><i class="bi ${removeIcon}"></i></button></td>
      </tr>`;
    }).join('');
  }

  /** Select a box (or none): highlight its row, bring it into view, optionally play it. */
  _select(id, { play = false, scroll = false } = {}) {
    this.selectedId = id;
    const i = this.boxes.findIndex(b => b.id === id), b = this.boxes[i];
    document.querySelectorAll('#bb-table tr[data-i]').forEach(tr => tr.classList.toggle('is-selected', +tr.dataset.i === i));
    this.spec.main.classList.toggle('is-editing', this.drawMode || !!b);
    if (b) {
      if (scroll) document.querySelector(`#bb-table tr[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const g = this._geom(b), span = this.spec.view.t1 - this.spec.view.t0;
      if (g.t0 < this.spec.view.t0 || g.t1 > this.spec.view.t1) this.spec.setView(g.t0 - span * 0.3, g.t0 - span * 0.3 + span);
      if (play) player.play(Math.max(0, g.t0 - 0.15), g.t1 + 0.15);
    }
    this._renderHint();
    this.spec.render();
  }

  _drawBoxes(ctx, h) {
    ctx.font = '600 11px Inter Variable, Inter, system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    this.boxes.forEach((b, i) => {
      const g = this._geom(b), x0 = h.timeToX(g.t0), x1 = h.timeToX(g.t1);
      if (x1 < 0 || x0 > h.width) return;
      const y0 = h.freqToY(g.fhi), y1 = h.freqToY(g.flo), edit = this._edit(b);
      const selected = b.id === this.selectedId, active = selected || b.id === this.hoverId;
      const base = b.manual ? '#fbbf24' : edit.verified ? '#4ade80' : '#22d3ee';
      const color = !edit.include ? 'rgba(148,163,184,0.7)' : active ? '#ffffff' : base;
      ctx.strokeStyle = color;
      ctx.lineWidth = active ? 2.5 : 1.5;
      ctx.setLineDash(edit.include ? [] : [4, 3]);
      ctx.strokeRect(x0, y0, Math.max(2, x1 - x0), Math.max(2, y1 - y0));
      ctx.setLineDash([]);
      if (active) { ctx.fillStyle = b.manual ? 'rgba(251,191,36,0.07)' : edit.verified ? 'rgba(74,222,128,0.07)' : 'rgba(34,211,238,0.07)'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
      const sp = this._species(b);
      const num = `${i + 1}${edit.verified && !b.manual ? ' ✓' : ''}`;
      let label = sp.s !== AVES ? `${num} · ${catalog.name(sp.s)}` : b.manual || edit.verified ? num : `${num} · ${fmtNumber(b.avg, 2)}`;
      // Keep crowded views readable: numbers only unless the label fits or the box is active
      if (!active && ctx.measureText(label).width > Math.max(x1 - x0, 0) + 24) label = num;
      const tw = ctx.measureText(label).width + 8, ly = Math.max(14, y0 - 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x0, ly - 13, tw, 15);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#05040c';
      ctx.fillText(label, x0 + 4, ly - 2);
      // Handles on the selected box show that it can be moved and resized
      if (selected && !this.drawMode && edit.include) {
        ctx.fillStyle = '#ffffff';
        const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
        for (const [hx, hy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [xm, y0], [xm, y1], [x0, ym], [x1, ym]]) ctx.fillRect(hx - 3, hy - 3, 6, 6);
      }
    });
    if (this.draft) {
      const d = this.draft, x0 = h.timeToX(d.t0), x1 = h.timeToX(d.t1), y0 = h.freqToY(d.fhi), y1 = h.freqToY(d.flo);
      ctx.fillStyle = 'rgba(251,191,36,0.14)';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
    }
  }

  /* ---------------- export ---------------- */

  _included() {
    return this.boxes.map((b, i) => ({ b, g: this._geom(b), i, edit: this._edit(b), sp: this._species(b) })).filter(r => r.edit.include);
  }

  _baseName() { return (shared.audio?.name || 'audio').replace(/\.[^.]+$/, ''); }

  /**
   * Mark what the Annota-JSON export still needs from the person; true when
   * nothing is missing. Facts about the person and the recording are asked
   * for, never guessed.
   */
  _checkXc() {
    const missing = [];
    const need = (id, ok, what) => {
      $(id).classList.toggle('is-invalid', !ok);
      if (!ok) missing.push({ id, what });
    };
    const unset = this._included().filter(r => !r.edit.soundType).map(r => `#${r.i + 1}`);
    const list = unset.length > 6 ? `${unset.slice(0, 6).join(', ')}, …` : unset.join(', ');
    need('bb-xcnr', !!parseXcNumber($('bb-xcnr').value), t('demo.bb.need.xcnr', 'the XC number'));
    need('bb-complete', !!$('bb-complete').value, t('demo.bb.need.complete', 'whether every bird sound is boxed'));
    need('bb-sound-default', !unset.length, t('demo.bb.need.sound', 'a sound type for {list}', { list }));
    need('bb-annotator', !!$('bb-annotator').value.trim(), t('demo.bb.need.name', 'your name'));
    need('bb-license', !!$('bb-license').value, t('demo.bb.need.license', 'a license'));
    $('bb-table-wrap').classList.toggle('bb-table-check', unset.length > 0);
    const check = $('bb-xc-check');
    check.hidden = !missing.length;
    check.textContent = t('demo.bb.need', 'Still needed: {list}.', { list: missing.map(m => m.what).join(' · ') });
    return missing;
  }

  /** Xeno-canto Annota-JSON: one annotation per included box, numbered as in the table. */
  _exportXc() {
    const rows = this._included();
    if (!rows.length) { toast(t('demo.bb.noneIncluded', 'Select at least one box to export.'), 'warning'); return; }
    const missing = this._checkXc();
    if (missing.length) { $(missing[0].id).focus(); return; }
    const xcNr = parseXcNumber($('bb-xcnr').value);
    const name = $('bb-annotator').value.trim();
    const xcId = xcContributor($('bb-xcid').value);
    const m = this.manifest;
    const commit = m?.sources?.birdbox?.match(/\/tree\/([0-9a-f]{7})/)?.[1];
    const birdboxName = `${m?.birdbox?.name || 'BirdBox Just-Bird'}${commit ? ` @ ${commit}` : ''}`;
    const birdnetName = `BirdNET+ V${m?.v3?.version || '3.0'}`;
    const date = new Date().toISOString().slice(0, 10);
    const counts = { drawn: 0, verified: 0, unverified: 0 };
    // Drawn, adjusted and verified boxes are the person's; the others stay BirdBox's
    const annotations = rows.map(r => {
      const adjusted = !r.b.manual && !!this.edits.get(r.b.id)?.geom;
      const human = r.edit.verified;
      counts[r.b.manual ? 'drawn' : human ? 'verified' : 'unverified']++;
      const box = r.b.manual ? 'Box drawn by the annotator'
        : `Box detected by BirdBox (confidence ${r.b.avg.toFixed(3)}), ${human ? `${adjusted ? 'adjusted and ' : ''}verified by the annotator` : 'not verified'}`;
      const species = r.sp.s === AVES ? 'species not identified'
        : r.edit.auto ? `species suggested by ${birdnetName}${r.sp.p != null ? ` (score ${r.sp.p.toFixed(3)})` : ''}${human ? ', confirmed by the annotator' : ''}`
          : 'species chosen by the annotator';
      return {
        annotation_source_id: `birdbox-${String(r.i + 1).padStart(6, '0')}`,
        sound_file: shared.audio?.name || '',
        xc_nr: xcNr,
        annotator: human ? name : 'BirdBox',
        annotator_xc_id: human ? xcId : '',
        frequency_high: Math.round(r.g.fhi),
        frequency_low: Math.round(r.g.flo),
        start_time: Number(r.g.t0.toFixed(3)),
        end_time: Number(r.g.t1.toFixed(3)),
        scientific_name: this._sciName(r.sp.s),
        sound_type: r.edit.soundType,
        date_identified: date,
        annotation_remarks: `${box}; ${species}`,
      };
    });
    const suggested = rows.some(r => r.sp.s !== AVES && r.edit.auto);
    const gap = +$('bb-gap').value;
    const settings = `confidence > ${(+$('bb-conf').value).toFixed(2)}, phrase gap ${gap > 0 ? `${gap.toFixed(2)} s` : 'off'}`;
    const payload = {
      set_source: '',
      set_uri: '',
      set_name: `BirdBox annotations of XC${xcNr}`,
      annotation_software_name_and_version: suggested ? `${birdboxName}; species suggestions: ${birdnetName}` : birdboxName,
      set_creator: name,
      set_creator_id: xcId ? `https://xeno-canto.org/contributor/${xcId}` : '',
      set_owner: name,   // the set is made here from scratch, so it is the person's own
      set_license: $('bb-license').value,
      project_uri: '',
      project_name: '',
      funding: '',
      set_remarks: `Made in the BirdNET browser demo. Boxes from BirdBox (${settings}): ${counts.verified} verified by the annotator, ${counts.unverified} not verified (annotator "BirdBox"); ${counts.drawn} drawn by the annotator.`,
      scope: [{ taxon_coverage: 'Aves', completeness: $('bb-complete').value }],
      annotations,
    };
    downloadFile(`XC${xcNr}.xeno-canto-annota.json`, `${JSON.stringify(payload, null, 2)}\n`, 'application/json');
  }

  _exportCsv() {
    const header = ['box', 'time_start', 'time_end', 'freq_low_hz', 'freq_high_hz', 'avg_confidence', 'max_confidence', 'detections_merged', 'class_id', 'species', 'scientific_name', 'common_name', 'suggestion_score', 'sound_type'];
    const lines = [header.join(',')];
    for (const r of this._included()) {
      const detector = r.b.manual ? ['', '', '', ''] : [r.b.avg.toFixed(6), r.b.max.toFixed(6), Math.round(r.b.n), Math.round(r.b.cls)];
      lines.push([r.i + 1, r.g.t0.toFixed(6), r.g.t1.toFixed(6), r.g.flo.toFixed(3), r.g.fhi.toFixed(3), ...detector, 'bird',
        csvField(this._sciName(r.sp.s)), csvField(r.sp.s === AVES ? '' : catalog.en[r.sp.s]), r.sp.p == null ? '' : r.sp.p.toFixed(6), csvField(r.edit.soundType)].join(','));
    }
    downloadFile(`${this._baseName()}.BirdBox.csv`, `${lines.join('\n')}\n`, 'text/csv;charset=utf-8');
  }

  _exportRaven() {
    const lines = [['Selection', 'View', 'Channel', 'Begin Time (s)', 'End Time (s)', 'Low Freq (Hz)', 'High Freq (Hz)', 'Annotation', 'Confidence'].join('\t')];
    this._included().forEach(r => {
      lines.push([r.i + 1, 'Spectrogram 1', 1, r.g.t0.toFixed(3), r.g.t1.toFixed(3), Math.round(r.g.flo), Math.round(r.g.fhi), this._sciName(r.sp.s), r.b.manual ? '' : r.b.avg.toFixed(3)].join('\t'));
    });
    downloadFile(`${this._baseName()}.BirdBox.selections.txt`, `${lines.join('\n')}\n`);
  }
}
