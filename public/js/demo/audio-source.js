/**
 * Audio input card (file, drag & drop, sample, microphone, Xeno-canto) for a
 * demo tab. Decoded audio goes to the shared store, so every tab sees the
 * same file.
 */
import { decodeAudio, MAX_SECONDS, Recorder, SAMPLE_RATE } from './audio.js';
import { CONFIG, esc, fmtBytes, fmtPct, fmtTime, shared, t, toast } from './core.js';
import { player } from './player.js';

const MAX_RECORD_SECONDS = 300;
const XC_EXT = { mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav', wave: 'wav', flac: 'flac', 'x-flac': 'flac', ogg: 'ogg' };

let loadToken = 0;

/** Decode a File and publish it as the current recording. */
export async function loadFile(file, { isSample = false, xc = null, onStatus } = {}) {
  const token = ++loadToken;
  onStatus?.('decoding');
  const tags = readXcTags(await file.slice(0, 1 << 20).arrayBuffer());
  const decoded = await decodeAudio(file, { onProgress: f => { if (token === loadToken) onStatus?.('decoding', f); } });
  if (token !== loadToken) return null;
  const url = URL.createObjectURL(file);
  if (shared.audio?.url) URL.revokeObjectURL(shared.audio.url);
  const audio = { name: file.name, size: file.size, file, url, isSample, xc: xc || tags?.xc || null, tags, ...decoded };
  player.setSource(url);
  useRecordingLocation(tags);   // before the tabs see the audio, so their first suggestions use it
  shared.setAudio(audio);
  return audio;
}

const syncsafe = (b, p) => ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);

const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/**
 * ID3 text. Xeno-canto writes UTF-8 even where the frame says Latin-1; older
 * tags mix a Latin-1 "©" with UTF-8 names, which read as "RÃ­os" until the
 * UTF-8 runs are decoded on their own.
 */
function id3Text(bytes, encoding) {
  if (encoding === 1 || encoding === 2) return new TextDecoder(encoding === 1 ? 'utf-16' : 'utf-16be').decode(bytes);
  let s;
  try { s = utf8(bytes); } catch { s = new TextDecoder('latin1').decode(bytes); }
  return s.replace(/[Â-ô][\u0080-¿]{1,3}/g, run => {
    try { return utf8(Uint8Array.from(run, c => c.charCodeAt(0))); } catch { return run; }
  });
}

/**
 * Recording metadata from the ID3 comment that Xeno-canto writes into its
 * MP3 files ("XC1000 © Recordist // Place (9.7751, -84.6167), Country //
 * 10m // ?h, 2002-07-22 // call // …"). Recordings uploaded as WAV are
 * served unchanged and carry no such tag; null then.
 */
export function readXcTags(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1 << 20));
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;
  const v = b[3], end = Math.min(b.length, 10 + syncsafe(b, 6));
  let p = 10 + (b[5] & 0x40 ? (v === 4 ? syncsafe(b, 10) : 4 + ((b[10] << 24 | b[11] << 16 | b[12] << 8 | b[13]) >>> 0)) : 0);
  let comment = '', title = '';
  while (p + 10 <= end) {
    const id = String.fromCharCode(...b.subarray(p, p + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const n = v === 4 ? syncsafe(b, p + 4) : (b[p + 4] << 24 | b[p + 5] << 16 | b[p + 6] << 8 | b[p + 7]) >>> 0;
    const frame = b.subarray(p + 10, Math.min(end, p + 10 + n));
    // COMM: encoding, language, description, NUL, text; T***: encoding, text
    if (id === 'COMM') comment = id3Text(frame.subarray(4), frame[0]).split('\0').filter(Boolean).pop() || '';
    else if (id === 'TIT2') title = id3Text(frame.subarray(1), frame[0]).replace(/\0/g, '').trim();
    p += 10 + n;
  }
  const m = comment.match(/^\s*XC(\d+)\s*©/);
  if (!m) return null;
  const parts = comment.split('//').map(s => s.replace(/\s+/g, ' ').trim());
  const where = parts[1]?.match(/^(.*?)\s*\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)\s*,?\s*(.*)$/);
  const day = parts.find(s => /\d{4}-\d{2}-\d{2}/.test(s))?.match(/(\d{4})-(\d{2})-(\d{2})/);
  // Unknown day or month are written as 00; a known month still gives the right weeks
  const date = day && +day[2] >= 1 && +day[2] <= 12 ? `${day[1]}-${day[2]}-${+day[3] >= 1 ? day[3] : '15'}` : null;
  return {
    xc: m[1],
    title,
    place: where ? [where[1], where[4]].filter(Boolean).join(', ') : parts[1] || '',
    lat: where ? +where[2] : null,
    lon: where ? +where[3] : null,
    date,
  };
}

