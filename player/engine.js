// Probe + remux engine. Runs inside the Web Worker (remux-worker.js) or, as a fallback, on the main
// thread. Speaks plain messages so both hosts share one code path:
//   in : {op:'probe', id, url} {op:'remux', id, runId, audioIndex, startSec, endSec, until, split}
//        {op:'demand', id, runId, until} {op:'abort', id, runId} {op:'close', id}
//   out: {op:'probed', id, info, ms} {op:'segment', id, runId, kind, data, startSec, endSec}
//        {op:'done', id, runId, result} {op:'error', id, runId?, stage, error}
// Error text is scrubbed of URLs: the CDN URL carries a TorBox token.

import * as M from './vendor/mediabunny.min.mjs';
import { openInput, probeInput } from './probe.js';
import { createRemuxer } from './remux.js';
import { openAvi, blockReader } from './avi.js';
import { createTranscoder } from './transcode.js';
import { createDecoders } from './decoders.js';
import { aviInput, mediabunnyInput } from './inputs.js';
import { openProgramStream, isProgramStream } from './demux-ps.js';
import { openAsf, isAsf } from './demux-asf.js';
import { openFlv, isFlv } from './demux-flv.js';
import { createFfmpegDecoder } from './decoders-ffmpeg.js';

export const scrub = e => String(e?.message || e || 'error').replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);

