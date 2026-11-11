/**
 * Audio decoding and recording for the demo.
 *
 * Recordings become 32 kHz mono (the V3.0 and BirdBox input), like
 * librosa.load(sr=32000, mono=True) in the desktop tools. The browser only
 * decodes; sample rate conversion is our own anti-aliased resampler
 * (resample.js), because the browsers' built-in resamplers let content
 * just above 16 kHz fold back into the bird band. Files that are already
 * 32 kHz are not filtered at all, so their samples match the desktop bit
 * for bit.
 *
 * PCM WAV files are read straight from disk in ranges, so long or
 * high-rate field recordings never sit in memory at their native rate.
 * Other formats go through decodeAudioData at their native rate (at most
 * 48 kHz; the browser's own aliasing from higher rates then stays above
 * 16 kHz, where our filter removes it). Several workers convert ranges of
 * the recording in parallel.
 */
import { makeConverter, StreamConverter } from './resample.js';

export const SAMPLE_RATE = 32000;
/** Longest stretch of a recording the demo analyzes; longer files are cut. */
export const MAX_SECONDS = 61 * 60;

const MAX_DECODE_RATE = 48000;
const JOB_SECONDS = 20;

const ascii = (b, p, n) => String.fromCharCode(...b.subarray(p, p + n));

/**
 * PCM layout of a WAV file (integer or float samples, also RF64 and
 * WAVE_FORMAT_EXTENSIBLE), or null when the file is no WAV this code reads.
 */
async function parseWav(file) {
  const read = async (p, n) => new Uint8Array(await file.slice(p, p + n).arrayBuffer());
  const head = await read(0, 12);
  if (head.length < 12 || !['RIFF', 'RF64'].includes(ascii(head, 0, 4)) || ascii(head, 8, 4) !== 'WAVE') return null;
  let fmt = null;
  for (let p = 12; p + 8 <= file.size;) {
    const h = await read(p, 8), id = ascii(h, 0, 4);
    let size = new DataView(h.buffer).getUint32(4, true);
    if (id === 'fmt ') {
      const f = new DataView((await read(p + 8, Math.min(size, 40))).buffer);
      if (f.byteLength < 16) return null;
      let tag = f.getUint16(0, true);
      if (tag === 0xfffe && f.byteLength >= 26) tag = f.getUint16(24, true);
      fmt = { tag, channels: f.getUint16(2, true), rate: f.getUint32(4, true), blockAlign: f.getUint16(12, true) };
    } else if (id === 'data') {
      if (!fmt?.channels || !fmt.rate) return null;
      const bytes = fmt.blockAlign / fmt.channels, float = fmt.tag === 3;
      if (!Number.isInteger(bytes) || !(fmt.tag === 1 && bytes >= 1 && bytes <= 4) && !(float && (bytes === 4 || bytes === 8))) return null;
      // RF64 and streamed files carry no usable size here; cut-off files end early
      const avail = file.size - (p + 8);
      if (size === 0xffffffff || size === 0 || size > avail) size = avail;
      return { file, offset: p + 8, blockAlign: fmt.blockAlign, channels: fmt.channels, rate: fmt.rate, float, bytes, frames: Math.floor(size / fmt.blockAlign) };
    }
    p += 8 + size + (size & 1);
  }
  return null;
}

/**
 * Native sample rate from a WAV, FLAC, MP3 or Ogg header (null if unknown).
 * Opus always decodes at 48 kHz.
 */
function sniffSampleRate(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1 << 20)), dv = new DataView(buffer);
  const tag = ascii(b, 0, 4);
  if (tag === 'RIFF') {
    for (let p = 12; p + 16 <= b.length;) {
      const size = dv.getUint32(p + 4, true);
      if (ascii(b, p, 4) === 'fmt ') return dv.getUint32(p + 12, true);
      p += 8 + size + (size & 1);
    }
    return null;
  }
  if (tag === 'fLaC' && b.length > 21) return (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  if (tag === 'OggS' && b.length > 27) {
    const p = 27 + b[26];  // first packet, after the segment table
    if (ascii(b, p, 8) === 'OpusHead') return 48000;
    if (ascii(b, p + 1, 6) === 'vorbis' && b.length >= p + 16) return dv.getUint32(p + 12, true);
    return null;
  }
  let p = 0;
  if (tag.startsWith('ID3') && b.length > 10) p = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
  for (let i = p; i < Math.min(b.length - 3, p + 65536); i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, index = (b[i + 2] >> 2) & 3;
    if (version === 1 || layer === 0 || index === 3) continue;
    const base = [44100, 48000, 32000][index];
    return version === 3 ? base : version === 2 ? base / 2 : base / 4;
  }
  return null;
}

