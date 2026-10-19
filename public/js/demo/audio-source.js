/**
 * Audio input card (file, drag & drop, sample, microphone) for a demo tab.
 * Decoded audio goes to the shared store, so every tab sees the same file.
 */
import { decodeAudio, Recorder, SAMPLE_RATE } from './audio.js';
import { CONFIG, esc, fmtBytes, fmtTime, shared, t } from './core.js';
import { player } from './player.js';

const MAX_RECORD_SECONDS = 300;

let loadToken = 0;

/** Decode a File and publish it as the current recording. */
export async function loadFile(file, { isSample = false, onStatus } = {}) {
  const token = ++loadToken;
  onStatus?.('decoding');
  const buffer = await file.arrayBuffer();
  const decoded = await decodeAudio(buffer);
  if (token !== loadToken) return null;
  const url = URL.createObjectURL(file);
  if (shared.audio?.url) URL.revokeObjectURL(shared.audio.url);
  const audio = { name: file.name, size: file.size, file, url, isSample, ...decoded };
  player.setSource(url);
  shared.setAudio(audio);
  return audio;
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
    this.$('sample').addEventListener('click', () => this._run(() => loadSample(s => this._status(s))));
    this.$('record').addEventListener('click', () => this._startRecording());
    this.$('stop').addEventListener('click', () => this._stopRecording());
    this.$('cancel').addEventListener('click', () => this._cancelRecording());
    this.$('replace').addEventListener('click', () => this._showDrop(true));
    this.$('play').addEventListener('click', () => player.toggle());
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

  _status(stage) {
    const msg = {
      fetching: t('demo.source.fetching', 'Loading sample…'),
      decoding: t('demo.source.decoding', 'Decoding audio…'),
    }[stage];
    this.$('status').textContent = msg || '';
    this.root.classList.toggle('is-busy', !!msg);
  }

  async _run(fn) {
    try {
      await fn();
    } catch (err) {
      console.error(err);
      this.$('status').innerHTML = `<span class="text-danger"><i class="bi bi-exclamation-triangle me-1"></i>${esc(t('demo.source.error', 'Could not decode this audio file. Try WAV, FLAC or MP3.'))}</span>`;
      this.root.classList.remove('is-busy');
      return;
    }
    this._status(null);
  }

  _load(file) {
    if (!/^audio\/|^video\/(webm|mp4|ogg)/.test(file.type) && !/\.(wav|flac|mp3|ogg|oga|opus|m4a|aac|webm|aiff?)$/i.test(file.name)) {
      this.$('status').innerHTML = `<span class="text-warning"><i class="bi bi-exclamation-circle me-1"></i>${esc(t('demo.source.notAudio', 'This does not look like an audio file.'))}</span>`;
      return;
    }
    this._run(() => loadFile(file, { onStatus: s => this._status(s) }));
  }

  _showDrop(show) {
    this.$('drop').hidden = !show;
    this.$('bar').hidden = show || !shared.audio;
    this.$('back').hidden = !shared.audio;
  }

  render() {
    const a = shared.audio;
    this._showDrop(!a);
    if (!a) return;
    this.$('name').textContent = a.name;
    const meta = [fmtTime(a.duration, a.duration < 60 ? 1 : 0)];
    if (a.size) meta.push(fmtBytes(a.size));
    if (a.sourceRate === SAMPLE_RATE) meta.push('32 kHz');
    else if (a.sourceRate) meta.push(t('demo.source.resampled', '{rate} kHz → 32 kHz', { rate: (a.sourceRate / 1000).toLocaleString() }));
    if (a.channels > 1) meta.push(t('demo.source.mono', '{n} channels → mono', { n: a.channels }));
    this.$('meta').textContent = meta.join(' · ');
    this.$('icon').className = `bi ${a.isSample ? 'bi-music-note-beamed' : a.name.startsWith('recording_') ? 'bi-mic-fill' : 'bi-file-earmark-music'}`;
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
    if (file) this._run(() => loadFile(file, { onStatus: s => this._status(s) }));
  }

  async _cancelRecording() {
    await this.recorder?.cancel();
    this.recorder = null;
    this.$('idle').hidden = false;
    this.$('recording').hidden = true;
  }
}
