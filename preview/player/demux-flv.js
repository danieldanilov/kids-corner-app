// FLV demuxer (Sorenson H.263, VP6 or H.264 video; MP3, AAC, Nellymoser or ADPCM audio) over range reads, as a
// transcode input (inputs.js shape). Tags are read in order; a seek uses the onMetaData keyframe list when the file
// has one, else estimates the byte position from the time and resyncs on a tag boundary. H.264 comes out as Annex B
// (start codes, SPS/PPS before each keyframe) for the browser's own decoder; the rest goes to ffmpeg.wasm.

import { syntheticAviHeader, FOURCC } from './aviwindow.js';

const VIDEO = { 2: 'flv1', 3: 'screen', 4: 'vp6f', 5: 'vp6a', 7: 'h264' };
const AUDIO = { 0: 'pcm', 1: 'adpcm_swf', 2: 'mp3', 3: 'pcm', 4: 'nellymoser', 5: 'nellymoser', 6: 'nellymoser', 10: 'aac', 11: 'speex', 14: 'mp3' };
const RATES = [5512, 11025, 22050, 44100];
const SCAN = 1 << 20;
const be24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

export const isFlv = h => h.length >= 9 && h[0] === 0x46 && h[1] === 0x4c && h[2] === 0x56 && h[3] === 1;

// AMF0, enough for onMetaData.
function amf(b, o) {
  const t = b[o++];
  if (t === 0) return [new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0), o + 8];
  if (t === 1) return [!!b[o], o + 1];
  if (t === 2) { const n = (b[o] << 8) | b[o + 1]; return [new TextDecoder().decode(b.subarray(o + 2, o + 2 + n)), o + 2 + n]; }
  if (t === 3 || t === 8) {
    if (t === 8) o += 4;
    const obj = {};
    while (o + 3 <= b.length) {
      const n = (b[o] << 8) | b[o + 1]; o += 2;
      if (n === 0 && b[o] === 9) return [obj, o + 1];
      const k = new TextDecoder().decode(b.subarray(o, o + n)); o += n;
      let v; [v, o] = amf(b, o); obj[k] = v;
    }
    return [obj, o];
  }
  if (t === 10) { const n = be32(b, o); o += 4; const arr = []; for (let k = 0; k < n; k++) { let v; [v, o] = amf(b, o); arr.push(v); } return [arr, o]; }
  if (t === 11) return [null, o + 10];
  if (t === 5 || t === 6) return [null, o];
  throw new Error('amf_type_' + t);
}

// Tags from byte position `from` (which must be a tag start): { at, type, ts (ms), data }.
async function* tags(read, size, from) {
  let pos = from, buf = new Uint8Array(0), bufAt = from;
  while (true) {
    while (buf.length - (pos - bufAt) < 15) {
      const end = bufAt + buf.length;
      if (end >= size) return;
      const chunk = await read(end, Math.min(SCAN, size - end));
      if (!chunk.length) return;
      const keep = buf.subarray(pos - bufAt);
      const nb = new Uint8Array(keep.length + chunk.length); nb.set(keep); nb.set(chunk, keep.length);
      buf = nb; bufAt = pos;
    }
    const o = pos - bufAt;
    const type = buf[o] & 0x1f, len = be24(buf, o + 1), ts = be24(buf, o + 4) | (buf[o + 7] << 24);
    if (o + 11 + len + 4 > buf.length) {
      const end = bufAt + buf.length;
      if (end >= size) return;
      const chunk = await read(end, Math.min(Math.max(SCAN, len + 15), size - end));
      if (!chunk.length) return;
      const keep = buf.subarray(o);
      const nb = new Uint8Array(keep.length + chunk.length); nb.set(keep); nb.set(chunk, keep.length);
      buf = nb; bufAt = pos;
      continue;
    }
    yield { at: pos, type, ts, data: buf.subarray(o + 11, o + 11 + len) };
    pos += 11 + len + 4;
  }
}

// A tag boundary at or after p: a plausible header whose size is confirmed by the PreviousTagSize after it.
async function resync(read, size, p) {
  const b = await read(p, Math.min(2 * SCAN, size - p));
  for (let o = 0; o + 15 < b.length; o++) {
    const type = b[o];
    if (type !== 8 && type !== 9 && type !== 18) continue;
    const len = be24(b, o + 1);
    if (len === 0 || len > 1 << 22 || b[o + 8] || b[o + 9] || b[o + 10]) continue;
    const after = o + 11 + len;
    if (after + 4 > b.length) continue;
    if (be32(b, after) === len + 11) return p + o;
  }
  return null;
}

function h263Size(d) { // Sorenson H.263 picture header: the frame's size
  if (d.length < 9) return null;
  const bits = (n, at) => { let v = 0; for (let k = 0; k < n; k++) { const i = at + k; v = (v << 1) | ((d[i >> 3] >> (7 - (i & 7))) & 1); } return v; };
  const fmt = bits(3, 30);
  if (fmt === 0) return [bits(8, 33), bits(8, 41)];
  if (fmt === 1) return [bits(16, 33), bits(16, 49)];
  return [[352, 288], [176, 144], [128, 96], [320, 240], [160, 120]][fmt - 2] || null;
}

