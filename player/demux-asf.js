// ASF demuxer (.wmv, .asf: WMV1/2/3 or VC-1 video, WMA audio) over range reads, as a transcode input (inputs.js
// shape). Reads the header objects (file and stream properties), then data packets of the fixed packet size,
// reassembling media objects (frames) from their payloads. Seeks with the Simple Index when the file has one,
// else by estimating the packet from the time and scanning to a keyframe.

import { syntheticAviHeader, syntheticAviAudioHeader, buildAviWindow, FOURCC } from './aviwindow.js';
import { aviVideoCodec, aviAudioCodec } from './avi.js';

const G = s => s.replace(/-/g, '').match(/../g).map(h => parseInt(h, 16));
const guid = str => { const b = G(str); return [b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.slice(8)]; };
const HEADER = guid('75B22630-668E-11CF-A6D9-00AA0062CE6C'), DATA = guid('75B22636-668E-11CF-A6D9-00AA0062CE6C');
const FILE_PROPS = guid('8CABDCA1-A947-11CF-8EE4-00C00C205365'), STREAM_PROPS = guid('B7DC0791-A9B7-11CF-8EE6-00C00C205365');
const SIMPLE_INDEX = guid('33000890-E5B1-11CF-89F4-00A0C90349CB');
const AUDIO_MEDIA = guid('F8699E40-5B4D-11CF-A8FD-00805F5C442B'), VIDEO_MEDIA = guid('BC19EFC0-5B4D-11CF-A8FD-00805F5C442B');
const eq = (b, o, g) => g.every((v, k) => b[o + k] === v);
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;
const lenOf = (b, o, type) => (type === 0 ? [0, 0] : type === 1 ? [b[o], 1] : type === 2 ? [u16(b, o), 2] : [u32(b, o), 4]);

export const isAsf = h => h.length >= 16 && eq(h, 0, HEADER);

// The payloads of one data packet: [{ stream, key, obj, off, objSize, time (ms), data }].
function packetPayloads(b, packetSize) {
  let o = 0;
  if (b[o] & 0x80) o += 1 + (b[o] & 0x0f); // error correction data
  const lt = b[o++], pf = b[o++];
  const multi = lt & 1;
  let pl, n;
  [pl, n] = lenOf(b, o, (lt >> 5) & 3); o += n;
  [, n] = lenOf(b, o, (lt >> 1) & 3); o += n; // sequence
  let pad; [pad, n] = lenOf(b, o, (lt >> 3) & 3); o += n;
  o += 6; // send time, duration
  const packetLen = pl || packetSize;
  const end = packetLen - pad;
  const rType = pf & 3, offType = (pf >> 2) & 3, objType = (pf >> 4) & 3;
  let count = 1, plType = 0;
  if (multi) { count = b[o] & 0x3f; plType = (b[o] >> 6) & 3; o++; }
  const out = [];
  for (let k = 0; k < count && o < end; k++) {
    const sn = b[o++];
    let obj, off, rl;
    [obj, n] = lenOf(b, o, objType); o += n;
    [off, n] = lenOf(b, o, offType); o += n;
    [rl, n] = lenOf(b, o, rType); o += n;
    let objSize = 0, time = 0;
    if (rl >= 8) { objSize = u32(b, o); time = u32(b, o + 4); }
    const compressed = rl === 1;
    o += rl;
    let len;
    if (multi) { [len, n] = lenOf(b, o, plType); o += n; } else len = end - o;
    const data = b.subarray(o, Math.min(end, o + len));
    o += len;
    if (compressed) { // sub-payloads, each a whole object; `off` is the presentation time
      let q = 0, sub = 0;
      while (q < data.length) { const sl = data[q++]; out.push({ stream: sn & 0x7f, key: !!(sn & 0x80), obj: obj + sub++, off: 0, objSize: sl, time: off, data: data.subarray(q, q + sl) }); q += sl; }
    } else out.push({ stream: sn & 0x7f, key: !!(sn & 0x80), obj, off, objSize, time, data });
  }
  return out;
}

