/**
 * Runs BirdBox as a stream, so boxes appear a few seconds of audio at a time,
 * in a file and in a recording that is still in progress. A port of StreamGraph
 * in BirdBox's docs/javascripts/demo/chunked-graph.js.
 *
 * The model takes each 3 s window's noise floor from the 60 s before the
 * window's end, on one frame grid for the whole recording. So the spectrogram
 * is computed once, a few seconds of audio at a time, and kept as frames, and
 * each window goes through the network as soon as its frames are there. A
 * window's rows are final as soon as the audio reaches its end (readyWindows),
 * and they are the rows of one run of the whole graph, bit for bit.
 *
 * Two models do the work (fetch-models.mjs takes them out of the BirdBox model):
 *   spectrogram(audio) -> db (n_mels, frames), sound (frames)
 *   detect(db, sound, first_frame, times, conf) -> raw
 * Frame m covers samples m HOP_LENGTH + origin to m HOP_LENGTH + origin + N_FFT,
 * and window w is frames 128 w to 128 w + 251.
 *
 * Rows have the 9 columns of the graph's raw_all tensor: clip, t0, t1, f_lo,
 * f_hi, score, class, clip start, file end (see birdbox-fusion.js).
 *
 * run() reads a file's audio as the frames need it, from an array or from a source
 * that hands it out a block at a time (BlockSource: birdbox-worker.js gets it from
 * the page so), so the worker need not hold a copy of the whole file.
 */

const SAMPLE_RATE = 32000;
const CLIP_SECONDS = 3;
const CLIP_SAMPLES = CLIP_SECONDS * SAMPLE_RATE, HOP_SAMPLES = CLIP_SAMPLES / 2;
const HOP_SECONDS = HOP_SAMPLES / SAMPLE_RATE;
const OWNED_UNTIL = 0.75 * CLIP_SECONDS;   // a window owns its boxes up to here (birdbox-fusion.js)
const SEGMENT_CLIPS = 60 / HOP_SECONDS;    // column 0 counts the windows of each minute, as in the graph
// The model's spectrogram (onnx_export.py in BirdBox)
const N_MELS = 256, HOP_LENGTH = 375, N_FFT = 2048, CLIP_FRAMES = 252;
const WINDOW_FRAMES = HOP_SAMPLES / HOP_LENGTH;    // 128 frames from one window to the next
const LEFT_PAD = 16000;                            // audio the graph mirrors in front of the file: 0.5 s
const f32 = Math.fround;

/** File end of rows (column 8) while the recording is still growing. */
export const NO_END = 1e9;

/** Windows whose rows are final in a recording of n samples: the audio has reached their end. */
export const readyWindows = n => Math.max(0, Math.floor((n - CLIP_SAMPLES) / HOP_SAMPLES) + 1);

/** Samples the graph pads n samples to: the end of the last window. */
const paddedLength = n => CLIP_SAMPLES + Math.ceil(Math.max(0, n - CLIP_SAMPLES) / HOP_SAMPLES) * HOP_SAMPLES;

/** Windows in a recording of n samples. */
export const windowCount = n => (paddedLength(n) - CLIP_SAMPLES) / HOP_SAMPLES + 1;

/** File end of rows (column 8) for a recording of n samples: where its last window ends. */
export const fileEnd = n => f32(paddedLength(n) / SAMPLE_RATE);

/** Seconds up to which every window that owns a box has been seen, after `windows` windows. */
export const analyzedTo = windows => (windows - 1) * HOP_SECONDS + OWNED_UNTIL;

/** A source of samples for run(): an array, or { length, read(from, to) } (read may return a promise). */
const sourceOf = samples => (samples instanceof Float32Array
  ? { length: samples.length, read: (from, to) => samples.subarray(from, to) }
  : samples);

/** Samples from..to-1 of a source, and silence after its end, as the graph pads the file. */
async function readPadded(source, from, to) {
  const have = Math.min(to, source.length);
  if (have >= to) return source.read(from, to);
  const out = new Float32Array(to - from);
  if (have > from) out.set(await source.read(from, have));
  return out;
}

/**
 * A recording handed out a block at a time, as a source for run(): ask(from, to) asks for
 * samples from..to-1, and receive({ from, data }) takes them when they come. The next block
 * is asked for while half of the last one is still to be read, and the samples run() is
 * done with are dropped, so only a few blocks are held at any time.
 */
export class BlockSource {
  /**
   * @param {number} length  samples of the recording
   * @param {(from: number, to: number) => void} ask
   * @param {number} [block]  samples per block: 10 s
   */
  constructor(length, ask, block = 10 * SAMPLE_RATE) {
    Object.assign(this, { length, ask, block, base: 0, data: new Float32Array(0), keep: 0, asked: 0, waiting: null });
  }

  get end() { return this.base + this.data.length; }

