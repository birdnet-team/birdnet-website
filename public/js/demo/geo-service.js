/**
 * BirdNET Geomodel service: [latitude, longitude, week] -> species
 * occurrence probabilities. Used by the Geomodel tab (maps, species lists,
 * phenology) and as the location filter of the V3.0 and BirdBox tabs.
 *
 * Species lists use the model output directly. Range maps score cells from a
 * cached 128-d embedding per cell (an extra output of the same graph) with
 * the model's final layer, so switching species or replaying weeks needs no
 * new inference.
 */
import { workerCount } from './core.js';
import { fetchAsset, fetchJson, getManifest } from './model-store.js';
import { OrtPool } from './ort-pool.js';
import { catalog } from './species.js';

export const RICHNESS_THRESHOLDS = [0.01, 0.03, 0.05, 0.1, 0.25, 0.5];

// fp16 helpers (the geomodel computes its head in half precision)
const HALF = new Float32Array(65536);
for (let h = 0; h < 65536; h++) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  HALF[h] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
}
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function toHalf(x) {
  f32[0] = x;
  const b = u32[0], sign = (b >>> 16) & 0x8000, exp = ((b >>> 23) & 0xff) - 127 + 15, mant = b & 0x7fffff;
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    const m = (mant | 0x800000) >> (1 - exp);
    return sign | ((m + 0x1000 + ((m >> 13) & 1) - 1) >> 13);
  }
  const h = sign | (exp << 10) | (mant >> 13), rest = mant & 0x1fff;
  return rest > 0x1000 || (rest === 0x1000 && (h & 1)) ? h + 1 : h;
}
const roundHalf = x => HALF[toHalf(x)];

class GeoService extends EventTarget {
  constructor() {
    super();
    this.ready = null;
    this.pool = null;
  }

  /** Download (or restore from cache) and start the geomodel. */
  ensure(onProgress) {
    if (!this.ready) {
      this.ready = (async () => {
        const manifest = await getManifest();
        const m = manifest.geo;
        this.manifest = m;
        await catalog.load();
        const [model, head, labels] = await Promise.all([
          fetchAsset(m.model, onProgress),
          fetchAsset(m.head),
          fetchJson(m.labels),
        ]);
        this.S = m.head.numSpecies;
        this.D = m.head.featureDim;
        const halfs = new Uint16Array(head);
        this.W = Float32Array.from(halfs.subarray(0, this.S * this.D), h => HALF[h]);
        this.B = Float32Array.from(halfs.subarray(this.S * this.D), h => HALF[h]);
        this.v3Index = Int32Array.from(labels.v3Index);
        const classOf = Uint8Array.from(this.v3Index, v => (v >= 0 ? catalog.cls[v] : 0));
        this.pool = new OrtPool({ name: 'geomodel', size: workerCount('geo') });
        await this.pool.start(model, {
          input: m.input, output: m.output, features: m.features,
          thresholds: RICHNESS_THRESHOLDS, classOf, nClasses: catalog.classes.length,
        });
        return this;
      })();
      this.ready.catch(() => { this.ready = null; });
    }
    return this.ready;
  }

  async _probs(inputs, opts) {
    await this.ensure();
    const res = await this.pool.run('geo', { inputs, mode: 'probs' }, [inputs.buffer], opts);
    return res.probs;
  }

  /** Geomodel probabilities for one location and week, in geomodel order. */
  predict(lat, lon, week, opts = { priority: 10 }) {
    return this._probs(Float32Array.of(lat, lon, week), opts);
  }

  /** Probabilities for all 48 weeks: Float32Array(48 x S), week-major. */
  predictYear(lat, lon, opts = { priority: 10 }) {
    const inputs = new Float32Array(48 * 3);
    for (let w = 0; w < 48; w++) inputs.set([lat, lon, w + 1], w * 3);
    return this._probs(inputs, opts);
  }

  /** Probabilities re-indexed to the V3.0 label order. */
  async v3Scores(lat, lon, week) {
    const probs = await this.predict(lat, lon, week);
    const out = new Float32Array(catalog.count);
    for (let g = 0; g < this.S; g++) { const v = this.v3Index[g]; if (v >= 0) out[v] = probs[g]; }
    return out;
  }

  /** Embeddings and richness counts for many cells ([lat, lon, week] triples). */
  async grid(inputs, opts) {
    await this.ensure();
    return this.pool.run('geo', { inputs, mode: 'grid' }, [inputs.buffer], opts);
  }

  /**
   * Score one species (V3.0 index) for cells from their fp16 embeddings,
   * mirroring the model's final Gemm + Sigmoid in half precision.
   */
  scoreCells(features, count, v3Index, out = new Float32Array(count)) {
    const g = catalog.geoIndex[v3Index];
    if (g < 0) return out.fill(0);
    const D = this.D, W = this.W, w0 = g * D, bias = this.B[g];
    for (let c = 0; c < count; c++) {
      let acc = 0;
      const f0 = c * D;
      for (let k = 0; k < D; k++) acc += HALF[features[f0 + k]] * W[w0 + k];
      const logit = roundHalf(Math.fround(acc + bias));
      out[c] = roundHalf(1 / (1 + Math.exp(-logit)));
    }
    return out;
  }

  get workers() { return this.pool?.readyCount || 0; }
}

export const geo = new GeoService();
