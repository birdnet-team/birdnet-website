/**
 * BirdNET V3.0 tab: analyze a recording with the V3.0 audio model, stream
 * results while the worker pool runs, and explore detections on a
 * spectrogram and species timeline. Threshold, taxa and location filters
 * re-filter the stored scores without new inference; species and single
 * detections can be removed or reassigned to another species.
 */
import { AudioSource } from './audio-source.js';
import { csvField, downloadFile, esc, fmtBytes, fmtNumber, fmtPct, fmtTime, pyRound, shared, statLine, t, throttle, toast } from './core.js';
import { activeMask, LocationFilter } from './location-filter.js';
import { pickSpecies } from './picker.js';
import { player } from './player.js';
import { SpecView } from './spec-view.js';
import { catalog, CLASS_INFO, classLabel } from './species.js';
import { imageUrl, speciesInfo } from './taxonomy.js';
import { planChunks, SR, v3 } from './v3-service.js';

const MAX_SECONDS = 15 * 60;
const LANE_H = 22;
const MAX_LANES = 8;
const DETECTIONS_SHOWN = 48;
const PALETTE = ['#60a5fa', '#fbbf24', '#34d399', '#f87171', '#a78bfa', '#22d3ee', '#f472b6', '#a3e635', '#fb923c', '#2dd4bf'];

const $ = id => document.getElementById(id);
const detKey = (c, s) => `${c}:${s}`;

/**
 * Compute a spectrogram in a worker owned by the viewer and stream it in.
 * Starting a new job stops the viewer's previous one.
 */
export function streamSpectrogram(view, pcm, type, duration) {
  view._specWorker?.terminate();
  const worker = view._specWorker = new Worker(new URL('./spec-worker.js', import.meta.url));
  worker.onmessage = ({ data }) => {
    if (data.type === 'meta') view.setSource({ frames: data.frames, rows: data.rows, fps: data.fps, duration, floor: data.floor || 0 });
    else if (data.type === 'slice') view.addSlice(data.start, data.data);
    else if (data.type === 'error') console.error('spectrogram:', data.error);
    if (data.type === 'done' || data.type === 'error') {
      worker.terminate();
      if (view._specWorker === worker) view._specWorker = null;
    }
  };
  worker.postMessage({ type, id: 1, pcm, sampleRate: SR, fMax: view.axis?.fMax });
}

/**
 * Thumbnail (3:2, like the taxonomy service's images) with a class icon
 * underneath as fallback; `ring` outlines it in the species' spectrogram color.
 */
export function thumb(s, cls = 'v3-thumb', lazy = cls !== 'tt-img', ring = null) {
  const icon = CLASS_INFO[catalog.className(s)]?.icon || 'fa-dove';
  const style = ring ? ` style="--c:${ring}"` : '';
  return `<span class="${cls}${ring ? ' has-ring' : ''}"${style}><img loading="${lazy ? 'lazy' : 'eager'}" alt="" src="${imageUrl(catalog.sci[s])}" onerror="this.remove()"><i class="fa-solid ${icon}"></i></span>`;
}

export class V3Tab {
  constructor() {
    this.state = { analysis: null, selected: null, mask: null, showAllLanes: false, listLimit: 30, expanded: new Set() };
    this.edits = { removed: new Set(), relabel: new Map(), history: [] };
    this.visible = false;
    this.pendingRun = false;
  }

  init() {
    this.source = new AudioSource($('v3-source'));
    this.location = new LocationFilter($('v3-location'));
    this.spec = new SpecView($('v3-spec'), {
      height: 230, kind: 'stft', axis: { type: 'linear', fMin: 0, fMax: 12000 },
      toolbar: document.querySelector('#pane-v3 .spec-tools-host'),
    });
    this.spec.overlay = (ctx, h) => this._drawOverlay(ctx, h);
    this.spec.minimapOverlay = (ctx, h) => this._drawMinimapOverlay(ctx, h);
    this.timelineCanvas = $('v3-timeline');
    this.tctx = this.timelineCanvas.getContext('2d');
    this._bind();
    this._renderModelChip();
    catalog.load().then(() => this._initNames()).catch(err => console.error(err));
    v3.cached().then(cached => { this.modelCached = cached; this._renderModelChip(); });
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
    this._drawTimeline();
    if (this.pendingRun) this.run();
  }

  hide() { this.visible = false; }

  /* ---------------- wiring ---------------- */

  _bind() {
    shared.addEventListener('audio', () => this._onAudio());
    this.location.addEventListener('change', () => this._updateMask());
    const conf = $('v3-conf');
    conf.addEventListener('input', () => { $('v3-conf-val').textContent = fmtPct(+conf.value, 0); this._refresh(); });
    $('v3-conf-val').textContent = fmtPct(+conf.value, 0);
    $('v3-overlap').addEventListener('change', () => this.run());
    $('v3-window').addEventListener('change', () => this.run());
    document.querySelectorAll('#v3-taxa input').forEach(cb => cb.addEventListener('change', () => this._refresh()));
    $('v3-run').addEventListener('click', () => (this.running ? this.stop() : this.run()));
    $('v3-export-csv').addEventListener('click', () => this._exportCsv());
    $('v3-export-raven').addEventListener('click', () => this._exportRaven());
    $('v3-lanes-toggle').addEventListener('click', () => { this.state.showAllLanes = !this.state.showAllLanes; this._refresh(); });
    v3.addEventListener('workers', () => this._renderModelChip());

    player.addEventListener('time', e => {
      if (!this.visible) return;
      this.spec.setCursor(e.detail);
      if (player.playing) this.spec.follow(e.detail);
      this._drawTimeline();
      this._markPlaying(e.detail);
    });
    player.addEventListener('state', () => this._markCardPlaying());
    this.spec.addEventListener('view', () => this._drawTimeline());
    this.spec.addEventListener('toggleplay', () => { this.playingSpecies = null; player.toggle(); });
    this.spec.addEventListener('pick', e => {
      if (!shared.audio) return;
      this.playingSpecies = null;
      player.play(e.detail.time);
    });
    this.spec.addEventListener('hover', e => this._hoverSpec(e.detail));
    this.timelineCanvas.addEventListener('pointermove', e => this._hoverTimeline(e));
    this.timelineCanvas.addEventListener('pointerleave', () => { $('v3-timeline-tip').hidden = true; this.hoverChunk = null; this.spec.render(); });
    this.timelineCanvas.addEventListener('click', e => this._clickTimeline(e));
    new ResizeObserver(() => this._drawTimeline()).observe(this.timelineCanvas.parentElement);

    $('v3-summary').addEventListener('click', e => {
      if (e.target.closest('[data-act="reset-edits"]')) this._resetEdits();
    });
    $('v3-results').addEventListener('click', e => this._onResultsClick(e));
  }