/**
 * Point the location and date filter at the place the recording was made.
 * A location taken from an earlier recording is switched off when the new
 * one has none; a location the person set is left alone.
 */
function useRecordingLocation(tags) {
  const prev = shared.location;
  if (tags && Number.isFinite(tags.lat) && Number.isFinite(tags.lon)) {
    shared.setLocation({ enabled: true, lat: tags.lat, lon: tags.lon, date: tags.date || prev?.date || new Date().toISOString().slice(0, 10), from: `XC${tags.xc}` });
    toast(t('demo.source.xcLocation', 'Species suggestions now use where and when XC{nr} was recorded: {place}.', { nr: tags.xc, place: tags.place }), 'info', {
      label: t('demo.edit.undo', 'Undo'),
      onClick: () => shared.setLocation(prev),
    });
  } else if (prev?.from && prev.enabled) {
    shared.setLocation({ ...prev, enabled: false, from: null });
    toast(t('demo.source.xcLocationOff', 'The location filter is off: it belonged to {from}, and this recording has no location.', { from: prev.from }), 'info');
  }
}

/** Xeno-canto number from "XC1059662", "1059662" or a recording link; null if none. */
export function parseXcNumber(value) {
  const s = String(value ?? '').trim();
  const m = s.match(/^XC\s*(\d+)$/i) || s.match(/^(\d+)$/) || s.match(/xeno-canto\.org\/(\d+)(?:[/?#]|$)/i);
  return m ? m[1] : null;
}

class XcError extends Error {
  constructor(message, nr) { super(message); this.nr = nr; }
}

/** Download a recording from Xeno-canto (served with open CORS) and load it. */
export async function loadXenoCanto(nr, { onStatus, onProgress } = {}) {
  onStatus?.('xc');
  // Offline, or Xeno-canto answered with a bot check instead of the file (no CORS header)
  const res = await fetch(`https://xeno-canto.org/${nr}/download`).catch(() => {
    throw new XcError(t('demo.source.xcNetwork', 'Could not load XC{nr} from Xeno-canto. You can download it there and open the file here:', { nr }), nr);
  });
  const type = (res.headers.get('Content-Type') || '').split(';')[0].trim();
  if (res.status === 404 || res.status === 410 || type.startsWith('text/')) {
    throw new XcError(t('demo.source.xcNotFound', 'Xeno-canto has no downloadable recording XC{nr}.', { nr }));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = +res.headers.get('Content-Length') || 0;
  const chunks = [];
  let loaded = 0;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress?.(loaded, total);
    }
  } else chunks.push(new Uint8Array(await res.arrayBuffer()));
  const ext = XC_EXT[type.split('/')[1]] || 'mp3';
  return loadFile(new File(chunks, `XC${nr}.${ext}`, { type: type || 'audio/mpeg' }), { xc: nr, onStatus });
}

export async function loadSample(onStatus) {
  onStatus?.('fetching');
  const res = await fetch(CONFIG.sample);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return loadFile(new File([blob], CONFIG.sampleName, { type: 'audio/flac' }), { isSample: true, onStatus });
}

export class AudioSource {
  /** @param {HTMLElement} root  element rendered by the demo-audio-source partial */
  constructor(root) {
    this.root = root;
    this.$ = role => root.querySelector(`[data-role="${role}"]`);
    this.recorder = null;
    this._bind();
    shared.addEventListener('audio', () => this.render());
    player.addEventListener('state', () => this._renderPlay());
    player.addEventListener('time', e => {
      const time = this.$('time');
      if (time && shared.audio) time.textContent = `${fmtTime(e.detail)} / ${fmtTime(shared.audio.duration)}`;
    });
    this.render();
  }

  _bind() {
    const input = this.$('input');
    this.$('choose').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { if (input.files[0]) this._load(input.files[0]); input.value = ''; });
    this.$('sample').addEventListener('click', () => this._run(() => loadSample((s, f) => this._status(s, null, f))));
    this.$('record').addEventListener('click', () => this._startRecording());
    this.$('stop').addEventListener('click', () => this._stopRecording());
    this.$('cancel').addEventListener('click', () => this._cancelRecording());
    this.$('replace').addEventListener('click', () => this._showDrop(true));
    this.$('play').addEventListener('click', () => player.toggle());
    this.$('xc-form').addEventListener('submit', e => {
      e.preventDefault();
      const input = this.$('xc'), nr = parseXcNumber(input.value);
      input.classList.toggle('is-invalid', !nr);
      if (!nr) {
        this._message('warning', t('demo.source.xcInvalid', 'Enter a Xeno-canto number such as XC1059662, or paste the recording link.'));
        input.focus();
        return;
      }
      this._run(() => loadXenoCanto(nr, {
        onStatus: (s, f) => this._status(s, nr, f),
        onProgress: (loaded, total) => {
          this.$('status').textContent = t('demo.source.xcFetching', 'Loading XC{nr} from Xeno-canto…', { nr })
            + (total ? ` ${fmtPct(loaded / total, 0)}` : ` ${fmtBytes(loaded)}`);
        },
      }).then(audio => { if (audio) input.value = ''; }));
    });
    this.$('xc').addEventListener('input', e => e.target.classList.remove('is-invalid'));
    const drop = this.$('drop');
    ['dragenter', 'dragover'].forEach(type => this.root.addEventListener(type, e => {
      e.preventDefault();
      drop.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach(type => this.root.addEventListener(type, e => {
      e.preventDefault();
      if (type === 'dragleave' && this.root.contains(e.relatedTarget)) return;
      drop.classList.remove('is-over');
    }));
    this.root.addEventListener('drop', e => {
      const file = e.dataTransfer?.files?.[0];
      if (file) this._load(file);
    });
  }

  _status(stage, nr, fraction) {
    const msg = {
      fetching: t('demo.source.fetching', 'Loading sample…'),
      xc: t('demo.source.xcFetching', 'Loading XC{nr} from Xeno-canto…', { nr }),
      decoding: t('demo.source.decoding', 'Decoding audio…') + (fraction != null ? ` ${fmtPct(fraction, 0)}` : ''),
    }[stage];
    this.$('status').textContent = msg || '';
    this.root.classList.toggle('is-busy', !!msg);
  }

  _message(level, text, xc) {
    const icon = level === 'danger' ? 'bi-exclamation-triangle' : 'bi-exclamation-circle';
    const link = xc ? ` <a href="https://xeno-canto.org/${xc}" target="_blank" rel="noopener">xeno-canto.org/${xc}</a>` : '';
    this.$('status').innerHTML = `<span class="text-${level}"><i class="bi ${icon} me-1"></i>${esc(text)}</span>${link}`;
  }

  async _run(fn) {
    try {
      await fn();
    } catch (err) {
      console.error(err);
      this.root.classList.remove('is-busy');
      if (err instanceof XcError) this._message('warning', err.message, err.nr);
      else this._message('danger', t('demo.source.error', 'Could not decode this audio file. Try WAV, FLAC or MP3.'));
      return;
    }
    this._status(null);
  }

  _load(file) {
    if (!/^audio\/|^video\/(webm|mp4|ogg)/.test(file.type) && !/\.(wav|flac|mp3|ogg|oga|opus|m4a|aac|webm|aiff?)$/i.test(file.name)) {
      this._message('warning', t('demo.source.notAudio', 'This does not look like an audio file.'));
      return;
    }
    this._run(() => loadFile(file, { onStatus: (s, f) => this._status(s, null, f) }));
  }

  _showDrop(show) {
    const a = shared.audio;
    this.$('drop').hidden = !show;
    this.$('bar').hidden = show || !a;
    this.$('back').hidden = !a;
    // Recordings longer than MAX_SECONDS were cut while decoding
    this.$('truncated').hidden = show || !(a?.fullDuration > a?.duration + 0.5);
  }

  render() {
    const a = shared.audio;
    this._showDrop(!a);
    if (!a) return;
    this.$('truncated').textContent = t('demo.source.truncated', 'This recording is {total} long. The demo analyzes the first {max} minutes.', { total: fmtTime(a.fullDuration), max: MAX_SECONDS / 60 });
    this.$('name').textContent = a.xc ? `XC${a.xc}${a.tags?.title ? ` · ${a.tags.title}` : ''}` : a.name;
    const link = this.$('xc-link');
    link.hidden = !a.xc;
    if (a.xc) {
      link.href = `https://xeno-canto.org/${a.xc}`;
      link.title = t('demo.source.xcOpen', 'Open XC{nr} on Xeno-canto', { nr: a.xc });
      link.setAttribute('aria-label', link.title);
    }
    const meta = [fmtTime(a.duration, a.duration < 60 ? 1 : 0)];
    if (a.size) meta.push(fmtBytes(a.size));
    if (a.sourceRate === SAMPLE_RATE) meta.push('32 kHz');
    else if (a.sourceRate) meta.push(t('demo.source.resampled', '{rate} kHz → 32 kHz', { rate: (a.sourceRate / 1000).toLocaleString() }));
    if (a.channels > 1) meta.push(t('demo.source.mono', '{n} channels → mono', { n: a.channels }));
    if (a.tags?.place) meta.push([a.tags.place, a.tags.date].filter(Boolean).join(', '));
    this.$('meta').textContent = meta.join(' · ');
    this.$('icon').className = `bi ${a.isSample ? 'bi-music-note-beamed' : a.xc ? 'bi-globe2' : a.name.startsWith('recording_') ? 'bi-mic-fill' : 'bi-file-earmark-music'}`;
    this.$('time').textContent = `${fmtTime(player.time)} / ${fmtTime(a.duration)}`;
    this._renderPlay();
  }

  _renderPlay() {
    const btn = this.$('play');
    btn.innerHTML = `<i class="bi ${player.playing ? 'bi-pause-fill' : 'bi-play-fill'}"></i>`;
    btn.setAttribute('aria-label', player.playing ? t('demo.player.pause', 'Pause') : t('demo.player.play', 'Play'));
  }

  async _startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      this.$('status').textContent = t('demo.mic.generic', 'Could not access microphone');
      return;
    }
    this.recorder = new Recorder({
      maxSeconds: MAX_RECORD_SECONDS,
      onTick: s => { this.$('timer').textContent = fmtTime(s); },
    });
    try {
      await this.recorder.start();
    } catch (err) {
      const msg = err.name === 'NotAllowedError'
        ? t('demo.mic.denied', 'Microphone access denied. Please allow microphone access in your browser settings.')
        : err.name === 'NotFoundError'
          ? t('demo.mic.notFound', 'No microphone found. Please connect a microphone and try again.')
          : t('demo.mic.generic', 'Could not access microphone');
      this.$('status').innerHTML = `<span class="text-warning"><i class="bi bi-exclamation-circle me-1"></i>${esc(msg)}</span>`;
      this.recorder = null;
      return;
    }
    player.pause();
    this.$('timer').textContent = '0:00';
    this.$('idle').hidden = true;
    this.$('recording').hidden = false;
  }

  async _stopRecording() {
    const file = await this.recorder?.stop();
    this.recorder = null;
    this.$('idle').hidden = false;
    this.$('recording').hidden = true;
    if (file) this._run(() => loadFile(file, { onStatus: (s, f) => this._status(s, null, f) }));
  }

  async _cancelRecording() {
    await this.recorder?.cancel();
    this.recorder = null;
    this.$('idle').hidden = false;
    this.$('recording').hidden = true;
  }
}
