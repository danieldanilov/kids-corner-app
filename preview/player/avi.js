// AVI (RIFF) demuxer over range reads, for the files the remux path's Mediabunny can't open (DVDRip .avi:
// Xvid/DivX, MS-MPEG4, sometimes H.264, with MP3 or AC-3 audio). Reads the header and the idx1 index, then any
// packet by its index entry. Pure: takes read(offset, length) -> Promise<Uint8Array>, so it runs in a Worker,
// on the main thread and in Node tests alike. OpenDML (AVI 2.0, files over 1 GB) is read through the first
// RIFF's idx1 only when present; files without any index are refused (reason 'avi_no_index').

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// Video codecs by FourCC (biCompression or fccHandler), upper-cased.
const VIDEO = {
  XVID: 'mpeg4', DIVX: 'mpeg4', DX50: 'mpeg4', FMP4: 'mpeg4', MP4V: 'mpeg4', '3IV2': 'mpeg4', DIV5: 'mpeg4', DIV6: 'mpeg4',
  DIV3: 'msmpeg4v3', MP43: 'msmpeg4v3', DIV4: 'msmpeg4v3', AP41: 'msmpeg4v3', MP42: 'msmpeg4v2', MP41: 'msmpeg4v1', MPG4: 'msmpeg4v1',
  H264: 'h264', X264: 'h264', AVC1: 'h264', DAVC: 'h264', VSSH: 'h264',
  MPG2: 'mpeg2video', MPEG: 'mpeg2video', MPG1: 'mpeg1video', WMV1: 'wmv1', WMV2: 'wmv2', WMV3: 'wmv3', WVC1: 'vc1',
  MJPG: 'mjpeg', H263: 'h263', I420: 'rawvideo', IYUV: 'rawvideo',
};
// Audio codecs by WAVEFORMATEX wFormatTag.
const AUDIO = { 0x0001: 'pcm', 0x0055: 'mp3', 0x0050: 'mp2', 0x2000: 'ac3', 0x2001: 'dts', 0x00ff: 'aac', 0x1610: 'aac', 0x706d: 'aac', 0x0160: 'wmav1', 0x0161: 'wmav2', 0x0162: 'wmapro', 0x0003: 'pcm_f32' };

export const aviVideoCodec = tag => VIDEO[String(tag || '').toUpperCase()] || null;
export const aviAudioCodec = fmt => AUDIO[fmt] || null;

// Walk the chunks of a list body [start, end): returns [{ id, listType, offset (of the chunk header), size, data? }].
function chunks(b, start, end) {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    const id = fourcc(b, o), size = u32(b, o + 4);
    const c = { id, offset: o, size };
    if (id === 'LIST' || id === 'RIFF') c.listType = fourcc(b, o + 8);
    out.push(c);
    o += 8 + size + (size & 1);
  }
  return out;
}