  _onResultsClick(e) {
    const act = e.target.closest('[data-act]');
    const card = e.target.closest('.v3-species');
    if (act) {
      e.stopPropagation();
      const s = +card?.dataset.species, c = act.dataset.c != null ? +act.dataset.c : null;
      if (act.dataset.act === 'play') {
        // The card's play button doubles as pause while its species plays
        if (act.classList.contains('v3-play') && card.classList.contains('is-playing')) { player.pause(); return; }
        const [c0, c1] = this.state.analysis.chunks[c];
        this.playingSpecies = s;
        player.play(c0 / SR, c1 / SR);
        this._select(s, { keep: true });
      } else if (act.dataset.act === 'remove-species') this._removeSpecies(s);
      else if (act.dataset.act === 'relabel-species') this._relabelSpecies(s);
      else if (act.dataset.act === 'remove-det') this._removeDetection(s, c);
      else if (act.dataset.act === 'relabel-det') this._relabelDetection(s, c);
      else if (act.dataset.act === 'all-dets') { card.dataset.allDets = '1'; this._renderDetail(card, s, true); }
      return;
    }
    if (e.target.closest('[data-more]')) { this.state.listLimit += 50; this._renderList(); return; }
    if (e.target.closest('.v3-detail a')) return;
    if (card && e.target.closest('.v3-species-main')) this._select(+card.dataset.species);
  }

  _initNames() {
    const select = $('v3-names');
    select.innerHTML = catalog.availableLangs().map(([code, label]) => `<option value="${code}">${esc(label)}</option>`).join('');
    select.value = catalog.lang;
    select.addEventListener('change', async () => {
      await catalog.setLang(select.value, { remember: true });
    });
    catalog.addEventListener('names', () => {
      select.value = catalog.lang;
      this.cards?.forEach(card => { delete card.dataset.infoLang; });
      this._refresh();
    });
  }

  /* ---------------- audio + analysis ---------------- */

  _onAudio() {
    const audio = shared.audio;
    v3.cancel();
    this.running = false;
    this.state.analysis = null;
    this.state.selected = null;
    this.state.listLimit = 30;
    this._clearEdits();
    $('v3-howto').hidden = !!audio;
    $('v3-workspace').hidden = !audio;
    $('v3-error').hidden = true;
    if (!audio) return;
    const pcm = audio.pcm.length > MAX_SECONDS * SR ? audio.pcm.subarray(0, MAX_SECONDS * SR) : audio.pcm;
    this.pcm = pcm;
    this.duration = pcm.length / SR;
    $('v3-truncated').hidden = audio.duration <= MAX_SECONDS;
    this.spec.clear();
    this.specPending = true;
    if (this.visible) this._startSpec();
    this.spec.setCursor(0);
    this._refresh();
    if (this.visible) this.run(); else this.pendingRun = true;
  }

