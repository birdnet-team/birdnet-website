/**
 * Audio conversion worker: turns one range of a recording into 32 kHz mono.
 * Several of these run side by side while a file loads (see audio.js).
 *
 * Messages in:
 *   { type: 'init', inRate, outRate, nIn, wav }   wav: PCM layout of a WAV file to read here, or null
 *   { type: 'job', o0, o1, pcm }                  pcm: mono input covering span(o0, o1), when wav is null
 * Messages out: { ready: true } | { o0, out: Float32Array } | { error }
 */
import { makeConverter } from './resample.js';

let conv = null, wav = null, nIn = 0;

/** Mono float samples [i0, i1) of a PCM WAV file, zero outside the recording. */
async function readWav(i0, i1) {
  const x = new Float32Array(i1 - i0);
  const a = Math.max(0, i0), b = Math.min(nIn, i1);
  if (b <= a) return x;
  const { file, offset, blockAlign, channels, float, bytes } = wav;
  const buf = await file.slice(offset + a * blockAlign, offset + b * blockAlign).arrayBuffer();
  const frames = Math.floor(buf.byteLength / blockAlign), n = frames * channels;
  let read;
  if (float) {
    const v = bytes === 4 ? new Float32Array(buf, 0, n) : new Float64Array(buf, 0, n);
    read = i => v[i];
  } else if (bytes === 2) {
    const v = new Int16Array(buf, 0, n);
    read = i => v[i] / 32768;
  } else if (bytes === 3) {
    const v = new Uint8Array(buf);
    read = i => ((v[3 * i] | (v[3 * i + 1] << 8) | (v[3 * i + 2] << 24 >> 8))) / 8388608;
  } else if (bytes === 4) {
    const v = new Int32Array(buf, 0, n);
    read = i => v[i] / 2147483648;
  } else {
    const v = new Uint8Array(buf);
    read = i => (v[i] - 128) / 128;
  }
  const o = a - i0;
  if (channels === 1) {
    for (let f = 0; f < frames; f++) x[o + f] = read(f);
  } else {
    // Channel mean in float32, like summing AudioBuffer channels into a Float32Array
    for (let f = 0; f < frames; f++) {
      let s = Math.fround(read(f * channels));
      for (let c = 1; c < channels; c++) s = Math.fround(s + Math.fround(read(f * channels + c)));
      x[o + f] = s / channels;
    }
  }
  return x;
}

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'init') {
      conv = makeConverter(msg.inRate, msg.outRate, msg.nIn);
      wav = msg.wav;
      nIn = msg.nIn;
      self.postMessage({ ready: true });
      return;
    }
    const [i0, i1] = conv ? conv.span(msg.o0, msg.o1) : [msg.o0, msg.o1];
    const x = msg.pcm || await readWav(i0, i1);
    const out = conv ? conv.process(x, i0, msg.o0, msg.o1) : x;
    self.postMessage({ o0: msg.o0, out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};
