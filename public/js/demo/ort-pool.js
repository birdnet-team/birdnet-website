/**
 * A pool of inference workers (ort-worker.js), each with its own
 * single-threaded ONNX Runtime session.
 *
 * Without cross-origin isolation (GitHub Pages cannot send COOP/COEP
 * headers) WASM threads are unavailable, but independent sessions in
 * parallel workers scale nearly as well and need no special headers.
 * Jobs start as soon as the first worker is ready; the others join the
 * queue when their session is loaded.
 */
import { CONFIG } from './core.js';

export class CancelledError extends Error {
  constructor() { super('cancelled'); this.cancelled = true; }
}

export class OrtPool extends EventTarget {
  /** @param {{name:string, size:number}} options */
  constructor({ name, size }) {
    super();
    this.name = name;
    this.size = Math.max(1, size);
    this.slots = [];
    this.queue = [];
    this.nextId = 1;
    this.started = null;
    this.allReady = null;
    this.lastError = null;
    this.spawning = 0;
  }

  get readyCount() { return this.slots.length; }

  /**
   * Start the pool with a model. Resolves when the first worker can run jobs.
   * The model buffer is transferred, so callers must not reuse it.
   */
  start(model, config) {
    if (this.started) return this.started;
    this.config = config;
    const copies = [];
    for (let i = 0; i < this.size; i++) copies.push(i === this.size - 1 ? model : model.slice(0));
    this.started = (async () => {
      const first = await this._spawn(copies[0], config);
      if (!first) throw this.lastError || new Error(`${this.name}: worker failed to start`);
      this.allReady = Promise.all(copies.slice(1).map(buf => this._spawn(buf, config)));
    })();
    this.started.catch(() => { this.started = null; });
    return this.started;
  }

  _spawn(buffer, config) {
    this.spawning++;
    return new Promise(resolve => {
      const worker = new Worker(CONFIG.workerUrl, { type: 'module', name: this.name });
      const fail = err => {
        this.spawning--;
        worker.terminate();
        this.lastError = err;
        resolve(null);
      };
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') {
          this.spawning--;
          const slot = { worker, job: null, ms: data.ms };
          worker.onmessage = e => this._onMessage(slot, e.data);
          worker.onerror = e => this._onCrash(slot, e);
          this.slots.push(slot);
          this.dispatchEvent(new Event('change'));
          this._pump();
          resolve(slot);
        } else if (data.type === 'error') {
          fail(new Error(data.error));
        }
      };
      worker.onerror = e => { e.preventDefault?.(); fail(new Error(e.message || `${this.name}: worker failed to start`)); };
      worker.postMessage({
        type: 'init',
        ortModule: CONFIG.ortModule,
        wasmPaths: CONFIG.ortWasm,
        model: buffer,
        config,
      }, [buffer]);
    });
  }

  /**
   * Queue a job. Higher priority runs first; jobs tagged with a generation
   * can be cancelled together.
   */
  run(type, payload, transfer = [], { gen = 0, priority = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const job = { id: this.nextId++, type, payload, transfer, gen, priority, resolve, reject };
      let i = this.queue.length;
      while (i > 0 && this.queue[i - 1].priority < priority) i--;
      this.queue.splice(i, 0, job);
      this._pump();
    });
  }

  /** Reject queued jobs of a generation (or all queued jobs). Running jobs finish. */
  cancel(gen) {
    const keep = [];
    for (const job of this.queue) {
      if (gen === undefined || job.gen === gen) job.reject(new CancelledError());
      else keep.push(job);
    }
    this.queue = keep;
  }

  _pump() {
    for (const slot of this.slots) {
      if (slot.job || !this.queue.length) continue;
      const job = this.queue.shift();
      slot.job = job;
      slot.worker.postMessage({ type: job.type, id: job.id, ...job.payload }, job.transfer);
    }
  }

  _onMessage(slot, msg) {
    const job = slot.job;
    slot.job = null;
    if (job && msg.id === job.id) {
      if (msg.type === 'error') job.reject(new Error(msg.error));
      else job.resolve(msg);
    }
    this._pump();
  }

  _onCrash(slot, event) {
    event.preventDefault?.();
    slot.worker.terminate();
    this.slots = this.slots.filter(s => s !== slot);
    this.lastError = new Error(event.message || `${this.name}: worker stopped (out of memory?)`);
    if (slot.job) slot.job.reject(this.lastError);
    if (!this.slots.length) {
      for (const job of this.queue) job.reject(this.lastError);
      this.queue = [];
      this.started = null;
    }
    this.dispatchEvent(new Event('change'));
    this._pump();
  }

  /** Stop idle workers beyond `keep` to give their memory back. */
  trim(keep = 1) {
    if (this.queue.length) return; // still working through a job list
    for (const slot of [...this.slots]) {
      if (this.slots.length <= keep) break;
      if (slot.job) continue;
      slot.worker.terminate();
      this.slots = this.slots.filter(s => s !== slot);
    }
    this.dispatchEvent(new Event('change'));
  }

  /** Start workers up to the pool size again after trim(). */
  async grow(getModel) {
    const missing = this.size - this.slots.length - this.spawning;
    if (missing <= 0 || this.growing || !this.config) return;
    this.growing = true;
    try {
      const model = await getModel();
      await Promise.all(Array.from({ length: missing }, (_, i) => this._spawn(i === missing - 1 ? model : model.slice(0), this.config)));
    } finally {
      this.growing = false;
    }
  }

  terminate() {
    this.cancel();
    for (const slot of this.slots) {
      slot.worker.terminate();
      if (slot.job) slot.job.reject(new CancelledError());
    }
    this.slots = [];
    this.started = null;
  }
}