export async function openAsf(read, { size }) {
  const h0 = await read(0, 30);
  if (!isAsf(h0)) throw new Error('asf_not_asf');
  const headerSize = u64(h0, 16);
  const head = await read(0, Math.min(size, headerSize + 50));
  let o = 30, packetSize = 0, packets = 0, preroll = 0, playDur = 0;
  const streams = [];
  while (o + 24 <= headerSize) {
    const sz = u64(head, o + 16);
    if (eq(head, o, FILE_PROPS)) {
      packets = u64(head, o + 24 + 32); playDur = u64(head, o + 24 + 40) / 1e7; preroll = u64(head, o + 24 + 56);
      packetSize = u32(head, o + 24 + 68);
    } else if (eq(head, o, STREAM_PROPS)) {
      const p = o + 24, tsl = u32(head, p + 40), num = u16(head, p + 48) & 0x7f, ts = p + 54;
      if (eq(head, p, VIDEO_MEDIA)) {
        const bih = ts + 11, biSize = u32(head, bih);
        const tag = String.fromCharCode(head[bih + 16], head[bih + 17], head[bih + 18], head[bih + 19]);
        streams.push({ type: 'video', num, width: u32(head, bih + 4), height: u32(head, bih + 8), tag, codec: aviVideoCodec(tag), extradata: biSize > 40 ? head.slice(bih + 40, bih + biSize) : null });
      } else if (eq(head, p, AUDIO_MEDIA)) {
        const fmt = u16(head, ts), cb = tsl >= 18 ? u16(head, ts + 16) : 0;
        streams.push({ type: 'audio', num, formatTag: fmt, codec: aviAudioCodec(fmt) || 'wma_' + fmt.toString(16), channels: u16(head, ts + 2), sampleRate: u32(head, ts + 4), avgBytesPerSec: u32(head, ts + 8), blockAlign: u16(head, ts + 12), bits: u16(head, ts + 14), wfx: head.slice(ts, ts + Math.min(tsl, 18 + cb)) });
      }
    }
    if (!sz) break;
    o += sz;
  }
  const dataStart = headerSize + 50;
  if (!packetSize) throw new Error('asf_no_packet_size');
  if (!packets) packets = Math.floor((size - dataStart) / packetSize);
  const video = streams.find(s => s.type === 'video');
  if (!video) throw new Error('asf_no_video');
  const audioTracks = streams.filter(s => s.type === 'audio');
  const durationSec = Math.max(0, playDur - preroll / 1000);

  // The Simple Index, after the data object: the packet holding the keyframe for each interval.
  let index = null;
  const idxAt = dataStart + packets * packetSize;
  if (idxAt + 56 <= size) {
    try {
      const ih = await read(idxAt, 56);
      if (eq(ih, 0, SIMPLE_INDEX)) {
        const interval = u64(ih, 40) / 1e7, n = u32(ih, 52);
        const body = await read(idxAt + 56, n * 6);
        index = { interval, packet: k => u32(body, Math.min(n - 1, k) * 6) };
      }
    } catch { /* no index */ }
  }

  let zero = 0; // the first video frame's time: times count from it
  // Frames from packet p on: { stream, key, pts, data }, objects reassembled across packets.
  async function* frames(p) {
    const open = new Map();
    const per = Math.max(1, Math.floor((1 << 20) / packetSize));
    for (; p < packets; p += per) {
      const n = Math.min(per, packets - p);
      const b = await read(dataStart + p * packetSize, n * packetSize);
      for (let k = 0; k < n && (k + 1) * packetSize <= b.length; k++) {
        let pl;
        try { pl = packetPayloads(b.subarray(k * packetSize, (k + 1) * packetSize), packetSize); } catch { continue; }
        for (const x of pl) {
          const key = x.stream + ':' + x.obj;
          if (x.off === 0 || !open.has(key)) {
            if (x.off !== 0) continue; // the start of this object was before we began
            open.set(key, { stream: x.stream, key: x.key, time: x.time, size: x.objSize || x.data.length, parts: [], got: 0 });
          }
          const ob = open.get(key);
          ob.parts.push(x.data); ob.got += x.data.length;
          if (ob.got >= ob.size) {
            open.delete(key);
            const data = new Uint8Array(ob.got); let q = 0; for (const d of ob.parts) { data.set(d, q); q += d.length; }
            yield { stream: ob.stream, key: ob.key, pts: Math.max(0, (ob.time - preroll) / 1000 - zero), data };
          }
        }
      }
    }
  }

  // The rate: the median gap between the first video frames, rounded to a common rate.
  let fps = 25;
  { const ts = []; for await (const f of frames(0)) { if (f.stream === video.num) ts.push(f.pts); if (ts.length >= 40) break; }
    const gaps = ts.slice(1).map((t, k) => t - ts[k]).filter(g => g > 0).sort((a, b) => a - b);
    if (gaps.length) { const g = gaps[gaps.length >> 1], r = 1 / g; fps = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60].reduce((a, c) => (Math.abs(c - r) < Math.abs(a - r) ? c : a), 25); }
    zero = ts.length ? Math.min(...ts.slice(0, 8)) : 0; }

  const startPacket = async t => {
    if (index) return Math.min(packets - 1, index.packet(Math.floor(t / index.interval)));
    const est = Math.floor(packets * Math.max(0, t - 3) / (durationSec || 1));
    for (let p = est, tries = 0; tries < 6; tries++, p = Math.max(0, p - Math.ceil(packets / 20))) {
      for await (const f of frames(p)) { if (f.stream === video.num && f.key) { if (f.pts <= t + 1e-3 || p === 0) return p; break; } }
      if (p === 0) return 0;
    }
    return 0;
  };
  const keyAt = async t => {
    const p = await startPacket(t);
    let best = null;
    for await (const f of frames(p)) { if (f.stream !== video.num) continue; if (f.key) { if (f.pts <= t + 1e-3 || best == null) best = f.pts; else break; } if (f.pts > t + 20) break; }
    return { p, pts: best ?? 0 };
  };

  return {
    container: 'asf', durationSec,
    video: { codec: video.codec, width: video.width, height: video.height, fps, extradata: video.extradata },
    audio: audioTracks.map((a, index) => ({ codec: a.codec, sampleRate: a.sampleRate, channels: a.channels, framed: true, index, lang: 'und', wfx: a.wfx, blockAlign: a.blockAlign, avgBytesPerSec: a.avgBytesPerSec })),
    aviHeader: syntheticAviHeader({ fourcc: FOURCC[video.codec] || video.tag, width: video.width, height: video.height, fps, extradata: video.extradata, frames: Math.round(durationSec * fps) }),
    audioFile(index, packets) {
      const a = audioTracks[index], w = a.wfx, cb = w.length >= 18 ? u16(w, 16) : 0;
      return buildAviWindow(syntheticAviAudioHeader({ formatTag: a.formatTag, channels: a.channels, sampleRate: a.sampleRate, avgBytesPerSec: a.avgBytesPerSec, blockAlign: a.blockAlign, bits: a.bits || 16, extradata: cb ? w.slice(18, 18 + cb) : null }), packets);
    },
    info() {
      return { container: 'asf', durationSec, video: { codec: video.codec, codecString: null, width: video.width, height: video.height, needsDecode: true },
        audio: audioTracks.map((a, index) => ({ index, codec: a.codec, codecString: null, lang: 'und', name: '', channels: a.channels, isDefault: index === 0, commentary: false })) };
    },
    async keyframeAt(t) { return (await keyAt(t)).pts; },
    async *gops(startSec) {
      const { p, pts } = await keyAt(startSec);
      let gop = null;
      for await (const f of frames(p)) {
        if (f.stream !== video.num) continue;
        if (f.key) { if (!gop && f.pts < pts - 1e-3) continue; if (gop) yield gop; gop = []; }
        if (!gop) continue;
        gop.push({ pts: f.pts, key: f.key, data: f.data });
      }
      if (gop?.length) yield gop;
    },
    async *audioPackets(index, startSec) {
      const a = audioTracks[index];
      if (!a) return;
      const { p } = await keyAt(startSec);
      for await (const f of frames(p)) {
        if (f.stream !== a.num || f.pts < startSec - 0.05) continue;
        yield { pts: f.pts, dur: f.data.length / (a.avgBytesPerSec || 16000), data: f.data };
      }
    },
  };
}
