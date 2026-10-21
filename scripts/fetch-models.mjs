#!/usr/bin/env node
/**
 * Fetch and prepare the ONNX models for the browser demo (/demo/).
 *
 * The models are too large to keep in this repository, so they are pulled
 * from pinned upstream commits at build time, verified by SHA-256, and
 * written to _models/dist/ (gitignored). Eleventy copies that folder to
 * /models/ in the built site. Downloads are cached in _models/upstream/, so
 * repeated builds are offline and fast; CI caches the whole _models folder.
 *
 * Derived files:
 *   v3/labels.json        species table for the V3.0 audio model
 *   v3/names/<lang>.json  localized common names, aligned with labels.json
 *   geo/<model>.onnx      geomodel with its 128-d species embedding exposed
 *                         as an extra graph output (weights untouched)
 *   geo/head.bin          fp16 weights + bias of the final species layer
 *   geo/labels.json       geomodel output index -> V3 label index
 *   birdbox/<model>.onnx  BirdBox graph with its per-window boxes (before
 *                         window fusion) exposed as an extra graph output
 *   manifest.json         sizes and SHA-256 of everything the demo loads
 *
 * Usage: node scripts/fetch-models.mjs [--force]
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '_models');
const UPSTREAM = join(OUT, 'upstream');
const DIST = join(OUT, 'dist');
const FORCE = process.argv.includes('--force');

// Pinned upstream sources. Bump the commit (and the expected hashes) to update.
const LIVE_APP = { repo: 'birdnet-team/birdnet-live-app', commit: '351310119bd17fe9c2149051055e810903e007e1' };
const BIRDBOX = { repo: 'birdnet-team/BirdBox', commit: '9aebee76cdd91d51e17a02e13e8f764549f97ff4' };

const raw = (src, path) => `https://raw.githubusercontent.com/${src.repo}/${src.commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
// Git LFS objects are served from media.githubusercontent.com
const lfs = (src, path) => `https://media.githubusercontent.com/media/${src.repo}/${src.commit}/${path.split('/').map(encodeURIComponent).join('/')}`;

const V3_MODEL = 'BirdNET+_V3.0-preview3.1_Global_10K-pruned_FP16.onnx';
const V3_LABELS = 'BirdNET+_V3.0-preview3.1_Global_10K-pruned_Labels.csv';
const GEO_MODEL = 'BirdNET+_Geomodel_V3.0.4_Global_10K-pruned_FP16.onnx';
const GEO_LABELS = 'BirdNET+_Geomodel_V3.0.4_Global_10K-pruned_Labels.txt';
const BIRDBOX_MODEL = 'Just-Bird_fp16.onnx';
const BIRDBOX_RAW = 'raw_all';   // per-window boxes, the input of the graph's window fusion

const FILES = {
  v3Model: { url: lfs(LIVE_APP, `assets/models/${V3_MODEL}`), name: V3_MODEL, sha256: '306e74f3edc5b95acc6e87ea7f3f1c701fdc0b18ec868b7615208cd6fc2f9457' },
  v3Labels: { url: raw(LIVE_APP, `assets/models/${V3_LABELS}`), name: V3_LABELS },
  geoModel: { url: lfs(LIVE_APP, `assets/models/${GEO_MODEL}`), name: GEO_MODEL, sha256: '198adb7bcb3cf03341ffa51fbfa7b2d295e5cd900ba09183dcfdbf6d12b5c63b' },
  geoLabels: { url: raw(LIVE_APP, `assets/models/${GEO_LABELS}`), name: GEO_LABELS },
  taxonomy: { url: raw(LIVE_APP, 'assets/models/taxonomy.csv'), name: 'taxonomy.csv' },
  birdboxModel: { url: raw(BIRDBOX, `docs/models/${BIRDBOX_MODEL}`), name: BIRDBOX_MODEL, sha256: '132d08f0888b4f4ad834ad968545fe412f952253cee11dec9386fada33c34787' },
};

// Species name languages shipped with the demo (taxonomy.csv column suffix).
// Columns with poor coverage are left out; missing names fall back to English.
const NAME_LANGS = ['en', 'de', 'es', 'fr', 'it', 'pt', 'pt_PT', 'nl', 'pl', 'ru', 'cs', 'sk', 'sv', 'da', 'no', 'fi',
  'uk', 'tr', 'ja', 'zh-CN', 'ca', 'bg', 'sr', 'hr', 'lt', 'et', 'cy', 'fa'];
const MIN_NAME_COVERAGE = 0.4;

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

function sha256File(path) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

async function download(file) {
  const dest = join(UPSTREAM, file.name);
  const meta = dest + '.url';
  // Cached copies are only trusted for the same pinned URL (and hash, if known)
  if (!FORCE && existsSync(dest) && existsSync(meta) && readFileSync(meta, 'utf8') === file.url) {
    if (!file.sha256 || (await sha256File(dest)) === file.sha256) return dest;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      process.stdout.write(`  downloading ${file.name} ... `);
      const res = await fetch(file.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (file.sha256 && sha256(buf) !== file.sha256) {
        throw new Error(`SHA-256 mismatch (got ${sha256(buf)}, expected ${file.sha256})`);
      }
      writeFileSync(dest + '.part', buf);
      renameSync(dest + '.part', dest);
      writeFileSync(meta, file.url);
      console.log(`${(buf.length / 1048576).toFixed(1)} MB`);
      return dest;
    } catch (err) {
      console.log(`failed: ${err.message}`);
      if (attempt >= 3) throw new Error(`Could not download ${file.url}: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

/* ------------------------------------------------------------------ */
/* CSV helpers                                                         */
/* ------------------------------------------------------------------ */

