/**
 * Species details from the BirdNET taxonomy service
 * (https://birdnet.cornell.edu/taxonomy/docs): photo with credit, localized
 * description and links. The API is same-origin on birdnet.cornell.edu; other
 * hosts (staging, localhost) would be blocked by CORS, so they skip it and use
 * the build-time snapshot in models/v3/info.json.
 */
import { fetchJson, getManifest } from './model-store.js';
import { catalog } from './species.js';

const API = 'https://birdnet.cornell.edu/taxonomy/api';
const LOCALES = { 'zh-CN': 'zh' };
const cache = new Map();
let apiAvailable = new URL(API).origin === location.origin ? null : false;
let fallback = null;

export const imageUrl = (sci, size = 'thumb') => `${API}/image/${encodeURIComponent(sci)}?size=${size}`;

const LICENSES = { 'cc-by': 'CC BY', 'cc-by-sa': 'CC BY-SA', 'cc-by-nc': 'CC BY-NC', 'cc-by-nc-sa': 'CC BY-NC-SA', 'cc-by-nd': 'CC BY-ND', 'cc-by-nc-nd': 'CC BY-NC-ND', cc0: 'CC0', pd: 'Public domain' };
const license = value => LICENSES[(value || '').toLowerCase()] || value || '';

function links(index, { wikipedia, inat, ebird, xc }) {
  const out = [];
  if (wikipedia) out.push({ label: 'Wikipedia', url: wikipedia });
  if (ebird && catalog.className(index) === 'Aves') out.push({ label: 'eBird', url: `https://ebird.org/species/${encodeURIComponent(ebird)}` });
  if (inat) out.push({ label: 'iNaturalist', url: `https://www.inaturalist.org/taxa/${inat}` });
  if (xc) out.push({ label: 'Xeno-canto', url: `https://xeno-canto.org/species/${encodeURIComponent(xc.replace(/ /g, '-'))}` });
  return out;
}

async function fromApi(index, locale) {
  const res = await fetch(`${API}/species/${encodeURIComponent(catalog.sci[index])}?locale=${encodeURIComponent(locale)},en`);
  if (!res.ok) throw new Error(`taxonomy API: HTTP ${res.status}`);
  const d = await res.json();
  const description = d.descriptions?.[locale] || d.descriptions?.en || '';
  const descLocale = d.descriptions?.[locale] ? locale : 'en';
  return {
    description,
    descriptionSource: d.description_sources?.[descLocale] || d.description_source || '',
    photo: d.image ? { author: d.image.author, license: license(d.image.license), source: d.image.source } : null,
    observations: d.observations_count || 0,
    links: links(index, {
      wikipedia: d.wikipedia_urls?.[locale] || d.wikipedia_urls?.en,
      inat: d.inat_id, ebird: d.ebird_code, xc: d.xc_name,
    }),
  };
}

async function fromSnapshot(index) {
  if (!fallback) fallback = getManifest().then(m => fetchJson(m.v3.info));
  const row = (await fallback)[index] || [];
  const [inat, wikipedia, author, lic, source] = row;
  return {
    description: '',
    descriptionSource: '',
    photo: author ? { author, license: license(lic), source } : null,
    observations: 0,
    links: links(index, { wikipedia, inat, ebird: catalog.ebird?.[index], xc: catalog.xc[index] }),
  };
}

/** Details for a V3.0 species index in the current species-name language. */
export function speciesInfo(index) {
  const locale = LOCALES[catalog.lang] || catalog.lang;
  const key = `${index}|${locale}`;
  if (!cache.has(key)) {
    const job = (async () => {
      if (apiAvailable !== false) {
        try {
          const info = await fromApi(index, locale);
          apiAvailable = true;
          return info;
        } catch (err) {
          if (apiAvailable === null && err instanceof TypeError) apiAvailable = false; // CORS / offline
        }
      }
      return fromSnapshot(index);
    })();
    cache.set(key, job);
    job.catch(() => cache.delete(key));
  }
  return cache.get(key);
}