  async run() {
    if (!shared.audio || !this.pcm) return;
    this.pendingRun = false;
    $('v3-error').hidden = true;
    const chunkSec = +$('v3-window').value, overlapSec = Math.min(+$('v3-overlap').value, chunkSec - 0.5);
    const pcm = this.pcm, audio = shared.audio;
    const plan = planChunks(pcm.length, chunkSec, overlapSec);
    const analysis = {
      audio, chunkSec, overlapSec, chunks: plan.chunks, done: new Uint8Array(plan.chunks.length), nDone: 0,
      scores: null, ms: 0, startedAt: 0, finished: false,
    };
    this.state.analysis = analysis;
    this._clearEdits(); // edits refer to windows of the previous run
    this.running = true;
    this._renderRunButton();
    const onProgress = p => {
      this.modelProgress = p;
      this._renderModelChip();
      this._setProgress(p.loaded / p.total * 0.999, p.cached
        ? t('demo.v3.status.cached', 'Loading BirdNET V3.0 from your browser cache…')
        : t('demo.v3.status.downloading', 'Downloading BirdNET V3.0 model: {done} of {total}', { done: fmtBytes(p.loaded), total: fmtBytes(p.total) }));
    };
    try {
      if (!v3.ready) {
        this._setProgress(0.01, t('demo.v3.status.preparing', 'Preparing BirdNET V3.0…'));
        const startListener = e => {
          if (e.detail === 'starting') this._setProgress(1, t('demo.v3.status.starting', 'Starting inference workers…'), true);
        };
        v3.addEventListener('status', startListener);
        await v3.ensure(onProgress).finally(() => v3.removeEventListener('status', startListener));
        this.modelCached = true;
        this._renderModelChip();
      }
      if (this.state.analysis !== analysis) return;
      analysis.startedAt = performance.now();
      analysis.scores = new Float32Array(plan.chunks.length * catalog.count);
      const update = throttle(() => this._refresh(), 200);
      this._setProgress(0, t('demo.v3.status.analyzing', 'Analyzing…'));
      const res = await v3.analyze(pcm, {
        chunkSec, overlapSec,
        onChunk: (i, scores) => {
          if (this.state.analysis !== analysis) return;
          analysis.scores.set(scores, i * catalog.count);
          analysis.done[i] = 1;
          analysis.nDone++;
          const elapsed = (performance.now() - analysis.startedAt) / 1000;
          const audioDone = analysis.nDone * (chunkSec - overlapSec);
          this._setProgress(analysis.nDone / plan.chunks.length, t('demo.v3.status.progress', 'Analyzing window {done} of {total} · {speed}× real time · {workers} workers', {
            done: analysis.nDone, total: plan.chunks.length, speed: fmtNumber(audioDone / Math.max(elapsed, 0.01), 1), workers: v3.workers,
          }));
          update();
        },
      });
      if (this.state.analysis !== analysis || res.cancelled) return;
      analysis.ms = performance.now() - analysis.startedAt;
      analysis.finished = true;
    } catch (err) {
      console.error(err);
      if (this.state.analysis === analysis) {
        this._setProgress(null);
        $('v3-error').hidden = false;
        $('v3-error').innerHTML = `<i class="bi bi-exclamation-triangle me-1"></i>${esc(t('demo.v3.error', 'The analysis failed: {message}', { message: err.message }))}`;
      }
    } finally {
      if (this.state.analysis === analysis) {
        this.running = false;
        this._renderRunButton();
        this._setProgress(null);
        this._refresh();
      }
    }
  }

  stop() {
    v3.cancel();
    this.running = false;
    this._renderRunButton();
    this._setProgress(null);
    this._refresh();
  }

  async _updateMask() {
    try {
      const mask = await activeMask(p => {
        if (!p.cached) $('v3-geo-status').textContent = t('demo.geo.downloading', 'Loading geomodel… {pct}', { pct: fmtPct(p.loaded / p.total, 0) });
      });
      this.state.mask = mask;
    } catch (err) {
      console.error(err);
      this.state.mask = null;
    }
    $('v3-geo-status').textContent = '';
    this._refresh();
  }

  /* ---------------- edits: remove or reassign detections ---------------- */

  _clearEdits() {
    this.edits = { removed: new Set(), relabel: new Map(), history: [] };
  }

  get editCount() { return this.edits.removed.size + this.edits.relabel.size; }

  /** Apply a change set and remember how to undo it. */
  _commit(change, message) {
    const undo = { removed: [], relabel: [] };
    for (const k of change.remove || []) if (!this.edits.removed.has(k)) { this.edits.removed.add(k); undo.removed.push(k); }
    for (const [k, s] of change.relabel || []) { undo.relabel.push([k, this.edits.relabel.get(k)]); this.edits.relabel.set(k, s); }
    this.edits.history.push(undo);
    this._refresh();
    toast(message, 'info', { label: t('demo.edit.undo', 'Undo'), onClick: () => this._undo(undo) });
  }

  _undo(undo) {
    undo.removed.forEach(k => this.edits.removed.delete(k));
    for (const [k, prev] of undo.relabel.reverse()) prev == null ? this.edits.relabel.delete(k) : this.edits.relabel.set(k, prev);
    this.edits.history = this.edits.history.filter(h => h !== undo);
    this._refresh();
  }

  _resetEdits() {
    this._clearEdits();
    this._refresh();
  }

  _stat(s) { return this.derived?.list.find(l => l.s === s); }

  _removeSpecies(s) {
    const st = this._stat(s);
    if (!st) return;
    if (this.state.selected === s) this.state.selected = null;
    this._commit({ remove: st.chunks.map(c => detKey(c, st.dets.get(c).src)) },
      t('demo.edit.removedSpecies', '{name} removed.', { name: catalog.name(s) }));
  }

  _removeDetection(s, c) {
    const st = this._stat(s);
    if (!st?.dets.has(c)) return;
    const [c0] = this.state.analysis.chunks[c];
    this._commit({ remove: [detKey(c, st.dets.get(c).src)] },
      t('demo.edit.removedDetection', 'Detection at {time} removed.', { time: fmtTime(c0 / SR) }));
  }

  /** Species the model also considered for a window, as picker suggestions. */
  _alternatives(c, exclude) {
    const a = this.state.analysis, S = catalog.count, out = [];
    for (let s = 0; s < S; s++) {
      const p = a.scores[c * S + s];
      if (p >= 0.02 && s !== exclude) out.push({ s, p });
    }
    return out.sort((x, y) => y.p - x.p).slice(0, 8);
  }

  async _relabelSpecies(s) {
    const st = this._stat(s);
    if (!st) return;
    const target = await pickSpecies({
      title: t('demo.edit.relabelSpeciesTitle', 'Replace {name} with…', { name: catalog.name(s) }),
      suggestions: this._alternatives(st.best, s), exclude: [s],
    });
    if (target == null) return;
    this.state.selected = target;
    this._commit({ relabel: st.chunks.map(c => [detKey(c, st.dets.get(c).src), target]) },
      t('demo.edit.relabeled', '{from} → {to}', { from: catalog.name(s), to: catalog.name(target) }));
  }

