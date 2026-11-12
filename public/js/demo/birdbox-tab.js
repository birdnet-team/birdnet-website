/**
 * BirdBox tab: bird vocalization bounding boxes with the BirdBox Just-Bird
 * model (its spectrogram, YOLO and NMS run inside the ONNX graphs).
 *
 * The model runs as a stream at the lowest confidence and reports the boxes
 * of its 3 s windows one window at a time, so boxes appear while detection
 * runs; in a file they show evenly spaced (birdbox-pacer.js). birdbox-fusion.js
 * merges them exactly like the model's window fusion for any (confidence,
 * phrase gap) setting, so both sliders update instantly. The boxes export as
 * Xeno-canto Annota-JSON.
 *
 * BirdNET V3.0 suggests a species for every box. It scores the same 3 s
 * windows alongside the detection, so a box's species is usually there when
 * the box appears, and a box that changes needs no new scoring.
 *
 * While this tab's card records, the spectrogram flies in from the right and
 * each window is detected once, as soon as it is complete. The model takes a
 * window's noise floor from the audio before the window's end, so these
 * boxes are final: when the recording ends, only the last windows are left,
 * and the result is that of the saved file.
 *
 * On the spectrogram, the selected box can be moved and resized and new
 * boxes can be drawn; changed and new boxes get fresh species suggestions.
 */
import { AudioSource, losslessView, parseXcNumber } from './audio-source.js';
import { fuseBoxes } from './birdbox-fusion.js';
import { Pacer } from './birdbox-pacer.js';
import { birdbox } from './birdbox-service.js';
import { analyzedTo as analyzedAfter, fileEnd, readyWindows, windowCount } from './birdbox-stream.js';
import { csvField, downloadFile, esc, fmtBytes, fmtNumber, fmtPct, fmtTime, shared, statLine, t, throttle, toast } from './core.js';
import { activeMask, LocationFilter } from './location-filter.js';
import { getManifest, isCached } from './model-store.js';
import { player } from './player.js';
import { isoTime, RAVEN_CLOCK, ravenClock } from './recording-time.js';
import { SpecView } from './spec-view.js';
import { pickSpecies } from './picker.js';
import { catalog } from './species.js';
import { SR, v3 } from './v3-service.js';
import { stopSpectrogram, streamSpectrogram, thumb } from './v3-tab.js';

const CLIP = 3, HOP = 1.5;    // the model's windows: seconds long, seconds apart
const MIN_SCORE = 0.05;       // BirdNET V3.0 scores below this are not kept
const SETTLED = 1.5;          // a box this far (plus the phrase gap) behind the detection line no longer changes, unless linked to one that may
const SCORES_MS = 120;        // show new species at most this often
const RETRY_MS = 10000;       // after BirdNET V3.0 failed, wait this long before trying again
const LIVE_MAX_WINDOWS = 8;   // windows per run when detection has fallen behind a recording
const LIVE_BEHIND = 6;        // seconds behind the sound at which the hint says so
const LIVE_EDGE = 0.13;       // seconds the right edge stays behind the microphone, for the last frames
const POP_MS = 420;           // a new box pops in over this time
const SOUND_TYPES = ['song', 'call', 'alarm call', 'flight call', 'begging call', 'dawn song', 'subsong', 'drumming', 'duet'];
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