function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows;
  return data.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/* ------------------------------------------------------------------ */
/* Minimal protobuf reader/writer for ONNX ModelProto surgery          */
/* ------------------------------------------------------------------ */

function readVarint(buf, pos) {
  let result = 0n, shift = 0n;
  for (;;) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7n;
  }
}

function encodeVarint(value) {
  let v = BigInt(value);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

/** Iterate the top-level fields of a protobuf message. */
function* fields(buf, start = 0, end = buf.length) {
  let pos = start;
  while (pos < end) {
    const tagStart = pos;
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Number(tag >> 3n), wire = Number(tag & 7n);
    let valueStart = pos, valueEnd, varint;
    if (wire === 0) { [varint, pos] = readVarint(buf, pos); valueEnd = pos; }
    else if (wire === 1) { pos += 8; valueEnd = pos; }
    else if (wire === 5) { pos += 4; valueEnd = pos; }
    else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      valueStart = pos;
      pos += Number(len);
      valueEnd = pos;
    } else throw new Error(`Unsupported protobuf wire type ${wire}`);
    yield { field, wire, tagStart, valueStart, valueEnd, end: pos, varint };
  }
}

const str = (buf, f) => buf.toString('utf8', f.valueStart, f.valueEnd);
const lenField = (field, payload) => Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(payload.length), payload]);
const varintField = (field, value) => Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);

function parseNode(buf, f) {
  const node = { inputs: [], outputs: [], op: '' };
  for (const g of fields(buf, f.valueStart, f.valueEnd)) {
    if (g.field === 1) node.inputs.push(str(buf, g));
    else if (g.field === 2) node.outputs.push(str(buf, g));
    else if (g.field === 4) node.op = str(buf, g);
  }
  return node;
}

function parseTensor(buf, f) {
  const t = { dims: [], dataType: 0, name: '', raw: null };
  for (const g of fields(buf, f.valueStart, f.valueEnd)) {
    if (g.field === 1) {
      if (g.wire === 0) t.dims.push(Number(g.varint));
      else for (let p = g.valueStart; p < g.valueEnd;) { const [v, n] = readVarint(buf, p); t.dims.push(Number(v)); p = n; }
    } else if (g.field === 2) t.dataType = Number(g.varint);
    else if (g.field === 8) t.name = str(buf, g);
    else if (g.field === 9) t.raw = buf.subarray(g.valueStart, g.valueEnd);
  }
  return t;
}

/**
 * Expose the input of the final species layer (Gemm -> Sigmoid) as an
 * additional fp16 graph output, and return that layer's weights. Running the
 * patched graph yields the original probabilities plus a 128-d embedding per
 * location, from which any single species can be scored cheaply in JS.
 */
function patchGeomodel(model) {
  const graphField = [...fields(model)].find(f => f.field === 7);
  if (!graphField) throw new Error('Geomodel: no graph in ModelProto');
  const graph = model.subarray(graphField.valueStart, graphField.valueEnd);
  const nodes = [], tensors = new Map();
  for (const f of fields(graph)) {
    if (f.field === 1) nodes.push(parseNode(graph, f));
    else if (f.field === 5) { const t = parseTensor(graph, f); tensors.set(t.name, t); }
  }
  const sigmoid = nodes.filter(n => n.op === 'Sigmoid');
  if (sigmoid.length !== 1) throw new Error(`Geomodel: expected one Sigmoid, found ${sigmoid.length}`);
  const gemm = nodes.find(n => n.op === 'Gemm' && n.outputs[0] === sigmoid[0].inputs[0]);
  if (!gemm) throw new Error('Geomodel: final Gemm not found');
  const [featureName, weightName, biasName] = gemm.inputs;
  const W = tensors.get(weightName), B = tensors.get(biasName);
  const FLOAT16 = 10;
  if (!W?.raw || !B?.raw || W.dataType !== FLOAT16 || B.dataType !== FLOAT16) throw new Error('Geomodel: unexpected head weight layout');
  const [numSpecies, featureDim] = W.dims;
  const patched = addGraphOutput(model, featureName, FLOAT16, ['batch', featureDim]);
  return { model: patched, featureName, numSpecies, featureDim, head: Buffer.concat([W.raw, B.raw]) };
}