// H.264 from FLV (length-prefixed NAL units) to Annex B; keyframes get the SPS and PPS in front.
function avcConfig(c) {
  const lengthSize = (c[4] & 3) + 1, nals = [];
  let o = 5;
  const nSps = c[o++] & 0x1f;
  for (let k = 0; k < nSps; k++) { const n = (c[o] << 8) | c[o + 1]; nals.push(c.subarray(o + 2, o + 2 + n)); o += 2 + n; }
  const nPps = c[o++];
  for (let k = 0; k < nPps; k++) { const n = (c[o] << 8) | c[o + 1]; nals.push(c.subarray(o + 2, o + 2 + n)); o += 2 + n; }
  return { lengthSize, nals };
}
function toAnnexB(d, cfg, key) {
  const parts = [];
  if (key) for (const n of cfg.nals) parts.push(n);
  for (let o = 0; o + cfg.lengthSize <= d.length;) {
    let n = 0; for (let k = 0; k < cfg.lengthSize; k++) n = n * 256 + d[o + k];
    o += cfg.lengthSize; parts.push(d.subarray(o, o + n)); o += n;
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + 4 + p.length, 0));
  let q = 0; for (const p of parts) { out.set([0, 0, 0, 1], q); out.set(p, q + 4); q += 4 + p.length; }
  return out;
}

