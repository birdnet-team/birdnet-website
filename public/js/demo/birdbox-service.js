/**
 * BirdBox detector service: downloads the model's two streaming graphs and
 * runs them in a worker (birdbox-worker.js).
 *
 * A run reports the boxes of the 3 s windows at the lowest slider confidence,
 * a few seconds of audio at a time. birdbox-fusion.js turns them into the
 * boxes for any slider setting.
 */
import { CONFIG } from './core.js';
import { fetchAsset, getManifest } from './model-store.js';
import { CancelledError } from './ort-pool.js';

export const RAW_CONF = 0.05;   // lowest value of the confidence slider
const STEP = 1;                 // windows per run in a file: new boxes every 1.5 s of audio, as fast as two per run

class BirdBoxService {
  constructor() { this.ready = null; this.worker = null; this.job = null; this.nextId = 1; this.models = null; }

  get loaded() { return !!this.worker; }

  /** Download (or restore) the graphs and start the worker; onProgress gets { loaded, total, cached }. */
  ensure(onProgress) {
    if (!this.ready) {
      const ready = this.ready = (async () => {
        const m = this.manifest = (await getManifest()).birdbox;
        if (!this.models) {
          const parts = [m.spectrogram, m.model], state = parts.map(() => ({ loaded: 0, cached: true }));
          const total = parts.reduce((sum, p) => sum + p.size, 0);
          const [spectrogram, detect] = await Promise.all(parts.map((entry, i) => fetchAsset(entry, p => {
            state[i] = p;
            onProgress?.({ loaded: state.reduce((sum, s) => sum + s.loaded, 0), total, cached: state.every(s => s.cached) });
          })));
          // Kept, so a stopped run restarts the worker without another download
          this.models = { spectrogram, detect };
        }
        if (this.ready !== ready) throw new CancelledError();
        const spectrogram = this.models.spectrogram.slice(0), detect = this.models.detect.slice(0);
        const worker = new Worker(new URL('./birdbox-worker.js', import.meta.url), { type: 'module', name: 'birdbox' });
        await new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) => {
            if (data.type === 'ready') resolve();
            else if (data.type === 'error') reject(new Error(data.error));
          };
          worker.onerror = e => { e.preventDefault?.(); reject(new Error(e.message || 'birdbox: worker failed to start')); };
          worker.postMessage({
            type: 'init', ortModule: CONFIG.ortModule, wasmPaths: CONFIG.ortWasm, spectrogram, detect,
            config: { floorWindowSeconds: m.floorWindowSeconds, frameOrigin: m.frameOrigin },
          }, [spectrogram, detect]);
        }).catch(err => { worker.terminate(); throw err; });
        if (this.ready !== ready) { worker.terminate(); throw new CancelledError(); }
        worker.onmessage = ({ data }) => this._done(data);
        worker.onerror = e => {
          e.preventDefault?.();
          this._fail(new Error(e.message || 'birdbox: worker stopped (out of memory?)'));
        };
        this.worker = worker;
        return this;
      })();
      ready.catch(() => { if (this.ready === ready) this.ready = null; });
    }
    return this.ready;
  }

  _job(message, transfer, onChunk) {
    if (this.job) return Promise.reject(new Error('A detection is already running'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.job = { id, resolve, reject, onChunk };
      this.worker.postMessage({ ...message, id, conf: RAW_CONF }, transfer);
    });
  }

  /**
   * Detect over a whole recording. onChunk({ data, rows, next, analyzedTo }) gets
   * the next rows as soon as they are ready; next counts the windows done. A run
   * continues an earlier one, or a recording's live windows, when `from` is
   * their `next`.
   * @returns {Promise<{ms: number}>}
   */
  detect(audio, onChunk, from = 0) {
    return this._job({ type: 'detect', audio, step: STEP, from }, [audio.buffer], onChunk);
  }

  /** A recording starts: its audio follows with liveAudio. */
  liveStart() {
    this.worker.postMessage({ type: 'live-start' });
  }

  /** Its next samples (a copy is sent). */
  liveAudio(pcm) {
    const copy = pcm.slice();
    this.worker.postMessage({ type: 'live-audio', pcm: copy }, [copy.buffer]);
  }

  /**
   * Final rows of the next `count` windows of the recording, from window `from` on.
   * The audio sent so far must have reached their end (readyWindows).
   * @returns {Promise<{data: Float32Array, rows: number, next: number, ms: number}>}
   */
  liveWindows(from, count) {
    return this._job({ type: 'windows', from, count });
  }

  _done(msg) {
    const job = this.job;
    if (!job || msg.id !== job.id) return;
    if (msg.type === 'chunk') { job.onChunk(msg); return; }
    this.job = null;
    if (msg.type === 'error') job.reject(new Error(msg.error));
    else job.resolve(msg);
  }

  _fail(err) {
    const job = this.job;
    this._reset();
    job?.reject(err);
  }

  /** Stop a run in progress (ONNX Runtime cannot interrupt one); the next run starts a fresh worker. */
  abort() {
    if (!this.job) return;
    const job = this.job;
    this._reset();
    job.reject(new CancelledError());
  }

  _reset() {
    this.worker?.terminate();
    this.worker = null;
    this.job = null;
    this.ready = null;
  }
}

export const birdbox = new BirdBoxService();
