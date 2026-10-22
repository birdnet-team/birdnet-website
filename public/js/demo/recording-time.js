/**
 * When a recording started, from the file's own metadata, so exports can
 * carry clock times next to the offsets in seconds. Read in this order:
 *
 * - AudioMoth comment in the WAV INFO chunk ("Recorded at 19:00:00
 *   12/05/2023 (UTC+1) by AudioMoth …"), also when it survived conversion
 *   to FLAC or another format
 * - GUANO "Timestamp" (Wildlife Acoustics, Titley, Pettersson and others)
 * - BWF bext origination date and time (Zoom, Tascam, Sound Devices, …)
 * - WAV INFO creation date, when it includes a time of day
 * - a date and time in the file name ("20230512_190000.WAV",
 *   "SMA01234_20230512_190000.wav", "2023-05-12 19-00-00.flac")
 *
 * A start is { ms, tz, source }: ms is the recorder's wall-clock time
 * written as if it were UTC (so formatting never shifts it into the
 * viewer's time zone), tz the offset from UTC in minutes or null when the
 * metadata does not say.
 */

const MAX_CHUNK = 1 << 16;
const HEAD_BYTES = 1 << 18;

const ascii = (b, p, n) => String.fromCharCode(...b.subarray(p, p + n));
const pad = (n, w = 2) => String(n).padStart(w, '0');

function make(y, mo, d, h, mi, s, frac, tz, source) {
  [y, mo, d, h, mi, s] = [y, mo, d, h, mi, s].map(Number);
  if (!(y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && s <= 60)) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) + (frac ? Math.round(Number(`0.${frac}`) * 1000) : 0);
  // Date.UTC rolls 31 April into May; such dates are no dates
  if (new Date(ms).getUTCDate() !== d) return null;
  return { ms, tz, source };
}

/** "+1", "-5", "+5:30", "+0530", "Z" → minutes; null when absent. */
function tzMinutes(sign, hours, minutes) {
  if (sign == null) return null;
  return (sign === '-' ? -1 : 1) * (Number(hours || 0) * 60 + Number(minutes || 0));
}

const AUDIOMOTH = /Recorded at (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))? (\d{2})\/(\d{2})\/(\d{4}) \(UTC(?:([+-])(\d{1,2})(?::(\d{2}))?)?\)/;

function fromAudioMoth(text) {
  const m = text.match(AUDIOMOTH);
  return m && make(m[7], m[6], m[5], m[1], m[2], m[3], m[4], tzMinutes(m[8] || '+', m[9], m[10]), 'AudioMoth');
}

const ISO = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?\s*(?:(Z)|([+-])(\d{2}):?(\d{2})?)?/;

function fromIso(text, source) {
  const m = text.match(ISO);
  if (!m) return null;
  const tz = m[8] ? 0 : tzMinutes(m[9], m[10], m[11]);
  return make(m[1], m[2], m[3], m[4], m[5], m[6], m[7], tz, source);
}

function fromGuano(text) {
  const line = text.split(/\r?\n/).find(l => /^Timestamp\s*:/.test(l));
  return line ? fromIso(line.replace(/^Timestamp\s*:\s*/, ''), 'GUANO') : null;
}

/** bext: OriginationDate at 320 ("yyyy-mm-dd") and OriginationTime at 330 ("hh:mm:ss"), local time. */
function fromBext(b) {
  if (b.length < 338) return null;
  const d = ascii(b, 320, 10).match(/^(\d{4})\D(\d{2})\D(\d{2})$/), t = ascii(b, 330, 8).match(/^(\d{2})\D(\d{2})\D(\d{2})$/);
  return d && t ? make(d[1], d[2], d[3], t[1], t[2], t[3], null, null, 'BWF') : null;
}

function fromFileName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const m = base.match(/(?<!\d)(\d{4})-?(\d{2})-?(\d{2})[T_ -](\d{2})[-_:.]?(\d{2})[-_:.]?(\d{2})(?!\d)/)
    || base.match(/(?<!\d)(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?!\d)/);
  return m && make(m[1], m[2], m[3], m[4], m[5], m[6], null, null, 'fileName');
}