  async read(from, to) {
    if (from < this.base) throw new Error(`samples from ${from} on were let go (${this.base})`);
    while (this.end < to) {
      this._ask();
      await new Promise(resolve => { this.waiting = resolve; });
    }
    if (this.asked - to < this.block / 2) this._ask();
    return this.data.subarray(from - this.base, to - this.base);
  }

  /** The samples before `before` are done with. */
  release(before) { this.keep = Math.max(this.keep, before); }

  _ask() {
    if (this.asked >= this.length || this.asked > this.end) return;   // all asked for, or a block is on its way
    const from = this.asked, to = Math.min(this.length, from + this.block);
    this.asked = to;
    this.ask(from, to);
  }

  /** A block; the samples let go of are dropped. */
  receive({ from, data }) {
    if (from !== this.end) throw new Error(`block at ${from}, expected ${this.end}`);
    const keep = Math.min(Math.max(this.keep, this.base), this.end), joined = new Float32Array(this.end - keep + data.length);
    joined.set(this.data.subarray(keep - this.base));
    joined.set(data, this.end - keep);
    this.base = keep;
    this.data = joined;
    this.waiting?.();
    this.waiting = null;
  }
}

/** Spectrogram frames from frame `base` on, band by band (n_mels, frames) as the graph wants them. */
class Frames {
  constructor() { this.cap = 0; this.db = new Float32Array(0); this.sound = new Uint8Array(0); this.base = 0; this.count = 0; }

  get end() { return this.base + this.count; }

  /** Forget the frames before `frame`. */
  drop(frame) {
    const k = Math.min(Math.max(0, frame - this.base), this.count);
    if (!k) return;
    for (let b = 0; b < N_MELS; b++) this.db.copyWithin(b * this.cap, b * this.cap + k, b * this.cap + this.count);
    this.sound.copyWithin(0, k, this.count);
    this.base += k;
    this.count -= k;
  }

  /** Append n frames of a (n_mels, n) block. */
  append(db, sound, n) {
    if (this.count + n > this.cap) {
      const cap = Math.max(2 * this.cap, this.count + n, 4096), grown = new Float32Array(N_MELS * cap);
      for (let b = 0; b < N_MELS; b++) grown.set(this.db.subarray(b * this.cap, b * this.cap + this.count), b * cap);
      const s = new Uint8Array(cap);
      s.set(this.sound.subarray(0, this.count));
      Object.assign(this, { cap, db: grown, sound: s });
    }
    for (let b = 0; b < N_MELS; b++) this.db.set(db.subarray(b * n, (b + 1) * n), b * this.cap + this.count);
    this.sound.set(sound.subarray(0, n), this.count);
    this.count += n;
  }

  /** Frames from..to-1, as new arrays. */
  slice(from, to) {
    const n = to - from, o = from - this.base, db = new Float32Array(N_MELS * n);
    if (o < 0 || o + n > this.count) throw new Error(`frames ${from} to ${to - 1} are not computed (${this.base} to ${this.end - 1})`);
    for (let b = 0; b < N_MELS; b++) db.set(this.db.subarray(b * this.cap + o, b * this.cap + o + n), b * n);
    return { db, sound: this.sound.slice(o, o + n), n };
  }
}

export class StreamGraph {
  /**
   * @param ort  the ONNX Runtime Web module
   * @param {{spectrogram: ArrayBuffer, detect: ArrayBuffer}} models
   * @param {object} options  session options
   * @param {{floorWindowSeconds: number, frameOrigin: number}} config  from the models manifest
   */
  static async create(ort, models, options, config) {
    const spectrogram = await ort.InferenceSession.create(new Uint8Array(models.spectrogram), options);
    const detect = await ort.InferenceSession.create(new Uint8Array(models.detect), options);
    return Object.assign(new StreamGraph(), { ort, spectrogram, detect, origin: config.frameOrigin, window: config.floorWindowSeconds * SAMPLE_RATE });
  }

  /** First frame of window w's floor window. */
  _first(w) {
    return Math.max(0, Math.ceil((w * HOP_SAMPLES + CLIP_SAMPLES - this.window - this.origin) / HOP_LENGTH));
  }

  /** Last frame window w needs. */
  _last(w) { return w * WINDOW_FRAMES + CLIP_FRAMES - 1; }

  /**
   * Compute frames up to `upTo` from the first n samples the graph sees (silence after the
   * source's end), `block` frames at most per run when audio allows. Afterwards the source
   * may let go of the samples before the next frame (release).
   */
  async _frames(frames, source, n, upTo, block) {
    const { ort, origin } = this, available = Math.floor((n - origin - N_FFT) / HOP_LENGTH);
    if (upTo > available) throw new Error(`frame ${upTo} needs more than ${n} samples`);
    while (frames.end <= upTo) {
      const m0 = frames.end, m1 = Math.min(available, Math.max(upTo, m0 + block - 1));
      const s0 = m0 * HOP_LENGTH + origin, s1 = m1 * HOP_LENGTH + origin + N_FFT;
      // Before the file start: the samples the graph's left pad puts there
      let piece = await readPadded(source, Math.max(0, s0), s1);
      if (s0 < 0) {
        const pre = new Float32Array(s1 - s0);
        pre.set(await readPadded(source, LEFT_PAD + s0, LEFT_PAD));
        pre.set(piece, -s0);
        piece = pre;
      }
      const out = await this.spectrogram.run({ audio: new ort.Tensor('float32', piece, [piece.length]) });
      const count = out.db.dims[1];
      if (count !== m1 - m0 + 1) throw new Error(`${count} frames from the spectrogram, ${m1 - m0 + 1} expected`);
      frames.append(out.db.data, out.sound.data, count);
    }
    source.release?.(Math.max(0, frames.end * HOP_LENGTH + origin));
  }

