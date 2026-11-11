/**
 * Spectrogram worker for the demo viewers.
 *
 * 'stft': log-power spectrogram for display (Hann, 1024-point FFT, 10 ms hop,
 *         0 Hz up to fMax, 12 kHz by default), with each band's noise floor
 *         subtracted so calls stand out.
 *
 * The page keeps the audio: the worker gets its length and asks for the
 * sample ranges it needs, a block at a time, so an hour of audio is never
 * copied in full.
 *   in:  { type: 'stft', id, length, sampleRate, fMax }  then  { type: 'pcm', data: Float32Array[] } per request
 *   out: { type: 'want', ranges: [[start, end], ...] }   samples outside the recording come back as zeros
 *
 * Results stream back in slices of frames (Uint8 levels, frame-major):
 *   { type: 'meta', id, frames, rows, fps, floor }  then  { type: 'slice', id, start, data }  then  { type: 'done', id }
 *
 * 'live-start', then 'live-audio' for each piece of a recording in progress:
 *         the same spectrogram, one frame at a time. The whole recording is
 *         not known yet, so each band's noise floor comes from the last seconds.
 *   in:  { type: 'live-start', id, sampleRate, fMax }  then  { type: 'live-audio', pcm: Float32Array }
 *   out: { type: 'meta', id, rows, fps, floor }  then  { type: 'live-frames', id, start, data }
 */

let answer = null;

/** Ask the page for sample ranges; resolves with one Float32Array per range. */
function want(ranges) {
  return new Promise(resolve => {
    answer = resolve;
    postMessage({ type: 'want', ranges });
  });
}

const fftCache = new Map();

function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  t = { rev, cos, sin };
  fftCache.set(n, t);
  return t;
}