// Range reads over HTTP for the AVI demuxer (Mediabunny reads the other containers itself).
export function rangeReader(url, fetchFn = fetch) {
  return async (offset, length) => {
    if (length <= 0) return new Uint8Array(0);
    const r = await fetchFn(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (r.status === 416) return new Uint8Array(0); // past the end (a read-ahead before the size is known)
    if (!r.ok && r.status !== 206) throw new Error('http_' + r.status);
    const b = new Uint8Array(await r.arrayBuffer());
    return r.status === 200 ? b.subarray(offset, offset + length) : b;
  };
}
// The file's size, from the Content-Range of a one-byte read.
async function remoteSize(url, fetchFn = fetch) {
  const r = await fetchFn(url, { headers: { Range: 'bytes=0-0' } });
  const m = /\/(\d+)\s*$/.exec(r.headers.get('content-range') || '');
  try { await r.arrayBuffer(); } catch { /* drained */ }
  if (m) return +m[1];
  const n = +r.headers.get('content-length');
  if (r.status === 200 && n > 0) return n;
  throw new Error('no_size');
}
const isAvi = h => h.length >= 12 && h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 && h[8] === 0x41 && h[9] === 0x56 && h[10] === 0x49;
function aviInfo(avi) {
  return {
    container: 'avi', durationSec: avi.durationSec,
    video: avi.video && { codec: avi.video.codec, codecString: null, width: avi.video.width, height: avi.video.height },
    audio: avi.audio.map((a, index) => ({ index, codec: a.codec, codecString: null, lang: 'und', name: '', channels: a.channels, isDefault: index === 0, commentary: false })),
  };
}

function serializable(info) {
  return {
    container: info.container,
    durationSec: info.durationSec,
    video: info.video,
    audio: info.audio.map(({ track, ...rest }) => rest),
  };
}

export function createEngine(post, { fetchFn, decoders = createDecoders({ wasm: createFfmpegDecoder() }) } = {}) {
  const inputs = new Map();
  const runs = new Map();

  function stopRuns(id) {
    for (const [runId, r] of runs) if (r.id === id) { r.ac.abort(); r.wake?.(); runs.delete(runId); }
  }

  return {
    async handle(msg) {
      const { op, id } = msg || {};
      if (op === 'probe') {
        const t0 = Date.now();
        let input;
        try {
          const read = rangeReader(msg.url, fetchFn);
          const head = await read(0, 64);
          // MPEG program streams, ASF and FLV: our own demuxers (Mediabunny opens none of them), then the transcode.
          const own = isProgramStream(head) ? openProgramStream : isAsf(head) ? openAsf : isFlv(head) ? openFlv : null;
          if (own) {
            const size = await remoteSize(msg.url, fetchFn);
            const tin = await own(blockReader(read), { size });
            const info = tin.info();
            inputs.set(id, { tin, info });
            decoders.prewarm?.(info.video.codec, fraction => post({ op: 'decoder', id, fraction }));
            post({ op: 'probed', id, info, ms: Date.now() - t0 });
            return;
          }
          if (isAvi(head)) {
            const avi = await openAvi(blockReader(read));
            if (!avi.video) throw new Error('avi_no_video');
            inputs.set(id, { avi, info: aviInfo(avi) });
            // The wasm decoder (32 MB, once per session) starts downloading now, while the player decides.
            decoders.prewarm?.(avi.video.codec, fraction => post({ op: 'decoder', id, fraction }));
            post({ op: 'probed', id, info: aviInfo(avi), ms: Date.now() - t0 });
            return;
          }
          input = openInput(M, msg.url, { fetchFn });
          const info = await probeInput(M, input);
          inputs.set(id, { input, info, url: msg.url });
          if (info.video?.needsDecode) decoders.prewarm?.(info.video.codec, fraction => post({ op: 'decoder', id, fraction }));
          post({ op: 'probed', id, info: serializable(info), ms: Date.now() - t0 });
        } catch (e) {
          try { input?.dispose(); } catch { /* ignore */ }
          post({ op: 'error', id, stage: 'probe', error: scrub(e) });
        }
      } else if (op === 'remux') {
        const rec = inputs.get(id);
        if (!rec) return post({ op: 'error', id, runId: msg.runId, stage: 'remux', error: 'not_probed' });
        const audio = rec.info.audio[msg.audioIndex];
        const run = { id, ac: new AbortController(), allowed: msg.until ?? Infinity, wake: null, wakeTs: 0 };
        runs.set(msg.runId, run);
        if (!rec.avi && rec.info.video?.needsDecode && !rec.tin) {
          // MKV or MP4 with video Safari can't play: read through Mediabunny, decoded here (inputs.js).
          rec.tin = mediabunnyInput(M, rec.info, rec.info.video.raw, { read: rangeReader(rec.url, fetchFn) });
          rec.tin.catch(() => { rec.tin = null; });
        }
        const tin = rec.avi ? aviInput(rec.avi) : rec.tin && !rec.tin.then ? rec.tin : rec.tin ? await rec.tin.catch(e => { post({ op: 'error', id, runId: msg.runId, stage: 'remux', error: scrub(e) }); return null; }) : null;
        if (!rec.avi && rec.info.video?.needsDecode && !tin) { runs.delete(msg.runId); return; }
        const remuxer = tin
          ? createTranscoder(M, tin, { audioIndex: msg.audioIndex ?? null, split: !!msg.split, audioMp3: !!msg.audioMp3, decoders })
          : createRemuxer(M, rec.input, { videoTrack: rec.info.videoTrack, audioTrack: audio?.track, splitAudio: !!msg.split });
        try {
          const result = await remuxer.run({
            startSec: msg.startSec || 0,
            endSec: msg.endSec ?? Infinity,
            signal: run.ac.signal,
            demand: ts => (ts <= run.allowed ? null : new Promise(res => { run.wakeTs = ts; run.wake = res; })),
            onSegment: s => post({ op: 'segment', id, runId: msg.runId, ...s }, [s.data.buffer]),
          });
          post({ op: 'done', id, runId: msg.runId, result });
        } catch (e) {
          post({ op: 'error', id, runId: msg.runId, stage: 'remux', error: scrub(e) });
        } finally {
          if (runs.get(msg.runId) === run) runs.delete(msg.runId);
        }
      } else if (op === 'demand') {
        const run = runs.get(msg.runId);
        if (!run) return;
        run.allowed = msg.until;
        if (run.wake && run.wakeTs <= run.allowed) { const w = run.wake; run.wake = null; w(); }
      } else if (op === 'abort') {
        const run = runs.get(msg.runId);
        if (run) { run.ac.abort(); run.wake?.(); runs.delete(msg.runId); }
      } else if (op === 'close') {
        stopRuns(id);
        const rec = inputs.get(id);
        if (rec) { try { rec.input?.dispose(); } catch { /* ignore */ } inputs.delete(id); }
      }
    },
  };
}
