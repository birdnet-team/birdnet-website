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
import { makeConverter } from './resample.js';

export const SAMPLE_RATE = 32000;

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
 * Decode an audio file to mono Float32 PCM at 32 kHz.
 * @param {Blob} file
 * @param {{onProgress?: (fraction: number) => void}} [options]
 * @returns {Promise<{pcm: Float32Array, duration: number, sourceRate: number|null, channels: number}>}
 */
export async function decodeAudio(file, { onProgress } = {}) {
  let pcm, sourceRate, channels;
  const wav = await parseWav(file).catch(() => null);
  if (wav) {
    if (!wav.frames) throw new Error('empty');
    ({ rate: sourceRate, channels } = wav);
    const conv = makeConverter(sourceRate, SAMPLE_RATE, wav.frames);
    pcm = await convert({ inRate: sourceRate, nIn: wav.frames, length: conv ? conv.length : wav.frames, wav, onProgress });
  } else {
    const encoded = await file.arrayBuffer();
    sourceRate = sniffSampleRate(encoded);
    const buffer = await decodeNative(encoded, sourceRate);
    if (!buffer.length) throw new Error('empty');
    const rate = buffer.sampleRate;
    channels = buffer.numberOfChannels;
    const conv = makeConverter(rate, SAMPLE_RATE, buffer.length);
    const length = conv ? conv.length : buffer.length;
    pcm = conv
      ? await convert({ inRate: rate, nIn: buffer.length, length, input: (i0, i1) => bufferRange(buffer, i0, i1), onProgress })
      : bufferRange(buffer, 0, length);
  }
  if (!pcm.length) throw new Error('empty');
  return { pcm, duration: pcm.length / SAMPLE_RATE, sourceRate, channels };
}

/** Best container the browser can record into. */
function recorderMime() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return options.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

/** Microphone recorder producing a File; raw processing disabled for clean bird audio. */
export class Recorder {
  constructor({ maxSeconds = 300, onTick } = {}) {
    this.maxSeconds = maxSeconds;
    this.onTick = onTick;
    this.chunks = [];
    this.recorder = null;
    this.stream = null;
    this.timer = null;
    this.startedAt = 0;
  }

  get elapsed() { return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0; }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const mimeType = recorderMime();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.start(1000);
    this.startedAt = performance.now();
    this.timer = setInterval(() => {
      this.onTick?.(this.elapsed);
      if (this.elapsed >= this.maxSeconds) this.stop();
    }, 250);
    this.done = new Promise(resolve => {
      this.recorder.onstop = () => {
        clearInterval(this.timer);
        this.stream.getTracks().forEach(track => track.stop());
        const type = this.recorder.mimeType || mimeType || 'audio/webm';
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        resolve(!this.cancelled && this.chunks.length ? new File(this.chunks, `recording_${stamp}.${ext}`, { type }) : null);
      };
    });
  }

  /** Stop and resolve with the recorded File. */
  stop() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    return this.done;
  }

  cancel() {
    this.cancelled = true;
    return this.stop();
  }
}
