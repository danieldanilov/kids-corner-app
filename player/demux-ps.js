// MPEG program stream demuxer (.mpg, .vob: MPEG-1/2 video with MP2, AC-3 or LPCM audio) over range reads, as a
// transcode input (inputs.js shape). A program stream has no index: a seek estimates the byte position from the
// time, then scans to the GOP whose I-frame is at or before it. Video comes out frame by frame (split at picture
// start codes, sequence and GOP headers kept with the next picture), with presentation times from the PES PTS
// and each picture's temporal reference. Audio comes out as PES payloads with their times.

import { syntheticAviHeader, FOURCC } from './aviwindow.js';

const FPS = [0, 24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60];
const SCAN = 1 << 20; // bytes read per step while scanning

// PES packets from a buffer, starting at offset o (which must be on a start code): yields
// { at (offset of its pack or packet start), id, sub, pts (90 kHz or null), data, next }.
function* pesPackets(b, o, base = 0) {
  let packAt = base + o;
  while (o + 6 <= b.length) {
    if (b[o] !== 0 || b[o + 1] !== 0 || b[o + 2] !== 1) { o++; continue; }
    const id = b[o + 3];
    if (id === 0xba) { // pack header
      packAt = base + o;
      if ((b[o + 4] & 0xc0) === 0x40) { if (o + 14 > b.length) return; o += 14 + (b[o + 13] & 7); } else o += 12;
      continue;
    }
    if (id < 0xbb) { o += 4; continue; } // not a stream: resync
    if (o + 6 > b.length) return;
    const len = (b[o + 4] << 8) | b[o + 5];
    const end = o + 6 + len;
    if (end > b.length) return; // the rest comes with the next read
    if (id === 0xbb || id === 0xbe || id === 0xbf || id === 0xbc || id < 0xbd) { o = end; continue; } // system, padding, private 2, map
    let p = o + 6, pts = null;
    if ((b[p] & 0xc0) === 0x80) { // MPEG-2 PES header
      const flags = b[p + 1], hl = b[p + 2];
      if (flags & 0x80) pts = ((b[p + 3] >> 1) & 7) * 2 ** 30 + ((b[p + 4] << 7) | (b[p + 5] >> 1)) * 2 ** 15 + ((b[p + 6] << 7) | (b[p + 7] >> 1));
      p += 3 + hl;
    } else { // MPEG-1
      while (b[p] === 0xff && p < end) p++;
      if ((b[p] & 0xc0) === 0x40) p += 2;
      if ((b[p] & 0xe0) === 0x20) { pts = ((b[p] >> 1) & 7) * 2 ** 30 + ((b[p + 1] << 7) | (b[p + 2] >> 1)) * 2 ** 15 + ((b[p + 3] << 7) | (b[p + 4] >> 1)); p += (b[p] & 0x10) ? 10 : 5; }
      else if (b[p] === 0x0f) p++;
    }
    let sub = null;
    if (id === 0xbd && p < end) { // private stream 1: a substream id, then (AC-3, DTS, LPCM) a small header
      sub = b[p];
      if (sub >= 0x80 && sub <= 0x8f) p += 4;
      else if (sub >= 0xa0 && sub <= 0xaf) p += 7;
      else p += 1;
    }
    yield { at: packAt, id, sub, pts, data: b.subarray(Math.min(p, end), end), next: end };
    o = end;
  }
}

// Sequential PES over the file from a byte offset.
async function* scanPes(read, size, from) {
  let pos = from, carry = new Uint8Array(0), carryAt = from;
  while (pos < size) {
    const chunk = await read(pos, Math.min(SCAN, size - pos));
    if (!chunk.length) return;
    const b = new Uint8Array(carry.length + chunk.length); b.set(carry); b.set(chunk, carry.length);
    let last = 0;
    for (const pk of pesPackets(b, 0, carryAt)) { yield pk; last = pk.next; }
    pos += chunk.length;
    const keep = b.subarray(last);
    if (keep.length > 4 << 20) { carry = new Uint8Array(0); carryAt = pos; } // garbage: drop it and resync
    else { carry = keep.slice(); carryAt = carryAt + last; }
  }
}

