/**
 * BirdNET Geomodel service: [latitude, longitude, week] -> species
 * occurrence probabilities. Used by the Geomodel tab (maps, species lists,
 * phenology) and as the location filter of the V3.0 and BirdBox tabs.
 *
 * Species lists use the model output directly. Range maps score cells from a
 * cached embedding per cell (an extra output of the same graph) with the
 * model's final layer, so switching species or replaying weeks needs no new
 * inference.
 *
 * The geomodel and the audio model each know species the other lacks; they
 * join by BirdNET ID (catalog.geoIndex, v3Index here).
 */
import { workerCount } from './core.js';
import { fetchAsset, fetchJson, getManifest } from './model-store.js';
import { OrtPool } from './ort-pool.js';
import { catalog } from './species.js';

export const RICHNESS_THRESHOLDS = [0.01, 0.03, 0.05, 0.1, 0.25, 0.5];

// The final layer's weights are stored in half precision; the model casts them to float32 and computes there
const HALF = new Float32Array(65536);
for (let h = 0; h < 65536; h++) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  HALF[h] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
}

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
        if (m.head.weights !== 'float16' || m.head.bias !== 'float32') throw new Error('geomodel: unexpected head format');
        const nW = this.S * this.D;
        this.W = Float32Array.from(new Uint16Array(head, 0, nW), h => HALF[h]);
        this.B = new Float32Array(head.slice(nW * 2));
        this.v3Index = Int32Array.from(labels.v3Index);
        // Species the audio model lacks are in no list: they count for no group (NONE)
        const NONE = 255, classOf = Uint8Array.from(this.v3Index, v => (v >= 0 ? catalog.cls[v] : NONE));
        // Groups without a single geomodel species (fishes, reptiles, non-animal sounds): the location filter cannot judge them
        this.classCovered = catalog.classes.map((_, c) => this.v3Index.some(v => v >= 0 && catalog.cls[v] === c));
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

  /**
   * Probabilities re-indexed to the V3.0 label order, for the location filter. A species
   * the geomodel lacks gets 0 and is filtered out, unless the geomodel has no species of
   * its whole group: those get 1 and pass.
   */
  async v3Scores(lat, lon, week) {
    const probs = await this.predict(lat, lon, week);
    const out = Float32Array.from(catalog.cls, c => (this.classCovered[c] ? 0 : 1));
    for (let g = 0; g < this.S; g++) { const v = this.v3Index[g]; if (v >= 0) out[v] = probs[g]; }
    return out;
  }

  /** Embeddings and richness counts for many cells ([lat, lon, week] triples). */
  async grid(inputs, opts) {
    await this.ensure();
    return this.pool.run('geo', { inputs, mode: 'grid' }, [inputs.buffer], opts);
  }

  /**
   * Score one species (V3.0 index) for cells from their embeddings,
   * mirroring the model's final Gemm + Sigmoid.
   */
  scoreCells(features, count, v3Index, out = new Float32Array(count)) {
    const g = catalog.geoIndex[v3Index];
    if (g < 0) return out.fill(0);
    const D = this.D, W = this.W, w0 = g * D, bias = this.B[g];
    for (let c = 0; c < count; c++) {
      let acc = 0;
      const f0 = c * D;
      for (let k = 0; k < D; k++) acc += features[f0 + k] * W[w0 + k];
      out[c] = 1 / (1 + Math.exp(-(acc + bias)));
    }
    return out;
  }

  get workers() { return this.pool?.readyCount || 0; }
}

export const geo = new GeoService();
