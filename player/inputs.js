// Transcode inputs: what the transcoder reads, whatever the container. One shape:
//   { container, durationSec,
//     video: { codec, width, height, fps, extradata },
//     audio: [{ codec, sampleRate, channels, framed, decoderConfig }],   framed: each packet is whole frames
//     aviHeader: { hdrl, video: { index } }   the header the window decoder (ffmpeg.wasm) builds its AVIs from
//     keyframeAt(t) -> Promise<number|null>   the time of the keyframe at or before t
//     gops(startSec) -> async iterator of [{ pts, key, data }]   whole GOPs of video, decode order, from that keyframe
//     audioPackets(index, startSec) -> async iterator of { pts, dur, data } }
// aviInput wraps avi.js; mediabunnyInput reads MKV and MP4 whose video Safari can't play (MPEG-4 Part 2, MPEG-1/2,
// VC-1, MS-MPEG4 in a VfW track) through Mediabunny, which hands over their packets without knowing the codec.

import { aviVideoCodec } from './avi.js';
import { syntheticAviHeader, syntheticAviAudioHeader, buildAviWindow, FOURCC } from './aviwindow.js';

export function aviInput(avi) {
  const vs = avi.video;
  const vEntries = vs ? avi.packetsOf(vs.index) : [];
  return {
    container: 'avi', durationSec: avi.durationSec,
    video: vs && { codec: vs.codec, width: vs.width, height: vs.height, fps: vs.fps, extradata: vs.extradata },
    audio: avi.audio.map(a => ({ codec: a.codec, sampleRate: a.sampleRate, channels: a.channels, avgBytesPerSec: a.avgBytesPerSec, framed: false, index: a.index })),
    aviHeader: { hdrl: avi.hdrl, video: { index: vs?.index ?? 0 } },
    // A small file of these audio packets that ffmpeg can open (for audio converted to MP3).
    audioFile(index, packets) {
      const a = avi.audio[index];
      return buildAviWindow(syntheticAviAudioHeader({ formatTag: a.formatTag, channels: a.channels, sampleRate: a.sampleRate, avgBytesPerSec: a.avgBytesPerSec, blockAlign: a.blockAlign, bits: a.bits || 16, extradata: a.extradata }), packets);
    },
    async keyframeAt(t) { return avi.keyframeAt(t)?.pts ?? null; },
    async *gops(startSec) {
      const key = avi.keyframeAt(startSec) || vEntries[0];
      if (!key) return;
      let i = vEntries.indexOf(key);
      while (i < vEntries.length) {
        let j = i + 1;
        while (j < vEntries.length && !vEntries[j].key) j++;
        const gop = [];
        for (const e of vEntries.slice(i, j)) gop.push({ pts: e.pts, key: e.key, data: await avi.readPacket(e) });
        yield gop;
        i = j;
      }
    },
    async *audioPackets(index, startSec) {
      const a = avi.audio[index];
      if (!a) return;
      const list = avi.packetsOf(a.index).filter(e => e.pts >= startSec - 0.05);
      for (let k = 0; k < list.length; k++) {
        const e = list[k], next = list[k + 1];
        yield { pts: e.pts, dur: next ? next.pts - e.pts : e.size / (a.avgBytesPerSec || 16000), data: await avi.readPacket(e) };
      }
    },
  };
}

// Codecs by Matroska CodecID and MP4 sample entry, for tracks Mediabunny reads without decoding.
const MKV_VIDEO = { 'V_MPEG4/ISO/ASP': 'mpeg4', 'V_MPEG4/ISO/SP': 'mpeg4', 'V_MPEG4/ISO/AP': 'mpeg4', 'V_MPEG2': 'mpeg2video', 'V_MPEG1': 'mpeg1video', 'V_MPEG4/MS/V3': 'msmpeg4v3', 'V_REAL/RV40': null };
const MP4_VIDEO = { mp4v: 'mpeg4', mp2v: 'mpeg2video', mp1v: 'mpeg1video', 'vc-1': 'vc1', ovc1: 'vc1' };

// The codec (our name) and extradata of a video track Mediabunny has no decoder config for; null when unknown.
export function rawVideoTrackInfo(track) {
  const it = track?._backing?.internalTrack;
  if (!it) return null;
  const id = it.codecId || it.internalCodecId || null;
  const priv = it.codecPrivate instanceof Uint8Array ? it.codecPrivate : null;
  if (id === 'V_MS/VFW/FOURCC' && priv && priv.length >= 40) { // a BITMAPINFOHEADER, then the codec's extradata
    const tag = String.fromCharCode(priv[16], priv[17], priv[18], priv[19]);
    const codec = aviVideoCodec(tag);
    return codec ? { codec, extradata: priv.length > 40 ? priv.slice(40) : null, internal: id + ':' + tag } : null;
  }
  const codec = MKV_VIDEO[id] ?? MP4_VIDEO[id] ?? null;
  return codec ? { codec, extradata: priv && priv.length ? priv : null, internal: id } : null;
}