  /** Rows of windows w0 .. w0+count-1 from the frames. */
  async _detect(frames, w0, count, conf) {
    const { ort } = this, first = this._first(w0);
    frames.drop(first);   // the next windows start their floor windows later
    const { db, sound, n } = frames.slice(first, this._last(w0 + count - 1) + 1);
    const times = new Float32Array(count);
    for (let i = 0; i < count; i++) times[i] = (w0 + i) * HOP_SECONDS;
    const raw = (await this.detect.run({
      db: new ort.Tensor('float32', db, [N_MELS, n]),
      sound: new ort.Tensor('bool', sound, [n]),
      first_frame: new ort.Tensor('int64', BigInt64Array.of(BigInt(first)), []),
      times: new ort.Tensor('float32', times, [count]),
      conf: new ort.Tensor('float32', Float32Array.of(conf), [1]),
    })).raw;
    const rows = raw.dims[0] || 0, data = raw.data.slice();
    for (let r = 0; r < rows; r++) data[r * 9] = Math.round(data[r * 9 + 7] / HOP_SECONDS) % SEGMENT_CLIPS;
    return { data, rows };
  }

  /**
   * A whole recording: yields { data, rows, next, analyzedTo } after every `step`
   * windows. data holds the next rows; next counts the windows done, and a run
   * given it as `from` continues there.
   *
   * @param {Float32Array|{length: number, read: Function, release?: Function}} samples  mono audio
   *   at 32 kHz, or a source of it: read(from, to) gives (or resolves to) samples from..to-1,
   *   reads move forward, and release(before) says the samples before `before` are done with
   * @param {number} conf  confidence threshold
   * @param {number} step  windows per network run
   * @param {number} [from]  windows already done
   */
  async* run(samples, conf, step, from = 0) {
    const source = sourceOf(samples), n = source.length, target = paddedLength(n);
    const total = windowCount(n);
    // As the graph, in float32: after the file's last sample only silence was added
    const content = f32(f32(n) / SAMPLE_RATE), duration = f32(f32(target) / SAMPLE_RATE);
    const padded = duration > f32(content + f32(0.5 / SAMPLE_RATE));
    const frames = new Frames();
    for (let w = from; w < total;) {
      const k = Math.min(step, total - w);
      // Only the frames of these windows: a run that also computed the next ones would take longer than the others
      await this._frames(frames, source, target, this._last(w + k - 1), k * WINDOW_FRAMES);
      const { data, rows } = await this._detect(frames, w, k, conf);
      let kept = 0;
      for (let r = 0; r < rows; r++) {
        const o = r * 9, t0 = data[o + 1], t1 = padded ? Math.min(data[o + 2], content) : data[o + 2];
        if (padded && !(t0 < content && t1 > t0)) continue;
        if (kept !== r) data.copyWithin(kept * 9, o, o + 9);
        data[kept * 9 + 2] = t1;
        data[kept * 9 + 8] = duration;
        kept++;
      }
      w += k;
      yield { data: data.slice(0, kept * 9), rows: kept, next: w, analyzedTo: analyzedTo(w) };
    }
  }

  /**
   * A recording in progress: push() its audio as it arrives, windows() gives the final
   * rows of the next windows once they are ready (readyWindows of the samples pushed),
   * with the file end (column 8) NO_END. Only new audio is turned into frames.
   */
  live() {
    const graph = this, frames = new Frames();
    let audio = new Float32Array(60 * SAMPLE_RATE), n = 0;
    return {
      get length() { return n; },
      push(pcm) {
        if (n + pcm.length > audio.length) {
          const grown = new Float32Array(Math.max(2 * audio.length, n + pcm.length));
          grown.set(audio.subarray(0, n));
          audio = grown;
        }
        audio.set(pcm, n);
        n += pcm.length;
      },
      async windows(conf, from, count) {
        if (from + count > readyWindows(n)) throw new Error(`windows ${from} to ${from + count - 1} are not ready in ${n} samples`);
        await graph._frames(frames, sourceOf(audio.subarray(0, n)), n, graph._last(from + count - 1), WINDOW_FRAMES);
        const { data, rows } = await graph._detect(frames, from, count, conf);
        for (let r = 0; r < rows; r++) data[r * 9 + 8] = NO_END;
        return { data, rows, next: from + count };
      },
    };
  }
}