/**
 * Declare an existing top-level tensor of the graph as an additional output.
 * dims entries are symbolic names (string) or fixed sizes (number).
 */
function addGraphOutput(model, name, elemType, dims) {
  const graphField = [...fields(model)].find(f => f.field === 7);
  if (!graphField) throw new Error('No graph in ModelProto');
  const graph = model.subarray(graphField.valueStart, graphField.valueEnd);
  const produced = new Set(), outputs = [];
  for (const f of fields(graph)) {
    if (f.field === 1) parseNode(graph, f).outputs.forEach(o => produced.add(o));
    else if (f.field === 12) {
      for (const g of fields(graph, f.valueStart, f.valueEnd)) if (g.field === 1) outputs.push(str(graph, g));
    }
  }
  if (outputs.includes(name)) return model;
  if (!produced.has(name)) throw new Error(`No top-level tensor named ${name}`);

  // ValueInfoProto { name, type: TypeProto { tensor_type { elem_type, shape { dim... } } } }
  const shape = Buffer.concat(dims.map(d => lenField(1, typeof d === 'string' ? lenField(2, Buffer.from(d)) : varintField(1, d))));
  const tensorType = Buffer.concat([varintField(1, elemType), lenField(2, shape)]);
  const valueInfo = Buffer.concat([lenField(1, Buffer.from(name)), lenField(2, lenField(1, tensorType))]);
  const newGraph = Buffer.concat([graph, lenField(12, valueInfo)]);
  return Buffer.concat([
    model.subarray(0, graphField.tagStart),
    lenField(7, newGraph),
    model.subarray(graphField.end),
  ]);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function writeIfChanged(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (existsSync(path) && statSync(path).size === buf.length && sha256(readFileSync(path)) === sha256(buf)) return;
  writeFileSync(path, buf);
}

function entry(relPath) {
  const buf = readFileSync(join(DIST, relPath));
  return { path: relPath, size: buf.length, sha256: sha256(buf) };
}

async function main() {
  console.log('Preparing demo models (_models/dist)');
  mkdirSync(UPSTREAM, { recursive: true });
  const paths = {};
  for (const [key, file] of Object.entries(FILES)) paths[key] = await download(file);

  // --- V3.0 audio model + labels ---------------------------------------
  const labels = parseCsv(readFileSync(paths.v3Labels, 'utf8'), ';');
  labels.forEach((l, i) => { if (+l.idx !== i) throw new Error(`V3 labels: idx ${l.idx} at row ${i}`); });
  const taxonomy = new Map(parseCsv(readFileSync(paths.taxonomy, 'utf8')).map(r => [r.scientific_name, r]));
  const classes = [...new Set(labels.map(l => l.class))].sort();
  const v3Species = labels.map(l => {
    const tax = taxonomy.get(l.sci_name) || {};
    // [scientific name, English common name, class index, Xeno-canto name, eBird code]
    return [l.sci_name, l.com_name, classes.indexOf(l.class), tax.xc_name || '', tax.ebird_code || ''];
  });

  // --- Geomodel ----------------------------------------------------------
  const geoLabels = readFileSync(paths.geoLabels, 'utf8').split(/\r?\n/).filter(Boolean).map(line => line.split('\t'));
  const v3Index = new Map(labels.map((l, i) => [l.sci_name, i]));
  const geoToV3 = geoLabels.map(([, sci]) => v3Index.get(sci) ?? -1);
  const v3ToGeo = new Array(labels.length).fill(-1);
  geoToV3.forEach((v, g) => { if (v >= 0) v3ToGeo[v] = g; });

  const patched = patchGeomodel(readFileSync(paths.geoModel));
  if (patched.numSpecies !== geoLabels.length) throw new Error('Geomodel: label count does not match head size');

  writeIfChanged(join(DIST, 'v3', V3_MODEL), readFileSync(paths.v3Model));
  writeIfChanged(join(DIST, 'v3', 'labels.json'), JSON.stringify({ classes, species: v3Species, geoIndex: v3ToGeo }));
  // Offline fallback for species details when the taxonomy API is not reachable
  // (it is same-origin only on birdnet.cornell.edu): [iNat ID, Wikipedia (en), photo author, license, source]
  writeIfChanged(join(DIST, 'v3', 'info.json'), JSON.stringify(labels.map(l => {
    const tax = taxonomy.get(l.sci_name) || {};
    return [+tax.inat_id || 0, tax.wikipedia_url_en || '', tax.image_author || '', tax.image_license || '', tax.image_source || ''];
  })));
  const names = {};
  for (const lang of NAME_LANGS) {
    const column = lang === 'en' ? 'common_name' : `common_name_${lang}`;
    let found = 0;
    const list = labels.map(l => {
      const name = (taxonomy.get(l.sci_name) || {})[column] || '';
      if (name) found++;
      return name;
    });
    if (found / labels.length < MIN_NAME_COVERAGE) continue;
    // English is the base list itself; other languages only store differences
    if (lang === 'en') continue;
    writeIfChanged(join(DIST, 'v3', 'names', `${lang}.json`), JSON.stringify(list));
    names[lang] = { coverage: +(found / labels.length).toFixed(3) };
  }

  writeIfChanged(join(DIST, 'geo', GEO_MODEL), patched.model);
  writeIfChanged(join(DIST, 'geo', 'head.bin'), patched.head);
  writeIfChanged(join(DIST, 'geo', 'labels.json'), JSON.stringify({
    species: geoLabels.map(([code, sci, com]) => [sci, com || sci, code]),
    v3Index: geoToV3,
  }));

  // The demo merges the per-window boxes itself (birdbox-fusion.js), so both
  // sliders update without another graph run.
  const FLOAT = 1;
  writeIfChanged(join(DIST, 'birdbox', BIRDBOX_MODEL), addGraphOutput(readFileSync(paths.birdboxModel), BIRDBOX_RAW, FLOAT, ['num_raw', 9]));

  // --- Manifest -----------------------------------------------------------
  const manifest = {
    sources: {
      liveApp: `https://github.com/${LIVE_APP.repo}/tree/${LIVE_APP.commit}/assets/models`,
      birdbox: `https://github.com/${BIRDBOX.repo}/tree/${BIRDBOX.commit}/docs/models`,
    },
    v3: {
      name: 'BirdNET+ V3.0-preview3.1 Global 10K-pruned (FP16)',
      version: '3.0-preview3.1',
      sampleRate: 32000,
      species: labels.length,
      classes,
      model: entry(`v3/${V3_MODEL}`),
      labels: entry('v3/labels.json'),
      info: entry('v3/info.json'),
      names: Object.fromEntries(Object.entries(names).map(([lang, info]) => [lang, { ...entry(`v3/names/${lang}.json`), ...info }])),
      input: 'input',
      output: 'predictions',
    },
    geo: {
      name: 'BirdNET+ Geomodel V3.0.4 Global 10K-pruned (FP16)',
      version: '3.0.4',
      species: geoLabels.length,
      model: entry(`geo/${GEO_MODEL}`),
      head: { ...entry('geo/head.bin'), featureDim: patched.featureDim, numSpecies: patched.numSpecies, dtype: 'float16' },
      labels: entry('geo/labels.json'),
      input: 'input',
      output: 'probabilities',
      features: patched.featureName,
      defaultThreshold: 0.03,
    },
    birdbox: {
      name: 'BirdBox Just-Bird (FP16)',
      sampleRate: 32000,
      model: entry(`birdbox/${BIRDBOX_MODEL}`),
      classNames: { 0: 'bird' },
      output: BIRDBOX_RAW,
      merge: 'fusion',
      defaultConf: 0.15,
      defaultPhraseGap: 0.05,
      clipSeconds: 3,
      clipHopSeconds: 1.5,
    },
  };
  writeIfChanged(join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Remove stale derived files from earlier model versions
  for (const dir of ['v3', 'geo', 'birdbox']) {
    const keep = new Set(Object.values(manifest[dir]).flatMap(v => v && typeof v === 'object' ? (v.path ? [v.path] : Object.values(v).map(x => x?.path)) : []).filter(Boolean));
    const walk = rel => readdirSync(join(DIST, rel), { withFileTypes: true }).forEach(d => {
      const p = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(p);
      else if (!keep.has(p)) rmSync(join(DIST, p));
    });
    walk(dir);
  }
  const total = Object.values(manifest).reduce((s, m) => s + (m.model?.size || 0), 0);
  console.log(`Demo models ready: ${(total / 1048576).toFixed(1)} MB of ONNX models, ${Object.keys(names).length + 1} name languages`);
}

main().catch(err => {
  console.error(`\nfetch-models: ${err.message}`);
  process.exit(1);
});