// Video frames from video PES: { at (pack offset of the PES the frame starts in), key, tr, pts90 (the PES PTS, when
// the frame's picture start code begins in a PES that has one), data }.
async function* videoFrames(pes, videoId) {
  let buf = new Uint8Array(0), bufAbs = 0, total = 0, scanAbs = 0, cur = null;
  let marks = []; // every video PES: { abs (ES offset of its first byte), at, pts, used }
  const markFor = a => { let m = null; for (const x of marks) { if (x.abs <= a) m = x; else break; } return m; };
  for await (const pk of pes) {
    if (pk.id !== videoId || !pk.data.length) continue;
    marks.push({ abs: total, at: pk.at, pts: pk.pts, used: false });
    const nb = new Uint8Array(buf.length + pk.data.length); nb.set(buf); nb.set(pk.data, buf.length); buf = nb;
    total += pk.data.length;
    for (let a = scanAbs; a + 6 <= total; a++) {
      const i = a - bufAbs;
      if (buf[i] !== 0 || buf[i + 1] !== 0 || buf[i + 2] !== 1) continue;
      const code = buf[i + 3];
      if (code !== 0xb3 && code !== 0xb8 && code !== 0x00) continue;
      if (cur && cur.hasPic) {
        yield { at: cur.at, key: cur.type === 1, tr: cur.tr, pts90: cur.pts, data: buf.slice(cur.startAbs - bufAbs, i) };
        buf = buf.slice(i); bufAbs = a; cur = null;
        const keepFrom = marks.findLastIndex(x => x.abs <= a);
        if (keepFrom > 0) marks = marks.slice(keepFrom);
      }
      if (!cur) cur = { startAbs: a, hasPic: false, at: markFor(a)?.at ?? pk.at, pts: null, type: 0, tr: 0 };
      if (code === 0x00 && !cur.hasPic) {
        const j = a - bufAbs;
        cur.hasPic = true; cur.tr = (buf[j + 4] << 2) | (buf[j + 5] >> 6); cur.type = (buf[j + 5] >> 3) & 7;
        const m = markFor(a);
        if (m && m.pts != null && !m.used) { cur.pts = m.pts; m.used = true; }
      }
      a += 3;
    }
    scanAbs = Math.max(scanAbs, total - 5);
  }
  if (cur && cur.hasPic) yield { at: cur.at, key: cur.type === 1, tr: cur.tr, pts90: cur.pts, data: buf.slice(cur.startAbs - bufAbs) };
}

function parseSeq(es) {
  for (let i = 0; i + 12 < es.length; i++) {
    if (es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 1 && es[i + 3] === 0xb3) {
      const width = (es[i + 4] << 4) | (es[i + 5] >> 4), height = ((es[i + 5] & 15) << 8) | es[i + 6];
      const fps = FPS[es[i + 7] & 15] || 25;
      let mpeg2 = false;
      for (let k = i + 12; k + 4 < es.length && k < i + 400; k++) if (es[k] === 0 && es[k + 1] === 0 && es[k + 2] === 1) { mpeg2 = es[k + 3] === 0xb5; if (es[k + 3] !== 0xb5) break; else break; }
      return { width, height, fps, codec: mpeg2 ? 'mpeg2video' : 'mpeg1video' };
    }
  }
  return null;
}

function mpaInfo(d) { // an MPEG audio frame header: layer and sample rate
  for (let i = 0; i + 4 < d.length; i++) {
    if (d[i] === 0xff && (d[i + 1] & 0xe0) === 0xe0) {
      const ver = (d[i + 1] >> 3) & 3, layer = 4 - ((d[i + 1] >> 1) & 3), sr = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]][ver]?.[(d[i + 2] >> 2) & 3];
      if (layer >= 1 && layer <= 3 && sr) return { codec: layer === 3 ? 'mp3' : 'mp2', sampleRate: sr, channels: (d[i + 3] >> 6) === 3 ? 1 : 2 };
    }
  }
  return null;
}

export const isProgramStream = h => h.length >= 4 && h[0] === 0 && h[1] === 0 && h[2] === 1 && h[3] === 0xba;

