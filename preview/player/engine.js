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

export const scrub = e => String(e?.message || e || 'error').replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);

function serializable(info) {
  return {
    container: info.container,
    durationSec: info.durationSec,
    video: info.video,
    audio: info.audio.map(({ track, ...rest }) => rest),
  };
}

export function createEngine(post, { fetchFn } = {}) {
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
          input = openInput(M, msg.url, { fetchFn });
          const info = await probeInput(M, input);
          inputs.set(id, { input, info });
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
        const remuxer = createRemuxer(M, rec.input, { videoTrack: rec.info.videoTrack, audioTrack: audio?.track, splitAudio: !!msg.split });
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
        if (rec) { try { rec.input.dispose(); } catch { /* ignore */ } inputs.delete(id); }
      }
    },
  };
}
