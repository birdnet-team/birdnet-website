/**
 * Location and date filter backed by the geomodel. The state lives in the
 * shared store, so the V3.0 tab, the BirdBox tab and the map all agree.
 * shared.location = { enabled, lat, lon, date: 'YYYY-MM-DD' }
 */
import { esc, fmtNumber, shared, t, toast, weekFromDate, weekLabel } from './core.js';
import { geo } from './geo-service.js';

const maskCache = new Map();

export function locationWeek(loc) {
  const d = loc?.date ? new Date(`${loc.date}T12:00:00`) : new Date();
  return weekFromDate(Number.isNaN(d.getTime()) ? new Date() : d);
}

export function validLocation(loc) {
  return !!loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon) && Math.abs(loc.lat) <= 90 && Math.abs(loc.lon) <= 180;
}

/** Geomodel scores (V3.0 order) for the active filter, or null when off. */
export async function activeMask(onProgress) {
  const loc = shared.location;
  if (!loc?.enabled || !validLocation(loc)) return null;
  const week = locationWeek(loc);
  const key = `${loc.lat.toFixed(4)},${loc.lon.toFixed(4)},${week}`;
  if (!maskCache.has(key)) {
    const p = geo.ensure(onProgress).then(() => geo.v3Scores(loc.lat, loc.lon, week));
    maskCache.set(key, p);
    p.catch(() => maskCache.delete(key));
  }
  return { scores: await maskCache.get(key), threshold: (await geo.ensure()).manifest.defaultThreshold, week, ...loc };
}

const today = () => new Date().toISOString().slice(0, 10);

export class LocationFilter extends EventTarget {
  constructor(root) {
    super();
    this.root = root;
    this.$ = role => root.querySelector(`[data-role="${role}"]`);
    this._bind();
    shared.addEventListener('location', () => this.render());
    this.render();
  }

  _bind() {
    const update = patch => {
      const cur = shared.location || { enabled: false, lat: NaN, lon: NaN, date: today() };
      shared.setLocation({ ...cur, ...patch });
    };
    this.$('enable').addEventListener('change', e => update({ enabled: e.target.checked }));
    const coords = () => update({ lat: parseFloat(this.$('lat').value), lon: parseFloat(this.$('lon').value) });
    this.$('lat').addEventListener('change', coords);
    this.$('lon').addEventListener('change', coords);
    this.$('date').addEventListener('change', e => update({ date: e.target.value || today() }));
    this.$('locate').addEventListener('click', () => this._locate(update));
    this.$('pick').addEventListener('click', () => window.dispatchEvent(new CustomEvent('demo:pick-location')));
  }

  _locate(update) {
    if (!navigator.geolocation) {
      toast(t('demo.geo.unsupported', 'Geolocation not supported by your browser.'), 'warning');
      return;
    }
    const btn = this.$('locate');
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(pos => {
      btn.disabled = false;
      update({ enabled: true, lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4) });
    }, err => {
      btn.disabled = false;
      toast(err.code === 1
        ? t('demo.geo.denied', 'Location access denied. Please allow location access in your browser.')
        : t('demo.geo.generic', 'Could not get location'), 'warning');
    }, { enableHighAccuracy: false, timeout: 10000 });
  }

  render() {
    const loc = shared.location;
    const enabled = !!loc?.enabled;
    this.$('enable').checked = enabled;
    this.$('fields').hidden = !enabled;
    if (loc) {
      if (document.activeElement !== this.$('lat')) this.$('lat').value = Number.isFinite(loc.lat) ? loc.lat : '';
      if (document.activeElement !== this.$('lon')) this.$('lon').value = Number.isFinite(loc.lon) ? loc.lon : '';
      this.$('date').value = loc.date || today();
    } else {
      this.$('date').value = today();
    }
    const badge = this.$('badge');
    badge.hidden = !enabled;
    if (!enabled) {
      this.$('summary').textContent = '';
    } else if (!validLocation(loc)) {
      badge.className = 'badge text-bg-warning';
      badge.textContent = t('demo.settings.locationNoCoords', 'No coordinates');
      this.$('summary').textContent = t('demo.location.hint', 'Enter coordinates, use your location, or pick a point on the map.');
    } else {
      badge.className = 'badge text-bg-success';
      badge.textContent = t('demo.settings.locationActive', 'Active');
      this.$('summary').innerHTML = esc(t('demo.location.summary', '{lat}°, {lon}° · {week}', {
        lat: fmtNumber(loc.lat, 2), lon: fmtNumber(loc.lon, 2), week: weekLabel(locationWeek(loc)),
      }));
    }
    this.dispatchEvent(new Event('change'));
  }
}