export async function openAvi(read, { size: fileSize = null } = {}) {
  // Header: the RIFF header and hdrl list sit at the start; 64 KB covers ordinary files, more is read if needed.
  let head = await read(0, 65536);
  if (fourcc(head, 0) !== 'RIFF' || fourcc(head, 8) !== 'AVI ') throw new Error('avi_not_riff');
  const top = [];
  let o = 12;
  for (;;) {
    if (o + 12 > head.length) { if (fileSize != null && o + 8 > fileSize) break; const more = await read(0, o + 65536); if (more.length <= head.length) break; head = more; continue; }
    const id = fourcc(head, o), size = u32(head, o + 4);
    const c = { id, offset: o, size, listType: id === 'LIST' ? fourcc(head, o + 8) : null };
    top.push(c);
    if (c.listType === 'movi' || id === 'idx1') { if (c.listType === 'movi') { const after = o + 8 + size + (size & 1); top.push({ id: 'after-movi', offset: after }); } break; }
    o += 8 + size + (size & 1);
  }
  const hdrl = top.find(c => c.listType === 'hdrl');
  const movi = top.find(c => c.listType === 'movi');
  if (!hdrl || !movi) throw new Error('avi_no_header');
  if (head.length < hdrl.offset + 8 + hdrl.size) head = await read(0, hdrl.offset + 8 + hdrl.size);

  const avih = chunks(head, hdrl.offset + 12, hdrl.offset + 8 + hdrl.size).find(c => c.id === 'avih');
  const streams = [];
  for (const sl of chunks(head, hdrl.offset + 12, hdrl.offset + 8 + hdrl.size).filter(c => c.listType === 'strl')) {
    const parts = chunks(head, sl.offset + 12, sl.offset + 8 + sl.size);
    const strh = parts.find(c => c.id === 'strh'), strf = parts.find(c => c.id === 'strf');
    if (!strh || !strf) { streams.push({ type: 'other' }); continue; }
    const h = strh.offset + 8, f = strf.offset + 8;
    const type = fourcc(head, h);
    const s = { index: streams.length, fccType: type, handler: fourcc(head, h + 4), scale: u32(head, h + 20), rate: u32(head, h + 24),
      length: u32(head, h + 32), sampleSize: u32(head, h + 44) };
    if (type === 'vids') {
      s.type = 'video';
      s.width = u32(head, f + 4); s.height = Math.abs(u32(head, f + 8) | 0);
      s.fourcc = fourcc(head, f + 16);
      s.codec = aviVideoCodec(s.fourcc) || aviVideoCodec(s.handler);
      s.extradata = strf.size > 40 ? head.slice(f + 40, f + strf.size) : null;
      s.fps = s.scale ? s.rate / s.scale : 25;
    } else if (type === 'auds') {
      s.type = 'audio';
      s.formatTag = u16(head, f); s.channels = u16(head, f + 2); s.sampleRate = u32(head, f + 4);
      s.avgBytesPerSec = u32(head, f + 8); s.blockAlign = u16(head, f + 12); s.bits = u16(head, f + 14);
      s.codec = aviAudioCodec(s.formatTag);
      const cb = strf.size >= 18 ? u16(head, f + 16) : 0;
      s.extradata = cb > 0 && strf.size >= 18 + cb ? head.slice(f + 18, f + 18 + cb) : null;
    } else s.type = 'other';
    streams.push(s);
  }

  // idx1 follows the movi list.
  const moviData = movi.offset + 8; // the 'movi' fourcc position: idx1 offsets are relative to it (usually)
  const idxAt = movi.offset + 8 + movi.size + (movi.size & 1);
  const idxHead = await read(idxAt, 8);
  if (idxHead.length < 8 || fourcc(idxHead, 0) !== 'idx1') throw new Error('avi_no_index');
  const idxSize = u32(idxHead, 4);
  const idx = await read(idxAt + 8, idxSize);
  if (idx.length < idxSize) throw new Error('avi_no_index'); // a truncated file: the index is cut off
  const entries = [];
  let base = null;
  const counts = streams.map(() => 0), bytes = streams.map(() => 0);
  for (let p = 0; p + 16 <= idx.length; p += 16) {
    const id = fourcc(idx, p);
    const sn = parseInt(id.slice(0, 2), 10);
    if (!(sn >= 0 && sn < streams.length) || id === 'rec ' || id.slice(0, 2) === 'ix') continue;
    const kind = id.slice(2);
    const flags = u32(idx, p + 4), off = u32(idx, p + 8), size = u32(idx, p + 12);
    if (base == null) base = off < moviData ? moviData : 0; // relative (to the 'movi' fourcc) or absolute
    const s = streams[sn];
    if (!s || (s.type === 'video' && !/^d[bc]$/.test(kind)) || (s.type === 'audio' && kind !== 'wb')) continue;
    // An empty audio chunk carries no time; an empty video chunk is a dropped frame: it holds its time slot but
    // has nothing to decode (ffprobe lists neither).
    if (!size && s.type === 'audio') continue;
    if (!size) { counts[sn]++; continue; }
    const e = { stream: sn, offset: base + off + 8, size, key: s.type === 'audio' || !!(flags & 0x10), n: counts[sn] };
    if (s.type === 'video') e.pts = counts[sn] * (s.scale / s.rate);
    else if (s.sampleSize > 0 && s.avgBytesPerSec > 0) e.pts = bytes[sn] / s.avgBytesPerSec; // CBR audio: by bytes
    else e.pts = counts[sn] * (s.scale / (s.rate || 1)); // VBR audio: one block per chunk
    counts[sn]++; bytes[sn] += size;
    entries.push(e);
  }
  for (const s of streams) if (s.type === 'video' || s.type === 'audio') { s.frames = counts[s.index]; s.packets = entries.filter(e => e.stream === s.index).length; s.bytes = bytes[s.index]; }

  const video = streams.find(s => s.type === 'video') || null;
  const audio = streams.filter(s => s.type === 'audio');
  const vEntries = video ? entries.filter(e => e.stream === video.index) : [];
  const durationSec = video ? video.frames / video.fps : audio[0] ? (audio[0].sampleSize > 0 ? audio[0].bytes / audio[0].avgBytesPerSec : audio[0].frames * audio[0].scale / audio[0].rate) : 0;
  const keyIdx = vEntries.filter(e => e.key);

  return {
    container: 'avi', streams, video, audio, entries, durationSec,
    hdrl: head.slice(hdrl.offset, hdrl.offset + 8 + hdrl.size + (hdrl.size & 1)), // the header list, as is (for window files)
    microSecPerFrame: avih ? u32(head, avih.offset + 8) : null,
    // The last keyframe at or before t (seconds), as an index into the video packets.
    keyframeAt(t) {
      let k = keyIdx[0] || null;
      for (const e of keyIdx) { if (e.pts <= t + 1e-6) k = e; else break; }
      return k;
    },
    // Packets of one stream from a given position, in file order.
    packetsOf(streamIndex) { return entries.filter(e => e.stream === streamIndex); },
    async readPacket(e) { return e.size ? read(e.offset, e.size) : new Uint8Array(0); },
  };
}