  async _relabelDetection(s, c) {
    const st = this._stat(s);
    if (!st?.dets.has(c)) return;
    const [c0] = this.state.analysis.chunks[c];
    const target = await pickSpecies({
      title: t('demo.edit.relabelDetectionTitle', 'Species at {time}', { time: fmtTime(c0 / SR) }),
      suggestions: this._alternatives(c, s), exclude: [s],
    });
    if (target == null) return;
    this._commit({ relabel: [[detKey(c, st.dets.get(c).src), target]] },
      t('demo.edit.relabeled', '{from} → {to}', { from: catalog.name(s), to: catalog.name(target) }));
  }

  /* ---------------- derived results ---------------- */

  _allowedFn() {
    const taxa = new Set([...document.querySelectorAll('#v3-taxa input:checked')].map(cb => cb.value));
    const classOk = catalog.classes.map(c => taxa.has(c));
    const mask = this.state.mask;
    return {
      taxa: s => classOk[catalog.cls[s]],
      geo: s => !mask || mask.scores[s] >= mask.threshold,
    };
  }

  /**
   * Per-species statistics over finished windows at the current settings,
   * after edits. Each species keeps its detections as window -> { p, src },
   * where src is the species the model reported (differs after a reassign).
   */
  _compute() {
    const a = this.state.analysis;
    if (!a?.scores || !catalog.count) return null;
    const S = catalog.count, theta = +$('v3-conf').value, allowed = this._allowedFn();
    const { removed, relabel } = this.edits;
    const stats = new Map(), geoHidden = new Set();
    for (let c = 0; c < a.chunks.length; c++) {
      if (!a.done[c]) continue;
      const base = c * S;
      for (let s = 0; s < S; s++) {
        const p = a.scores[base + s];
        if (p < theta || !allowed.taxa(s)) continue;
        if (!allowed.geo(s)) { geoHidden.add(s); continue; }
        const key = detKey(c, s);
        if (removed.has(key)) continue;
        const target = relabel.get(key) ?? s;
        let st = stats.get(target);
        if (!st) stats.set(target, st = { s: target, max: 0, best: c, dets: new Map(), edited: false });
        const prev = st.dets.get(c);
        if (!prev || p > prev.p) st.dets.set(c, { p, src: s });
        if (target !== s) st.edited = true;
      }
    }
    let detections = 0;
    for (const st of stats.values()) {
      st.chunks = [...st.dets.keys()].sort((x, y) => x - y);
      st.count = st.chunks.length;
      detections += st.count;
      for (const c of st.chunks) { const p = st.dets.get(c).p; if (p > st.max) { st.max = p; st.best = c; } }
    }
    const list = [...stats.values()].sort((x, y) => y.max - x.max);
    list.forEach((st, i) => { st.color = PALETTE[i % PALETTE.length]; });
    return { list, theta, detections, geoHidden: geoHidden.size };
  }

  _refresh() {
    this.derived = this._compute();
    if (this.state.selected != null && !this._stat(this.state.selected)) this.state.selected = null;
    this._renderSummary();
    this._renderList();
    this._drawTimeline();
    this.spec.render();
  }

  _select(s, { keep = false } = {}) {
    this.state.selected = !keep && this.state.selected === s ? null : s;
    this.cards?.forEach((card, cs) => {
      card.classList.toggle('is-selected', cs === this.state.selected);
      this._renderDetail(card, cs);
    });
    this._drawTimeline();
    this.spec.render();
  }

  /* ---------------- rendering ---------------- */

  _setProgress(fraction, text, indeterminate = false) {
    const wrap = $('v3-progress');
    if (fraction == null) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const bar = wrap.querySelector('.progress-bar');
    bar.style.width = `${Math.round(Math.max(0.02, fraction) * 100)}%`;
    bar.classList.toggle('progress-bar-striped', indeterminate);
    bar.classList.toggle('progress-bar-animated', indeterminate);
    $('v3-progress-text').textContent = text || '';
  }

  _renderRunButton() {
    const btn = $('v3-run');
    btn.innerHTML = this.running
      ? `<i class="bi bi-stop-fill me-1"></i>${esc(t('demo.v3.stop', 'Stop'))}`
      : `<i class="bi bi-arrow-clockwise me-1"></i>${esc(t('demo.v3.rerun', 'Analyze again'))}`;
    btn.classList.toggle('btn-outline-danger', !!this.running);
    btn.classList.toggle('btn-outline-primary', !this.running);
    // Settings re-run on their own; the button is for stopping and resuming
    btn.hidden = !this.running && !!this.state.analysis?.finished;
  }

  _renderModelChip() {
    const chip = $('v3-model-chip');
    if (!chip) return;
    let html = '';
    chip.className = 'demo-status';
    if (v3.workers) {
      html = `<i class="bi bi-cpu me-1"></i>${esc(t('demo.v3.chip.ready', 'Model ready · {n} workers', { n: v3.workers }))}`;
      chip.className = 'demo-status is-ok';
    } else if (this.running && this.modelProgress && this.modelProgress.loaded < this.modelProgress.total) {
      html = `<i class="bi bi-cloud-arrow-down me-1"></i>${esc(fmtPct(this.modelProgress.loaded / this.modelProgress.total, 0))}`;
      chip.className = 'demo-status is-busy';
    } else if (this.modelCached) {
      html = `<i class="bi bi-hdd me-1"></i>${esc(t('demo.v3.chip.cached', 'Model cached'))}`;
      chip.className = 'demo-status is-ok';
    }
    chip.innerHTML = html;
  }

