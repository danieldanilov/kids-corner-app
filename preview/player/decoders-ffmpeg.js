// The wasm decoder for the transcode path: ffmpeg.wasm (@ffmpeg/core, libavcodec). It decodes windows of an AVI's
// video (a small AVI built from the original header and a run of packets, aviwindow.js) to raw I420 frames, already
// scaled to the output size; the transcoder encodes them to H.264 with WebCodecs. Implements the decoders.js
// interface with decodeWindow() in place of decode().
//
// The wasm is downloaded and compiled once per engine Worker (compileFfmpeg, with download progress) and runs in
// a Worker of its own (ffmpeg-worker.js), so that:
//  - a run that hangs is killed after runTimeoutMs and retried on a fresh instance, and a run that fails is
//    retried once the same way, so the player is never left waiting on a stuck decoder;
//  - the instance is replaced every recycleAfter runs, before ffmpeg.wasm's per-run leaks make it crash or hang
//    (on the Fixies stand-in that happened at ~150-180 runs), and after idleMs without work, freeing its memory;
//  - raw frames come back in a transferred buffer that is handed back for the next run, never copied.

import { buildAviWindow } from './aviwindow.js';

export const FFMPEG_CODECS = new Set(['mpeg4', 'msmpeg4v1', 'msmpeg4v2', 'msmpeg4v3', 'mpeg1video', 'mpeg2video', 'wmv1', 'wmv2', 'wmv3', 'vc1', 'h263', 'mjpeg', 'flv1', 'vp6f', 'vp6']);
// Audio it turns into MP3 for the audio/mpeg buffer (Safari plays none of these).
export const FFMPEG_AUDIO = new Set(['wmav1', 'wmav2', 'wmapro', 'pcm', 'pcm_f32', 'nellymoser', 'adpcm_swf', 'mp2', 'dts', 'vorbis']);
// The vendored @ffmpeg/core 0.12.10 wasm: its size (for download progress) and the start of its SHA-256 (a
// version in its URL, so a cache can keep it for good and a new build is a new URL).
export const FFMPEG_WASM = { bytes: 32232419, version: '9f57947a' };
const here = p => new URL(p, import.meta.url).href;
const DEFAULTS = {
  coreURL: here(`./vendor/ffmpeg-core.js?v=${FFMPEG_WASM.version}`),
  wasmURL: here(`./vendor/ffmpeg-core.wasm?v=${FFMPEG_WASM.version}`),
  workerURL: here('./ffmpeg-worker.js'),
  runTimeoutMs: 20000, initTimeoutMs: 30000, recycleAfter: 64, idleMs: 60000,
};

// Download and compile once; every host in this Worker shares the module. onProgress gets 0..1 (1 when compiled).
const modules = new Map();
export function compileFfmpeg(wasmURL = DEFAULTS.wasmURL, onProgress = null) {
  let entry = modules.get(wasmURL);
  if (!entry) {
    const subs = new Set();
    const emit = f => { for (const fn of subs) { try { fn(f); } catch { /* a listener's problem */ } } };
    const promise = (async () => {
      const res = await fetch(wasmURL);
      if (!res.ok) throw new Error('ffmpeg_wasm_http_' + res.status);
      let got = 0, last = 0;
      const body = res.body
        ? res.body.pipeThrough(new TransformStream({ transform(chunk, ctl) {
          got += chunk.byteLength;
          const f = Math.min(0.99, got / FFMPEG_WASM.bytes);
          if (f - last >= 0.01) { last = f; emit(+f.toFixed(2)); }
          ctl.enqueue(chunk);
        } }))
        : await res.arrayBuffer();
      const mod = await WebAssembly.compileStreaming(new Response(body, { headers: { 'content-type': 'application/wasm' } }));
      return mod;
    })();
    entry = { promise, subs };
    modules.set(wasmURL, entry);
    promise.catch(() => { if (modules.get(wasmURL) === entry) modules.delete(wasmURL); });
  }
  if (onProgress) {
    entry.subs.add(onProgress);
    entry.promise.then(() => { entry.subs.delete(onProgress); onProgress(1); }, () => entry.subs.delete(onProgress));
  }
  return entry.promise;
}

