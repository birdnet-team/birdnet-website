/**
 * BirdBox worker: the model's two streaming graphs in single-threaded ONNX
 * Runtime Web (WASM) sessions (birdbox-stream.js). Running them here keeps the
 * page responsive and lets the page stop a run by terminating the worker.
 *
 * Messages in:
 *   { type: 'init', ortModule, wasmPaths, spectrogram: ArrayBuffer, detect: ArrayBuffer, config }
 *   { type: 'detect', id, audio: Float32Array, conf, step, from? }   a whole recording, `step` windows at a time
 *   { type: 'live-start' }                                           a recording starts
 *   { type: 'live-audio', pcm: Float32Array }                        its next samples
 *   { type: 'windows', id, from, count, conf }                       its next windows
 * Messages out:
 *   { type: 'ready', ms }
 *   { type: 'chunk', id, data, rows, next, analyzedTo }   after every `step` windows of a recording
 *   { type: 'result', id, ms, data?, rows?, next? }       when the recording or the windows are done
 *   { type: 'error', id, error }
 */
import { StreamGraph } from './birdbox-stream.js';

let graph = null;
let live = null;   // the recording in progress, with its spectrogram frames

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function init(msg) {
  const t0 = performance.now();
  const ort = await import(msg.ortModule);
  ort.env.wasm.wasmPaths = msg.wasmPaths;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  graph = await StreamGraph.create(ort, msg, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }, msg.config);
  post({ type: 'ready', ms: performance.now() - t0 });
}

async function detect(msg) {
  for await (const chunk of graph.run(msg.audio, msg.conf, msg.step, msg.from)) {
    post({ type: 'chunk', id: msg.id, ...chunk }, [chunk.data.buffer]);
  }
}

const JOBS = {
  detect,
  windows: msg => live.windows(msg.conf, msg.from, msg.count),
};

self.onmessage = async ({ data: msg }) => {
  // Between the awaits of a run: the run reads the samples there are when it starts
  if (msg.type === 'live-start') { live = graph.live(); return; }
  if (msg.type === 'live-audio') { live?.push(msg.pcm); return; }
  if (msg.type === 'init') {
    try {
      await init(msg);
    } catch (err) {
      post({ type: 'error', error: String(err?.message || err) });
    }
    return;
  }
  try {
    const t0 = performance.now();
    const result = await JOBS[msg.type](msg);
    post({ type: 'result', id: msg.id, ms: performance.now() - t0, ...result }, result ? [result.data.buffer] : []);
  } catch (err) {
    post({ type: 'error', id: msg.id, error: String(err?.message || err) });
  }
};