export async function openFlv(read, { size }) {
  const h = await read(0, 13);
  if (!isFlv(h)) throw new Error('flv_not_flv');
  const first = be32(h, 5) + 4;
  let meta = {}, vcodec = null, acodec = null, arate = 44100, achan = 2, aacConfig = null, avc = null, vp6adj = null, wh = null;
  let firstVts = [], firstTs = null;
  for await (const t of tags(read, size, first)) {
    if (t.type === 18) { try { const [name, o] = amf(t.data, 0); if (name === 'onMetaData') meta = amf(t.data, o)[0] || {}; } catch { /* no metadata */ } }
    else if (t.type === 9 && t.data.length > 1) {
      const c = t.data[0] & 15; vcodec ??= VIDEO[c] || 'flv_' + c;
      if (c === 7 && t.data[1] === 0 && !avc) avc = avcConfig(t.data.subarray(5));
      if ((c === 4 || c === 5) && vp6adj == null) vp6adj = t.data[1];
      if (c === 2 && !wh) wh = h263Size(t.data.subarray(1));
      if (!(c === 7 && t.data[1] === 0)) { firstVts.push(t.ts); if (firstTs == null) firstTs = t.ts; }
    } else if (t.type === 8 && t.data.length > 1) {
      const f = t.data[0] >> 4; acodec ??= AUDIO[f] || 'flv_audio_' + f; arate = f === 10 ? 44100 : f === 5 ? 8000 : RATES[(t.data[0] >> 2) & 3]; achan = (t.data[0] & 1) + 1;
      if (f === 10 && t.data[1] === 0 && !aacConfig) aacConfig = t.data.slice(2);
    }
    if (firstVts.length >= 30 && (acodec || t.at > 4 << 20)) break;
  }
  if (!vcodec) throw new Error('flv_no_video');
  const gaps = firstVts.slice(1).map((t, k) => t - firstVts[k]).filter(g => g > 0).sort((a, b) => a - b);
  const r = meta.framerate > 0 ? meta.framerate : gaps.length ? 1000 / gaps[gaps.length >> 1] : 25;
  const fps = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60].reduce((a, c) => (Math.abs(c - r) < Math.abs(a - r) ? c : a), 25);
  const width = meta.width || wh?.[0] || 320, height = meta.height || wh?.[1] || 240;
  let durationSec = meta.duration > 0 ? meta.duration : null;
  if (!durationSec) { // the last tag's time, from the tail
    const p = await resync(read, size, Math.max(first, size - 2 * SCAN));
    let last = 0; if (p != null) for await (const t of tags(read, size, p)) if (t.type === 9) last = t.ts;
    durationSec = (last - (firstTs || 0)) / 1000 + 1 / fps;
  }
  const t0 = firstTs || 0;
  const kf = meta.keyframes && Array.isArray(meta.keyframes.times) && Array.isArray(meta.keyframes.filepositions) ? meta.keyframes : null;

  // Where to start reading for time t: a tag at or before the keyframe for t.
  const startAt = async t => {
    if (kf) { let k = 0; for (let i = 0; i < kf.times.length; i++) if (kf.times[i] <= t + 1e-3) k = i; return kf.filepositions[k] || first; }
    let p = Math.max(first, Math.floor(first + (size - first) * Math.max(0, t - 3) / (durationSec || 1)));
    for (let tries = 0; tries < 6; tries++) {
      const q = p <= first ? first : await resync(read, size, p);
      if (q == null) { p = Math.max(first, p - SCAN); continue; }
      for await (const g of tags(read, size, q)) { if (g.type === 9 && g.data.length > 1 && !(g.data[0] & 15 === 7 && g.data[1] === 0)) { if ((g.ts - t0) / 1000 <= t + 1e-3 || q === first) return q; break; } }
      if (q === first) return first;
      p = Math.max(first, p - Math.ceil((size - first) / 10));
    }
    return first;
  };
  const isKey = d => (d[0] >> 4) === 1;
  const frameOf = (d, ts) => {
    const c = d[0] & 15;
    if (c === 7) { if (d[1] !== 1 || !avc) return null; const cts = ((d[2] << 16) | (d[3] << 8) | d[4]) << 8 >> 8; return { pts: (ts + cts - t0) / 1000, key: isKey(d), data: toAnnexB(d.subarray(5), avc, isKey(d)) }; }
    if (c === 4 || c === 5) return { pts: (ts - t0) / 1000, key: isKey(d), data: d.subarray(c === 5 ? 5 : 2) };
    return { pts: (ts - t0) / 1000, key: isKey(d), data: d.subarray(1) };
  };
  const keyAt = async t => {
    const p = await startAt(t);
    let best = null, at = p;
    for await (const g of tags(read, size, p)) {
      if (g.type !== 9 || g.data.length < 2) continue;
      const f = frameOf(g.data, g.ts); if (!f) continue;
      if (f.key) { if (f.pts <= t + 1e-3 || best == null) { best = f.pts; at = g.at; } else break; }
      if (f.pts > t + 20) break;
    }
    return { at, pts: best ?? 0 };
  };
  const vcodecName = vcodec === 'vp6a' ? 'vp6f' : vcodec;

  return {
    container: 'flv', durationSec,
    video: { codec: vcodecName, width, height, fps, extradata: vp6adj != null ? new Uint8Array([vp6adj]) : null },
    audio: acodec ? [{ codec: acodec, sampleRate: arate, channels: achan, framed: true, index: 0, lang: 'und', decoderConfig: aacConfig ? { codec: 'mp4a.40.2', sampleRate: arate, numberOfChannels: achan, description: aacConfig } : null }] : [],
    aviHeader: syntheticAviHeader({ fourcc: FOURCC[vcodecName] || 'FLV1', width, height, fps, extradata: vp6adj != null ? new Uint8Array([vp6adj]) : null, frames: Math.round(durationSec * fps) }),
    // A small FLV of these audio tags (Nellymoser, ADPCM, PCM: ffmpeg's FLV demuxer knows how to read them).
    audioFile(index, packets) {
      const n = 13 + packets.reduce((s2, p) => s2 + 15 + p.tag.length, 0), out = new Uint8Array(n);
      out.set([0x46, 0x4c, 0x56, 1, 4, 0, 0, 0, 9, 0, 0, 0, 0]);
      let q = 13;
      for (const p of packets) {
        const len = p.tag.length, ts = p.ts - packets[0].ts;
        out.set([8, (len >> 16) & 255, (len >> 8) & 255, len & 255, (ts >> 16) & 255, (ts >> 8) & 255, ts & 255, (ts >> 24) & 255, 0, 0, 0], q);
        out.set(p.tag, q + 11);
        const pt = len + 11; out.set([(pt >>> 24) & 255, (pt >> 16) & 255, (pt >> 8) & 255, pt & 255], q + 11 + len);
        q += 15 + len;
      }
      return out;
    },
    info() {
      return { container: 'flv', durationSec, video: { codec: vcodecName, codecString: null, width, height, needsDecode: true },
        audio: acodec ? [{ index: 0, codec: acodec, codecString: null, lang: 'und', name: '', channels: achan, isDefault: true, commentary: false }] : [] };
    },
    async keyframeAt(t) { return (await keyAt(t)).pts; },
    async *gops(startSec) {
      const { at, pts } = await keyAt(startSec);
      let gop = null;
      for await (const g of tags(read, size, at)) {
        if (g.type !== 9 || g.data.length < 2) continue;
        const f = frameOf(g.data, g.ts); if (!f) continue;
        if (f.key) { if (!gop && f.pts < pts - 1e-3) continue; if (gop) yield gop; gop = []; }
        if (gop) gop.push(f);
      }
      if (gop?.length) yield gop;
    },
    async *audioPackets(index, startSec) {
      if (!acodec || index !== 0) return;
      const { at } = await keyAt(startSec);
      let prev = null;
      for await (const g of tags(read, size, at)) {
        if (g.type !== 8 || g.data.length < 2) continue;
        if ((g.data[0] >> 4) === 10 && g.data[1] === 0) continue; // the AAC config
        const pts = (g.ts - t0) / 1000;
        if (pts < startSec - 0.05) continue;
        const data = (g.data[0] >> 4) === 10 ? g.data.subarray(2) : g.data.subarray(1);
        const pkt = { pts, dur: 0, data, tag: g.data, ts: g.ts };
        if (prev) { prev.dur = Math.max(0, pts - prev.pts); yield prev; }
        prev = pkt;
      }
      if (prev) { prev.dur = prev.dur || 0.026; yield prev; }
    },
  };
}