/**
 * Decode with the browser at `rate`, or at 48 kHz when unknown or higher.
 * Engines that refuse the rate fall back to 48 kHz, then to the device rate.
 */
async function decodeNative(buffer, rate) {
  const want = rate && rate <= MAX_DECODE_RATE ? rate : MAX_DECODE_RATE;
  let ctx = null;
  for (const r of [want, 48000]) {
    try { ctx = new OfflineAudioContext(1, 1, r); break; } catch { /* rate not supported here */ }
  }
  if (ctx) return ctx.decodeAudioData(buffer);
  const live = new (window.AudioContext || window.webkitAudioContext)();
  try { return await live.decodeAudioData(buffer); } finally { live.close?.(); }
}

const workerCount = () => Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

/**
 * Convert input samples to `length` samples at 32 kHz with a pool of
 * audio-worker.js workers. Workers read WAV files themselves; otherwise
 * input(i0, i1) supplies mono samples for each job.
 */
async function convert({ inRate, nIn, length, wav = null, input = null, onProgress }) {
  const conv = makeConverter(inRate, SAMPLE_RATE, nIn);
  const out = new Float32Array(length), jobs = [];
  for (let o = 0; o < length; o += JOB_SECONDS * SAMPLE_RATE) jobs.push([o, Math.min(length, o + JOB_SECONDS * SAMPLE_RATE)]);
  const workers = Array.from({ length: Math.min(jobs.length, workerCount()) },
    () => new Worker(new URL('./audio-worker.js', import.meta.url), { type: 'module' }));
  let next = 0, done = 0;
  try {
    await Promise.all(workers.map(w => new Promise((resolve, reject) => {
      w.onerror = e => { e.preventDefault?.(); reject(new Error(e.message || 'audio worker failed')); };
      w.onmessage = ({ data }) => {
        if (data.error) { reject(new Error(data.error)); return; }
        if (data.out) {
          out.set(data.out, data.o0);
          onProgress?.(++done / jobs.length);
        }
        if (next >= jobs.length) { resolve(); return; }
        const [o0, o1] = jobs[next++];
        const pcm = wav ? null : input(...(conv ? conv.span(o0, o1) : [o0, o1]));
        w.postMessage({ type: 'job', o0, o1, pcm }, pcm ? [pcm.buffer] : []);
      };
      w.postMessage({ type: 'init', inRate, outRate: SAMPLE_RATE, nIn, wav });
    })));
  } finally {
    workers.forEach(w => w.terminate());
  }
  return out;
}

/** Mono samples [i0, i1) of an AudioBuffer, zero outside it (channel mean in float32). */
function bufferRange(buffer, i0, i1) {
  const x = new Float32Array(i1 - i0), a = Math.max(0, i0), b = Math.min(buffer.length, i1);
  if (b <= a) return x;
  const n = buffer.numberOfChannels, view = x.subarray(a - i0, b - i0);
  for (let c = 0; c < n; c++) {
    const data = buffer.getChannelData(c).subarray(a, b);
    if (c === 0) view.set(data);
    else for (let i = 0; i < view.length; i++) view[i] += data[i];
  }
  if (n > 1) for (let i = 0; i < view.length; i++) view[i] /= n;
  return x;
}

/**
 * Decode an audio file to mono Float32 PCM at 32 kHz, at most MAX_SECONDS.
 * @param {Blob} file
 * @param {{onProgress?: (fraction: number) => void}} [options]
 * @returns {Promise<{pcm: Float32Array, duration: number, fullDuration: number, sourceRate: number|null, channels: number}>}
 */
export async function decodeAudio(file, { onProgress } = {}) {
  const maxOut = MAX_SECONDS * SAMPLE_RATE;
  let pcm, sourceRate, channels, fullDuration;
  const wav = await parseWav(file).catch(() => null);
  if (wav) {
    if (!wav.frames) throw new Error('empty');
    ({ rate: sourceRate, channels } = wav);
    fullDuration = wav.frames / sourceRate;
    const conv = makeConverter(sourceRate, SAMPLE_RATE, wav.frames);
    pcm = await convert({ inRate: sourceRate, nIn: wav.frames, length: Math.min(maxOut, conv ? conv.length : wav.frames), wav, onProgress });
  } else {
    const encoded = await file.arrayBuffer();
    sourceRate = sniffSampleRate(encoded);
    const buffer = await decodeNative(encoded, sourceRate);
    if (!buffer.length) throw new Error('empty');
    const rate = buffer.sampleRate;
    channels = buffer.numberOfChannels;
    fullDuration = buffer.length / rate;
    const conv = makeConverter(rate, SAMPLE_RATE, buffer.length);
    const length = Math.min(maxOut, conv ? conv.length : buffer.length);
    pcm = conv
      ? await convert({ inRate: rate, nIn: buffer.length, length, input: (i0, i1) => bufferRange(buffer, i0, i1), onProgress })
      : bufferRange(buffer, 0, length);
  }
  if (!pcm.length) throw new Error('empty');
  return { pcm, duration: pcm.length / SAMPLE_RATE, fullDuration, sourceRate, channels };
}

