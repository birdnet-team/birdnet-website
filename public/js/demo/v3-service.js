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
const IDLE_TRIM_MS = 120000;     // keep one warm worker after two idle minutes
const IDLE_RELEASE_MS = 600000;  // and none after ten: the model is back from the browser cache in a second or two
// Species for BirdBox's boxes: two workers keep up with its detection, and each
// further one holds another copy of the model (about 500 MB)
const SUGGEST_WORKERS = 2;
const LOSS_WINDOW_MS = 120000;   // workers lost to failures are replaced, unless LOSS_MAX were lost within this time
const LOSS_MAX = 3;
const BOX_PARTS = 6;      // of a box longer than BOX_PARTS x BOX_MAX seconds, this many parts are scored, evenly spread
const BOX_MIN = 1;        // seconds: a shorter box is scored with the audio around it
const BOX_MAX = 10;       // seconds in one run: a longer box is scored in equal parts

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
   * BirdBox's species, which start only `workers` workers, as wake() lets them use.
   */
  ensure(onProgress, { suggest = false, workers = SUGGEST_WORKERS } = {}) {
    if (!this.ready) {
      this.ready = (async () => {
        const m = await this.manifestEntry();
        await catalog.load();
        const model = await fetchAsset(m.model, onProgress);
        this.dispatchEvent(new CustomEvent('status', { detail: 'starting' }));
        this.pool = new OrtPool({ name: 'birdnet-v3', size: workerCount('v3'), retireOnError: true });
        this.pool.addEventListener('lost', () => this._replace());
        if (suggest && !this.analyzing) this.pool.limitTo(Math.min(workers, SUGGEST_WORKERS));
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
   * pcm: cropped in time (boxCrops), limited to the box's band and without the
   * rectangles `cuts` (the sound of other boxes inside it), both in the worker
   * (region-cut.js), and run through the model at that length. Resolves to
   * [[class, score], ...] for the classes scoring at least `min`: over the parts of
   * a long box, each class's highest score. The parts run one after the other, so a
   * long box neither fills the queue nor holds a copy of all its audio.
   */
  async scoreBox(pcm, total, g, cuts, min, opts) {
    this._idle();
    const best = new Map();
    let crops = boxCrops(g, total) || [];
    if (crops.length > BOX_PARTS) crops = Array.from({ length: BOX_PARTS }, (_, i) => crops[Math.round(i * (crops.length - 1) / (BOX_PARTS - 1))]);
    for (const [s, e] of crops) {
      if (opts?.alive && !opts.alive()) break;   // the audio is gone: the parts left are not worth their runs
      // Zero-padded only where the recording ends within BOX_MIN of the crop's start
      const audio = new Float32Array(Math.max(e - s, BOX_MIN * SR));
      audio.set(pcm.subarray(s, e));
      // The cuts in this part, in seconds from its start
      const from = s / SR;
      const regions = Float32Array.from(cuts.filter(c => c.t1 * SR > s && c.t0 * SR < e).flatMap(c => [c.t0 - from, c.t1 - from, c.flo, c.fhi]));
      const r = await this.pool.run('v3box', { audio, sampleRate: SR, flo: g.flo, fhi: g.fhi, cuts: regions, min }, [audio.buffer], opts);
      r.index.forEach((c, k) => { if (!(best.get(c) >= r.score[k])) best.set(c, r.score[k]); });
    }
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
        // A window whose worker failed is tried once more, on the worker that replaces it
        for (let attempt = 0; ; attempt++) {
          try {
            out = await this.scoreWindow(pcm, s, e, len, { gen: `v3-${gen}` });
            break;
          } catch (err) {
            if (err.cancelled || gen !== this.gen) return;
            if (attempt) {
              this.cancel();   // the other windows stop too
              throw err;
            }
          }
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
   * Before BirdBox's boxes are scored one by one: run `workers` workers (SUGGEST_WORKERS
   * at most), or the full pool while the V3.0 tab analyzes. The idle timer goes on:
   * only scoring a box (scoreBox) counts as use.
   */
  wake(workers = SUGGEST_WORKERS) {
    if (!this.pool) return;
    if (!this.analyzing) this.pool.limitTo(Math.min(workers, SUGGEST_WORKERS));
    this._grow();
  }

  /** A worker was lost to a failure: start another, unless they keep failing (out of memory, most likely). */
  _replace() {
    const now = performance.now();
    this.losses = (this.losses || []).filter(t => now - t < LOSS_WINDOW_MS);
    this.losses.push(now);
    if (this.losses.length <= LOSS_MAX) this._grow();
    else this.pool.limitTo(Math.max(1, this.pool.readyCount));   // go on with the workers that hold
  }

  /** The workers BirdBox's species may keep busy. */
  get suggestWorkers() { return this.pool?.target || 0; }

  _busy() {
    clearTimeout(this.trimTimer);
    clearTimeout(this.releaseTimer);
    this.pool.limitTo(Infinity);
    this._grow();
  }

  _grow() {
    this.pool.grow(async () => fetchAsset((await this.manifestEntry()).model)).catch(() => {});
  }

  /** Unused from now on: after a while one worker stays, later none. Each holds about 500 MB. */
  _idle() {
    clearTimeout(this.trimTimer);
    clearTimeout(this.releaseTimer);
    this.trimTimer = setTimeout(() => { if (!this.analyzing) this.pool?.trim(1); }, IDLE_TRIM_MS);
    this.releaseTimer = setTimeout(() => { if (!this.analyzing) this.pool?.trim(0); }, IDLE_RELEASE_MS);
  }

  /** Abort the running analysis (its queued windows are dropped), or the queued jobs tagged `tag`. */
  cancel(tag) {
    if (tag) { this.pool?.cancel(tag); return; }
    this.pool?.cancel(`v3-${this.gen}`);
    this.gen++;
  }
}

export const v3 = new V3Service();
