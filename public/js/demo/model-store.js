/**
 * Model and data downloads for the demo.
 *
 * Files listed in models/manifest.json are fetched once with progress,
 * verified against their SHA-256, and kept in Cache Storage so later visits
 * start without a download. Concurrent requests for the same file share one
 * download.
 */
import { CONFIG } from './core.js';

const CACHE_NAME = 'birdnet-demo-models-v1';
const inflight = new Map();
let manifestPromise = null;

export function getManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(`${CONFIG.models}manifest.json`, { cache: 'no-cache' }).then(res => {
      if (!res.ok) throw new Error(`models/manifest.json: HTTP ${res.status}`);
      return res.json();
    });
    manifestPromise.catch(() => { manifestPromise = null; });
  }
  return manifestPromise;
}

const assetUrl = entry => `${CONFIG.models}${entry.path}?v=${entry.sha256.slice(0, 12)}`;

async function openCache() {
  try {
    return 'caches' in self ? await caches.open(CACHE_NAME) : null;
  } catch {
    return null; // storage blocked (private mode, disabled site data)
  }
}

async function sha256Hex(buffer) {
  if (!crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** True if the file is already in Cache Storage (no network needed). */
export async function isCached(entry) {
  const cache = await openCache();
  if (!cache) return false;
  try {
    return !!(await cache.match(assetUrl(entry)));
  } catch {
    return false;
  }
}

/**
 * Fetch a manifest entry as an ArrayBuffer.
 * @param {{path:string,size:number,sha256:string}} entry
 * @param {(p:{loaded:number,total:number,cached:boolean})=>void} [onProgress]
 */
export function fetchAsset(entry, onProgress) {
  const url = assetUrl(entry);
  let job = inflight.get(url);
  if (!job) {
    job = { listeners: new Set(), promise: null };
    job.promise = download(entry, url, p => job.listeners.forEach(fn => fn(p)))
      .finally(() => inflight.delete(url));
    inflight.set(url, job);
  }
  if (onProgress) job.listeners.add(onProgress);
  return job.promise;
}

export async function fetchJson(entry, onProgress) {
  const buffer = await fetchAsset(entry, onProgress);
  return JSON.parse(new TextDecoder().decode(buffer));
}

async function download(entry, url, report) {
  const cache = await openCache();
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const buffer = await hit.arrayBuffer();
        if (buffer.byteLength === entry.size) {
          report({ loaded: entry.size, total: entry.size, cached: true });
          return buffer;
        }
        await cache.delete(url);
      }
    } catch { /* fall through to the network */ }
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`${entry.path}: HTTP ${res.status}`);
  const total = entry.size || Number(res.headers.get('Content-Length')) || 0;
  let buffer;
  if (res.body && total) {
    const out = new Uint8Array(total);
    const reader = res.body.getReader();
    let loaded = 0, lastReport = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.length > out.length) throw new Error(`${entry.path}: unexpected size`);
      out.set(value, loaded);
      loaded += value.length;
      const now = performance.now();
      if (now - lastReport > 80) { lastReport = now; report({ loaded, total, cached: false }); }
    }
    if (loaded !== total) throw new Error(`${entry.path}: download incomplete (${loaded} of ${total} bytes)`);
    buffer = out.buffer;
  } else {
    buffer = await res.arrayBuffer();
  }
  report({ loaded: buffer.byteLength, total: buffer.byteLength, cached: false });

  const hash = await sha256Hex(buffer);
  if (hash && entry.sha256 && hash !== entry.sha256) {
    throw new Error(`${entry.path}: checksum mismatch, please reload the page`);
  }

  if (cache) {
    try {
      await cache.put(url, new Response(buffer.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } }));
      // Drop older versions of the same file
      for (const req of await cache.keys()) {
        const u = new URL(req.url);
        if (u.pathname === new URL(url, location.href).pathname && req.url !== new URL(url, location.href).href) await cache.delete(req);
      }
    } catch { /* quota exceeded: keep working without the cache */ }
  }
  return buffer;
}
