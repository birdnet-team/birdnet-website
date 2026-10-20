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
  window.dispatchEvent(new CustomEvent('demo:tab-shown', { detail: name }));
  if (updateHash) history.replaceState(null, '', `#${HASH[name]}`);
}

/**
 * Pinned workspace for the V3.0 and BirdBox tabs on large screens. When the
 * viewer, the settings and a useful part of the detections fit in the
 * viewport, scrolling lands the page exactly with the viewer under the site
 * header, and from there the detections column scrolls on its own and ends
 * at the bottom of the viewport. The spectrogram and the settings stay where
 * they are while the detections scroll, wherever the wheel is used, and the
 * page moves on to the footer only once the detections are at their end.
 * Without room for that (short windows) the page scrolls as usual.
 */
function initWorkspaces() {
  const viewers = [...document.querySelectorAll('.demo-viewer-main')];
  const large = matchMedia('(min-width: 992px)');
  const MIN_LIST = 280; // px of detections worth pinning the workspace for
  let clearance = 0;    // --demo-top in px
  const measure = () => {
    const el = document.body.appendChild(document.createElement('div'));
    el.style.cssText = 'position:absolute;visibility:hidden;height:var(--demo-top)';
    clearance = el.offsetHeight;
    el.remove();
  };
  const scrollable = (el, delta) => !!el && (delta > 0 ? el.scrollTop < el.scrollHeight - el.clientHeight - 1 : el.scrollTop > 0);
  /** Geometry of a workspace: how far the page is from the pinned position and the room below the row there. */
  const layout = viewer => {
    const pane = viewer.closest('.demo-pane'), box = pane.querySelector('.demo-scroll');
    const v = viewer.getBoundingClientRect(), c = viewer.parentElement.getBoundingClientRect();
    const rowTop = clearance + (box.getBoundingClientRect().top - c.top); // row top once pinned
    return { pane, box, rowTop, room: innerHeight - rowTop - 16, offset: c.top - clearance, height: v.height };
  };
  const fit = () => {
    for (const viewer of viewers) {
      const { pane, box, rowTop, room, offset, height } = layout(viewer);
      if (pane.hidden) continue;
      const fitted = large.matches && height > 0 && room >= MIN_LIST;
      pane.classList.toggle('is-fitted', fitted);
      pane.style.setProperty('--demo-row-top', `${Math.round(rowTop)}px`);
      const maxHeight = fitted && offset <= 1 ? `${Math.round(room)}px` : '';
      if (box.style.maxHeight !== maxHeight) box.style.maxHeight = maxHeight;
    }
  };
  for (const viewer of viewers) {
    const pane = viewer.closest('.demo-pane'), box = pane.querySelector('.demo-scroll');
    pane.addEventListener('wheel', e => {
      if (!pane.classList.contains('is-fitted') || e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
      const offset = viewer.parentElement.getBoundingClientRect().top - clearance;
      if (offset > 1) {
        // Approaching the pinned position: land on it instead of overshooting
        if (delta > offset) { e.preventDefault(); scrollBy({ top: offset, behavior: 'instant' }); }
        return;
      }
      // Pinned: the detections scroll first, unless a scrollable settings card is under the pointer
      if (box.contains(e.target) || scrollable(e.target.closest('.demo-sticky'), delta) || !scrollable(box, delta)) return;
      e.preventDefault();
      box.scrollTop += delta;
    }, { passive: false });
  }
  let raf = 0;
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; fit(); }); };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', () => { measure(); schedule(); });
  const observer = new ResizeObserver(schedule);
  viewers.forEach(v => observer.observe(v));
  observer.observe(document.body);
  window.addEventListener('demo:tab-shown', schedule);
  measure();
  fit();
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
  initWorkspaces();
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
