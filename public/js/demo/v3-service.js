/**
 * BirdNET V3.0 audio model service: model download, worker pool and chunked
 * inference with the same chunking as the desktop analyzer (analyze.py):
 * windows start every (chunk - overlap) seconds, the last one is zero-padded,
 * and scores are the model's sigmoid outputs without further processing.
 *
 * For BirdBox it scores single boxes (scoreBox): the model takes audio of any
 * length, so a box is scored on its own time span and frequency band, without
 * the parts of it that belong to other boxes.
 */
import { workerCount } from './core.js';
import { fetchAsset, getManifest, isCached } from './model-store.js';
import { OrtPool } from './ort-pool.js';
import { catalog } from './species.js';

export const SR = 32000;
const IDLE_TRIM_MS = 120000; // keep one warm worker after two idle minutes
// Species for BirdBox's boxes: two workers keep up with its detection, and each
// further one holds another copy of the model (about 400 MB)
const SUGGEST_WORKERS = 2;
const BOX_MIN = 1;        // seconds: a shorter box is scored with the audio around it
const BOX_MAX = 10;       // seconds in one run: a longer box is scored in equal parts
const BOX_SETTLE = 0.05;  // seconds of audio before a box that only settle the bandpass

/**
 * The audio a box is scored on, as [startSample, endSample] ranges: its time span,
 * or BOX_MIN seconds centred on a shorter box (moved, at the ends of the recording,
 * to where there is audio). A box longer than BOX_MAX is cut into equal parts.
 * `open`: the recording goes on, and null says that audio after the box is still to come.
 */
export function boxCrops(g, total, open = false) {
  const min = BOX_MIN * SR;
  let s = Math.max(0, Math.round(g.t0 * SR)), e = Math.round(g.t1 * SR);
  const short = e - s < min;
  if (short) {
    s = Math.max(0, Math.round((g.t0 + g.t1) / 2 * SR - min / 2));
    e = s + min;
  }
  if (e > total) {
    if (open) return null;
    if (short) s = Math.max(0, total - min);
    e = total;
  }
  if (e <= s) return [];
  const parts = Math.ceil((e - s) / (BOX_MAX * SR)), len = Math.ceil((e - s) / parts);
  return Array.from({ length: parts }, (_, i) => [s + i * len, Math.min(e, s + (i + 1) * len)]);
}

/** Chunk plan of analyze.py chunk_audio(): [startSample, endSample] per window. */
export function planChunks(numSamples, chunkSec, overlapSec) {
  const len = Math.round(chunkSec * SR);
  const step = len - Math.round(overlapSec * SR);
  const chunks = [];
  for (let s = 0; s < numSamples; s += step) {
    const e = Math.min(s + len, numSamples);
    chunks.push([s, e]);
    if (e >= numSamples) break;
  }
  return { chunks, len };
}

class V3Service extends EventTarget {
  constructor() {
    super();
    this.ready = null;
    this.pool = null;
    this.gen = 0;
    this.analyzing = 0;   // analyze() calls running
  }

  async manifestEntry() {
    return (await getManifest()).v3;
  }

  async cached() {
    try { return await isCached((await this.manifestEntry()).model); } catch { return false; }
  }

  /**
   * Download (or restore) the model and start the worker pool. `suggest`: for
   * BirdBox's species, which start only the workers wake() lets them use.
   */
  ensure(onProgress, { suggest = false } = {}) {
    if (!this.ready) {
      this.ready = (async () => {
        const m = await this.manifestEntry();
        await catalog.load();
        const model = await fetchAsset(m.model, onProgress);
        this.dispatchEvent(new CustomEvent('status', { detail: 'starting' }));
        this.pool = new OrtPool({ name: 'birdnet-v3', size: workerCount('v3') });
        if (suggest && !this.analyzing) this.pool.limitTo(SUGGEST_WORKERS);
        this.pool.addEventListener('change', () => this.dispatchEvent(new Event('workers')));
        await this.pool.start(model, { input: m.input, output: m.output });
        this.dispatchEvent(new CustomEvent('status', { detail: 'ready' }));
        return this;
      })();
      this.ready.catch(() => { this.ready = null; this.pool = null; });
    }
    return this.ready;
  }

  get workers() { return this.pool?.readyCount || 0; }

  /** Score one window (zero-padded/truncated to `len` samples). */
  scoreWindow(pcm, start, end, len, opts) {
    this._idle();
    const audio = new Float32Array(len);
    audio.set(pcm.subarray(Math.max(0, start), Math.min(end, start + len, pcm.length)), Math.max(0, -start));
    return this.pool.run('v3', { audio, batch: 1, samples: len }, [audio.buffer], opts).then(r => r.scores);
  }

