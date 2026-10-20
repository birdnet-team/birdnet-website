/**
 * Species labels and localized common names shared by all demo tabs.
 * Index order follows the BirdNET V3.0 audio model output.
 */
import { siteLang, t } from './core.js';
import { fetchJson, getManifest } from './model-store.js';

export const NAME_LANGS = {
  en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français', it: 'Italiano',
  pt: 'Português (Brasil)', pt_PT: 'Português (Portugal)', nl: 'Nederlands', pl: 'Polski',
  ru: 'Русский', cs: 'Čeština', sk: 'Slovenčina', sv: 'Svenska', da: 'Dansk', no: 'Norsk',
  fi: 'Suomi', uk: 'Українська', tr: 'Türkçe', ja: '日本語', 'zh-CN': '中文', ca: 'Català',
  bg: 'Български', sr: 'Srpski', hr: 'Hrvatski', lt: 'Lietuvių', et: 'Eesti', cy: 'Cymraeg', fa: 'فارسی',
};

const SITE_TO_NAMES = { 'pt-BR': 'pt', pt: 'pt_PT', tlh: 'en' };
const STORAGE_KEY = 'birdnet-demo-species-lang';

export const CLASS_INFO = {
  Aves: { icon: 'fa-dove', key: 'demo.taxa.birds', label: 'Birds' },
  Amphibia: { icon: 'fa-frog', key: 'demo.taxa.amphibians', label: 'Amphibians' },
  Insecta: { icon: 'fa-bug', key: 'demo.taxa.insects', label: 'Insects' },
  Mammalia: { icon: 'fa-paw', key: 'demo.taxa.mammals', label: 'Mammals' },
};

export const classLabel = cls => t(CLASS_INFO[cls]?.key || '', CLASS_INFO[cls]?.label || cls);

class Catalog extends EventTarget {
  constructor() {
    super();
    this.ready = null;
    this.lang = 'en';
    this.names = null;
  }

  /** Load the label table once; resolves to this catalog. */
  load() {
    if (!this.ready) {
      this.ready = (async () => {
        const manifest = await getManifest();
        const table = await fetchJson(manifest.v3.labels);
        this.manifest = manifest;
        this.classes = table.classes;
        this.count = table.species.length;
        this.sci = table.species.map(s => s[0]);
        this.en = table.species.map(s => s[1]);
        this.cls = Uint8Array.from(table.species, s => s[2]);
        this.xc = table.species.map(s => s[3] || s[0]);
        this.ebird = table.species.map(s => s[4] || '');
        this.geoIndex = Int32Array.from(table.geoIndex);
        this.bySci = new Map(this.sci.map((s, i) => [s, i]));
        this.names = this.en;
        await this.setLang(this.preferredLang(), { silent: true });
        return this;
      })();
      this.ready.catch(() => { this.ready = null; });
    }
    return this.ready;
  }

  availableLangs() {
    const shipped = new Set(['en', ...Object.keys(this.manifest?.v3.names || {})]);
    return Object.entries(NAME_LANGS).filter(([code]) => shipped.has(code));
  }

  preferredLang() {
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* storage blocked */ }
    const shipped = new Set(this.availableLangs().map(([c]) => c));
    if (stored && shipped.has(stored)) return stored;
    const site = siteLang();
    const mapped = SITE_TO_NAMES[site] || site;
    return shipped.has(mapped) ? mapped : 'en';
  }

  async setLang(lang, { silent = false, remember = false } = {}) {
    let names = this.en;
    if (lang !== 'en') {
      const entry = this.manifest.v3.names[lang];
      if (!entry) lang = 'en';
      else {
        const list = await fetchJson(entry);
        names = list.map((n, i) => n || this.en[i]);
      }
    }
    this.lang = lang;
    this.names = names;
    if (remember) { try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* not persisted */ } }
    if (!silent) this.dispatchEvent(new Event('names'));
  }

  name(i) { return this.names[i]; }
  className(i) { return this.classes[this.cls[i]]; }

  /** Case- and accent-insensitive search over common, English and scientific names. */
  search(query, limit = 30, filter) {
    const fold = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const q = fold(query.trim());
    if (!q) return [];
    if (!this._folded || this._foldedLang !== this.lang) {
      this._folded = this.names.map((n, i) => `${fold(n)}|${fold(this.en[i])}|${fold(this.sci[i])}`);
      this._foldedLang = this.lang;
    }
    const starts = [], contains = [];
    for (let i = 0; i < this.count; i++) {
      if (filter && !filter(i)) continue;
      const hay = this._folded[i];
      const pos = hay.indexOf(q);
      if (pos < 0) continue;
      (pos === 0 || hay[pos - 1] === '|' || hay[pos - 1] === ' ' ? starts : contains).push(i);
      if (starts.length >= limit) break;
    }
    return starts.concat(contains).slice(0, limit);
  }
}

export const catalog = new Catalog();
