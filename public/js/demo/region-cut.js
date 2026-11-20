/**
 * Cut time-frequency regions out of audio: the sound of other boxes inside a box.
 *
 * Works on a short-time Fourier transform (1024 samples, Hann window, 3/4 overlap).
 * Only the frames a region covers are transformed: what a region holds there is
 * taken back to the time domain and subtracted from the audio, so everything else
 * stays as it was, sample for sample.
 */

const N = 1024, HOP = N / 4;
const WINDOW = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
const GAIN = 1.5;   // sum of the squared window over the overlapping frames
const COS = Float64Array.from({ length: N / 2 }, (_, i) => Math.cos(2 * Math.PI * i / N));
const SIN = Float64Array.from({ length: N / 2 }, (_, i) => Math.sin(2 * Math.PI * i / N));
const REVERSED = Uint16Array.from({ length: N }, (_, i) => {
  let r = 0;
  for (let b = 1, v = i; b < N; b <<= 1, v >>= 1) r = (r << 1) | (v & 1);
  return r;
});

/** In-place radix-2 FFT of N complex values; `sign` -1 forward, +1 inverse (unscaled). */
function fft(re, im, sign) {
  for (let i = 0; i < N; i++) {
    const j = REVERSED[i];
    if (j > i) {
      let v = re[i]; re[i] = re[j]; re[j] = v;
      v = im[i]; im[i] = im[j]; im[j] = v;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step], s = sign * SIN[k * step];
        const a = start + k, b = a + half;
        const xr = re[b] * c - im[b] * s, xi = re[b] * s + im[b] * c;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/**
 * Remove regions from x, in place.
 * @param {Float32Array} x
 * @param {ArrayLike<number>} regions [t0, t1, flo, fhi] per region: seconds from the start of x, Hz
 * @returns {Float32Array} x
 */
export function cutRegions(x, sr, regions) {
  const count = Math.floor(regions.length / 4);
  if (!count) return x;
  // Frame k holds the samples from k * HOP; a region covers the frames centred in its time span
  const spans = [];
  let first = Infinity, last = -Infinity;
  for (let r = 0; r < count; r++) {
    const k0 = Math.ceil((regions[r * 4] * sr - N / 2) / HOP), k1 = Math.floor((regions[r * 4 + 1] * sr - N / 2) / HOP);
    const b0 = Math.max(0, Math.floor(regions[r * 4 + 2] * N / sr)), b1 = Math.min(N / 2, Math.ceil(regions[r * 4 + 3] * N / sr));
    if (k1 < k0 || b1 < b0) continue;
    spans.push([k0, k1, b0, b1]);
    first = Math.min(first, k0);
    last = Math.max(last, k1);
  }
  first = Math.max(first, Math.ceil((1 - N) / HOP));
  last = Math.min(last, Math.floor((x.length - 1) / HOP));
  const re = new Float64Array(N), im = new Float64Array(N), cut = new Uint8Array(N / 2 + 1);
  const out = new Float64Array(x.length);   // what the regions hold
  for (let k = first; k <= last; k++) {
    cut.fill(0);
    let any = false;
    for (const [k0, k1, b0, b1] of spans) {
      if (k < k0 || k > k1) continue;
      cut.fill(1, b0, b1 + 1);
      any = true;
    }
    if (!any) continue;
    const start = k * HOP;
    for (let i = 0; i < N; i++) {
      const p = start + i;
      re[i] = p >= 0 && p < x.length ? x[p] * WINDOW[i] : 0;
      im[i] = 0;
    }
    fft(re, im, -1);
    for (let b = 0; b <= N / 2; b++) {
      if (cut[b]) continue;
      re[b] = 0; im[b] = 0;
      if (b > 0 && b < N / 2) { re[N - b] = 0; im[N - b] = 0; }
    }
    fft(re, im, 1);
    for (let i = Math.max(0, -start), end = Math.min(N, x.length - start); i < end; i++) out[start + i] += re[i] * WINDOW[i];
  }
  const scale = 1 / (N * GAIN);
  for (let i = 0; i < x.length; i++) if (out[i] !== 0) x[i] -= out[i] * scale;
  return x;
}
