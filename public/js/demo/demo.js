/**
 * Demo page shell: tabs, deep links (#v3, #geomodel, #birdbox, #v2.4) and
 * cross-tab flows. The V2.4 tab keeps its original inline script.
 */
import { BirdBoxTab } from './birdbox-tab.js';
import { GeoTab } from './geo-tab.js';
import { player } from './player.js';
import { V3Tab } from './v3-tab.js';

const HASH = { v3: 'v3', geomodel: 'geomodel', birdbox: 'birdbox', v24: 'v2.4' };
const FROM_HASH = Object.fromEntries(Object.entries(HASH).map(([k, v]) => [v, k]));

const tabs = { v3: new V3Tab(), geomodel: new GeoTab(), birdbox: new BirdBoxTab() };
let current = null;
window.birdnetDemo = tabs; // handy for debugging from the console

function show(name, { updateHash = true } = {}) {
  if (!document.querySelector(`[data-pane="${name}"]`)) name = 'v3';
  if (name === current) return;
  const previous = current;
  current = name;
  document.querySelectorAll('#demo-tabs [data-tab]').forEach(btn => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-pane]').forEach(pane => { pane.hidden = pane.dataset.pane !== name; });
  if (previous) {
    tabs[previous]?.hide();
    window.dispatchEvent(new CustomEvent('demo:tab-hidden', { detail: previous }));
  }
  // The V3.0 and BirdBox tabs share one player; other tabs silence it
  if (name === 'geomodel' || name === 'v24') player.pause();
  tabs[name]?.show();
  if (updateHash) history.replaceState(null, '', `#${HASH[name]}`);
}

function init() {
  Object.values(tabs).forEach(tab => tab.init());
  const nav = document.getElementById('demo-tabs');
  nav.addEventListener('click', e => {
    const btn = e.target.closest('[data-tab]');
    if (btn) show(btn.dataset.tab);
  });
  nav.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const buttons = [...nav.querySelectorAll('[data-tab]')];
    const i = buttons.findIndex(b => b.dataset.tab === current);
    const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
    show(next.dataset.tab);
    next.focus();
  });
  // Settings panels fold into one row on small screens
  document.querySelectorAll('.demo-settings-toggle').forEach(btn => btn.addEventListener('click', () => {
    const open = btn.closest('.demo-settings').classList.toggle('is-open');
    btn.setAttribute('aria-expanded', String(open));
  }));
  window.addEventListener('hashchange', () => show(FROM_HASH[location.hash.slice(1)] || 'v3', { updateHash: false }));
  window.addEventListener('demo:show-tab', e => show(e.detail));
  window.addEventListener('demo:pick-location', () => {
    const back = current;
    show('geomodel');
    tabs.geomodel.startPick(back);
    document.getElementById('geo-map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  show(FROM_HASH[location.hash.slice(1)] || 'v3', { updateHash: !!location.hash });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
