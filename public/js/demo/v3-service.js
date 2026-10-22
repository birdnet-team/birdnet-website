/**
 * BirdNET V3.0 audio model service: model download, worker pool and chunked
 * inference with the same chunking as the desktop analyzer (analyze.py):
 * windows start every (chunk - overlap) seconds, the last one is zero-padded,
 * and scores are the model's sigmoid outputs without further processing.
 */
import { workerCount } from './core.js';
import { fetchAsset, getManifest, isCached } from './model-store.js';
import { OrtPool } from './ort-pool.js';
import { catalog } from './species.js';

export const SR = 32000;
const IDLE_TRIM_MS = 120000; // keep one warm worker after two idle minutes

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
  }

  async manifestEntry() {
    return (await getManifest()).v3;
  }

  async cached() {
    try { return await isCached((await this.manifestEntry()).model); } catch { return false; }
  }

  /** Download (or restore) the model and start the worker pool. */
  ensure(onProgress) {
    if (!this.ready) {
      this.ready = (async () => {
        const m = await this.manifestEntry();
        await catalog.load();
        const model = await fetchAsset(m.model, onProgress);
        this.dispatchEvent(new CustomEvent('status', { detail: 'starting' }));
        this.pool = new OrtPool({ name: 'birdnet-v3', size: workerCount('v3') });
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
   * Analyze a recording. Calls onChunk(index, scores) as windows finish (in
   * any order). Returns { chunks, scores: Float32Array(n x species), ms }.
   */
  async analyze(pcm, { chunkSec = 3, overlapSec = 0, onChunk } = {}) {
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

  _busy() {
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