/** 16-bit PCM WAV of Int16Array chunks. */
function wavBytes(chunks, rate) {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new ArrayBuffer(44 + samples * 2), view = new DataView(bytes);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples * 2, true);
  let o = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++, o += 2) view.setInt16(o, chunk[i], true);
  }
  return bytes;
}

/**
 * Microphone recorder: raw samples with the browser's processing turned off,
 * converted to 32 kHz as they arrive and kept as a 16-bit WAV, so a recording
 * reaches the models without the compression of a browser recording. onAudio
 * gets the samples as they arrive, exactly as the file will decode to them,
 * so what is found while recording is what the file gives. stop() returns
 * the file.
 */
export class Recorder {
  constructor({ maxSeconds = 300, onTick, onAudio, onLimit } = {}) {
    this.maxSeconds = maxSeconds;
    this.onTick = onTick;
    this.onAudio = onAudio;
    this.onLimit = onLimit;   // the limit was reached, or the microphone went away
    this.chunks = [];
    this.samples = 0;         // at the device's rate
    this.rate = 0;
    this.stream = null;
    this.timer = null;
    this.stopped = false;
  }

  /** Seconds recorded so far. */
  get elapsed() { return this.rate ? this.samples / this.rate : 0; }

  async start() {
    // Created before the permission prompt, while the click still counts as a
    // user gesture; a context created later may stay suspended and read zeros.
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      await this.audioContext.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
    } catch (err) {
      this.stream?.getTracks().forEach(track => track.stop());
      this.audioContext.close().catch(() => {});
      throw err;
    }
    this.rate = this.audioContext.sampleRate;
    this.converter = new StreamConverter(this.rate, SAMPLE_RATE);
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.tap = new AudioWorkletNode(this.audioContext, 'demo-recorder-tap', { numberOfOutputs: 1, outputChannelCount: [1] });
    // Connected, so every browser keeps pulling the tap; it writes silence
    this.source.connect(this.tap).connect(this.audioContext.destination);
    this.tap.port.onmessage = ({ data }) => this._onChunk(data);
    this.stream.getAudioTracks()[0]?.addEventListener('ended', () => this.onLimit?.());
    this.audioContext.resume().catch(() => {});
    this.startDate = new Date();
    this.timer = setInterval(() => this.onTick?.(this.elapsed), 250);
  }

  _onChunk(chunk) {
    if (this.stopped) return;
    const room = Math.round(this.maxSeconds * this.rate) - this.samples;
    if (chunk.length >= room) {
      chunk = chunk.subarray(0, Math.max(0, room));
      if (!this.limited) {
        this.limited = true;
        queueMicrotask(() => this.onLimit?.());
      }
    }
    if (!chunk.length) return;
    this.samples += chunk.length;
    this._keep(this.converter.process(chunk));
  }

  /** Samples at 32 kHz: rounded to 16 bits for the file, and passed on as the file will decode to them. */
  _keep(pcm) {
    if (!pcm.length) return;
    const values = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const v = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32768)));
      values[i] = v;
      pcm[i] = v / 32768;
    }
    this.chunks.push(values);
    this.onAudio?.(pcm);
  }

  _release() {
    this.stopped = true;
    clearInterval(this.timer);
    this.source?.disconnect();
    this.tap?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    this.audioContext?.close().catch(() => {});
  }

  /** Stop and return the recording as a WAV file (null if nothing arrived). */
  stop() {
    if (this.stopped) return null;
    this._release();
    if (!this.samples) return null;
    this._keep(this.converter.flush());
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return new File([wavBytes(this.chunks, SAMPLE_RATE)], `recording_${stamp}.wav`, { type: 'audio/wav' });
  }

  cancel() {
    this._release();
    this.chunks = [];
  }
}