  /**
   * Score the sound of one box { t0, t1, flo, fhi } in the first `total` samples of
   * pcm: cropped in time (boxCrops), without the rectangles `cuts` (the sound of
   * other boxes inside it, region-cut.js), limited to the box's band (bandpass.js),
   * and run through the model at that length; all of it in the worker. Resolves to
   * [[class, score], ...] for the classes scoring at least `min`: over the parts of
   * a long box, each class's highest score.
   */
  async scoreBox(pcm, total, g, cuts, min, opts) {
    this._idle();
    const best = new Map();
    await Promise.all((boxCrops(g, total) || []).map(async ([s, e]) => {
      const skip = Math.min(s, Math.round(BOX_SETTLE * SR));
      // Zero-padded only where the recording ends within BOX_MIN of the crop's start
      const audio = new Float32Array(skip + Math.max(e - s, BOX_MIN * SR));
      audio.set(pcm.subarray(s - skip, e));
      // The cuts in this part, in seconds from the start of `audio`
      const from = (s - skip) / SR;
      const regions = Float32Array.from(cuts.filter(c => c.t1 * SR > s && c.t0 * SR < e).flatMap(c => [c.t0 - from, c.t1 - from, c.flo, c.fhi]));
      const r = await this.pool.run('v3box', { audio, skip, sampleRate: SR, flo: g.flo, fhi: g.fhi, cuts: regions, min }, [audio.buffer], opts);
      r.index.forEach((c, k) => { if (!(best.get(c) >= r.score[k])) best.set(c, r.score[k]); });
    }));
    return [...best];
  }

  /**
   * Analyze a recording. Calls onChunk(index, scores) as windows finish (in
   * any order). Returns { chunks, scores: Float32Array(n x species), ms }.
   */
  async analyze(pcm, { chunkSec = 3, overlapSec = 0, onChunk } = {}) {
    this.analyzing++;
    try {
      return await this._analyze(pcm, chunkSec, overlapSec, onChunk);
    } finally {
      this.analyzing--;
    }
  }

  async _analyze(pcm, chunkSec, overlapSec, onChunk) {
    await this.ensure();
    this.cancel();
    this._busy();
    const gen = ++this.gen;
    const { chunks, len } = planChunks(pcm.length, chunkSec, overlapSec);
    const S = catalog.count;
    const scores = new Float32Array(chunks.length * S);
    const t0 = performance.now();
    // Windows are cut from the recording as they are queued, a few per
    // worker ahead, so an hour of audio never sits in the queue at once.
    let next = 0;
    const lane = async () => {
      while (next < chunks.length && gen === this.gen) {
        const i = next++, [s, e] = chunks[i];
        let out;
        try {
          out = await this.scoreWindow(pcm, s, e, len, { gen: `v3-${gen}` });
        } catch (err) {
          if (err.cancelled) return;
          throw err;
        }
        if (gen !== this.gen) return;
        scores.set(out, i * S);
        onChunk?.(i, out);
      }
    };
    await Promise.all(Array.from({ length: Math.min(chunks.length, 2 * this.pool.size) }, lane));
    this._idle();
    return { chunks, scores, ms: performance.now() - t0, cancelled: gen !== this.gen };
  }

  /**
   * Before BirdBox's boxes are scored one by one: run SUGGEST_WORKERS workers,
   * or the full pool while the V3.0 tab analyzes.
   */
  wake() {
    if (!this.pool) return;
    if (!this.analyzing) this.pool.limitTo(SUGGEST_WORKERS);
    this._grow();
  }

  /** The workers BirdBox's species may keep busy. */
  get suggestWorkers() { return this.pool?.target || 0; }

  _busy() {
    this.pool.limitTo(Infinity);
    this._grow();
  }

  _grow() {
    clearTimeout(this.trimTimer);
    this.pool.grow(async () => fetchAsset((await this.manifestEntry()).model)).catch(() => {});
  }

  _idle() {
    clearTimeout(this.trimTimer);
    this.trimTimer = setTimeout(() => this.pool?.trim(1), IDLE_TRIM_MS);
  }

  /** Abort the running analysis (its queued windows are dropped), or the queued jobs tagged `tag`. */
  cancel(tag) {
    if (tag) { this.pool?.cancel(tag); return; }
    this.pool?.cancel(`v3-${this.gen}`);
    this.gen++;
  }
}

export const v3 = new V3Service();
