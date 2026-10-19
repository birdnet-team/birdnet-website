/**
 * Species picker dialog: suggested species first, then search over all
 * 9,789 labels. Resolves with a V3.0 species index, or null when dismissed.
 */
import { esc, fmtPct, t } from './core.js';
import { catalog, CLASS_INFO } from './species.js';
import { imageUrl } from './taxonomy.js';

let modal = null;
let resolver = null;

function row(i, score) {
  const cls = catalog.className(i);
  return `<button type="button" class="picker-item" data-i="${i}">
    <span class="picker-img"><img loading="lazy" alt="" src="${imageUrl(catalog.sci[i])}" onerror="this.remove()"><i class="fa-solid ${CLASS_INFO[cls]?.icon || 'fa-dove'}"></i></span>
    <span class="picker-name"><span>${esc(catalog.name(i))}</span><i>${esc(catalog.sci[i])}</i></span>
    ${score != null ? `<span class="picker-score">${fmtPct(score, 0)}</span>` : ''}
  </button>`;
}

/**
 * @param {{title?:string, suggestions?:Array<{s:number,p:number}>, exclude?:number[], filter?:(i:number)=>boolean}} opts
 */
export async function pickSpecies({ title, suggestions = [], exclude = [], filter } = {}) {
  await catalog.load();
  const el = document.getElementById('species-picker');
  modal ||= window.bootstrap.Modal.getOrCreateInstance(el);
  const input = el.querySelector('#species-picker-q'), list = el.querySelector('#species-picker-list');
  el.querySelector('.modal-title').textContent = title || t('demo.picker.title', 'Choose a species');
  const skip = new Set(exclude);
  const render = () => {
    const q = input.value.trim();
    if (q) {
      const hits = catalog.search(q, 40, i => !skip.has(i) && (!filter || filter(i)));
      list.innerHTML = hits.map(i => row(i)).join('') || `<div class="picker-empty">${esc(t('demo.geo.noMatch', 'No matching species'))}</div>`;
    } else {
      const sug = suggestions.filter(x => !skip.has(x.s));
      list.innerHTML = sug.length
        ? `<div class="picker-head">${esc(t('demo.picker.suggested', 'Suggested by the model'))}</div>${sug.map(x => row(x.s, x.p)).join('')}`
        : `<div class="picker-empty">${esc(t('demo.picker.hint', 'Type a common or scientific name.'))}</div>`;
    }
  };
  input.value = '';
  render();
  input.oninput = render;
  input.onkeydown = e => { if (e.key === 'Enter') list.querySelector('.picker-item')?.click(); };
  list.onclick = e => {
    const item = e.target.closest('[data-i]');
    if (!item) return;
    const done = resolver;
    resolver = null;
    modal.hide();
    done?.(+item.dataset.i);
  };
  el.addEventListener('shown.bs.modal', () => input.focus(), { once: true });
  el.addEventListener('hidden.bs.modal', () => { const done = resolver; resolver = null; done?.(null); }, { once: true });
  return new Promise(resolve => { resolver = resolve; modal.show(); });
}
