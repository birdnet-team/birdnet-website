/**
 * Inference worker: one single-threaded ONNX Runtime Web (WASM) session.
 * The pool in ort-pool.js runs several of these side by side.
 *
 * Messages in:
 *   { type: 'init', ortModule, wasmPaths, model: ArrayBuffer, config }
 *   { type: 'v3', id, audio: Float32Array, batch, samples }
 *   { type: 'v3box', id, audio: Float32Array, sampleRate, flo, fhi, cuts: Float32Array, min }
 *   { type: 'geo', id, inputs: Float32Array (B x [lat, lon, week]), mode: 'probs' | 'grid' }
 * Messages out: { type: 'ready', ms } | { type: 'result', id, ... } | { type: 'error', id, error }
 */

import { isolateBox } from './region-cut.js';

let ort = null;
let session = null;
let config = {};

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

/** Detach a typed array into its own buffer so it can be transferred. */
function own(typed) {
  return typed.byteOffset === 0 && typed.buffer.byteLength === typed.byteLength ? typed : typed.slice();
}

async function init(msg) {
  const t0 = performance.now();
  ort = await import(msg.ortModule);
  ort.env.wasm.wasmPaths = msg.wasmPaths;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'error';
  config = msg.config || {};
  session = await ort.InferenceSession.create(new Uint8Array(msg.model), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  post({ type: 'ready', ms: performance.now() - t0 });
}

async function runV3(msg) {
  const input = new ort.Tensor('float32', msg.audio, [msg.batch, msg.samples]);
  const out = await session.run({ [config.input]: input }, [config.output]);
  const scores = own(out[config.output].data);
  return [{ scores }, [scores.buffer]];
}

/**
 * The audio of one box: what is outside the box's band, and the regions `cuts` (the
 * sound of other boxes inside it), are replaced by background noise; then it is scored
 * at its own length (the model takes any). Returns the classes scoring at least `min`,
 * not the whole table.
 */
async function runV3Box(msg) {
  const clip = isolateBox(msg.audio, msg.sampleRate, msg.flo, msg.fhi, msg.cuts);
  const input = new ort.Tensor('float32', clip, [1, clip.length]);
  const out = await session.run({ [config.input]: input }, [config.output]);
  const scores = out[config.output].data, min = msg.min;
  let n = 0;
  for (let s = 0; s < scores.length; s++) if (scores[s] >= min) n++;
  const index = new Int32Array(n), score = new Float32Array(n);
  for (let s = 0, k = 0; s < scores.length; s++) if (scores[s] >= min) { index[k] = s; score[k++] = scores[s]; }
  return [{ index, score }, [index.buffer, score.buffer]];
}

async function runGeo(msg) {
  const rows = msg.inputs.length / 3;
  const input = new ort.Tensor('float32', msg.inputs, [rows, 3]);
  if (msg.mode === 'probs') {
    const out = await session.run({ [config.input]: input }, [config.output]);
    const probs = own(out[config.output].data);
    return [{ probs }, [probs.buffer]];
  }
  // Grid mode: species embedding per row plus species counts per threshold
  // and taxon class, so the map never has to move full probability tables.
  const out = await session.run({ [config.input]: input }, [config.output, config.features]);
  const probs = out[config.output].data;
  const features = own(out[config.features].data);
  const thresholds = config.thresholds, classOf = config.classOf, nClasses = config.nClasses;
  const nThr = thresholds.length, stride = nClasses + 1, S = classOf.length;
  const counts = new Uint16Array(rows * nThr * stride);
  const t0 = thresholds[0];
  for (let r = 0; r < rows; r++) {
    const base = r * S, cbase = r * nThr * stride;
    for (let s = 0; s < S; s++) {
      const p = probs[base + s];
      if (p < t0 || classOf[s] >= nClasses) continue;   // below every threshold, or not a species of the demo
      const c = classOf[s] + 1;
      for (let k = 0; k < nThr && p >= thresholds[k]; k++) {
        counts[cbase + k * stride]++;
        counts[cbase + k * stride + c]++;
      }
    }
  }
  return [{ features, counts }, [features.buffer, counts.buffer]];
}

const handlers = { v3: runV3, v3box: runV3Box, geo: runGeo };

self.onmessage = async ({ data: msg }) => {
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
    const [result, transfer] = await handlers[msg.type](msg);
    post({ type: 'result', id: msg.id, ms: performance.now() - t0, ...result }, transfer);
  } catch (err) {
    post({ type: 'error', id: msg.id, error: String(err?.message || err) });
  }
};