  _renderSummary() {
    const a = this.state.analysis, d = this.derived, el = $('v3-summary');
    const exportable = !!(a && a.nDone && d);
    $('v3-export-csv').disabled = !exportable;
    $('v3-export-raven').disabled = !exportable;
    if (!a || !a.nDone || !d) { el.innerHTML = ''; return; }
    const stats = [
      [d.list.length, d.list.length === 1 ? t('demo.v3.sum.speciesOne', 'species') : t('demo.v3.sum.species', 'species')],
      [d.detections, d.detections === 1 ? t('demo.v3.sum.detectionOne', 'detection') : t('demo.v3.sum.detections', 'detections')],
    ];
    if (!a.finished) stats.push([fmtTime(Math.min(this.duration, a.nDone === a.chunks.length ? this.duration : a.chunks[Math.max(0, a.nDone - 1)][1] / SR)), t('demo.v3.sum.audio', 'audio')]);
    else stats.push([`${fmtNumber(a.ms / 1000, 1)} s`, t('demo.v3.sum.time', 'analysis ({speed}× real time)', { speed: fmtNumber(this.duration / (a.ms / 1000), 1) })]);
    const notes = [];
    if (this.state.mask) notes.push(`<i class="bi bi-geo-alt-fill text-success me-1"></i>${esc(d.geoHidden
      ? t('demo.v3.sum.geo', 'Location filter: {n} species not expected at this place and time are hidden.', { n: d.geoHidden })
      : t('demo.v3.sum.geoNone', 'Location filter: all detected species are expected at this place and time.'))}`);
    if (this.editCount) notes.push(`<i class="bi bi-pencil-square me-1"></i>${esc(t('demo.edit.count', 'Your changes: {n}', { n: this.editCount }))} · <button type="button" class="btn btn-link btn-sm p-0 align-baseline" data-act="reset-edits">${esc(t('demo.edit.reset', 'Reset'))}</button>`);
    if (!a.finished && !this.running) notes.push(`<i class="bi bi-pause-circle me-1"></i>${esc(t('demo.v3.sum.stopped', 'Stopped after {done} of {total} windows.', { done: a.nDone, total: a.chunks.length }))}`);
    el.innerHTML = `${statLine(stats)}${notes.map(n => `<div class="small text-muted mt-1">${n}</div>`).join('')}`;
  }

  _renderList() {
    const el = $('v3-results'), d = this.derived, a = this.state.analysis;
    if (!a || !d) { el.innerHTML = ''; return; }
    if (!d.list.length) {
      el.innerHTML = a.nDone ? `<div class="demo-empty-note"><i class="bi bi-search me-2"></i>${esc(t('demo.v3.none', 'No species above {threshold}. Lower the minimum confidence to see weaker detections.', { threshold: fmtPct(d.theta, 0) }))}</div>` : '';
      return;
    }
    let grid = el.querySelector('.v3-species-grid');
    if (!grid) {
      el.innerHTML = '<div class="v3-species-grid"></div><button type="button" class="btn btn-sm btn-light w-100 mt-2" data-more hidden></button>';
      grid = el.querySelector('.v3-species-grid');
      this.cards = new Map();
    }
    const shown = d.list.slice(0, this.state.listLimit), keep = new Set(shown.map(st => st.s));
    for (const [s, card] of this.cards) if (!keep.has(s)) { card.remove(); this.cards.delete(s); }
    shown.forEach((st, rank) => {
      const s = st.s;
      let card = this.cards.get(s);
      if (!card) {
        card = this._createCard(s);
        this.cards.set(s, card);
        requestAnimationFrame(() => card.classList.remove('is-new'));
      }
      if (grid.children[rank] !== card) grid.insertBefore(card, grid.children[rank] || null);
      card.style.setProperty('--c', st.color);
      const selected = this.state.selected === s;
      card.classList.toggle('is-selected', selected);
      card.classList.toggle('is-edited', st.edited);
      card.querySelector('.v3-name').textContent = catalog.name(s);
      card.querySelector('.v3-conf').textContent = fmtPct(st.max, 1);
      card.querySelector('.v3-count span').textContent = st.count === 1
        ? t('demo.results.detectionOne', '{count} detection', { count: 1 })
        : t('demo.results.detectionMany', '{count} detections', { count: st.count });
      const best = card.querySelector('.v3-play');
      best.dataset.c = st.best;
      best.title = t('demo.v3.playBestAt', 'Play best detection ({time})', { time: fmtTime(a.chunks[st.best][0] / SR) });
      best.setAttribute('aria-label', best.title);
      this._renderDetail(card, s);
    });
    const more = el.querySelector('[data-more]');
    more.hidden = d.list.length <= this.state.listLimit;
    more.textContent = t('demo.v3.more', 'Show {n} more species', { n: d.list.length - this.state.listLimit });
  }

