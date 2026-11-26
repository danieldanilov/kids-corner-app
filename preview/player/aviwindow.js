// A small AVI made of the original's header and a run of its video packets (a GOP or part of one), for decoders
// that take whole files (ffmpeg.wasm): the original header keeps every codec detail (FourCC, extradata, size).

const enc = s => [...s].map(c => c.charCodeAt(0));
function le32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }

// avi: { hdrl, video: { index }, kind? } ('wb' for an audio-only header).
export function buildAviWindow(avi, packets) {
  const sn = String(avi.video.index).padStart(2, '0');
  const id = enc(sn + (avi.kind || 'dc'));
  let moviBody = 4; // 'movi'
  for (const p of packets) moviBody += 8 + p.data.length + (p.data.length & 1);
  const idx1Size = packets.length * 16;
  const riffBody = 4 + avi.hdrl.length + 8 + moviBody + 8 + idx1Size;
  const out = new Uint8Array(8 + riffBody);
  let o = 0;
  const put = arr => { out.set(arr, o); o += arr.length; };
  put(enc('RIFF')); put(le32(riffBody)); put(enc('AVI '));
  put(avi.hdrl);
  put(enc('LIST')); put(le32(moviBody)); put(enc('movi'));
  const moviData = o - 4; // idx1 offsets are relative to the 'movi' fourcc
  const index = [];
  for (const p of packets) {
    index.push([o - moviData, p.data.length, p.key]);
    put(id); put(le32(p.data.length)); put(p.data);
    if (p.data.length & 1) put([0]);
  }
  put(enc('idx1')); put(le32(idx1Size));
  for (const [off, size, key] of index) { put(id); put(le32(key ? 0x10 : 0)); put(le32(off)); put(le32(size)); }
  return out;
}

// FourCCs ffmpeg's AVI demuxer maps to each decoder, for tracks that come from other containers.
export const FOURCC = {
  mpeg4: 'XVID', msmpeg4v3: 'DIV3', msmpeg4v2: 'MP42', msmpeg4v1: 'MPG4', mpeg1video: 'MPG1', mpeg2video: 'MPG2',
  wmv1: 'WMV1', wmv2: 'WMV2', wmv3: 'WMV3', vc1: 'WVC1', h263: 'H263', mjpeg: 'MJPG', flv1: 'FLV1', vp6f: 'VP6F', vp6: 'VP60', h264: 'H264',
};

// An AVI header list (LIST hdrl: avih, one video strl) for a video track from another container, so the window
// decoder can take its packets the same way: the codec's FourCC, size, rate and extradata (in strf, after the
// BITMAPINFOHEADER, where ffmpeg reads it).
export function syntheticAviHeader({ fourcc, width, height, fps = 25, extradata = null, frames = 0 }) {
  const ex = extradata || new Uint8Array(0);
  const strfSize = 40 + ex.length, strfPad = strfSize & 1;
  const strlBody = 4 + (8 + 56) + (8 + strfSize + strfPad);
  const hdrlBody = 4 + (8 + 56) + (8 + strlBody);
  const out = new Uint8Array(8 + hdrlBody);
  const dv = new DataView(out.buffer);
  let o = 0;
  const tag = s => { for (let k = 0; k < 4; k++) out[o++] = s.charCodeAt(k); };
  const u32 = v => { dv.setUint32(o, v >>> 0, true); o += 4; };
  const u16 = v => { dv.setUint16(o, v, true); o += 2; };
  const rate = Math.round(fps * 1000), scale = 1000;
  tag('LIST'); u32(hdrlBody); tag('hdrl');
  tag('avih'); u32(56);
  u32(Math.round(1e6 / fps)); u32(0); u32(0); u32(0x10); u32(frames); u32(0); u32(1); u32(0); u32(width); u32(height); u32(0); u32(0); u32(0); u32(0);
  tag('LIST'); u32(strlBody); tag('strl');
  tag('strh'); u32(56);
  tag('vids'); tag(fourcc); u32(0); u16(0); u16(0); u32(0); u32(scale); u32(rate); u32(0); u32(frames); u32(0); u32(0xffffffff); u32(0);
  u16(0); u16(0); u16(width); u16(height);
  tag('strf'); u32(strfSize);
  u32(40); u32(width); u32(height); u16(1); u16(24); tag(fourcc); u32(width * height * 3); u32(0); u32(0); u32(0); u32(0);
  out.set(ex, o); o += ex.length + strfPad;
  return { hdrl: out, video: { index: 0 } };
}

// An audio-only AVI header (LIST hdrl: avih, one 'auds' strl with the WAVEFORMATEX and its extradata), so ffmpeg can
// decode audio packets from any container the same way (to MP3, for audio Safari can't play).
export function syntheticAviAudioHeader({ formatTag, channels = 2, sampleRate = 48000, avgBytesPerSec = 16000, blockAlign = 1, bits = 16, extradata = null }) {
  const ex = extradata || new Uint8Array(0);
  const strfSize = 18 + ex.length, strfPad = strfSize & 1;
  const strlBody = 4 + (8 + 56) + (8 + strfSize + strfPad);
  const hdrlBody = 4 + (8 + 56) + (8 + strlBody);
  const out = new Uint8Array(8 + hdrlBody);
  const dv = new DataView(out.buffer);
  let o = 0;
  const tag = t => { for (let k = 0; k < 4; k++) out[o++] = t.charCodeAt(k); };
  const u32 = v => { dv.setUint32(o, v >>> 0, true); o += 4; };
  const u16 = v => { dv.setUint16(o, v, true); o += 2; };
  tag('LIST'); u32(hdrlBody); tag('hdrl');
  tag('avih'); u32(56);
  u32(0); u32(avgBytesPerSec); u32(0); u32(0x10); u32(0); u32(0); u32(1); u32(0); u32(0); u32(0); u32(0); u32(0); u32(0); u32(0);
  tag('LIST'); u32(strlBody); tag('strl');
  tag('strh'); u32(56);
  tag('auds'); u32(0); u32(0); u16(0); u16(0); u32(0); u32(blockAlign || 1); u32(avgBytesPerSec || 16000); u32(0); u32(0); u32(0); u32(0xffffffff); u32(blockAlign || 0);
  u16(0); u16(0); u16(0); u16(0);
  tag('strf'); u32(strfSize);
  u16(formatTag); u16(channels); u32(sampleRate); u32(avgBytesPerSec); u16(blockAlign); u16(bits); u16(ex.length);
  out.set(ex, o);
  return { hdrl: out, video: { index: 0 }, kind: 'wb' };
}