export function createFfmpegDecoder(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const stats = { spawns: 0, execs: 0, retries: 0, timeouts: 0, failures: 0, recycles: 0, lastLog: '' };
  let worker = null, ready = null, runs = 0, seq = 0, pending = null, initWait = null, idleTimer = null;
  // One run at a time per factory: decoders from one factory share its worker, and a new transcode run (after a
  // seek) can start while an aborted one is still inside decodeWindow. Each call waits its turn; an aborted call
  // stops waiting at once, but the next caller still waits for the run in flight.
  let lane = Promise.resolve();
  const abortError = () => { const e = new Error('aborted'); e.aborted = true; return e; };

  const kill = () => {
    clearTimeout(idleTimer); idleTimer = null;
    if (worker) worker.terminate();
    worker = null; ready = null; runs = 0;
    const p = pending; pending = null; p?.reject(new Error('ffmpeg_killed'));
    const w = initWait; initWait = null; w?.reject(new Error('ffmpeg_killed'));
  };
  const spawn = () => {
    if (ready) return ready;
    stats.spawns++;
    const w = worker = new Worker(o.workerURL, { type: 'module' });
    const spawnNo = stats.spawns;
    w.onmessage = ({ data }) => {
      if (w !== worker) return;
      if (data.op === 'done') { const p = pending; if (p && p.id === data.id) { pending = null; p.resolve(data); } }
      else if (data.op === 'ready') { const i = initWait; initWait = null; i?.resolve(); }
      else if (data.op === 'error') { const i = initWait; initWait = null; i?.reject(new Error('ffmpeg_init: ' + data.error)); }
    };
    w.onerror = e => {
      if (w !== worker) return;
      const err = new Error('ffmpeg_worker: ' + (e?.message || 'error'));
      const i = initWait; initWait = null; i?.reject(err);
      const p = pending; pending = null; p?.reject(err);
    };
    ready = (async () => {
      const module = await compileFfmpeg(o.wasmURL, o.onProgress);
      if (w !== worker) throw new Error('ffmpeg_killed');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (initWait) { initWait = null; reject(new Error('ffmpeg_init_timeout')); } }, o.initTimeoutMs);
        initWait = { resolve: () => { clearTimeout(timer); resolve(); }, reject: e => { clearTimeout(timer); reject(e); } };
        w.postMessage({ op: 'init', module, coreURL: o.coreURL, spawn: spawnNo });
      });
    })();
    ready.catch(() => { if (worker === w) kill(); });
    return ready;
  };
  const run = msg => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending?.id !== id) return;
      pending = null;
      const e = new Error('ffmpeg_timeout'); e.timeout = true; reject(e);
    }, o.runTimeoutMs);
    pending = { id, resolve: d => { clearTimeout(timer); resolve(d); }, reject: e => { clearTimeout(timer); reject(e); } };
    worker.postMessage({ op: 'decode', id, ...msg }, [msg.win, ...(msg.buf ? [msg.buf] : [])]);
  });

  // One ffmpeg run over a small file, in its turn on this factory's lane: retried once on a fresh instance when it
  // fails or hangs. Returns { buf, used, partial } (buf holds `used` bytes of output); throws after two failures
  // that left nothing.
  const inTurn = async (signal, work) => {
    const turn = lane;
    let release;
    lane = new Promise(r => { release = r; });
    try {
      if (signal) {
        if (signal.aborted) throw abortError();
        let onAbort;
        const stopped = new Promise((_, rej) => { onAbort = () => rej(abortError()); signal.addEventListener('abort', onAbort, { once: true }); });
        try { await Promise.race([turn, stopped]); } finally { signal.removeEventListener('abort', onAbort); }
      } else await turn;
      return await work();
    } finally { turn.then(release); }
  };
  const runFile = async (makeWin, args, cap, buf = null) => {
    clearTimeout(idleTimer); idleTimer = null;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        await spawn();
        const b = buf; buf = null;
        res = await run({ win: makeWin().buffer, args, cap, buf: b });
      } catch (e) {
        if (/^ffmpeg_wasm_http_/.test(e?.message)) throw e; // the decoder didn't download: its own code, no retry
        res = { ret: e?.timeout ? 'timeout' : -2, used: 0, buf: null, log: String(e?.message || e) };
      }
      stats.execs++;
      if (res.ret === 0) {
        if (++runs >= o.recycleAfter) { stats.recycles++; kill(); }
        else idleTimer = setTimeout(kill, o.idleMs);
        return { buf: res.buf, used: res.used };
      }
      // A failed or stuck run: the instance is never trusted again. One more try on a fresh one.
      stats.lastLog = `ret ${res.ret}: ${res.log || ''}`.slice(0, 400);
      if (res.ret === 'timeout') stats.timeouts++;
      kill();
      if (attempt === 0) { stats.retries++; continue; }
      stats.failures++;
      if (res.buf && res.used > 0) return { buf: res.buf, used: res.used, partial: true }; // what came out before the failure is good
      throw new Error(res.ret === 'timeout' ? 'ffmpeg_timeout' : `ffmpeg_decode_${res.ret}: ${String(res.log || '').slice(0, 120)}`);
    }
  };

  return {
    stats,
    has: codec => FFMPEG_CODECS.has(codec),
    dispose: kill,
    prewarm: onProgress => compileFfmpeg(o.wasmURL, onProgress).catch(() => null),
    // Audio Safari can't play (WMA, PCM, Nellymoser ...) to MP3: `header` is an audio-only window header
    // (aviwindow.js syntheticAviAudioHeader) or makeFile builds a whole small file; returns the MP3 bytes.
    async toMp3({ header, packets, makeFile, channels = 2, signal = null }) {
      const args = ['-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', ...(channels > 2 ? ['-ac', '2'] : []), '-write_xing', '0', '-id3v2_version', '0', '-f', 'mp3'];
      const make = makeFile || (() => buildAviWindow(header, packets));
      const r = await inTurn(signal, () => runFile(make, args, 1 << 20));
      return new Uint8Array(r.buf, 0, r.used).slice();
    },
    // aviHeader: { hdrl, video: { index } } the windows are built on (inputs.js); an avi.js object works too.
    async create(codec, { avi, aviHeader, outWidth, outHeight }) {
      const header = aviHeader || (avi?.hdrl && { hdrl: avi.hdrl, video: { index: avi.video.index } });
      if (!header?.hdrl) throw new Error('ffmpeg_needs_header');
      const frameBytes = outWidth * outHeight * 1.5;
      let spare = null; // the last run's buffer, handed back to the worker with the next run
      return {
        window: true,
        // Decode packets (a GOP from its keyframe, or its first part) and return the frames after the first `skip`.
        // Each frame's data is a view of the last run's buffer: valid until the next decodeWindow call.
        async decodeWindow(packets, { skip = 0, signal = null } = {}) {
          const vf = `${skip > 0 ? `select=gte(n\\,${skip}),` : ''}scale=${outWidth}:${outHeight}:flags=bilinear`;
          const args = ['-map', '0:v:0', '-an', '-vf', vf, '-fps_mode', 'passthrough', '-pix_fmt', 'yuv420p', '-f', 'rawvideo'];
          const cap = (Math.max(0, packets.length - skip) + 2) * frameBytes;
          const r = await inTurn(signal, () => { const b = spare; spare = null; return runFile(() => buildAviWindow(header, packets), args, cap, b); });
          if (!r.partial) spare = r.buf;
          const out = new Uint8Array(r.buf, 0, r.used - (r.used % frameBytes));
          const frames = [];
          for (let off = 0; off + frameBytes <= out.length; off += frameBytes) frames.push({ data: out.subarray(off, off + frameBytes), width: outWidth, height: outHeight });
          return frames;
        },
        async flush() { return []; },
        close() { spare = null; },
      };
    },
  };
}