  _createCard(s) {
    const cls = catalog.className(s), sci = catalog.sci[s];
    const card = document.createElement('div');
    card.className = 'v3-species is-new';
    card.dataset.species = s;
    card.innerHTML = `
      <div class="v3-species-main" role="button" tabindex="0" aria-expanded="false">
        ${thumb(s)}
        <div class="v3-text">
          <div class="v3-name-row"><span class="v3-name"></span><i class="bi bi-pencil-fill v3-edited" title="${esc(t('demo.edit.edited', 'Changed by you'))}"></i></div>
          <div class="v3-sci text-truncate"><i>${esc(sci)}</i> · ${esc(classLabel(cls))}</div>
        </div>
        <div class="v3-side">
          <div class="v3-conf"></div>
          <div class="v3-count"><span></span><i class="bi bi-chevron-down v3-chev"></i></div>
        </div>
        <button type="button" class="v3-play" data-act="play"><i class="bi bi-play-fill"></i><i class="bi bi-pause-fill"></i></button>
      </div>
      <div class="v3-detail" hidden>
        <div class="v3-info"></div>
        <div class="v3-dets"></div>
        <div class="v3-edit">
          <button type="button" class="btn btn-link btn-sm" data-act="relabel-species"><i class="bi bi-arrow-left-right me-1"></i>${esc(t('demo.edit.relabelSpecies', 'Replace species…'))}</button>
          <button type="button" class="btn btn-link btn-sm text-danger" data-act="remove-species"><i class="bi bi-trash3 me-1"></i>${esc(t('demo.edit.removeSpecies', 'Remove species'))}</button>
        </div>
      </div>`;
    card.querySelector('.v3-species-main').addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._select(s); }
    });
    return card;
  }

  /** Expanded part of a card: species info and the detection list. */
  _renderDetail(card, s, force = false) {
    const detail = card.querySelector('.v3-detail');
    card.querySelector('.v3-species-main').setAttribute('aria-expanded', String(this.state.selected === s));
    detail.hidden = this.state.selected !== s;
    if (detail.hidden) return;
    const st = this._stat(s), a = this.state.analysis;
    if (!st) return;
    if (card.dataset.infoLang !== catalog.lang) {
      card.dataset.infoLang = catalog.lang;
      this._renderInfo(card.querySelector('.v3-info'), s);
    }
    const key = `${st.count}:${st.max}:${this.derived.theta}:${this.editCount}:${card.dataset.allDets || ''}`;
    if (!force && card.dataset.detKey === key) return;
    card.dataset.detKey = key;
    const all = card.dataset.allDets === '1' || st.chunks.length <= DETECTIONS_SHOWN;
    // Best detections first; equal scores keep time order
    const byScore = st.chunks.slice().sort((x, y) => st.dets.get(y).p - st.dets.get(x).p || x - y);
    const chunks = all ? byScore : byScore.slice(0, DETECTIONS_SHOWN);
    const rows = chunks.map(c => {
      const [c0, c1] = a.chunks[c], { p, src } = st.dets.get(c);
      const moved = src !== s ? ` title="${esc(t('demo.edit.from', 'Reported as {name}', { name: catalog.name(src) }))}"` : '';
      return `<div class="v3-det${src !== s ? ' is-moved' : ''}" data-c="${c}" data-t0="${c0 / SR}" data-t1="${c1 / SR}"${moved}>
        <button type="button" class="v3-det-play" data-act="play" data-c="${c}" aria-label="${esc(t('demo.results.playSegment', 'Play segment'))}"><i class="bi bi-play-fill"></i></button>
        <span class="v3-det-time">${fmtTime(c0 / SR)}<span>–${fmtTime(c1 / SR)}</span></span>
        <span class="v3-det-bar"><i style="width:${Math.round(p * 100)}%"></i></span>
        <span class="v3-det-p">${fmtPct(p, 0)}</span>
        <span class="v3-det-actions"><button type="button" class="v3-det-act" data-act="relabel-det" data-c="${c}" title="${esc(t('demo.edit.relabelDetection', 'Change species'))}" aria-label="${esc(t('demo.edit.relabelDetection', 'Change species'))}"><i class="bi bi-arrow-left-right"></i></button>
        <button type="button" class="v3-det-act" data-act="remove-det" data-c="${c}" title="${esc(t('demo.edit.removeDetection', 'Remove detection'))}" aria-label="${esc(t('demo.edit.removeDetection', 'Remove detection'))}"><i class="bi bi-x-lg"></i></button></span>
      </div>`;
    }).join('');
    const more = all ? '' : `<button type="button" class="btn btn-link btn-sm p-0 mt-1" data-act="all-dets">${esc(t('demo.v3.allDetections', 'Show all {n} detections', { n: st.count }))}</button>`;
    card.querySelector('.v3-dets').innerHTML = `<div class="v3-det-grid">${rows}</div>${more}`;
    this._markPlaying(player.time);
  }

  async _renderInfo(el, s) {
    el.innerHTML = '';
    let info;
    try { info = await speciesInfo(s); } catch { info = null; }
    if (!el.isConnected || !info) return;
    if (info.description) {
      el.innerHTML = `<div class="v3-info-photo">${thumb(s, 'v3-info-img')}</div><div class="v3-info-text"></div>`;
      const img = el.querySelector('.v3-info-img img');
      if (img) img.src = imageUrl(catalog.sci[s], 'medium');
    } else {
      el.innerHTML = '<div class="v3-info-text"></div>';
    }
    const text = el.querySelector('.v3-info-text');
    const credit = info.photo?.author
      ? `<div class="v3-credit">${esc(t('demo.info.photo', 'Photo: {author}', { author: info.photo.author }))}${info.photo.license && !info.photo.source?.startsWith(info.photo.license.replace(/^©\s*/, '')) ? ` · ${esc(info.photo.license)}` : ''}${info.photo.source ? ` · ${esc(info.photo.source)}` : ''}</div>` : '';
    const descSource = info.descriptionSource === 'wikipedia' ? 'Wikipedia' : info.descriptionSource === 'ebird' ? 'eBird' : '';
    text.innerHTML = `
      ${info.description ? `<p class="v3-desc">${esc(info.description)}</p>${descSource ? `<div class="v3-credit">${esc(t('demo.info.text', 'Text: {source}', { source: descSource }))}</div>` : ''}` : ''}
      <div class="v3-links">${info.links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} <i class="bi bi-box-arrow-up-right"></i></a>`).join('')}</div>
      ${credit}`;
  }

  _markCardPlaying() {
    this.cards?.forEach((card, s) => card.classList.toggle('is-playing', player.playing && s === this.playingSpecies));
  }

  /** Highlight the detection row that is playing. */
  _markPlaying(time) {
    const card = this.state.selected != null && this.cards?.get(this.state.selected);
    if (!card) return;
    card.querySelectorAll('.v3-det').forEach(row => {
      row.classList.toggle('is-playing', player.playing && time >= +row.dataset.t0 && time < +row.dataset.t1);
    });
  }

  _lanes() {
    const d = this.derived;
    if (!d) return [];
    let lanes = this.state.showAllLanes ? d.list : d.list.slice(0, MAX_LANES);
    if (this.state.selected != null && !lanes.some(l => l.s === this.state.selected)) {
      const sel = this._stat(this.state.selected);
      if (sel) lanes = [...lanes, sel];
    }
    return lanes;
  }

  _drawTimeline() {
    const canvas = this.timelineCanvas, a = this.state.analysis;
    const lanes = this._lanes();
    const toggle = $('v3-lanes-toggle');
    const total = this.derived?.list.length || 0;
    toggle.hidden = total <= MAX_LANES;
    toggle.textContent = this.state.showAllLanes ? t('demo.v3.lanesFewer', 'Show top {n}', { n: MAX_LANES }) : t('demo.v3.lanesAll', 'Show all {n} species', { n: total });
    const W = canvas.parentElement.clientWidth, H = Math.max(1, lanes.length) * LANE_H + 4, dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.height = `${H}px`;
    }
    const ctx = this.tctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0a14';
    ctx.fillRect(0, 0, W, H);
    if (!a?.scores || !lanes.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = '12px Inter Variable, Inter, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(a && this.running ? t('demo.v3.timeline.waiting', 'Detections appear here as the analysis runs…') : t('demo.v3.timeline.empty', 'No detections above the threshold.'), 10, H / 2);
      return;
    }
    const theta = this.derived.theta, spec = this.spec;
    lanes.forEach((lane, i) => {
      const y = 2 + i * LANE_H, sel = this.state.selected === lane.s;
      if (sel) { ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(0, y, W, LANE_H); }
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(0, y + LANE_H - 1, W, 1);
      ctx.fillStyle = lane.color;
      for (const c of lane.chunks) {
        const p = lane.dets.get(c).p;
        const x0 = spec.timeToX(a.chunks[c][0] / SR), x1 = spec.timeToX(a.chunks[c][1] / SR);
        if (x1 < 0 || x0 > W) continue;
        ctx.globalAlpha = 0.3 + 0.7 * Math.min(1, (p - theta) / Math.max(0.01, 1 - theta));
        ctx.fillRect(x0 + 0.5, y + 3, Math.max(1.5, x1 - x0 - 1), LANE_H - 7);
      }
      ctx.globalAlpha = 1;
      const label = catalog.name(lane.s);
      ctx.font = `${sel ? 600 : 500} 11px Inter Variable, Inter, system-ui, sans-serif`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(11,10,20,0.78)';
      ctx.fillRect(4, y + 3, tw + 12, LANE_H - 7);
      ctx.fillStyle = lane.color;
      ctx.fillRect(4, y + 3, 3, LANE_H - 7);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 11, y + LANE_H / 2 - 1);
    });
    if (player.time && spec.cursor != null) {
      const x = Math.round(spec.timeToX(spec.cursor)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
  }

  _timelineHit(e) {
    const a = this.state.analysis, lanes = this._lanes();
    if (!a?.scores || !lanes.length) return null;
    const r = this.timelineCanvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const lane = lanes[Math.floor((y - 2) / LANE_H)];
    if (!lane) return null;
    const time = this.spec.xToTime(x);
    let best = null;
    for (const c of lane.chunks) {
      if (a.chunks[c][0] / SR <= time && time < a.chunks[c][1] / SR && (best == null || lane.dets.get(c).p > lane.dets.get(best).p)) best = c;
    }
    return best == null ? null : { lane, c: best, p: lane.dets.get(best).p, x, y };
  }

  _hoverTimeline(e) {
    const hit = this._timelineHit(e), tip = $('v3-timeline-tip');
    this.timelineCanvas.style.cursor = hit ? 'pointer' : 'default';
    this.hoverChunk = hit ? hit.c : null;
    this.spec.render();
    if (!hit) { tip.hidden = true; return; }
    const [c0, c1] = this.state.analysis.chunks[hit.c];
    tip.innerHTML = `<div class="tt-species">${thumb(hit.lane.s, 'tt-img', false, hit.lane.color)}<div><strong>${esc(catalog.name(hit.lane.s))}</strong> ${fmtPct(hit.p, 1)}<div class="tt-time">${fmtTime(c0 / SR, 1)} – ${fmtTime(c1 / SR, 1)}</div></div></div>`;
    tip.hidden = false;
    tip.style.left = `${Math.min(hit.x + 12, this.timelineCanvas.clientWidth - tip.offsetWidth - 4)}px`;
    tip.style.top = `${Math.max(0, hit.y - tip.offsetHeight - 6)}px`;
  }

  _clickTimeline(e) {
    const hit = this._timelineHit(e);
    if (!hit) return;
    const [c0, c1] = this.state.analysis.chunks[hit.c];
    this._select(hit.lane.s, { keep: true });
    this.playingSpecies = hit.lane.s;
    player.play(c0 / SR, c1 / SR);
  }

  _hoverSpec(detail) {
    const a = this.state.analysis, d = this.derived;
    if (!detail || !a?.scores || !d) { this.spec.showTooltip(null); this.hoverChunk = null; return; }
    const ids = [];
    for (let c = 0; c < a.chunks.length; c++) if (a.done[c] && a.chunks[c][0] / SR <= detail.time && detail.time < a.chunks[c][1] / SR) ids.push(c);
    if (!ids.length) { this.spec.showTooltip(null); return; }
    const c = ids[ids.length - 1];
    const top = d.list.filter(st => st.dets.has(c)).map(st => [st, st.dets.get(c).p]).sort((x, y) => y[1] - x[1]).slice(0, 4);
    const [c0, c1] = a.chunks[c];
    const rows = top.map(([st, p]) => `<div class="tt-species">${thumb(st.s, 'tt-img', false, st.color)}<span>${esc(catalog.name(st.s))} <b>${fmtPct(p, 0)}</b></span></div>`).join('');
    this.spec.showTooltip(`<div class="tt-time">${fmtTime(c0 / SR, 1)} – ${fmtTime(c1 / SR, 1)}</div>${rows || `<div class="text-white-50">${esc(t('demo.v3.tt.none', 'Nothing above threshold'))}</div>`}`, detail.x, detail.y);
  }

  _drawOverlay(ctx, h) {
    const a = this.state.analysis;
    if (!a) return;
    // Dim windows that are not analyzed yet
    if (!a.finished) {
      ctx.fillStyle = this.spec.light ? 'rgba(255,255,255,0.6)' : 'rgba(5,4,12,0.55)';
      for (let c = 0; c < a.chunks.length; c++) {
        if (a.done[c]) continue;
        const next = a.chunks[c + 1]?.[0] ?? a.chunks[c][1];
        const x0 = h.timeToX(a.chunks[c][0] / SR), x1 = h.timeToX(next / SR);
        if (x1 >= 0 && x0 <= h.width) ctx.fillRect(x0, 0, x1 - x0 + 0.5, h.height);
      }
    }
    if (!a.scores) return;
    if (this.hoverChunk != null) {
      const [c0, c1] = a.chunks[this.hoverChunk];
      ctx.fillStyle = this.spec.light ? 'rgba(15,23,42,0.08)' : 'rgba(255,255,255,0.10)';
      ctx.fillRect(h.timeToX(c0 / SR), 0, h.timeToX(c1 / SR) - h.timeToX(c0 / SR), h.height);
    }
    const st = this.state.selected != null && this._stat(this.state.selected);
    if (!st) return;
    ctx.strokeStyle = st.color;
    ctx.lineWidth = 2;
    ctx.font = '600 11px Inter Variable, Inter, system-ui, sans-serif';
    for (const c of st.chunks) {
      const x0 = h.timeToX(a.chunks[c][0] / SR), x1 = h.timeToX(a.chunks[c][1] / SR);
      if (x1 < 0 || x0 > h.width) continue;
      ctx.strokeRect(x0 + 1, 1, x1 - x0 - 2, h.height - 2);
      const label = fmtPct(st.dets.get(c).p, 0);
      if (x1 - x0 > 34) {
        ctx.fillStyle = st.color;
        ctx.fillRect(x0 + 1, 1, ctx.measureText(label).width + 10, 16);
        ctx.fillStyle = '#0b0a14';
        ctx.fillText(label, x0 + 6, 13);
      }
    }
  }

  _drawMinimapOverlay(ctx, h) {
    const a = this.state.analysis, st = this.state.selected != null && this._stat(this.state.selected);
    if (!a?.scores || !st) return;
    ctx.fillStyle = st.color;
    for (const c of st.chunks) {
      const x0 = h.timeToX(a.chunks[c][0] / SR), x1 = h.timeToX(a.chunks[c][1] / SR);
      ctx.fillRect(x0, h.height - 4, Math.max(1, x1 - x0), 4);
    }
  }

  /* ---------------- export ---------------- */

  /** Detections after filters and edits: per window, highest confidence first. */
  _rows() {
    const a = this.state.analysis, d = this.derived;
    if (!a?.scores || !d) return [];
    const rows = [];
    for (const st of d.list) for (const c of st.chunks) rows.push({ c, s: st.s, p: st.dets.get(c).p, start: a.chunks[c][0] / SR, end: a.chunks[c][1] / SR });
    return rows.sort((x, y) => x.c - y.c || y.p - x.p);
  }

  _baseName() {
    return (shared.audio?.name || 'audio').replace(/\.[^.]+$/, '');
  }

  /** Columns and number formatting of the V3.0 command-line analyzer. */
  _exportCsv() {
    const name = shared.audio?.name || 'audio';
    const lines = ['name,start_sec,end_sec,confidence,label'];
    for (const r of this._rows()) {
      lines.push([csvField(name), pyRound(r.start, 3), pyRound(r.end, 3), pyRound(r.p, 6), csvField(`${catalog.sci[r.s]}_${catalog.en[r.s]}`)].join(','));
    }
    downloadFile(`${this._baseName()}.BirdNET_V3.results.csv`, `${lines.join('\n')}\n`, 'text/csv;charset=utf-8');
  }

  _exportRaven() {
    const lines = [['Selection', 'View', 'Channel', 'Begin Time (s)', 'End Time (s)', 'Low Freq (Hz)', 'High Freq (Hz)', 'Common Name', 'Scientific Name', 'Confidence'].join('\t')];
    this._rows().forEach((r, i) => {
      lines.push([i + 1, 'Spectrogram 1', 1, r.start.toFixed(3), r.end.toFixed(3), 0, 16000, catalog.name(r.s), catalog.sci[r.s], r.p.toFixed(4)].join('\t'));
    });
    downloadFile(`${this._baseName()}.BirdNET_V3.selections.txt`, `${lines.join('\n')}\n`);
  }
}