/** In-place iterative radix-2 FFT. */
function fft(re, im) {
  const n = re.length, { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const a = start + k, b = a + half;
        const tr = re[b] * cos[w] - im[b] * sin[w];
        const ti = re[b] * sin[w] + im[b] * cos[w];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

async function stft(id, length, sampleRate, fMax = 12000) {
  const N = 1024, HOP = Math.round(sampleRate / 100), ROWS = Math.round(Math.min(fMax, sampleRate / 2) / (sampleRate / N));
  const frames = Math.max(1, Math.floor((length - N) / HOP) + 1);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const re = new Float64Array(N), im = new Float64Array(N);
  // pcm holds samples from pcmStart on
  const frameDb = (pcm, pcmStart, f, out) => {
    const off = f * HOP - pcmStart;
    for (let i = 0; i < N; i++) { re[i] = (pcm[off + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < ROWS; k++) out[k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-12);
  };
  // Display contrast: subtract each band's noise floor (median level over a
  // sample of frames), so calls stand out over wind and traffic rumble.
  const sampleCount = Math.min(frames, 600), tmp = new Float32Array(ROWS);
  const sampled = Array.from({ length: sampleCount }, (_, s) => Math.floor((s + 0.5) * frames / sampleCount));
  const sampledPcm = await want(sampled.map(f => [f * HOP, f * HOP + N]));
  const byRow = Array.from({ length: ROWS }, () => new Float32Array(sampleCount));
  for (let s = 0; s < sampleCount; s++) {
    frameDb(sampledPcm[s], sampled[s] * HOP, sampled[s], tmp);
    for (let k = 0; k < ROWS; k++) byRow[k][s] = tmp[k];
  }
  const noise = new Float32Array(ROWS), residual = new Float32Array(sampleCount * ROWS);
  for (let k = 0; k < ROWS; k++) {
    const sorted = byRow[k].slice().sort();
    noise[k] = percentile(sorted, 0.5);
    for (let s = 0; s < sampleCount; s++) residual[s * ROWS + k] = byRow[k][s] - noise[k];
  }
  residual.sort();
  // Quantize -6..hi dB above the noise floor; the viewer's default display
  // starts at +7 dB and the brightness control can reach below that.
  const lo = -6, hi = Math.max(24, percentile(residual, 0.9995));
  postMessage({ type: 'meta', id, frames, rows: ROWS, fps: sampleRate / HOP, hzPerRow: sampleRate / N, floor: (7 - lo) / (hi - lo) });
  const SLICE = 1024;
  for (let start = 0; start < frames; start += SLICE) {
    const end = Math.min(frames, start + SLICE), data = new Uint8Array((end - start) * ROWS);
    const [pcm] = await want([[start * HOP, (end - 1) * HOP + N]]);
    for (let f = start; f < end; f++) {
      frameDb(pcm, start * HOP, f, tmp);
      const o = (f - start) * ROWS;
      for (let k = 0; k < ROWS; k++) {
        const v = (tmp[k] - noise[k] - lo) / (hi - lo);
        data[o + k] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(255 * v);
      }
    }
    postMessage({ type: 'slice', id, start, data }, [data.buffer]);
  }
  postMessage({ type: 'done', id });
}

const LIVE_FLOOR_SECONDS = 20;  // audio behind the noise floor of a recording in progress
const LIVE_FLOOR_FRAMES = 300;  // frames kept from it
const LIVE_FLOOR_REFRESH = 25;  // frames between updates of the floor
const LIVE_FIRST_FRAMES = 12;   // about 0.1 s until the first frames can be levelled

/**
 * The spectrogram of audio that is still arriving. Frames line up with the
 * finished spectrogram's. Bands are levelled by a running estimate of their
 * noise floor, and frames already sent stay as they are.
 */
class LiveSpectrogram {
  constructor(id, sampleRate, fMax = 12000) {
    const N = 1024;
    this.id = id;
    this.n = N;
    this.hop = Math.round(sampleRate / 100);
    this.rows = Math.round(Math.min(fMax, sampleRate / 2) / (sampleRate / N));
    // The finished spectrogram's range: -6 dB up to its loudest calls, usually about here
    this.lo = -6;
    this.hi = 28;
    this.win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.buffer = new Float32Array(1 << 18);
    this.length = 0;     // samples in the buffer
    this.position = 0;   // where the next frame starts in it
    this.frames = 0;
    this.sent = 0;
    this.held = [];      // the first frames, until there is a floor to level them with
    // History for the floor: one frame in every `every` over the last LIVE_FLOOR_SECONDS
    const fps = sampleRate / this.hop;
    this.every = Math.max(1, Math.round(fps * LIVE_FLOOR_SECONDS / LIVE_FLOOR_FRAMES));
    this.history = new Float32Array(LIVE_FLOOR_FRAMES * this.rows);
    this.stored = 0;
    this.floor = new Float32Array(this.rows);
    this.current = new Float32Array(this.rows);
    postMessage({ type: 'meta', id, rows: this.rows, fps, hzPerRow: sampleRate / N, floor: (7 - this.lo) / (this.hi - this.lo) });
  }

  _frame(offset) {
    const { n, re, im, win, buffer, rows, current } = this;
    for (let i = 0; i < n; i++) { re[i] = buffer[offset + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < rows; k++) current[k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-12);
  }

  /** Each band's median over the frames in `column(k, s)`, s = 0..count-1. */
  _updateFloor(count, column) {
    const sorted = new Float32Array(count);
    for (let k = 0; k < this.rows; k++) {
      for (let s = 0; s < count; s++) sorted[s] = column(k, s);
      sorted.sort();
      this.floor[k] = percentile(sorted, 0.5);
    }
  }

  _levels(db) {
    const levels = new Uint8Array(this.rows), { lo, hi, floor } = this;
    for (let k = 0; k < this.rows; k++) {
      const v = (db[k] - floor[k] - lo) / (hi - lo);
      levels[k] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(255 * v);
    }
    return levels;
  }

  push(pcm) {
    if (this.length + pcm.length > this.buffer.length) {
      // Samples before the next frame are done with
      this.buffer.copyWithin(0, this.position, this.length);
      this.length -= this.position;
      this.position = 0;
      if (this.length + pcm.length > this.buffer.length) {
        const grown = new Float32Array(2 * (this.length + pcm.length));
        grown.set(this.buffer.subarray(0, this.length));
        this.buffer = grown;
      }
    }
    this.buffer.set(pcm, this.length);
    this.length += pcm.length;
    const out = [];
    while (this.position + this.n <= this.length) {
      this._frame(this.position);
      this.position += this.hop;
      if (this.frames % this.every === 0) {
        this.history.set(this.current, (this.stored % LIVE_FLOOR_FRAMES) * this.rows);
        this.stored++;
      }
      this.frames++;
      // The floor needs a little history; it then follows the sounds
      if (this.frames < LIVE_FIRST_FRAMES) {
        this.held.push(this.current.slice());
        continue;
      }
      if (this.held.length) this._updateFloor(this.held.length, (k, j) => this.held[j][k]);
      else if (this.frames % LIVE_FLOOR_REFRESH === 0) this._updateFloor(Math.min(this.stored, LIVE_FLOOR_FRAMES), (k, j) => this.history[j * this.rows + k]);
      for (const held of this.held) out.push(this._levels(held));
      this.held.length = 0;
      out.push(this._levels(this.current));
    }
    if (!out.length) return;
    const data = new Uint8Array(out.length * this.rows);
    out.forEach((levels, j) => data.set(levels, j * this.rows));
    postMessage({ type: 'live-frames', id: this.id, start: this.sent, data }, [data.buffer]);
    this.sent += out.length;
  }
}

let live = null;

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'pcm') { answer?.(msg.data); return; }
  try {
    if (msg.type === 'live-start') live = new LiveSpectrogram(msg.id, msg.sampleRate, msg.fMax);
    else if (msg.type === 'live-audio') live?.push(msg.pcm);
    else if (msg.type === 'stft') await stft(msg.id, msg.length, msg.sampleRate, msg.fMax);
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, error: String(err?.message || err) });
  }
};
