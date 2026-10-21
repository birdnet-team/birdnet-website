/**
 * Shared helpers for the BirdNET demo tabs (V3.0, Geomodel, BirdBox).
 * Plain ES module, no build step. Paths come from #demo-config so the site
 * can be served under a path prefix.
 */

const configEl = document.getElementById('demo-config');
// Paths from the page are site-relative; workers and dynamic imports need absolute URLs
export const CONFIG = Object.fromEntries(Object.entries(configEl ? JSON.parse(configEl.textContent) : {})
  .map(([k, v]) => [k, typeof v === 'string' && v.startsWith('/') ? new URL(v, location.href).href : v]));

/* ------------------------------------------------------------------ */
/* i18n                                                                */
/* ------------------------------------------------------------------ */

/** Translate a key; returns the English fallback when no translation exists. */
export function t(key, fallback, params) {
  let text = fallback;
  if (window.i18n && typeof window.i18n.t === 'function') {
    const tr = window.i18n.t(key);
    if (tr && tr !== key) text = tr;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) text = text.split(`{${k}}`).join(v);
  }
  return text;
}

export function siteLang() {
  return (window.i18n && window.i18n.getCurrentLang && window.i18n.getCurrentLang()) || 'en';
}

/** BCP-47 locale for number/date formatting (Klingon falls back to English). */
export function locale() {
  const lang = siteLang();
  return lang === 'tlh' ? 'en' : lang;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);

export function fmtTime(sec, decimals = 0) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  // Round first so 59.999 s becomes 1:00.00, not 0:60.00
  const f = Math.pow(10, decimals);
  sec = decimals ? Math.round(sec * f) / f : Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  let s = sec % 60;
  s = decimals ? s.toFixed(decimals).padStart(decimals + 3, '0') : String(Math.floor(s)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** One line of key figures: [[value, label], ...] -> "8 species · 73 detections". */
export function statLine(stats) {
  return `<div class="demo-sumline">${stats.map(([v, l]) => `<span><b>${esc(typeof v === 'number' ? fmtNumber(v) : v)}</b> ${esc(l)}</span>`).join('')}</div>`;
}

export function fmtNumber(value, digits = 0) {
  return Number(value).toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(p, digits = 1) {
  return `${fmtNumber(p * 100, digits)}%`;
}

export function fmtBytes(bytes) {
  if (bytes < 1048576) return `${fmtNumber(bytes / 1024, 0)} KB`;
  return `${fmtNumber(bytes / 1048576, bytes < 10 * 1048576 ? 1 : 0)} MB`;
}

/** Mirror Python's repr() of a float rounded with round(x, digits). */
export function pyRound(value, digits) {
  const rounded = Number(value.toFixed(digits));
  return Number.isInteger(rounded) ? `${rounded}.0` : String(rounded);
}

export function csvField(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function downloadFile(name, content, type = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function throttle(fn, ms) {
  let last = 0, timer = null, pendingArgs = null;
  return (...args) => {
    pendingArgs = args;
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      fn(...pendingArgs);
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; last = performance.now(); fn(...pendingArgs); }, ms - (now - last));
    }
  };
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

export const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

/** Geomodel week (1-48): four weeks per month, as in the BirdNET Live app. */
export function weekFromDate(date) {
  return date.getMonth() * 4 + Math.min(3, Math.floor((date.getDate() - 1) / 7)) + 1;
}

export function monthNames(style = 'short') {
  const fmt = new Intl.DateTimeFormat(locale(), { month: style });
  return Array.from({ length: 12 }, (_, m) => fmt.format(new Date(2024, m, 15)));
}

/** Localized day range of a geomodel week, e.g. "May 8 – 14". */
export function weekRange(week) {
  const month = Math.floor((week - 1) / 4), part = (week - 1) % 4;
  const lastDay = new Date(2023, month + 1, 0).getDate();
  const start = new Date(2023, month, 1 + part * 7);
  const end = new Date(2023, month, part === 3 ? lastDay : 7 + part * 7);
  const fmt = new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric' });
  return typeof fmt.formatRange === 'function' ? fmt.formatRange(start, end) : `${fmt.format(start)} – ${fmt.format(end)}`;
}

export function weekLabel(week) {
  return t('demo.week.label', 'Week {week} · {range}', { week, range: weekRange(week) });
}

/* ------------------------------------------------------------------ */
/* Device capabilities                                                 */
/* ------------------------------------------------------------------ */

const ua = navigator.userAgent || '';
const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isMobile = navigator.userAgentData?.mobile ?? (isIOS || /Android|Mobi/i.test(ua));

export const DEVICE = {
  cores: navigator.hardwareConcurrency || 4,
  memoryGB: navigator.deviceMemory || null,
  mobile: isMobile,
  ios: isIOS,
};

/**
 * How many single-threaded inference workers to run for a model. Each worker
 * holds its own ONNX Runtime session (the page is not cross-origin isolated,
 * so WASM threads are unavailable), which scales well but costs memory:
 * roughly 500 MB per V3.0 worker and 60 MB per geomodel worker.
 */
export function workerCount(kind) {
  const { cores, memoryGB, mobile, ios } = DEVICE;
  let n = Math.max(1, Math.min(4, Math.floor(cores / 2)));
  if (kind === 'v3') {
    if (ios) n = 1;
    else if (mobile) n = Math.min(n, memoryGB && memoryGB >= 6 ? 2 : 1);
    else if (memoryGB && memoryGB <= 2) n = 1;
    else if (memoryGB && memoryGB <= 4) n = Math.min(n, 2);
  } else if (kind === 'geo') {
    if (mobile) n = Math.min(n, 2);
  } else {
    n = 1;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Cross-tab state                                                     */
/* ------------------------------------------------------------------ */

class Store extends EventTarget {
  constructor() {
    super();
    this.audio = null;     // { name, pcm, duration, url, isSample, sourceRate, channels }
    this.location = null;  // { enabled, lat, lon, date, from }: from names the recording it came from
  }
  setAudio(audio) {
    this.audio = audio;
    this.dispatchEvent(new CustomEvent('audio', { detail: audio }));
  }
  setLocation(location) {
    this.location = location;
    this.dispatchEvent(new CustomEvent('location', { detail: location }));
  }
}

export const shared = new Store();

/**
 * Show a transient message in the demo's toast area, optionally with one
 * action button (e.g. Undo).
 */
export function toast(message, tone = 'info', action) {
  let host = document.getElementById('demo-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'demo-toasts';
    host.className = 'demo-toasts';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `demo-toast demo-toast-${tone}`;
  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);
  const close = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); };
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'demo-toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.onClick(); close(); });
    el.appendChild(btn);
  }
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(close, action ? 6500 : 3800);
}