export async function openProgramStream(read, { size }) {
  if (!(size > 0)) throw new Error('ps_no_size');
  const head = await read(0, Math.min(size, 2 * SCAN));
  let videoId = null, seq = null, firstPts = null;
  const audio = new Map();
  let es = new Uint8Array(0);
  for (const pk of pesPackets(head, 0)) {
    if (pk.id >= 0xe0 && pk.id <= 0xef) {
      if (videoId == null) videoId = pk.id;
      if (pk.id === videoId) {
        if (pk.pts != null && firstPts == null) firstPts = pk.pts;
        if (!seq && es.length < 1 << 20) { const n = new Uint8Array(es.length + pk.data.length); n.set(es); n.set(pk.data, es.length); es = n; seq = parseSeq(es); }
      }
    } else if ((pk.id >= 0xc0 && pk.id <= 0xdf) || pk.id === 0xbd) {
      const key = pk.id === 0xbd ? 0xbd00 | pk.sub : pk.id;
      if (!audio.has(key) && pk.data.length) {
        let a = null;
        if (pk.id !== 0xbd) a = mpaInfo(pk.data);
        else if (pk.sub >= 0x80 && pk.sub <= 0x87) a = { codec: 'ac3', sampleRate: 48000, channels: 2 };
        else if (pk.sub >= 0xa0 && pk.sub <= 0xa7) a = { codec: 'pcm_dvd', sampleRate: 48000, channels: 2 }; // not converted yet: the picture plays alone
        if (a) audio.set(key, { ...a, id: pk.id, sub: pk.sub });
      }
    }
  }
  if (videoId == null || !seq) throw new Error('ps_no_video');
  // The length: from the first video PTS to the last one near the end.
  const tail = await read(Math.max(0, size - 2 * SCAN), Math.min(size, 2 * SCAN));
  let lastPts = null;
  let s0 = 0; while (s0 + 4 < tail.length && !(tail[s0] === 0 && tail[s0 + 1] === 0 && tail[s0 + 2] === 1 && tail[s0 + 3] === 0xba)) s0++;
  for (const pk of pesPackets(tail, s0)) if (pk.id === videoId && pk.pts != null && (lastPts == null || pk.pts > lastPts)) lastPts = pk.pts;
  const fd = 1 / seq.fps;
  const durationSec = firstPts != null && lastPts != null ? (lastPts - firstPts) / 90000 + fd : null;
  const toSec = p90 => (p90 - firstPts) / 90000;
  const tracks = [...audio.values()];

  // The keyframe (I-frame) at or before t: { at (pack offset to start reading from), pts }.
  const keyCache = new Map();
  async function findKey(t) {
    const k = Math.round(t * 10);
    if (keyCache.has(k)) return keyCache.get(k);
    const rate = durationSec ? size / durationSec : 1e6;
    let from = Math.max(0, Math.floor((t * rate) - 3 * SCAN));
    for (let tries = 0; tries < 6; tries++) {
      let best = null, firstSeen = null;
      const frames = videoFrames(scanPes(read, size, from), videoId);
      let gopBase = null;
      for await (const f of frames) {
        if (f.key && f.pts90 != null) {
          const pts = toSec(f.pts90) - f.tr * fd;
          gopBase = pts;
          const ipts = toSec(f.pts90);
          if (firstSeen == null) firstSeen = ipts;
          if (ipts <= t + 1e-3) best = { at: f.at, pts: ipts };
          else break;
        }
        if (gopBase != null && toSec(f.pts90 ?? firstPts) > t + 15) break;
      }
      await frames.return?.();
      if (best || from === 0) { const r = best || { at: 0, pts: 0 }; keyCache.set(k, r); return r; }
      from = Math.max(0, from - 4 * SCAN * (tries + 1));
    }
    return { at: 0, pts: 0 };
  }

  return {
    container: 'mpg', durationSec,
    video: { codec: seq.codec, width: seq.width, height: seq.height, fps: seq.fps, extradata: null },
    aviHeader: syntheticAviHeader({ fourcc: FOURCC[seq.codec], width: seq.width, height: seq.height, fps: seq.fps, frames: Math.round((durationSec || 0) * seq.fps) }),
    audio: tracks.map((a, index) => ({ codec: a.codec, sampleRate: a.sampleRate, channels: a.channels, framed: false, index, lang: 'und' })),
    // MPEG audio's frames are a file on their own (ffmpeg's mp3 demuxer reads layer II too).
    audioFile(index, packets) {
      const out = new Uint8Array(packets.reduce((n, p) => n + p.data.length, 0)); let q = 0;
      for (const p of packets) { out.set(p.data, q); q += p.data.length; }
      return out;
    },
    info() {
      return { container: 'mpg', durationSec, video: { codec: seq.codec, codecString: null, width: seq.width, height: seq.height, needsDecode: true },
        audio: tracks.map((a, index) => ({ index, codec: a.codec, codecString: null, lang: 'und', name: '', channels: a.channels, isDefault: index === 0, commentary: false })) };
    },
    async keyframeAt(t) { return (await findKey(t)).pts; },
    async *gops(startSec) {
      const key = await findKey(startSec);
      let gop = null, base = null, started = false;
      for await (const f of videoFrames(scanPes(read, size, key.at), videoId)) {
        if (f.key) {
          if (f.pts90 != null) base = toSec(f.pts90) - f.tr * fd;
          else if (base != null && gop) base += gop.length * fd;
          if (!started && (base == null || base + f.tr * fd < key.pts - 1e-3)) continue;
          started = true;
          if (gop) yield gop;
          gop = [];
        }
        if (!started || !gop) continue;
        gop.push({ pts: Math.max(0, (base ?? 0) + f.tr * fd), key: f.key, data: f.data });
      }
      if (gop?.length) yield gop;
    },
    async *audioPackets(index, startSec) {
      const a = tracks[index];
      if (!a) return;
      const key = await findKey(startSec);
      let pts = null, byteRate = a.codec === 'ac3' ? 24000 : 24000;
      let lastAt = null, lastLen = 0;
      for await (const pk of scanPes(read, size, key.at)) {
        if (pk.id !== a.id || (a.id === 0xbd && pk.sub !== a.sub) || !pk.data.length) continue;
        if (pk.pts != null) {
          const p = toSec(pk.pts);
          if (lastAt != null && p > lastAt && lastLen) byteRate = lastLen / (p - lastAt);
          pts = p; lastAt = p; lastLen = 0;
        } else if (pts != null) pts += pk.data.length / byteRate;
        lastLen += pk.data.length;
        if (pts == null || pts < startSec - 0.05) continue;
        yield { pts, dur: pk.data.length / byteRate, data: pk.data };
      }
    },
  };
}