const latin1 = b => new TextDecoder('latin1').decode(b);
const text = b => new TextDecoder('utf-8').decode(b).replace(/\0+$/, '');

/** Walk the chunks of a RIFF/WAVE file, including those after the audio data. */
async function fromWav(file) {
  const read = async (p, n) => new Uint8Array(await file.slice(p, p + n).arrayBuffer());
  const head = await read(0, 12);
  if (head.length < 12 || !['RIFF', 'RF64'].includes(ascii(head, 0, 4)) || ascii(head, 8, 4) !== 'WAVE') return null;
  const found = {};
  for (let p = 12; p + 8 <= file.size;) {
    const h = await read(p, 8), id = ascii(h, 0, 4), size = new DataView(h.buffer).getUint32(4, true);
    if (size === 0xffffffff) break;   // RF64 audio data: its real size is elsewhere, and nothing we need follows
    if (size <= MAX_CHUNK && ['LIST', 'guan', 'bext'].includes(id)) {
      const b = await read(p + 8, size);
      if (id === 'guan') found.guano ??= fromGuano(text(b));
      else if (id === 'bext') found.bext ??= fromBext(b);
      else if (ascii(b, 0, 4) === 'INFO') {
        for (let q = 4; q + 8 <= b.length;) {
          const sid = ascii(b, q, 4), n = new DataView(b.buffer, q + 4, 4).getUint32(0, true);
          const value = text(b.subarray(q + 8, q + 8 + n));
          if (sid === 'ICMT') found.audiomoth ??= fromAudioMoth(value);
          else if (sid === 'ICRD') found.icrd ??= fromIso(value, 'WAV INFO');
          q += 8 + n + (n & 1);
        }
      }
    }
    p += 8 + size + (size & 1);
  }
  return found.audiomoth || found.guano || found.bext || found.icrd || null;
}

/** Start of the recording in this file, or null when nothing says. */
export async function readRecordingStart(file) {
  try {
    const start = await fromWav(file)
      || fromAudioMoth(latin1(new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer())));
    return start || fromFileName(file.name || '');
  } catch (err) {
    console.warn('Could not read the recording start time', err);
    return null;
  }
}

/** Start of a recording made on this device, in its local time. */
export function localStart(date) {
  const tz = -date.getTimezoneOffset();
  return { ms: date.getTime() + tz * 60000, tz, source: 'device' };
}

/* ---------------- formatting ---------------- */

function parts(start, offsetSec) {
  const d = new Date(start.ms + Math.round(offsetSec * 1000));
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`,
  };
}

/** "+01:00", "Z", or "" when the offset is unknown. */
function isoOffset(tz) {
  if (tz == null) return '';
  if (tz === 0) return 'Z';
  const a = Math.abs(tz);
  return `${tz < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Raven selection table columns for the recorder's wall-clock time. */
export const RAVEN_CLOCK = ['Begin Date', 'Begin Clock Time', 'End Clock Time'];

/** Values for RAVEN_CLOCK: "2023-05-12", "19:00:03.000", "19:00:06.000". */
export function ravenClock(start, beginSec, endSec) {
  const b = parts(start, beginSec);
  return [b.date, b.time, parts(start, endSec).time];
}

/** "2023-05-12T19:00:03.000+01:00" (no offset when unknown). */
export function isoTime(start, offsetSec) {
  const p = parts(start, offsetSec);
  return `${p.date}T${p.time}${isoOffset(start.tz)}`;
}

/** "UTC+1", "UTC+5:30", "UTC", or "" when unknown. */
export function utcLabel(tz) {
  if (tz == null) return '';
  if (tz === 0) return 'UTC';
  const a = Math.abs(tz);
  return `UTC${tz < 0 ? '-' : '+'}${Math.floor(a / 60)}${a % 60 ? `:${pad(a % 60)}` : ''}`;
}
