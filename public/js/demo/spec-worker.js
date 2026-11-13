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
 *         not known yet, so each band's noise floor comes from the last seconds;
 *         the first frames wait until the microphone's input has settled.
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
const LIVE_SETTLE = 30;         // frames of settled input the first floor is taken from (0.3 s)
const LIVE_HOLD = 100;          // at most this many frames of input are held back for it (1 s)
const LIVE_RISE_DB = 3;         // input has settled when its level rose less than this over the last 0.15 s
const LIVE_JUMP_DB = 10;        // a frame this far above the floor in most bands: the input itself got louder
const LIVE_WAKE = 300;          // ... which starts the floor anew only in the first 3 s of sound (a microphone waking up late)
const LIVE_POOL = 8;            // bands on each side a floor from few frames also takes in
const LIVE_POOLED_UNTIL = 60;   // ... until it rests on this many frames
const SILENT_DB = -115;         // frames below this in every band are digital silence (1e-12 power is -120 dB)
// The brightest colour, as in the finished spectrogram: the 99.95th percentile of the levels above
// the floor, at least 24 dB. The colours start at +7 dB, which stays at the same place in the scale.
const HI_MIN = 24, HI_QUANTILE = 0.9995, CUT = (7 + 6) / (HI_MIN + 6);
const RES_MIN = -60, RES_STEP = 0.1, RES_BINS = 1500;   // histogram of the levels above the floor, -60..90 dB

/** The value at quantile q of the first n values of a, which it reorders. */
function select(a, n, q) {
  const sorted = a.subarray(0, n).sort();
  return percentile(sorted, q);
}

/**
 * The spectrogram of audio that is still arriving. Frames line up with the
 * finished spectrogram's. Bands are levelled by a running estimate of their
 * noise floor, and frames already sent stay as they are.
 *
 * A microphone's first moments are often a fade-in or near silence. So frames are
 * held back until the input has settled (its level stops rising, at least 0.3 s
 * and at most 1 s of sound), the floor is taken from the settled frames, and the
 * held frames are then levelled with it. While a floor rests on few frames, each
 * band also takes in its neighbours: noise changes smoothly with frequency. When,
 * in the first 3 s of sound, the input itself gets much louder in most bands for
 * 0.3 s (a microphone that comes alive late), the floor is taken anew the same way.
 * The brightest colour follows the loudest levels so far, as in the finished
 * spectrogram.
 */
class LiveSpectrogram {
  constructor(id, sampleRate, fMax = 12000) {
    const N = 1024;
    this.id = id;
    this.n = N;
    this.hop = Math.round(sampleRate / 100);
    this.rows = Math.round(Math.min(fMax, sampleRate / 2) / (sampleRate / N));
    this.residuals = new Float64Array(RES_BINS);
    this.counted = 0;
    this._setRange(HI_MIN);
    this.win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.buffer = new Float32Array(1 << 18);
    this.length = 0;     // samples in the buffer
    this.position = 0;   // where the next frame starts in it
    this.frames = 0;
    this.sent = 0;
    this.held = [];      // frames not sent yet: { db, sound, index, level }
    this.settled = false;
    this.firstSound = -1;  // the first frame that is not digital silence
    // History for the floor: one frame in every `every` over the last LIVE_FLOOR_SECONDS
    const fps = sampleRate / this.hop;
    this.every = Math.max(1, Math.round(fps * LIVE_FLOOR_SECONDS / LIVE_FLOOR_FRAMES));
    this.history = new Float32Array(LIVE_FLOOR_FRAMES * this.rows);
    this.stored = 0;
    this.floor = new Float32Array(this.rows);
    this.pool = new Float32Array(LIVE_FLOOR_FRAMES * (2 * LIVE_POOL + 1));
    postMessage({ type: 'meta', id, rows: this.rows, fps, hzPerRow: sampleRate / N, floor: (7 - this.lo) / (this.hi - this.lo) });
  }

