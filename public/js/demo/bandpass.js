/**
 * A cheap bandpass for the audio of a box: a 4th-order Butterworth high-pass at
 * the box's lower edge and a 4th-order Butterworth low-pass at its upper edge,
 * each as two biquads (24 dB per octave). One pass over the samples, in place.
 *
 * The edges are the filters' -3 dB points, so the sound inside the box stays and
 * what lies outside its band fades with distance from it. An edge at the bottom or
 * the top of the spectrum needs no filter and gets none.
 */

const Q = [0.54119610, 1.30656296];   // the two sections of a 4th-order Butterworth filter
const LOW_EDGE = 40;                  // Hz: a box that starts below has no lower edge to cut at
const HIGH_EDGE = 0.46;               // of the sample rate: a box that ends above has no upper edge (the demo's boxes end at 15 kHz of 32)

/** One biquad (RBJ cookbook), direct form II transposed, state in double precision. */
function biquad(x, type, f, q, sr) {
  const w = 2 * Math.PI * f / sr, cos = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
  const b1 = (type === 'high' ? -(1 + cos) : 1 - cos) / a0, b0 = Math.abs(b1) / 2, b2 = b0;
  const a1 = -2 * cos / a0, a2 = (1 - alpha) / a0;
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i], y = b0 * v + z1;
    z1 = b1 * v - a1 * y + z2;
    z2 = b2 * v - a2 * y;
    x[i] = y;
  }
}

/**
 * Keep the band flo..fhi (Hz) of x, in place.
 * @param {Float32Array} x
 * @returns {Float32Array} x
 */
export function bandpass(x, sr, flo, fhi) {
  if (flo >= LOW_EDGE) for (const q of Q) biquad(x, 'high', Math.min(flo, sr * HIGH_EDGE), q, sr);
  if (fhi < sr * HIGH_EDGE) for (const q of Q) biquad(x, 'low', Math.max(fhi, LOW_EDGE), q, sr);
  return x;
}