// MPEG-4 Part 2 in MP4: the VOL header lives in the esds box Mediabunny doesn't parse. Find it in the sample
// description near the sample table and return the DecoderSpecificInfo (tag 5) payload.
export async function mp4EsdsExtradata(read, track) {
  const off = track?._backing?.internalTrack?.sampleTableByteOffset;
  if (!(off >= 0)) return null;
  const b = await read(off, 64 * 1024);
  for (let i = 4; i + 4 < b.length; i++) {
    if (b[i] !== 0x65 || b[i + 1] !== 0x73 || b[i + 2] !== 0x64 || b[i + 3] !== 0x73) continue; // 'esds'
    let p = i + 8; // version and flags
    const end = Math.min(b.length, i - 4 + ((b[i - 4] << 24) | (b[i - 3] << 16) | (b[i - 2] << 8) | b[i - 1]));
    const len = () => { let n = 0; for (let k = 0; k < 4; k++) { const c = b[p++]; n = (n << 7) | (c & 0x7f); if (!(c & 0x80)) break; } return n; };
    while (p < end) {
      const tag = b[p++], n = len();
      if (tag === 0x03) { const flags = b[p + 2]; p += 3; if (flags & 0x80) p += 2; if (flags & 0x40) p += 1 + b[p]; if (flags & 0x20) p += 2; continue; }
      if (tag === 0x04) { p += 13; continue; }
      if (tag === 0x05) return b.slice(p, p + n);
      p += n;
    }
    return null;
  }
  return null;
}

const MB_AUDIO = { aac: 'aac', mp3: 'mp3', ac3: 'ac3', eac3: 'eac3', opus: 'opus', flac: 'flac', vorbis: 'vorbis' };

// An MKV or MP4 read by Mediabunny. info: probeInput's result (tracks included); raw: rawVideoTrackInfo(); read:
// a range reader (for the MP4 esds).
export async function mediabunnyInput(M, info, raw, { read } = {}) {
  const vt = info.videoTrack;
  const sink = new M.EncodedPacketSink(vt);
  const first = await sink.getFirstPacket();
  let extradata = raw.extradata;
  if (!extradata && raw.internal === 'mp4v' && read) extradata = await mp4EsdsExtradata(read, vt);
  const it = vt._backing?.internalTrack || {};
  const fps = it.defaultDurationNs > 0 ? 1e9 / it.defaultDurationNs : first?.duration > 0 ? 1 / first.duration : 25;
  const width = vt.codedWidth || info.video.width, height = vt.codedHeight || info.video.height;
  const fourcc = FOURCC[raw.codec];
  const audio = await Promise.all(info.audio.map(async a => ({
    codec: MB_AUDIO[a.codec] || a.codec, sampleRate: a.track.sampleRate, channels: a.track.numberOfChannels, framed: true, track: a.track,
    decoderConfig: await a.track.getDecoderConfig().catch(() => null),
  })));
  return {
    container: info.container, durationSec: info.durationSec,
    video: { codec: raw.codec, width, height, fps, extradata },
    audio,
    aviHeader: syntheticAviHeader({ fourcc, width, height, fps, extradata, frames: Math.round((info.durationSec || 0) * fps) }),
    async keyframeAt(t) { const k = await sink.getKeyPacket(t, { metadataOnly: true }); return k ? k.timestamp : first ? first.timestamp : null; },
    async *gops(startSec) {
      let p = (await sink.getKeyPacket(startSec)) || first;
      while (p) {
        const gop = [{ pts: p.timestamp, key: true, data: p.data }];
        let q = await sink.getNextPacket(p);
        while (q && q.type !== 'key') { gop.push({ pts: q.timestamp, key: false, data: q.data }); q = await sink.getNextPacket(q); }
        yield gop;
        p = q;
      }
    },
    async *audioPackets(index, startSec) {
      const a = audio[index];
      if (!a) return;
      const as = new M.EncodedPacketSink(a.track);
      let p = (await as.getPacket(startSec)) || (await as.getFirstPacket());
      while (p) { yield { pts: p.timestamp, dur: p.duration, data: p.data }; p = await as.getNextPacket(p); }
    },
  };
}