  _frame(offset) {
    const { n, re, im, win, buffer, rows } = this, db = new Float32Array(rows);
    for (let i = 0; i < n; i++) { re[i] = buffer[offset + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < rows; k++) db[k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-12);
    return db;
  }

  /**
   * Each band's median over `count` frames (frame(j) gives frame j's dB), taking in
   * `reach` bands on each side.
   */
  _setFloor(count, frame, reach) {
    const { rows, pool, floor } = this;
    for (let k = 0; k < rows; k++) {
      let c = 0;
      for (let b = Math.max(0, k - reach); b <= Math.min(rows - 1, k + reach); b++) for (let j = 0; j < count; j++) pool[c++] = frame(j)[b];
      floor[k] = select(pool, c, 0.5);
    }
  }

  /** The floor from the history, taking in neighbouring bands while it is short. */
  _historyFloor() {
    const count = Math.min(this.stored, LIVE_FLOOR_FRAMES), rows = this.rows, history = this.history;
    if (!count) return;   // nothing but digital silence so far
    const reach = Math.round(LIVE_POOL * Math.max(0, 1 - count / LIVE_POOLED_UNTIL));
    const views = Array.from({ length: count }, (_, j) => history.subarray(j * rows, (j + 1) * rows));
    this._setFloor(count, j => views[j], reach);
  }

  _remember(db) {
    if (this.frames % this.every === 0) {
      this.history.set(db, (this.stored % LIVE_FLOOR_FRAMES) * this.rows);
      this.stored++;
    }
  }

  /** Levels from lo to hi dB above the floor, +7 dB at the same place for any hi (CUT). */
  _setRange(hi) {
    this.hi = hi;
    this.lo = (7 - CUT * hi) / (1 - CUT);
  }

  /** Count a frame's levels above the floor. */
  _count(db) {
    const { rows, floor, residuals } = this;
    for (let k = 0; k < rows; k++) {
      const bin = Math.floor((db[k] - floor[k] - RES_MIN) / RES_STEP);
      residuals[bin < 0 ? 0 : bin >= RES_BINS ? RES_BINS - 1 : bin]++;
    }
    this.counted += rows;
  }

  /** hi from the levels counted so far. */
  _updateRange() {
    let above = this.counted * (1 - HI_QUANTILE), bin = RES_BINS - 1;
    for (; bin > 0 && above > this.residuals[bin]; bin--) above -= this.residuals[bin];
    this._setRange(Math.max(HI_MIN, RES_MIN + (bin + 0.5) * RES_STEP));
  }

  /** Start the floor anew from the last LIVE_SETTLE frames of sound held back. */
  _settle() {
    // Digital silence only (a muted microphone): a floor from it shows it dark
    let sound = this.held.filter(h => h.sound).slice(-LIVE_SETTLE);
    if (!sound.length) sound = this.held.slice(-LIVE_SETTLE);
    this._setFloor(sound.length, j => sound[j].db, LIVE_POOL);
    this.stored = 0;
    for (const h of sound) if (h.index % this.every === 0) {
      this.history.set(h.db, (this.stored % LIVE_FLOOR_FRAMES) * this.rows);
      this.stored++;
    }
    for (const h of sound) this._count(h.db);
    this._updateRange();
    this.settled = true;
  }

  /** Has the input settled: enough sound held back, and its level no longer rising? */
  _hasSettled() {
    const sound = this.held.filter(h => h.sound);
    if (sound.length >= LIVE_HOLD || (!sound.length && this.held.length >= LIVE_HOLD)) return true;
    if (sound.length < LIVE_SETTLE) return false;
    const recent = sound.slice(-LIVE_SETTLE), half = LIVE_SETTLE >> 1;
    const level = list => { const x = Float32Array.from(list, h => h.level); return select(x, x.length, 0.5); };
    return level(recent.slice(half)) - level(recent.slice(0, half)) < LIVE_RISE_DB;
  }

  /** How far a frame lies above the floor in most bands. */
  _above(db) {
    const d = new Float32Array(this.rows);
    for (let k = 0; k < this.rows; k++) d[k] = db[k] - this.floor[k];
    return select(d, d.length, 0.5);
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
    const release = () => { for (const h of this.held) out.push(this._levels(h.db)); this.held.length = 0; };
    while (this.position + this.n <= this.length) {
      const db = this._frame(this.position);
      this.position += this.hop;
      const index = this.frames++;
      let max = -Infinity;
      for (let k = 0; k < this.rows; k++) if (db[k] > max) max = db[k];
      const sound = max > SILENT_DB;
      if (sound && this.firstSound < 0) this.firstSound = index;
      if (!this.settled) {
        // Hold the frames back until the input has settled; digital silence does not count
        this.held.push({ db, sound, index, level: sound ? select(db.slice(), db.length, 0.5) : 0 });
        if (this._hasSettled()) { this._settle(); release(); }
        continue;
      }
      if (sound && index < this.firstSound + LIVE_WAKE && this._above(db) > LIVE_JUMP_DB) {
        // Much louder in most bands: hold back; if it lasts, the input itself changed
        this.held.push({ db, sound, index, level: 0 });
        if (this.held.length >= LIVE_SETTLE) { this._settle(); release(); }
        continue;
      }
      release();
      if (sound) { this._remember(db); this._count(db); }
      if (this.frames % LIVE_FLOOR_REFRESH === 0) { this._historyFloor(); this._updateRange(); }
      out.push(this._levels(db));
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