/** Xeno-canto contributor ID from the ID itself or a xeno-canto.org/contributor/… link. */
const xcContributor = v => v.trim().replace(/^.*\/contributor\//i, '').replace(/[/?#].*$/, '');

/** Detector boxes keep their identity through slider changes by their geometry. */
const boxKey = b => `${b.t0.toFixed(4)}|${b.t1.toFixed(4)}|${b.flo}|${b.fhi}`;

const geomOf = g => ({ t0: g.t0, t1: g.t1, flo: g.flo, fhi: g.fhi });
const concat = (a, b) => {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

export class BirdBoxTab {
  constructor() {
    this.visible = false;
    this.pendingRun = false;
    this.raw = null;               // { data, rows, ms, next, done }: the windows' boxes of the recording, so far
    this.analyzedTo = null;        // seconds analyzed while detection runs, else null
    this.rec = null;               // the recording in progress
    this.liveEnded = null;         // it ended, and its file is on the way
    this.liveIdle = null;          // settles when no live detection is using the worker any more
    this.born = new Map();         // box id -> when it appeared while recording
    this.tableHeld = false;        // a press on the list: redrawing it now would lose the click
    this.songs = [];               // detector boxes at the current sliders
    this.fusion = {};              // fuseBoxes' cache: the boxes later windows cannot change
    this.userBoxes = [];           // boxes drawn by the user
    this.boxes = [];               // both, ordered by start time
    this.scores = new Map();       // window -> [[species, score], ...]: the birds BirdNET V3.0 hears in it
    this.scoring = new Set();      // windows on their way
    this.wanted = new Set();       // windows the boxes lie in that are not scored yet
    this.ahead = 0;                // next window to score ahead of the detection
    this.candidates = new Map();   // 'first-last' window -> [{ s, p }]: the species of a box in these windows
    this.mask = undefined;         // location filter for the candidates, null when off; undefined: not fetched yet
    this.maskVersion = 0;
    this.retryAt = 0;
    this.edits = new Map();        // box id -> { species?, soundType?, include?, geom? }
    this.selectedId = null;
    this.hoverId = null;
    this.drawMode = false;
    this.gesture = null;           // move, resize or draw in progress
    this.live = null;              // { id, g }: geometry while dragging
    this.draft = null;             // box being drawn
    this.userSeq = 0;
    this.runToken = 0;
    this.scoreToken = 0;           // invalidates scores still on their way after the audio changes
    this.scoresChanged = throttle(() => {
      this._renderSummary();
      this._renderTable();
      this.spec.render();
      if (!$('bb-xc-check').hidden) this._checkXc();
    }, SCORES_MS);
  }

  init() {
    this.source = new AudioSource($('bb-source'), { live: true });
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
    // Size the detection list to fit under the viewer (see .demo-table-wrap in demo.css)
    const wrap = $('bb-table-wrap'), viewer = wrap.closest('.demo-pane').querySelector('.demo-viewer');
    const fit = new ResizeObserver(() => wrap.style.setProperty('--bb-list-offset', `${wrap.getBoundingClientRect().top - viewer.getBoundingClientRect().top}px`));
    [viewer, wrap.parentElement].forEach(el => fit.observe(el));
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
    this._usePlayer();
    this.spec._resize();
    if (this.specPending) this._startSpec();
    if (this.pendingRun) this.run(true);
  }

  hide() {
    this.visible = false;
    // The other tabs play the browser's recording
    const a = shared.audio;
    if (a?.lossless && player.audio.src !== a.url) player.setSource(a.url);
  }

  /** The audio of this tab: its own recordings as their WAV, whose times the boxes have. */
  _audio() { return losslessView(shared.audio); }

  /** While this tab is shown, the player plays that audio. */
  _usePlayer() {
    const url = this._audio()?.url;
    if (this.visible && url && player.audio.src !== url) player.setSource(url);
  }

  _soundLabel(s) { return t(`demo.bb.sound.${s.replace(/ /g, '_')}`, s); }

  /** Recording, or waiting for the recording's file: nothing to play or edit yet. */
  get recording() { return !!(this.rec || this.liveEnded); }

  _bind() {
    shared.addEventListener('audio', () => this._onAudio());
    this.source.addEventListener('livestart', e => this._liveStart(e.detail));
    this.source.addEventListener('liveaudio', e => this._liveAudio(e.detail.pcm));
    this.source.addEventListener('liveend', () => this._liveEnd());
    this.source.addEventListener('livecancel', () => this._liveCancel());
    // Leaving the page would lose a recording in progress
    window.addEventListener('beforeunload', e => { if (this.rec) e.preventDefault(); });
    const conf = $('bb-conf'), gap = $('bb-gap');
    const sync = () => {
      $('bb-conf-val').textContent = fmtNumber(+conf.value, 2);
      $('bb-gap-val').textContent = +gap.value > 0 ? `${fmtNumber(+gap.value, 2)} s` : t('demo.bb.gapOff', 'off');
    };
    sync();
    $('bb-stop').addEventListener('click', () => this._stop());
    $('bb-continue').addEventListener('click', () => this.run(true));
    conf.addEventListener('input', () => { sync(); this._update(); });
    gap.addEventListener('input', () => { sync(); this._update(); });
    $('bb-suggest').addEventListener('change', () => this._update());
    // Another place or date: the scores stay, and the species are picked from them again
    this.location.addEventListener('change', () => {
      this.maskVersion++;
      this.mask = undefined;
      this.candidates.clear();
      this._update();
    });
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
    this.spec.addEventListener('toggleplay', () => { if (!this.recording) player.toggle(); });
    this.spec.addEventListener('pick', e => {
      if (this.recording) return;
      const { time, freq } = e.detail;
      const hit = freq != null ? this._boxAt(time, freq) : null;
      if (hit) { this._select(hit.id, { play: true, scroll: 'list' }); return; }
      if (this.selectedId != null) this._select(null);
      player.play(time);
    });
    this.spec.addEventListener('hover', e => {
      const d = e.detail;
      const b = d && d.freq != null && !this.gesture && !this.drawMode ? this._boxAt(d.time, d.freq) : null;
      this._setHover(b?.id ?? null);
      if (!b) { this.spec.showTooltip(null); return; }
      const g = this._geom(b), sp = this._species(b), n = this.boxes.indexOf(b) + 1;
      const origin = b.manual
        ? `<div>${esc(t('demo.bb.drawn', 'Drawn by you'))}</div>`
        : `<div>${esc(t('demo.bb.boxConf', 'Box confidence'))} <b>${fmtNumber(b.avg, 2)}</b>${this._edit(b).verified ? ` · ${esc(t('demo.bb.verified', 'Verified by you'))}` : ''}</div>`;
      this.spec.showTooltip(`<div class="tt-time">#${n} · ${fmtTime(g.t0, 2)} – ${fmtTime(g.t1, 2)}</div><div>${fmtNumber(g.flo)}–${fmtNumber(g.fhi)} Hz</div>${origin}${sp.s !== AVES ? `<div class="tt-species mt-1">${thumb(sp.s, 'tt-img')}<span>${esc(catalog.name(sp.s))}${sp.p != null ? ` <b>${fmtPct(sp.p, 0)}</b>` : ''}</span></div>` : ''}`, d.x, d.y);
    });
    // Editing keys work anywhere on the tab except while typing in a field or a dialog
    document.addEventListener('keydown', e => {
      if (!this.visible || !this.raw || this.recording || e.ctrlKey || e.metaKey || e.altKey) return;
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
    // Hovering a row highlights its box, as hovering a box highlights its row
    table.addEventListener('mouseover', e => {
      const tr = e.target.closest('tr[data-i]');
      this._setHover(tr ? this.boxes[+tr.dataset.i]?.id ?? null : null);
    });
    table.addEventListener('mouseleave', () => this._setHover(null));
    table.addEventListener('pointerdown', () => { this.tableHeld = true; });
    for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, () => { this.tableHeld = false; });
    table.addEventListener('click', e => {
      const tr = e.target.closest('tr[data-i]');
      const b = tr ? this.boxes[+tr.dataset.i] : null;
      if (!b || this.recording) return;
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
          suggestions: this._candidates(this._geom(b)) || [],
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
    if (this.rec) {
      const behind = Math.floor(this.rec.n / SR - (this.analyzedTo ?? 0) - CLIP);
      text = this.raw && behind >= LIVE_BEHIND
        ? t('demo.bb.hint.liveBehind', 'This device is {n} s behind the sound. Nothing is lost: the rest is detected when you stop.', { n: behind })
        : t('demo.bb.hint.live', 'The line shows how far detection has come. Dashed boxes may still change; solid ones are final, the same as in the saved recording.');
    } else if (this.liveEnded) text = t('demo.bb.hint.liveEnd', 'Finishing the recording…');
    else if (!this.raw) text = t('demo.bb.hint.wait', 'Boxes appear here while detection runs.');
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
    if (birdbox.loaded) { chip.className = 'demo-status is-ok'; chip.innerHTML = `<i class="bi bi-cpu me-1"></i>${esc(t('demo.bb.chip.ready', 'Model ready'))}`; }
    else if (this.modelCached) { chip.className = 'demo-status is-ok'; chip.innerHTML = `<i class="bi bi-hdd me-1"></i>${esc(t('demo.v3.chip.cached', 'Model cached'))}`; }
    else { chip.className = 'demo-status'; chip.innerHTML = ''; }
  }

  _setProgress(fraction, text, indeterminate = false) {
    const wrap = $('bb-progress');
    if (fraction == null) { wrap.hidden = true; return; }
    wrap.hidden = false;
    $('bb-stop').hidden = this.recording;   // a recording stops with its own button
    $('bb-continue').hidden = true;
    const bar = wrap.querySelector('.progress-bar');
    bar.style.width = `${Math.round(Math.max(0.02, Math.min(1, fraction)) * 100)}%`;
    bar.classList.toggle('progress-bar-striped', indeterminate);
    bar.classList.toggle('progress-bar-animated', indeterminate);
    $('bb-progress-text').textContent = text || '';
  }

  /** Progress of the model download, the first third of the bar. */
  _modelProgress(p) {
    this._setProgress(p.loaded / p.total * 0.3, p.cached
      ? t('demo.bb.status.cached', 'Loading BirdBox from your browser cache…')
      : t('demo.bb.status.downloading', 'Downloading BirdBox model: {done} of {total}', { done: fmtBytes(p.loaded), total: fmtBytes(p.total) }));
  }

  /** Stop a file's detection, as in the BirdBox docs demo. */
  _stop() {
    this.runToken++;
    this.pacer?.stop();   // the windows held back are dropped: Continue starts after the last one shown
    birdbox.abort();
    this._showStopped();
  }

  /**
   * The boxes found so far stay, with their species, and CSV and Raven exports cover
   * them. Continue picks detection up after the last window, with the same result as
   * a run without a stop.
   */
  _showStopped() {
    if (this.raw) this.raw.stopped = true;
    else this.analyzedTo = null;
    const total = windowCount(this.pcm.length), n = this.raw?.next ?? 0;
    this._setProgress(n ? 0.3 + 0.7 * n / total : 0.01, n
      ? t('demo.bb.status.stopped', 'Stopped at clip {n} of {total}', { n, total })
      : t('demo.bb.status.stoppedEarly', 'Detection stopped'));
    $('bb-stop').hidden = true;
    $('bb-continue').hidden = false;
    this._update();
  }

  /* ---------------- recording in progress ---------------- */

  /**
   * The microphone of this tab's card is on. What was loaded steps aside: it
   * comes back as it was if the recording is cancelled.
   */
  _liveStart({ maxSeconds }) {
    this.runToken++;
    birdbox.abort();
    stopSpectrogram(this.spec);
    const prev = shared.audio ? { raw: this.raw, analyzedTo: this.analyzedTo, userBoxes: this.userBoxes, edits: this.edits, selectedId: this.selectedId, scores: this.scores } : null;
    const rec = this.rec = {
      maxSeconds, prev, pcm: new Float32Array((maxSeconds + 1) * SR), n: 0, arrivedAt: 0,
      data: new Float32Array(0), rows: 0, ms: 0, next: 0,   // its boxes so far, and the windows they come from
      ended: false, wake: null, specWorker: null, loop: null,
    };
    this._resetScores();   // scores still on their way belong to the audio that steps aside
    Object.assign(this, {
      pcm: rec.pcm, duration: 0, raw: null, analyzedTo: 0, songs: [], userBoxes: [], edits: new Map(),
      selectedId: null, hoverId: null, liveEnded: null, pendingRun: false, specPending: false,
    });
    this.born.clear();
    this._setDrawMode(false);
    this._setProgress(null);
    $('bb-error').hidden = true;
    $('bb-suggest-status').textContent = '';
    $('bb-howto').hidden = true;
    $('bb-workspace').hidden = false;
    $('pane-birdbox').classList.add('is-recording');
    this.spec.clear();
    const worker = rec.specWorker = new Worker(new URL('./spec-worker.js', import.meta.url));
    worker.onmessage = ({ data }) => {
      if (this.rec !== rec) return;
      if (data.type === 'meta') this.spec.startLive({ rows: data.rows, fps: data.fps, floor: data.floor || 0, capacity: maxSeconds + 1, clock: () => this._liveClock(rec) });
      else if (data.type === 'live-frames') this.spec.addFrames(data.start, data.data);
      else if (data.type === 'error') console.error('spectrogram:', data.error);
    };
    worker.postMessage({ type: 'live-start', id: 1, sampleRate: SR, fMax: FREQ_MAX });
    this._update();
    rec.loop = this._liveLoop(rec);
  }

  /** Seconds to show at the right edge: smooth between the pieces of audio, which arrive in bursts. */
  _liveClock(rec) {
    if (!rec.n) return 0;
    return Math.max(0, rec.n / SR + Math.min(performance.now() - rec.arrivedAt, 120) / 1000 - LIVE_EDGE);
  }

  _liveAudio(pcm) {
    const rec = this.rec;
    if (!rec || rec.ended) return;
    rec.pcm.set(pcm.subarray(0, rec.pcm.length - rec.n), rec.n);
    rec.n = Math.min(rec.pcm.length, rec.n + pcm.length);
    rec.arrivedAt = performance.now();
    this.duration = rec.n / SR;
    rec.specWorker.postMessage({ type: 'live-audio', pcm }, [pcm.buffer]);
    rec.wake?.();
    this._pumpScores();   // a window may be complete now
  }

  /**
   * The worker keeps the recording's spectrogram and adds frames for new audio only.
   * Each window is run once, as soon as the audio reaches its end, and its rows are
   * final: the rows of the saved file. A run takes every window that has become ready
   * meanwhile (up to LIVE_MAX_WINDOWS), so a slower device falls behind by a run, not
   * more. When the recording ends, the file's run continues after the last window done.
   */
  async _liveLoop(rec) {
    try {
      await birdbox.ensure(p => { if (this.rec === rec) this._modelProgress(p); });
      if (this.rec === rec) {
        this._setProgress(null);
        this.modelCached = true;
        this._renderChip();
      }
      if (rec.ended) return;
      birdbox.liveStart();
      let sent = 0;   // samples the worker has
      while (!rec.ended) {
        if (rec.n > sent) {
          birdbox.liveAudio(rec.pcm.subarray(sent, rec.n));
          sent = rec.n;
        }
        const ready = readyWindows(sent);
        if (ready <= rec.next) {
          await new Promise(resolve => { rec.wake = resolve; });
          continue;
        }
        const res = await birdbox.liveWindows(rec.next, Math.min(ready - rec.next, LIVE_MAX_WINDOWS));
        if (rec.ended) return;
        rec.data = concat(rec.data, res.data);
        rec.rows += res.rows;
        rec.ms += res.ms;
        rec.next = res.next;
        this.analyzedTo = analyzedAfter(rec.next);
        this.raw = { data: rec.data, rows: rec.rows, ms: rec.ms, next: rec.next, done: false };
        this._liveUpdate();
      }
    } catch (err) {
      if (err.cancelled || rec.ended) return;
      console.error(err);
      $('bb-error').hidden = false;
      $('bb-error').textContent = t('demo.bb.liveError', 'Boxes stopped appearing: {message}. The recording goes on, and its boxes are detected when you stop.', { message: err.message });
    }
  }

  /** New boxes, marked so they pop in. A box that only grew does not. The list stays at its end. */
  _liveUpdate() {
    if (this.tableHeld) return;
    const wrap = $('bb-table-wrap'), atEnd = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 8;
    const before = this.songs, now = performance.now();
    this._update();
    for (const b of this.songs) {
      if (before.some(o => o.t0 < b.t1 && b.t0 < o.t1 && o.flo < b.fhi && b.flo < o.fhi)) continue;
      this.born.set(b.id, now);
    }
    if (atEnd) wrap.scrollTop = wrap.scrollHeight;
  }

  /** Stop was pressed: the file is on its way. What is on screen stays until then. */
  _liveEnd() {
    const rec = this.rec;
    if (!rec) return;
    this._liveClose(rec);
    this.liveEnded = rec;
    this._renderHint();
  }

  _liveClose(rec) {
    rec.ended = true;
    rec.wake?.();
    rec.specWorker.terminate();
    this.liveIdle = rec.loop;
    this.rec = null;
    this.spec.stopLive();
    $('pane-birdbox').classList.remove('is-recording');
    this._setProgress(null);
  }

  /** Cancelled, or no file came of it: back to the audio that was there, as it was. */
  _liveCancel() {
    const rec = this.rec || this.liveEnded;
    if (!rec) return;
    if (this.rec) this._liveClose(rec);
    this.liveEnded = null;
    this._resetScores();
    this.born.clear();
    $('bb-error').hidden = true;
    $('bb-suggest-status').textContent = '';
    const { prev } = rec, audio = shared.audio, exact = audio?.lossless ?? audio;
    Object.assign(this, {
      pcm: exact?.pcm ?? null, duration: exact?.duration ?? 0, songs: [], hoverId: null,
      raw: prev?.raw ?? null, analyzedTo: prev?.analyzedTo ?? null, userBoxes: prev?.userBoxes ?? [], edits: prev?.edits ?? new Map(),
      scores: prev?.scores ?? this.scores, selectedId: prev?.selectedId ?? null,
    });
    this.spec.clear();
    $('bb-howto').hidden = !!audio;
    $('bb-workspace').hidden = !audio;
    if (!audio) { this._update(); return; }
    this._showTooShort();
    this.specPending = true;
    if (this.visible) this._startSpec();
    this.spec.setCursor(0);
    this._update();
    // A detection the recording interrupted goes on where it was, unless it was stopped
    if (this.raw?.done) return;
    if (this.raw?.stopped) { this._showStopped(); return; }
    if (this.visible) this.run(true); else this.pendingRun = true;
  }

  /**
   * The boxes found while recording, as a run stopped after their windows, if the file
   * holds the samples they were found on. It does by construction (Recorder): this makes sure.
   */
  _finalSoFar(rec, pcm) {
    if (!rec.next || pcm.length !== rec.n) return null;
    for (let i = 0; i < pcm.length; i++) if (pcm[i] !== rec.pcm[i]) return null;
    const end = fileEnd(pcm.length);
    for (let r = 0; r < rec.rows; r++) rec.data[r * 9 + 8] = end;
    return { data: rec.data, rows: rec.rows, ms: rec.ms, next: rec.next, done: false };
  }

  _showTooShort() {
    const short = this.pcm.length < CLIP * SR;
    $('bb-error').hidden = !short;
    if (short) $('bb-error').textContent = t('demo.bb.tooShort', 'BirdBox needs at least 3 seconds of audio.');
  }

  _onAudio() {
    // A recording of this tab comes with its WAV (lossless); the other tabs analyze the browser's recording
    const audio = shared.audio, exact = audio?.lossless ?? audio;
    // Audio from another tab while this one records: the recording gives way
    if (this.rec) {
      this._liveClose(this.rec);
      this.source.cancelRecording();
    }
    const ended = this.liveEnded;
    this.liveEnded = null;
    this.runToken++;
    // A live detection still running ends by itself in a moment, and the worker stays warm
    if (!ended) birdbox.abort();
    // The boxes of a recording hold for its file, and so does what BirdNET V3.0 heard
    this.raw = ended && audio ? this._finalSoFar(ended, exact.pcm) : null;
    this.analyzedTo = this.raw ? analyzedAfter(this.raw.next) : null;
    this.songs = [];
    this.userBoxes = [];
    if (!this.raw) this._resetScores();
    this.candidates.clear();   // the last windows of a file are not those of a recording in progress
    this.edits = new Map();
    this.selectedId = null;
    this.hoverId = null;
    this.born.clear();
    this._setDrawMode(false);
    this._setProgress(null);
    $('bb-howto').hidden = !!audio;
    $('bb-workspace').hidden = !audio;
    if (!audio) return;
    this.pcm = exact.pcm;
    this.duration = exact.duration;
    this._usePlayer();
    // A file named like XC1059662.wav is most likely that recording; the field stays editable
    const m = audio.name.match(/(?:^|[^A-Za-z0-9])XC[_-]?(\d+)/i);
    const nr = audio.xc || m?.[1];
    $('bb-xcnr').value = nr ? `XC${nr}` : '';
    $('bb-complete').value = '';
    $('bb-xc').querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));
    $('bb-xc-check').hidden = true;
    this._showTooShort();
    if (this.raw) {
      // The live picture stays until the finished spectrogram replaces it, and the view opens up to the whole recording
      this.spec.duration = this.duration;
      this.specPending = false;
      streamSpectrogram(this.spec, this.pcm, 'stft', this.duration, { swap: true });
      this.spec.animateView(0, this.duration);
    } else {
      this.spec.clear();
      this.specPending = true;
      if (this.visible) this._startSpec();
    }
    this.spec.setCursor(0);
    this._update();
    if (this.visible) this.run(true); else this.pendingRun = true;
  }

  /** Detect over the recording, or go on after the windows there are boxes for already (resume). */
  async run(resume = false) {
    if (!this.pcm || this.pcm.length < CLIP * SR || this.recording) return;
    this.pendingRun = false;
    const token = ++this.runToken;
    const total = windowCount(this.pcm.length);
    const from = resume && this.raw && !this.raw.done ? this.raw.next : 0;
    if (from) this.raw.stopped = false;
    else {
      this.raw = null;
      this.analyzedTo = 0;
    }
    this._update();
    const progress = done => {
      const ms = this.raw?.ms || 0, left = done ? (total - done) * ms / done / 1000 : 0;
      let text = t('demo.bb.status.detecting', 'Detecting vocalizations · clip {n} of {total}', { n: Math.max(1, done), total });
      // As in the V3.0 tab: seconds of audio detected per second of detection
      if (done && ms > 0) text += ` · ${t('demo.bb.status.speed', '{speed}× real time', { speed: fmtNumber(Math.min(this.duration, (done - 1) * HOP + CLIP) / (ms / 1000), 1) })}`;
      if (left > 20) text += ` · ${t('demo.bb.status.left', 'about {time} left', { time: fmtTime(Math.ceil(left / 10) * 10) })}`;
      this._setProgress(0.3 + 0.7 * done / total, text);
    };
    try {
      if (from) progress(from);
      else this._setProgress(0.01, t('demo.bb.status.preparing', 'Preparing BirdBox…'));
      await this.liveIdle;   // a live detection that was still running needs the worker first
      if (token !== this.runToken) return;
      await birdbox.ensure(p => { if (token === this.runToken && !from) this._modelProgress(p); });
      this.modelCached = true;
      this._renderChip();
      if (token !== this.runToken) return;
      // Detection time of the whole recording: a continued run adds to the time so far
      const t0 = performance.now() - (from ? this.raw.ms : 0);
      let data = from ? this.raw.data : new Float32Array(0), rows = from ? this.raw.rows : 0;
      progress(from);
      this.pacer?.stop();
      const pacer = this.pacer = new Pacer(item => {
        if (token !== this.runToken) { pacer.stop(); return; }
        this.analyzedTo = item.analyzedTo;
        this.raw = { ...item, done: false };
        progress(item.next);
        // Not in the middle of a drag or a click on the list, which a redraw would disturb
        if (!this.gesture && !this.tableHeld) this._update();
      });
      // The worker asks for the audio a block at a time: no copy of the whole recording
      await birdbox.detect(this.pcm, chunk => {
        if (token !== this.runToken) return;
        data = concat(data, chunk.data);
        rows += chunk.rows;
        pacer.push({ data, rows, ms: performance.now() - t0, next: chunk.next, analyzedTo: chunk.analyzedTo });
      }, from);
      const ms = performance.now() - t0;   // the detection's time, without the windows held back
      await pacer.finish();
      if (token !== this.runToken) return;
      this.raw = { data, rows, ms, next: total, done: true };
      this._renderChip();
    } catch (err) {
      if (token !== this.runToken || err.cancelled) return;
      console.error(err);
      $('bb-error').hidden = false;
      $('bb-error').textContent = t('demo.bb.error', 'BirdBox failed: {message}', { message: err.message });
    } finally {
      if (token === this.runToken) {
        this.analyzedTo = null;
        this._setProgress(null);
        this._update();
      }
    }
  }

  /* ---------------- boxes + edits ---------------- */

  _update() {
    const conf = +$('bb-conf').value, gap = +$('bb-gap').value, raw = this.raw;
    // Rows still to come start with the next window: the boxes before them are fused once
    this.songs = raw ? fuseBoxes(raw.data, raw.rows, conf, gap, this.fusion, raw.done ? Infinity : raw.next * HOP) : [];
    for (const b of this.songs) b.id ??= boxKey(b);
    this._markPending();
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
    this.wanted.clear();
    if ($('bb-suggest').checked) {
      for (const b of this.boxes) {
        const [first, last] = this._windowsOf(this._geom(b));
        for (let k = first; k <= last; k++) if (!this.scores.has(k)) this.wanted.add(k);
      }
    }
    this._pumpScores();
  }

  /* ---------------- species: BirdNET V3.0 on the same windows ---------------- */

  /**
   * The windows a box lies in, [first, last]. BirdNET V3.0 scores the 3 s windows
   * BirdBox detects on, one every 1.5 s. A window owns its middle half, as in the
   * window fusion, so a box up to 1.5 s long takes the window that owns its centre:
   * the one BirdBox found it in. A longer box takes the windows from the one around
   * its first 1.5 s to the one around its last, which cover it.
   */
  _windowsOf(g) {
    const end = this.recording ? Infinity : windowCount(this.pcm.length) - 1;
    const owner = time => clamp(Math.floor((time - CLIP / 4) / HOP), 0, end);
    if (g.t1 - g.t0 <= HOP) {
      const k = owner((g.t0 + g.t1) / 2);
      return [k, k];
    }
    return [owner(g.t0 + HOP / 2), owner(g.t1 - HOP / 2)];
  }

  /**
   * Up to five species for a box, best first: each species' highest score in the box's
   * windows, within the location filter. null while a window is still to be scored.
   */
  _candidates(g) {
    const [first, last] = this._windowsOf(g), key = `${first}-${last}`;
    let cands = this.candidates.get(key);
    if (cands || this.mask === undefined) return cands || null;
    const best = new Map(), mask = this.mask;
    for (let k = first; k <= last; k++) {
      const birds = this.scores.get(k);
      if (!birds) return null;
      for (const [s, p] of birds) if (!(best.get(s) >= p)) best.set(s, p);
    }
    cands = [...best].filter(([s]) => !mask || mask.scores[s] >= mask.threshold).map(([s, p]) => ({ s, p })).sort((a, b) => b.p - a.p).slice(0, 5);
    this.candidates.set(key, cands);
    return cands;
  }

  /** Other audio: forget what BirdNET V3.0 heard, and ignore the windows still on their way. */
  _resetScores() {
    this.scoreToken++;
    this.scores = new Map();
    this.scoring.clear();
    this.wanted.clear();
    this.candidates.clear();
    this.ahead = 0;
    v3.cancel('birdbox');
  }

  /**
   * Keep BirdNET V3.0 busy alongside the detection. Called whenever there may be a
   * window to score: boxes or audio arrived, or a window is done.
   */
  async _pumpScores() {
    if (this.pumping || !this.pcm || !$('bb-suggest').checked || performance.now() < this.retryAt) return;
    const status = $('bb-suggest-status');
    this.pumping = true;
    try {
      if (!v3.workers) status.textContent = t('demo.bb.suggest.loading', 'Loading BirdNET V3.0 for species suggestions…');
      await v3.ensure(p => {
        if (!p.cached) status.textContent = t('demo.bb.suggest.downloading', 'Downloading BirdNET V3.0 for species suggestions: {pct}', { pct: fmtPct(p.loaded / p.total, 0) });
      });
      while (this.mask === undefined) {
        const version = this.maskVersion, mask = await activeMask();
        if (version !== this.maskVersion) continue;   // the filter changed meanwhile
        this.mask = mask;
        this.scoresChanged();
      }
      status.textContent = '';
    } catch (err) {
      console.error(err);
      this.retryAt = performance.now() + RETRY_MS;
      status.textContent = t('demo.bb.suggest.failed', 'Species suggestions are unavailable: {message}', { message: err.message });
      return;
    } finally {
      this.pumping = false;
    }
    v3.wake();
    for (let k; this.scoring.size < 2 * v3.pool.size && (k = this._nextWindow()) != null;) this._scoreWindow(k);
  }

  /**
   * The window to score next: first the earliest one a box is waiting for, then the
   * next one ahead of the detection, whose boxes are about to appear. A window the
   * detection has passed without a box is never scored.
   */
  _nextWindow() {
    const rec = this.rec || this.liveEnded;
    const complete = rec ? readyWindows(rec.n) : windowCount(this.pcm.length);
    for (const k of this.wanted) {
      if (this.scores.has(k)) this.wanted.delete(k);
      else if (!this.scoring.has(k) && k < complete) return k;
    }
    if (this.analyzedTo == null || this.raw?.stopped) return null;   // no detection is running
    this.ahead = Math.max(this.ahead, this.raw?.next ?? 0);
    while (this.scores.has(this.ahead) || this.scoring.has(this.ahead)) this.ahead++;
    return this.ahead < complete ? this.ahead : null;
  }

  /** BirdNET V3.0 on window k (silence after the end of the recording, as for BirdBox). */
  async _scoreWindow(k) {
    const token = this.scoreToken, start = k * HOP * SR, length = CLIP * SR;
    this.scoring.add(k);
    try {
      const out = await v3.scoreWindow(this.pcm, start, start + length, length, { gen: 'birdbox', priority: 5 });
      if (token !== this.scoreToken) return;
      const aves = catalog.classes.indexOf('Aves'), birds = [];
      for (let s = 0; s < out.length; s++) if (out[s] >= MIN_SCORE && catalog.cls[s] === aves) birds.push([s, out[s]]);
      this.scores.set(k, birds);
      this.scoring.delete(k);
      if (this.wanted.delete(k)) this.scoresChanged();
    } catch (err) {
      if (token !== this.scoreToken || err.cancelled) return;
      this.scoring.delete(k);
      console.error(err);
      this.retryAt = performance.now() + RETRY_MS;
      $('bb-suggest-status').textContent = t('demo.bb.suggest.failed', 'Species suggestions are unavailable: {message}', { message: err.message });
      return;
    }
    this._pumpScores();
  }

  /** Box geometry with the user's changes (and the live one while dragging). */
  _geom(b) {
    if (this.live?.id === b.id) return this.live.g;
    return this.edits.get(b.id)?.geom || b;
  }

  /** Species, sound type and inclusion: the user's choices over the defaults. */
  _edit(b) {
    const o = this.edits.get(b.id) || {};
    const cands = $('bb-suggest').checked ? this._candidates(this._geom(b)) : null;
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
    const edit = this._edit(b), cands = this._candidates(this._geom(b)) || [];
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
    if (on) { this._setHover(null); this.spec.showTooltip(null); }
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
    if (this.recording) return '';
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
    if (!this.raw || this.recording) return false;
    if (this.drawMode) {
      this.gesture = { type: 'draw', start: p };
      return true;
    }
    const h = this._handleAt(p);
    if (!h) return false;
    this.gesture = { type: h.move ? 'move' : 'resize', id: h.b.id, start: p, from: geomOf(h.g), edges: h.edges };
    this._setHover(null);
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
        this._scrollToRow(this.boxes.indexOf(box), 'list');
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
    // Exports wait for the whole recording. A stopped run exports its part as CSV and
    // Raven; the Annota-JSON goes to Xeno-canto, where it would look complete
    const stopped = !!this.raw?.stopped;
    $('bb-export-xc').disabled = !this.raw?.done || !this.boxes.length;
    ['bb-export-csv', 'bb-export-raven'].forEach(id => { $(id).disabled = !(this.raw?.done || stopped) || !this.boxes.length; });
    const note = $('bb-export-note');
    note.hidden = !stopped;
    if (stopped) {
      note.textContent = t('demo.bb.partial', 'Detection was stopped at {done} of {total}. CSV and Raven cover only this part; the Annota-JSON needs the whole recording.',
        { done: fmtTime(this.analyzedTo ?? 0), total: fmtTime(this.duration) });
    }
    if (!this.raw) { el.innerHTML = ''; return; }
    const included = this.boxes.filter(b => this._edit(b).include);
    const species = new Set(included.map(b => this._edit(b).species).filter(s => s !== AVES));
    const stats = [
      [this.boxes.length, t('demo.bb.sum.boxes', 'boxes')],
      [included.filter(b => this._edit(b).verified).length, t('demo.bb.sum.verified', 'verified by you')],
      [species.size, t('demo.bb.sum.species', 'suggested species')],
      this.raw.done ? [`${fmtNumber(this.raw.ms / 1000, 1)} s`, t('demo.bb.sum.time', 'detection ({speed}× real time)', { speed: fmtNumber(this.duration / Math.max(this.raw.ms / 1000, 0.001), 1) })]
        : [fmtTime(this.analyzedTo ?? 0), t('demo.v3.sum.audio', 'audio')],
    ];
    el.innerHTML = statLine(stats);
  }

  /**
   * The list of boxes. Only rows that changed are replaced: the others keep an open
   * menu and the focus while boxes come in.
   */
  _renderTable() {
    const tbody = $('bb-table').querySelector('tbody');
    $('bb-table-wrap').hidden = !this.raw;
    if (!this.raw || !this.boxes.length) {
      const note = !this.raw ? '' : this.rec ? t('demo.bb.listening', 'Listening. Boxes appear here as they are found.')
        : this.raw.done || this.raw.stopped ? t('demo.bb.none', 'No bird vocalizations above this confidence. Try a lower threshold.')
          : t('demo.bb.hint.wait', 'Boxes appear here while detection runs.');
      tbody.innerHTML = note ? `<tr><td colspan="6" class="text-center text-muted py-3">${esc(note)}</td></tr>` : '';
      return;
    }
    const rows = [...tbody.children], template = document.createElement('template');
    if (rows[0]?.dataset.i == null) rows.splice(0).forEach(tr => tr.remove());   // the note
    this.boxes.forEach((b, i) => {
      const html = this._rowHtml(b, i);
      let tr = rows[i];
      if (tr?.rowHtml !== html) {
        template.innerHTML = html;
        const fresh = template.content.firstElementChild;
        fresh.rowHtml = html;
        if (tr) tr.replaceWith(fresh); else tbody.appendChild(fresh);
        tr = fresh;
      }
      tr.classList.toggle('is-selected', b.id === this.selectedId);
      tr.classList.toggle('is-hover', b.id === this.hoverId);
    });
    rows.slice(this.boxes.length).forEach(tr => tr.remove());
  }

  _rowHtml(b, i) {
    const suggest = $('bb-suggest').checked, locked = this.recording ? ' disabled' : '';
    const g = this._geom(b), edit = this._edit(b), cands = this._candidates(g);
    let speciesCell;
    if (suggest && !cands) speciesCell = `<span class="text-muted small"><span class="spinner-border spinner-border-sm me-1"></span>${esc(t('demo.bb.identifying', 'Identifying…'))}</span>`;
    else {
      const opts = (cands || []).map(c => `<option value="${c.s}"${c.s === edit.species ? ' selected' : ''}>${esc(catalog.name(c.s))} (${fmtPct(c.p, 0)})</option>`);
      if (edit.species !== AVES && !(cands || []).some(c => c.s === edit.species)) opts.unshift(`<option value="${edit.species}" selected>${esc(catalog.name(edit.species))}</option>`);
      opts.push(`<option value="${AVES}"${edit.species === AVES ? ' selected' : ''}>${esc(t('demo.bb.aves', 'Bird (unidentified) · Aves'))}</option>`);
      opts.push(`<option value="pick">${esc(t('demo.bb.otherSpecies', 'Other species…'))}</option>`);
      speciesCell = `${edit.species !== AVES ? thumb(edit.species, 'bb-thumb') : '<span class="bb-thumb"><i class="fa-solid fa-dove"></i></span>'}<select class="form-select form-select-sm bb-select" data-field="species" aria-label="${esc(t('demo.bb.col.species', 'Species'))}"${locked}>${opts.join('')}</select>`;
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
      : `<button type="button" class="bb-verify${edit.verified ? ' is-on' : ''}" data-act="verify" aria-pressed="${edit.verified}" title="${verifyLabel}" aria-label="${verifyLabel}"${locked}><i class="bi ${edit.verified ? 'bi-check-circle-fill' : 'bi-check-circle'}"></i></button>`;
    return `<tr data-i="${i}" class="${edit.include ? '' : 'is-excluded'}">
        <td class="bb-c-play"><button type="button" class="bb-play${b.manual ? ' is-manual' : ''}" data-play="${i}" aria-label="${esc(t('demo.results.playSegment', 'Play segment'))} ${i + 1}"${locked}><i class="bi bi-play-fill"></i>${i + 1}</button></td>
        <td class="bb-c-time">${fmtTime(g.t0, 2)}–${fmtTime(g.t1, 2)}<span>${fmtNumber(g.flo / 1000, 1)}–${fmtNumber(g.fhi / 1000, 1)} kHz${mark}</span></td>
        <td class="bb-c-conf"${b.manual ? ` title="${drawn}"` : ` title="max ${fmtNumber(b.max, 2)} · ${b.n}×"`}>${b.manual ? '–' : fmtNumber(b.avg, 2)}</td>
        <td class="bb-c-species"><div class="bb-species-wrap">${speciesCell}</div></td>
        <td class="bb-c-sound"><select class="form-select form-select-sm bb-select${edit.soundType ? '' : ' is-unset'}" data-field="sound" aria-label="${esc(t('demo.bb.col.sound', 'Sound type'))}"${locked}>${sound}</select></td>
        <td class="bb-c-toggle">${verify}<button type="button" class="bb-toggle" data-act="toggle" title="${removeLabel}" aria-label="${removeLabel}"${locked}><i class="bi ${removeIcon}"></i></button></td>
      </tr>`;
  }

  /**
   * Bring a row into view. A list that scrolls on its own scrolls to it; otherwise the page does,
   * unless only the list may move (scroll = 'list'), so the spectrogram stays where it is.
   */
  _scrollToRow(i, scroll) {
    const wrap = $('bb-table-wrap'), tr = wrap.querySelector(`tr[data-i="${i}"]`);
    if (!tr || !scroll) return;
    if (wrap.scrollHeight <= wrap.clientHeight) {
      if (scroll !== 'list') tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    const view = wrap.getBoundingClientRect(), row = tr.getBoundingClientRect();
    const top = view.top + wrap.querySelector('thead').offsetHeight;
    if (row.top < top) wrap.scrollBy({ top: row.top - top, behavior: 'smooth' });
    else if (row.bottom > view.bottom) wrap.scrollBy({ top: row.bottom - view.bottom, behavior: 'smooth' });
  }

  /** Highlight a box (or none) on the spectrogram and its row in the list. */
  _setHover(id) {
    if (id === this.hoverId) return;
    this.hoverId = id;
    document.querySelectorAll('#bb-table tr[data-i]').forEach(tr => tr.classList.toggle('is-hover', this.boxes[+tr.dataset.i]?.id === id));
    this.spec.render();
  }

  /** Select a box (or none): highlight its row, bring it into view, optionally play it. */
  _select(id, { play = false, scroll = false } = {}) {
    this.selectedId = id;
    const i = this.boxes.findIndex(b => b.id === id), b = this.boxes[i];
    document.querySelectorAll('#bb-table tr[data-i]').forEach(tr => tr.classList.toggle('is-selected', +tr.dataset.i === i));
    this.spec.main.classList.toggle('is-editing', this.drawMode || !!b);
    if (b) {
      this._scrollToRow(i, scroll);
      const g = this._geom(b), span = this.spec.view.t1 - this.spec.view.t0;
      if (g.t0 < this.spec.view.t0 || g.t1 > this.spec.view.t1) this.spec.setView(g.t0 - span * 0.3, g.t0 - span * 0.3 + span);
      if (play) player.play(Math.max(0, g.t0 - 0.15), g.t1 + 0.15);
    }
    this._renderHint();
    this.spec.render();
  }

  /** While recording, a soft edge marks how far detection has come; the newest sound stays bright. */
  _drawFrontier(ctx, h) {
    const x = h.timeToX(this.analyzedTo);
    if (x < 0 || x > h.width) return;
    const tint = this.spec.light ? '15,23,42' : '34,211,238', band = Math.min(h.width - x, 90);
    if (band > 0) {
      const fade = ctx.createLinearGradient(x, 0, x + band, 0);
      fade.addColorStop(0, `rgba(${tint},0.14)`);
      fade.addColorStop(1, `rgba(${tint},0)`);
      ctx.fillStyle = fade;
      ctx.fillRect(x, 0, band, h.height);
    }
    ctx.fillStyle = `rgba(${tint},0.55)`;
    ctx.fillRect(Math.round(x), 0, 1, h.height);
  }

  /** How far along a box's pop-in is while recording: 1 when done. */
  _popOf(b, now) {
    const born = this.rec ? this.born.get(b.id) : null;
    return born == null ? 1 : Math.min(1, (now - born) / POP_MS);
  }

  /**
   * While detection runs, the boxes that may still change, drawn dashed. The next windows can
   * fuse a box near the line with theirs, join it into a phrase or hide it as nested, so a box
   * ending less than one window step (1.5 s) plus the phrase gap behind the line may change.
   * A phrase that grows also widens its band, and can then take in a box beside it that ended
   * long before: so a box linked to one that may change (within the phrase gap in time, with
   * overlapping bands) may change too. In simulated recordings of the sample soundscape and an
   * 11-minute file, at confidences 0.05 to 0.5 and phrase gaps 0 to 1 s, no box this leaves
   * solid changed later.
   */
  _markPending() {
    this.pending = new Set();
    if (this.analyzedTo == null) return;
    const gap = +$('bb-gap').value, after = this.analyzedTo - SETTLED - gap, todo = [];
    for (const b of this.songs) if (b.t1 > after) { this.pending.add(b); todo.push(b); }
    while (todo.length) {
      const p = todo.pop();
      for (const b of this.songs) {
        if (this.pending.has(b) || b.cls !== p.cls) continue;
        if (Math.max(b.t0, p.t0) - Math.min(b.t1, p.t1) > gap || b.fhi <= p.flo || p.fhi <= b.flo) continue;
        this.pending.add(b);
        todo.push(b);
      }
    }
  }

  /** A detected box that may still change. Drawn and adjusted boxes are the person's own. */
  _pending(b) {
    return !!this.pending?.has(b) && !this.edits.get(b.id)?.geom;
  }

  _drawBoxes(ctx, h) {
    const now = performance.now(), calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (this.recording) {
      if (this.analyzedTo != null) this._drawFrontier(ctx, h);
    }
    // Dim what is not analyzed yet, as on the V3.0 tab
    else if (this.analyzedTo != null) {
      const x0 = Math.max(0, h.timeToX(this.analyzedTo));
      ctx.fillStyle = this.spec.light ? 'rgba(255,255,255,0.6)' : 'rgba(5,4,12,0.55)';
      if (x0 < h.width) ctx.fillRect(x0, 0, h.width - x0, h.height);
    }
    ctx.font = '600 11px Inter Variable, Inter, system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    this.boxes.forEach((b, i) => {
      const g = this._geom(b), x0 = h.timeToX(g.t0), x1 = h.timeToX(g.t1);
      if (x1 < 0 || x0 > h.width) return;
      const y0 = h.freqToY(g.fhi), y1 = h.freqToY(g.flo), edit = this._edit(b);
      const selected = b.id === this.selectedId, active = selected || b.id === this.hoverId;
      const base = b.manual ? '#fbbf24' : edit.verified ? '#4ade80' : '#22d3ee';
      const color = !edit.include ? 'rgba(148,163,184,0.7)' : active ? '#ffffff' : base;
      const pop = calm ? 1 : this._popOf(b, now);
      if (pop < 1) {
        // A ring that settles on the box as it appears
        const grow = (1 - pop) * 10, eased = pop * pop;
        ctx.strokeStyle = base;
        ctx.globalAlpha = (1 - eased) * 0.8;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 - grow, y0 - grow, Math.max(2, x1 - x0) + 2 * grow, Math.max(2, y1 - y0) + 2 * grow);
        ctx.fillStyle = base;
        ctx.globalAlpha = (1 - eased) * 0.22;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = active ? 2.5 : 1.5;
      ctx.setLineDash(!edit.include ? [4, 3] : this._pending(b) ? [6, 3] : []);
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

  /** File name of CSV and Raven exports; a stopped run's say they cover a part. */
  _baseName() { return `${(this._audio()?.name || 'audio').replace(/\.[^.]+$/, '')}${this.raw?.stopped ? '_partial' : ''}`; }

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
        sound_file: this._audio()?.name || '',
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

  /** Clock times are added when the recording's start is known. */
  _exportCsv() {
    const start = this._audio()?.start;
    const header = ['box', 'time_start', 'time_end', 'freq_low_hz', 'freq_high_hz', 'avg_confidence', 'max_confidence', 'detections_merged', 'class_id', 'species', 'scientific_name', 'common_name', 'suggestion_score', 'sound_type'];
    if (start) header.push('datetime_start', 'datetime_end');
    const lines = [header.join(',')];
    for (const r of this._included()) {
      const detector = r.b.manual ? ['', '', '', ''] : [r.b.avg.toFixed(6), r.b.max.toFixed(6), Math.round(r.b.n), Math.round(r.b.cls)];
      const clock = start ? [isoTime(start, r.g.t0), isoTime(start, r.g.t1)] : [];
      lines.push([r.i + 1, r.g.t0.toFixed(6), r.g.t1.toFixed(6), r.g.flo.toFixed(3), r.g.fhi.toFixed(3), ...detector, 'bird',
        csvField(this._sciName(r.sp.s)), csvField(r.sp.s === AVES ? '' : catalog.en[r.sp.s]), r.sp.p == null ? '' : r.sp.p.toFixed(6), csvField(r.edit.soundType), ...clock].join(','));
    }
    downloadFile(`${this._baseName()}.BirdBox.csv`, `${lines.join('\n')}\n`, 'text/csv;charset=utf-8');
  }

  _exportRaven() {
    const start = this._audio()?.start;
    const lines = [['Selection', 'View', 'Channel', 'Begin Time (s)', 'End Time (s)', ...(start ? RAVEN_CLOCK : []), 'Low Freq (Hz)', 'High Freq (Hz)', 'Annotation', 'Confidence'].join('\t')];
    this._included().forEach(r => {
      const clock = start ? ravenClock(start, r.g.t0, r.g.t1) : [];
      lines.push([r.i + 1, 'Spectrogram 1', 1, r.g.t0.toFixed(3), r.g.t1.toFixed(3), ...clock, Math.round(r.g.flo), Math.round(r.g.fhi), this._sciName(r.sp.s), r.b.manual ? '' : r.b.avg.toFixed(3)].join('\t'));
    });
    downloadFile(`${this._baseName()}.BirdBox.selections.txt`, `${lines.join('\n')}\n`);
  }
}
