/**
 * Inference worker: one single-threaded ONNX Runtime Web (WASM) session.
 * The pool in ort-pool.js runs several of these side by side.
 *
 * Messages in:
 *   { type: 'init', ortModule, wasmPaths, model: ArrayBuffer, config }
 *   { type: 'v3', id, audio: Float32Array, batch, samples }
 *   { type: 'geo', id, inputs: Float32Array (B x [lat, lon, week]), mode: 'probs' | 'grid' }
 *   { type: 'birdbox', id, audio: Float32Array, conf, songGap }
 * Messages out: { type: 'ready', ms } | { type: 'result', id, ... } | { type: 'error', id, error }
 */

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
  const feat = out[config.features].data;
  const features = feat instanceof Uint16Array ? feat.slice() : new Uint16Array(feat.buffer, feat.byteOffset, feat.length).slice();
  const thresholds = config.thresholds, classOf = config.classOf, nClasses = config.nClasses;
  const nThr = thresholds.length, stride = nClasses + 1, S = classOf.length;
  const counts = new Uint16Array(rows * nThr * stride);
  const t0 = thresholds[0];
  for (let r = 0; r < rows; r++) {
    const base = r * S, cbase = r * nThr * stride;
    for (let s = 0; s < S; s++) {
      const p = probs[base + s];
      if (p < t0) continue;
      const c = classOf[s] + 1;
      for (let k = 0; k < nThr && p >= thresholds[k]; k++) {
        counts[cbase + k * stride]++;
        counts[cbase + k * stride + c]++;
      }
    }
  }
  return [{ features, counts }, [features.buffer, counts.buffer]];
}

async function runBirdbox(msg) {
  const feeds = {
    audio: new ort.Tensor('float32', msg.audio, [msg.audio.length]),
    conf: new ort.Tensor('float32', Float32Array.of(msg.conf), [1]),
    song_gap: new ort.Tensor('float32', Float32Array.of(msg.songGap), [1]),
  };
  const out = await session.run(feeds);
  const tensor = out[session.outputNames[0]];
  const detections = own(tensor.data);
  return [{ detections, rows: tensor.dims[0] || 0 }, [detections.buffer]];
}

const handlers = { v3: runV3, geo: runGeo, birdbox: runBirdbox };

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
