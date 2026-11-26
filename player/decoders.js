// Video decoders for the transcode path, behind one interface:
//   create(codec, { width, height, extradata, fps }) -> { decode({ data, key, pts }) -> Promise<frame[]>, flush() -> Promise<frame[]>, close() }
// A frame is either { data: Uint8Array (I420), width, height } or a WebCodecs VideoFrame.
// Built in: raw I420 ('rawvideo'), and H.264 through WebCodecs. Every other codec (Xvid/DivX, MS-MPEG4, MPEG-2,
// VC-1) needs the wasm decoder: `wasm` is a factory with the same interface, plugged in once it is vendored.

function rawDecoder({ width, height }) {
  const size = width * height * 1.5;
  return {
    async decode({ data }) { return data.length >= size ? [{ data: data.subarray(0, size), width, height }] : []; },
    async flush() { return []; },
    close() {},
  };
}

// H.264 from an AVI is Annex B (start codes, SPS/PPS in the stream): WebCodecs takes it with no description.
function webcodecsH264({ width, height }) {
  const out = [];
  let error = null;
  const dec = new VideoDecoder({ output: f => out.push(f), error: e => { error = e; } });
  dec.configure({ codec: 'avc1.64002A', codedWidth: width, codedHeight: height, optimizeForLatency: true });
  let n = 0;
  const take = () => { if (error) throw error; return out.splice(0); };
  return {
    async decode({ data, key }) {
      dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: n++ * 40000, data }));
      while (dec.decodeQueueSize > 4) await new Promise(r => setTimeout(r, 0));
      return take();
    },
    async flush() { await dec.flush(); return take(); },
    close() { try { dec.close(); } catch { /* closed */ } out.forEach(f => f.close()); out.length = 0; },
  };
}

export function createDecoders({ wasm = null, webcodecs = typeof VideoDecoder === 'function' } = {}) {
  return {
    has(codec) {
      if (codec === 'rawvideo') return true;
      if (codec === 'h264' && webcodecs) return true;
      return !!(wasm && wasm.has(codec));
    },
    // Start loading what `codec` needs ahead of the first create (the wasm decoder's download and compile);
    // onProgress gets 0..1. Null when nothing needs loading.
    prewarm(codec, onProgress) {
      if (codec === 'rawvideo' || (codec === 'h264' && webcodecs)) return null;
      return wasm?.has(codec) && wasm.prewarm ? wasm.prewarm(onProgress) : null;
    },
    // Audio Safari can't play, to MP3 (the wasm decoder's): { makeFile, channels, signal } -> Uint8Array.
    toMp3: wasm?.toMp3 ? o => wasm.toMp3(o) : null,
    async create(codec, cfg) {
      if (codec === 'rawvideo') return rawDecoder(cfg);
      if (codec === 'h264' && webcodecs) return webcodecsH264(cfg);
      if (wasm && wasm.has(codec)) return wasm.create(codec, cfg);
      throw new Error('needs_decoder');
    },
  };
}