// Packet reads over the network as a few large range requests: the file is read in aligned blocks (1 MB by
// default), the last few kept, so the interleaved video and audio packets of a run come from the same blocks.
export function blockReader(read, { blockSize = 1 << 20, keep = 24, ahead = 1 } = {}) {
  const blocks = new Map(); // index -> Promise<Uint8Array>
  let endBlock = Infinity; // the first short block is the file's last
  const get = i => {
    let b = blocks.get(i);
    if (!b) {
      b = read(i * blockSize, blockSize).then(d => { if (d.length < blockSize) endBlock = Math.min(endBlock, i); return d; });
      blocks.set(i, b);
      b.catch(() => blocks.delete(i));
      while (blocks.size > keep) blocks.delete(blocks.keys().next().value);
    } else { blocks.delete(i); blocks.set(i, b); } // most recently used last
    return b;
  };
  return async (offset, length) => {
    if (length <= 0) return new Uint8Array(0);
    if (length > blockSize * 4) return read(offset, length); // big reads (the index) go straight through
    const first = Math.floor(offset / blockSize), last = Math.floor((offset + length - 1) / blockSize);
    for (let k = 1; k <= ahead; k++) if (last + k <= endBlock && !blocks.has(last + k)) get(last + k).catch(() => {}); // read ahead, never past the end
    if (first === last) {
      const b = await get(first);
      const s = offset - first * blockSize;
      return b.subarray(s, Math.min(b.length, s + length));
    }
    const out = new Uint8Array(length);
    let o = 0;
    for (let i = first; i <= last; i++) {
      const b = await get(i);
      const s = i === first ? offset - first * blockSize : 0;
      const e = Math.min(b.length, i === last ? offset + length - i * blockSize : blockSize);
      out.set(b.subarray(s, e), o); o += e - s;
    }
    return o === length ? out : out.subarray(0, o);
  };
}
