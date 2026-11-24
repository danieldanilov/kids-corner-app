// Kids Corner player. Contract and behaviour: README.md in this folder.
// import { createPlayer } from './player/index.js'

import { rankStreams } from './select.js';
import { decide } from './probe.js';
import { fetchStreams, fetchCinemeta, resolveViaWorker, scrubSecrets } from './sources.js';
import { createMseSink, isTypeSupported, mediaSourceClass } from './mse.js';
import { createYouTubeHost, YT_STATE } from './youtube.js';
import { createLearned } from './learned.js';
import { SILENT_MP4, SILENT_M4A } from './silent.js';

export const DEFAULTS = {
  firstByteMs: 4000,     // no probe answer in 4 s: race the next candidate
  canplayMs: 8000,       // no canplay 8 s after attach: next candidate
  stallNoticeMs: 6000,   // 'stalled' after 6 s of waiting mid-play
  stallSwitchMs: 15000,  // after 15 s, switch to a smaller candidate at the same position
  aheadSec: 60,          // remux at most this far ahead of the playhead
  startBufferSec: 4,     // 'progress' fraction reaches 1 at this much buffered
  prefetchSec: 5,        // prefetch holds this much of the likely episode
  warmMaxAgeMs: 30 * 60e3,
  ytEndGuardSec: 0.6,    // stop this close to the end so YouTube's end panel never shows
  ytNeedsTapMs: 2500,
};

const uid = () => (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36));
const itemKey = it => [it.kind, it.type, it.imdbId, it.season, it.episode, it.lang].join(':');

// --- engine client: Web Worker with a main-thread fallback -----------------------------------
function createEngineClient() {
  const handlers = new Map();
  const dispatch = msg => handlers.get(msg.id)?.(msg);
  let worker = null, fallback = null;
  const useFallback = () => {
    if (!fallback) fallback = import('./engine.js').then(m => m.createEngine(dispatch));
    return fallback;
  };
  try {
    worker = new Worker(new URL('./remux-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = e => dispatch(e.data);
    worker.onerror = () => { worker = null; useFallback(); for (const h of handlers.values()) h({ op: 'error', stage: 'worker', error: 'worker_failed' }); };
  } catch { worker = null; }
  const post = (m, t) => (worker ? worker.postMessage(m, t || []) : useFallback().then(e => e.handle(m)));
  let n = 0;
  return {
    mode: () => (worker ? 'worker' : 'main'),
    open() { const id = ++n; handlers.set(id, () => {}); return id; },
    route(id, fn) { if (handlers.has(id)) handlers.set(id, fn); },
    probe(id, url) { post({ op: 'probe', id, url }); },
    remux(id, runId, o) { post({ op: 'remux', id, runId, ...o }); },
    demand(id, runId, until) { post({ op: 'demand', id, runId, until }); },
    abort(id, runId) { post({ op: 'abort', id, runId }); },
    close(id) { handlers.delete(id); post({ op: 'close', id }); },
  };
}

function caps() {
  return { isTypeSupported, av1: isTypeSupported('video/mp4; codecs="av01.0.08M.08"') };
}

// --- player ----------------------------------------------------------------------------------
export function createPlayer({ video, ytContainer, audio, workerUrl, getSecrets, lang = 'en', options = {} } = {}) {
  const o = { ...DEFAULTS, ...options };
  const engine = createEngineClient();
  const learnedStore = createLearned();
  const learned = {
    snapshot: () => learnedStore.snapshot(),
    good: k => { if (k && k !== 'file') learnedStore.good(k); },
    failed: k => { if (k && k !== 'file') learnedStore.failed(k); },
  };
  let yt = null;
  let current = null;
  let warm = null;
  let unlocked = false;

  // options.muted: everything silent (automated checks, tests). The YouTube player is muted on ready.
  if (o.muted) { if (video) video.muted = true; if (audio) audio.muted = true; }
  if (video) {
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('x-webkit-airplay', 'deny');
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;
    video.controls = false;
    video.preload = 'auto';
  }
  if (ytContainer) {
    // Created early so the first YouTube tap lands on a ready player.
    try { yt = createYouTubeHost(ytContainer, { muted: !!o.muted }); } catch { yt = null; }
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    for (const [el, src] of [[video, SILENT_MP4], [audio, SILENT_M4A]]) {
      if (!el) continue;
      try {
        el.src = src;
        const p = el.play();
        // Clean up only if nothing real was attached meanwhile (a tap can go straight to play()).
        p?.then(() => { if (el.src === src) { el.pause(); el.removeAttribute('src'); el.load(); } }).catch(() => {});
      } catch { /* ignore */ }
    }
  }

  // ---- candidate pipeline (shared by play and prefetch) ----
  async function listCandidates(item, secrets, emit) {
    emit('progress', { fraction: null, stage: 'list' });
    const it = { ...item, lang: item.lang || lang };
    if (!(it.runtimeMin > 0) || !it.year) {
      try { const m = await fetchCinemeta(it); it.runtimeMin ||= m.runtimeMin; it.year ||= m.year; } catch { /* keep */ }
    }
    const streams = await fetchStreams(secrets.torrentioConfig, it);
    const { ranked, skipped } = rankStreams(streams, it, caps(), learned.snapshot());
    return { it, ranked, skipped };
  }

  function makeTry(it, secrets, rep, emit) {
    const resolved = new Map();
    const resolveC = c => {
      if (!resolved.has(c)) resolved.set(c, resolveViaWorker({ workerUrl, appToken: secrets.appToken, url: c.url }));
      return resolved.get(c);
    };
    const tryOne = async c => {
      emit('progress', { fraction: null, stage: 'resolve' });
      const r = c.resolvedUrl ? { status: 'ok', url: c.resolvedUrl } : await resolveC(c);
      if (r.status === 'fatal') { const e = new Error(r.reason); e.fatal = true; throw e; }
      if (r.status !== 'ok') throw new Error(r.reason);
      emit('progress', { fraction: null, stage: 'probe' });
      const id = engine.open();
      const info = await new Promise((resolve, reject) => {
        engine.route(id, msg => {
          if (msg.op === 'probed') resolve(msg.info);
          else if (msg.op === 'error') reject(new Error('probe:' + msg.error));
        });
        engine.probe(id, r.url);
      }).catch(e => { engine.close(id); throw e; });
      const d = decide(info, it, caps());
      if (!d.ok) { engine.close(id); const e = new Error(d.reason); e.durationCheck = d.durationCheck; throw e; }
      return { c, url: r.url, info, d, id, release: () => engine.close(id) };
    };
    return { tryOne, resolveC };
  }

  function race(cands, startIdx, tryOne, onFail) {
    return new Promise(resolve => {
      let next = startIdx, pending = 0, done = false;
      const timers = [];
      const finish = v => { done = true; timers.forEach(clearTimeout); resolve(v); };
      const launch = () => {
        if (done) return;
        if (next >= cands.length) { if (pending === 0) finish(null); return; }
        const c = cands[next++];
        pending++;
        const t = setTimeout(() => launch(), o.firstByteMs);
        timers.push(t);
        tryOne(c).then(win => {
          pending--; clearTimeout(t);
          if (done) { win.release(); return; }
          finish({ ...win, nextIdx: next });
        }, err => {
          pending--; clearTimeout(t);
          if (err?.fatal) { if (!done) finish({ fatal: err.message }); return; }
          onFail(c, err);
          if (!done && pending === 0) launch();
        });
      };
      launch();
    });
  }

  // ---- warm prefetch ----
  function prefetch(item) {
    if (!item || item.kind !== 'torbox') return;
    const key = itemKey({ ...item, lang: item.lang || lang });
    if (warm?.key === key) return;
    dropWarm();
    const w = { key, at: Date.now(), cancelled: false };
    w.promise = (async () => {
      const secrets = await getSecrets();
      if (!secrets?.torrentioConfig || !secrets?.appToken) return null;
      const noop = () => {};
      const { it, ranked, skipped } = await listCandidates(item, secrets, noop);
      const fallbacks = [];
      const { tryOne } = makeTry(it, secrets, null, noop);
      const win = await race(ranked, 0, tryOne, (c, e) => { fallbacks.push({ rank: c.rank, reason: scrubSecrets(e.message) }); learned.failed(c.key); });
      if (!win || win.fatal || w.cancelled) { win?.release?.(); return win?.fatal ? { fatal: win.fatal } : null; }
      const segments = [];
      if (win.d.path === 'remux') {
        const runId = uid();
        await new Promise(res => {
          engine.route(win.id, msg => {
            if (msg.runId !== runId) return;
            if (msg.op === 'segment') segments.push(msg);
            else if (msg.op === 'done') { segments.stoppedAt = msg.result?.endSec; res(); }
            else if (msg.op === 'error') res();
          });
          engine.remux(win.id, runId, { audioIndex: win.d.audioIndex, startSec: 0, endSec: o.prefetchSec, split: !!win.d.split });
        });
      }
      return { it, ranked, skipped, win, segments, fallbacks };
    })().catch(() => null);
    warm = w;
  }
  function dropWarm() {
    if (!warm) return;
    warm.cancelled = true;
    const w = warm; warm = null;
    w.promise.then(r => r?.win?.release?.());
  }

  // ---- session ----
  function play(item, { startAt = 0, keepAwake = true } = {}) {
    if (current) current._stop('replaced');
    if (!unlocked) unlock();
    const s = new EventTarget();
    const rep = {
      playId: uid(), kind: item?.kind, final: false, ttffMs: null, fileSize: null, sizeMB: null, candidate: null,
      fallbacks: [], failures: [], container: null, path: null, durationCheck: null, stalls: 0, watchedSec: 0,
      endReason: null, engine: engine.mode(), startedAt: new Date().toISOString(), marks: {},
    };
    const t0 = performance.now();
    const mark = name => { if (rep.marks[name] == null) rep.marks[name] = Math.round(performance.now() - t0); };
    let stopped = false, readyEmitted = false, cleanup = [];
    const emit = (type, detail) => {
      if (type === 'progress' && detail?.stage) mark(detail.stage);
      if (!stopped || type === 'report' || type === 'ended' || type === 'failed-all') s.dispatchEvent(new CustomEvent(type, { detail }));
    };
    const report = final => { rep.final = final; emit('report', JSON.parse(JSON.stringify(rep))); };
    const markReady = () => {
      if (readyEmitted) return;
      mark('firstFrame');
      readyEmitted = true;
      rep.ttffMs = Math.round(performance.now() - t0);
      emit('progress', { fraction: 1, stage: 'ready' });
      emit('ready', {});
      report(false);
    };
    let finished = false;
    const finish = (reason, extra) => {
      if (finished) return;
      finished = true;
      rep.endReason = reason;
      if (reason === 'failed-all') { emit('failed-all', { reasons: extra || rep.failures }); }
      if (reason === 'ended') emit('ended', {});
      if (!readyEmitted && reason === 'failed-all') report(false);
      report(true);
    };
    s._ctl = { pause() {}, resume() {}, seek() {} };
    s.pause = () => s._ctl.pause();
    s.resume = () => s._ctl.resume();
    s.seek = t => s._ctl.seek(t);
    s._stop = reason => {
      if (stopped) return;
      stopped = true;
      cleanup.forEach(f => { try { f(); } catch { /* ignore */ } });
      cleanup = [];
      if (!finished) finish(reason || 'stop');
    };
    s.stop = () => s._stop('stop');
    current = s;

    const kind = item?.kind;
    if (kind === 'youtube') playYouTube(item, startAt, s, { emit, rep, markReady, finish, cleanup: f => cleanup.push(f) });
    else if (kind === 'audio') playAudio(item, startAt, keepAwake, s, { emit, rep, markReady, finish, cleanup: f => cleanup.push(f) });
    else if (kind === 'torbox' || kind === 'file') playTorbox(item, startAt, s, { emit, rep, markReady, finish, mark, cleanup: f => cleanup.push(f), isStopped: () => stopped });
    else queueMicrotask(() => { rep.failures.push('bad_item'); finish('failed-all', ['bad_item']); });
    return s;
  }

  // ---- TorBox ----
  function playTorbox(item, startAt, s, ctx) {
    const { emit, rep, markReady, finish, cleanup, isStopped, mark } = ctx;
    rep.path = null;
    let media = null; // { kind:'direct'|'remux', teardown() }
    let lastTime = -1;
    const onTime = () => {
      const t = video.currentTime;
      rep.watchedSec = Math.max(rep.watchedSec, Math.round(t - startAt));
      if (Math.abs(t - lastTime) >= 1) { lastTime = t; emit('time', { position: t, duration: video.duration || null }); }
      media?.onTime?.();
    };
    let stallTimer1 = null, stallTimer2 = null, stalledEmitted = false;
    const clearStall = () => { clearTimeout(stallTimer1); clearTimeout(stallTimer2); stallTimer1 = stallTimer2 = null; };
    const onWaiting = () => {
      if (!rep.ttffMs || stallTimer1) return;
      media?.onWaiting?.();
      stallTimer1 = setTimeout(() => { stalledEmitted = true; rep.stalls++; emit('stalled', {}); }, o.stallNoticeMs);
      stallTimer2 = setTimeout(() => switchSmaller('stall'), o.stallSwitchMs);
    };
    const onPlaying = () => {
      clearStall();
      if (stalledEmitted) { stalledEmitted = false; emit('resumed', {}); }
      if (!rep.ttffMs && media) {
        state.win && learned.good(state.win.c.key);
        markReady();
      }
    };
    const onPause = () => { if (rep.ttffMs && !video.ended) emit('paused', {}); };
    const onEnded = () => { clearStall(); finish('ended'); teardownAll(); };
    const onProgress = () => {
      if (rep.ttffMs || !media) return;
      const end = bufferedEnd();
      if (end != null) emit('progress', { fraction: Math.min(1, Math.max(0, (end - startAt) / o.startBufferSec)), stage: 'buffer' });
    };
    const bufferedEnd = () => {
      const b = video.buffered, t = Math.max(video.currentTime, startAt);
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return b.end(i);
      return null;
    };
    const listeners = { timeupdate: onTime, waiting: onWaiting, playing: onPlaying, pause: onPause, ended: onEnded, progress: onProgress };
    for (const [k, f] of Object.entries(listeners)) video.addEventListener(k, f);
    const teardownAll = () => {
      clearStall();
      for (const [k, f] of Object.entries(listeners)) video.removeEventListener(k, f);
      media?.teardown(); media = null;
      if (state.win) { state.win.release(); state.win = null; }
    };
    cleanup(teardownAll);

    const state = { it: null, ranked: [], nextIdx: 0, win: null, secrets: null };
    s._ctl.pause = () => { video.pause(); };
    s._ctl.resume = () => { video.play().catch(() => {}); };
    s._ctl.seek = t => { media?.seek ? media.seek(t) : (video.currentTime = t); };

    async function attach(win, at, segments) {
      rep.path = win.d.path; rep.container = win.info.container; rep.durationCheck = win.d.durationCheck;
      rep.candidate = { rank: win.c.rank, score: win.c.score, container: win.c.container, res: win.c.res, videoCodec: win.c.videoCodec, audioCodec: win.c.audioCodec, filename: win.c.filename };
      rep.sizeMB = win.c.sizeMB != null ? Math.round(win.c.sizeMB) : null;
      rep.fileSize = win.c.sizeMB != null ? Math.round(win.c.sizeMB * 1048576) : null;
      emit('progress', { fraction: 0, stage: 'buffer' });
      media = win.d.path === 'direct' ? attachDirect(win, at) : await attachRemux(win, at, segments || []);
      // A remux error before the first frame fails over at once instead of waiting out the canplay timer.
      const ok = await Promise.race([waitCanPlay(), media.failed || new Promise(() => {})]);
      return ok;
    }

    function waitCanPlay() {
      return new Promise(resolve => {
        if (video.readyState >= 3) return resolve(true);
        let t;
        const done = v => { clearTimeout(t); video.removeEventListener('canplay', yes); video.removeEventListener('error', no); resolve(v); };
        const yes = () => done(true), no = () => done(false);
        video.addEventListener('canplay', yes);
        video.addEventListener('error', no);
        t = setTimeout(() => done(video.readyState >= 3), o.canplayMs);
      });
    }

    function attachDirect(win, at) {
      video.src = win.url;
      if (at > 0) video.addEventListener('loadedmetadata', () => { video.currentTime = at; }, { once: true });
      video.play().catch(() => {});
      return { kind: 'direct', teardown() { video.removeAttribute('src'); try { video.load(); } catch { /* ignore */ } } };
    }

    async function attachRemux(win, at, segments = []) {
      let runId = null, ended = false, firstMedia = false, until = at + 10, audioStarted = false, failNow;
      const failed = new Promise(r => { failNow = r; });
      const split = !!win.d.split;
      const sink = createMseSink(video, win.d.mime, {
        audioMime: split ? win.d.audioMime : null,
        onEvicted: t => startRun(t),
        onStreamingChange: () => pushDemand(),
      });
      try {
        await Promise.race([sink.opened, new Promise((_, rej) => setTimeout(() => rej(new Error('sourceopen_timeout')), o.canplayMs))]);
      } catch (e) {
        rep.failures.push(scrubSecrets(e?.message));
        sink.destroy();
        return { kind: 'remux', failed: Promise.resolve(false), teardown() {} };
      }
      if (o.debug) globalThis.__kcSink = sink;
      const pushDemand = () => {
        if (!runId) return;
        const t = video.currentTime;
        const end = sink.bufferedEndAt(t) ?? t;
        until = !sink.managed || sink.streaming ? Math.max(t, at) + o.aheadSec : Math.max(end, t + 5);
        engine.demand(win.id, runId, until);
      };
      const onSeg = msg => {
        if (msg.runId !== runId) return;
        if (msg.op === 'segment') {
          let which = 'main', offset = null;
          // WebKit's audio/mpeg buffer silently drops everything after a negative timestampOffset, so clamp at 0
          // (MP3 encoder delay makes the first frame about -25 ms: an inaudible shift).
          if (msg.kind === 'audio') { which = 'audio'; if (!audioStarted) { audioStarted = true; offset = Math.max(0, msg.startSec || 0); } }
          sink.append(msg.data, which, offset).then(() => {
            if (msg.kind === 'media' && !firstMedia) {
              firstMedia = true; mark('firstAppend');
              if (at > 0 && Math.abs(video.currentTime - at) > 0.5) video.currentTime = at;
              video.play().catch(() => {});
            }
            onProgress();
          }, e => { if (!firstMedia) { rep.failures.push('append:' + scrubSecrets(e?.message)); failNow(false); } });
        } else if (msg.op === 'done' && msg.result?.done) { ended = true; sink.end(); }
        else if (msg.op === 'error') { rep.failures.push('remux:' + scrubSecrets(msg.error)); if (!firstMedia) failNow(false); }
      };
      engine.route(win.id, onSeg);
      function startRun(from) {
        if (runId) engine.abort(win.id, runId);
        sink.dropQueued();
        runId = uid(); ended = false; audioStarted = false;
        engine.remux(win.id, runId, { audioIndex: win.d.audioIndex, startSec: from, until: from + 10, split });
      }
      // Warm segments from prefetch go in first; the live run continues from where they stopped.
      if (segments.length && at <= 0.5) {
        runId = segments[0].runId;
        for (const m of segments) onSeg(m);
        const last = segments[segments.length - 1];
        const nextFrom = segments.stoppedAt ?? last.endSec ?? o.prefetchSec;
        runId = uid(); audioStarted = false;
        engine.remux(win.id, runId, { audioIndex: win.d.audioIndex, startSec: nextFrom, until: nextFrom + 10, split });
      } else {
        startRun(at);
      }
      return {
        kind: 'remux',
        failed,
        onTime: pushDemand,
        onWaiting() { const t = video.currentTime; if (sink.bufferedEndAt(t) == null && !ended) startRun(t); },
        seek(t) {
          if (sink.bufferedEndAt(t) != null) { video.currentTime = t; return; }
          video.currentTime = t;
          startRun(t);
        },
        teardown() { if (runId) engine.abort(win.id, runId); runId = null; sink.destroy(); },
      };
    }

    async function switchSmaller(why) {
      if (isStopped() || !state.win) return;
      const curSize = state.win.c.sizeMB ?? Infinity;
      const idx = state.ranked.findIndex((c, i) => i >= state.nextIdx && (c.sizeMB ?? Infinity) < curSize);
      if (idx < 0) return;
      rep.fallbacks.push({ rank: state.win.c.rank, reason: why });
      learned.failed(state.win.c.key);
      const at = video.currentTime;
      media?.teardown(); media = null; state.win.release(); state.win = null;
      clearStall();
      await runFrom(idx, at);
    }

    async function runFrom(idx, at, warmWin, warmSegs) {
      let win = warmWin;
      while (!isStopped()) {
        if (!win) {
          win = await race(state.ranked, idx, makeTry(state.it, state.secrets, rep, emit).tryOne, (c, e) => {
            const reason = scrubSecrets(e.message);
            rep.fallbacks.push({ rank: c.rank, reason });
            if (!/app_token|origin/.test(reason)) learned.failed(c.key);
          });
          if (!win) break;
          if (win.fatal) { rep.failures.push(win.fatal); return finish('failed-all', [win.fatal]); }
        }
        if (isStopped()) { win.release(); return; }
        state.win = win; state.nextIdx = win.nextIdx ?? idx + 1;
        const ok = await attach(win, at, warmSegs);
        warmSegs = null;
        if (isStopped()) return;
        if (ok) return;
        rep.fallbacks.push({ rank: win.c.rank, reason: 'no_canplay' });
        learned.failed(win.c.key);
        media?.teardown(); media = null; win.release(); state.win = null;
        idx = state.nextIdx; win = null;
      }
      if (!isStopped()) {
        const reasons = rep.fallbacks.map(f => f.reason);
        rep.failures.push('no_playable_candidate');
        finish('failed-all', reasons.length ? reasons : ['no_candidates']);
      }
    }

    (async () => {
      try {
        if (item.kind === 'file') {
          // Diagnostic / testbed item: a media URL played through the same probe, checks and attach paths.
          // Also the seam where a future TorBox Pro HLS kind would plug in (resolve elsewhere, attach here).
          state.secrets = {}; state.it = { ...item, lang: item.lang || lang };
          const filename = String(item.url || '').split('?')[0].split('/').pop();
          const ext = (/\.([a-z0-9]{2,4})$/i.exec(filename) || [])[1]?.toLowerCase() || 'unknown';
          state.ranked = [{ rank: 1, score: 0, url: item.url, resolvedUrl: item.url, key: 'file', container: ext, filename, sizeMB: item.sizeMB ?? null }];
          return runFrom(0, startAt);
        }
        const secrets = await getSecrets();
        if (!secrets?.torrentioConfig || !secrets?.appToken) { rep.failures.push('no_secrets'); return finish('failed-all', ['no_secrets']); }
        state.secrets = secrets;
        const key = itemKey({ ...item, lang: item.lang || lang });
        let w = null;
        if (warm?.key === key && Date.now() - warm.at < o.warmMaxAgeMs) {
          const pending = warm; warm = null;
          w = await pending.promise;
          if (w?.fatal) { rep.failures.push(w.fatal); return finish('failed-all', [w.fatal]); }
        } else dropWarm();
        if (isStopped()) { w?.win?.release(); return; }
        if (w?.win) {
          state.it = w.it; state.ranked = w.ranked; rep.fallbacks.push(...w.fallbacks);
          rep.skipped = w.skipped; rep.prefetched = true;
          return runFrom(w.win.nextIdx, startAt, w.win, startAt <= 0.5 ? w.segments : null);
        }
        const { it, ranked, skipped } = await listCandidates(item, secrets, emit);
        state.it = it; state.ranked = ranked; rep.skipped = skipped;
        if (!ranked.length) { rep.failures.push('no_candidates'); return finish('failed-all', ['no_candidates']); }
        await runFrom(0, startAt);
      } catch (e) {
        rep.failures.push(scrubSecrets(e?.message));
        finish('failed-all', [scrubSecrets(e?.message)]);
      }
    })();
  }

  // ---- YouTube ----
  function playYouTube(item, startAt, s, ctx) {
    const { emit, rep, markReady, finish, cleanup } = ctx;
    rep.path = 'youtube';
    if (!yt) { rep.failures.push('no_yt_container'); queueMicrotask(() => finish('failed-all', ['no_yt_container'])); return; }
    let started = false, paused = false, endedByUs = false, stopping = false, lastSeek = null, seekRetried = false;
    let stallT = null, seekT = null, needsTapT = null, lastEmit = -1;
    const clearT = () => { clearTimeout(stallT); clearTimeout(seekT); stallT = seekT = null; };
    const endNow = () => {
      if (endedByUs) return;
      endedByUs = true; yt.show(false); yt.pause(); clearT();
      finish('ended');
    };
    const poll = setInterval(() => {
      const t = yt.time(), d = yt.duration();
      if (started) rep.watchedSec = Math.max(rep.watchedSec, Math.round(t - startAt));
      if (started && Math.abs(t - lastEmit) >= 1) { lastEmit = t; emit('time', { position: t, duration: d || null }); }
      if (started && !endedByUs && d > 0 && t >= d - o.ytEndGuardSec && yt.state() === YT_STATE.PLAYING) endNow();
    }, 250);
    yt.setHandler({
      onState(st) {
        if (endedByUs || stopping) { if (st !== YT_STATE.PAUSED && st !== YT_STATE.ENDED) yt.show(false); return; }
        if (st === YT_STATE.PLAYING) {
          clearTimeout(needsTapT); clearT(); yt.show(true);
          if (!started) { started = true; markReady(); }
          else if (paused) { paused = false; emit('resumed', {}); }
          else emit('resumed', {});
        } else if (st === YT_STATE.BUFFERING) {
          if (started) yt.show(true);
          if (!stallT) stallT = setTimeout(() => { rep.stalls++; emit('stalled', {}); }, o.stallNoticeMs);
          if (lastSeek != null && !seekRetried && !seekT) {
            seekT = setTimeout(() => { seekRetried = true; yt.seek(lastSeek); }, 8000);
          }
        } else if (st === YT_STATE.PAUSED) {
          clearT();
          if (started && !paused) { paused = true; emit('paused', {}); }
        } else if (st === YT_STATE.ENDED) {
          endNow();
        } else {
          yt.show(false);
        }
      },
      onError(code) {
        yt.show(false); clearT();
        rep.failures.push('yt_' + code);
        finish('failed-all', ['yt_' + code]);
      },
    });
    emit('progress', { fraction: null, stage: 'buffer' });
    const sync = yt.load(item.ytId || item.videoId, startAt || 0);
    if (!sync) rep.ytLoadedLate = true;
    // If the player is still unstarted or cued after a moment, iOS refused the programmatic start: show it so
    // she can tap YouTube's own play button. While it is buffering it is simply loading, so keep waiting.
    let tapChecks = 0;
    const checkTap = () => {
      if (started) return;
      const st = yt.state();
      if ((st === YT_STATE.BUFFERING || st === undefined) && ++tapChecks < 6) { needsTapT = setTimeout(checkTap, 1500); return; }
      if (st === YT_STATE.UNSTARTED || st === YT_STATE.CUED || tapChecks >= 6) { rep.needsTap = true; yt.show(true); emit('needs-tap', {}); }
    };
    needsTapT = setTimeout(checkTap, o.ytNeedsTapMs + (sync ? 0 : 3000));
    s._ctl.pause = () => { yt.show(false); yt.pause(); };
    s._ctl.resume = () => { endedByUs = false; yt.play(); };
    s._ctl.seek = t => { lastSeek = t; seekRetried = false; clearTimeout(seekT); seekT = null; yt.seek(t); };
    cleanup(() => { stopping = true; clearInterval(poll); clearTimeout(needsTapT); clearT(); yt.show(false); yt.pause(); yt.setHandler(null); });
  }

  // ---- Audio ----
  function playAudio(item, startAt, keepAwake, s, ctx) {
    const { emit, rep, markReady, finish, cleanup } = ctx;
    rep.path = 'audio';
    if (!audio) { rep.failures.push('no_audio_element'); queueMicrotask(() => finish('failed-all', ['no_audio_element'])); return; }
    let wakeLock = null, stallT = null, stalled = false, lastEmit = -1;
    const lockOn = async () => { if (!keepAwake || !navigator.wakeLock) return; try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not allowed */ } };
    const onVis = () => { if (document.visibilityState === 'visible' && !audio.paused) lockOn(); };
    const L = {
      playing: () => { clearTimeout(stallT); stallT = null; if (stalled) { stalled = false; emit('resumed', {}); } markReady(); lockOn(); },
      waiting: () => { if (!stallT && rep.ttffMs) stallT = setTimeout(() => { stalled = true; rep.stalls++; emit('stalled', {}); }, o.stallNoticeMs); },
      pause: () => { if (!audio.ended) emit('paused', {}); },
      timeupdate: () => { const t = audio.currentTime; rep.watchedSec = Math.max(rep.watchedSec, Math.round(t - startAt)); if (Math.abs(t - lastEmit) >= 1) { lastEmit = t; emit('time', { position: t, duration: audio.duration || null }); } },
      ended: () => finish('ended'),
      error: () => { rep.failures.push('audio_error'); finish('failed-all', ['audio_error']); },
      progress: () => { if (!rep.ttffMs) emit('progress', { fraction: audio.buffered.length ? Math.min(1, (audio.buffered.end(0) - startAt) / o.startBufferSec) : 0, stage: 'buffer' }); },
    };
    for (const [k, f] of Object.entries(L)) audio.addEventListener(k, f);
    document.addEventListener('visibilitychange', onVis);
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: item.title || '', artwork: item.poster ? [{ src: item.poster, sizes: '512x512' }] : [] });
        navigator.mediaSession.setActionHandler('play', () => audio.play());
        navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      } catch { /* ignore */ }
    }
    audio.src = item.url;
    if (startAt > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
    audio.play().catch(() => {});
    s._ctl.pause = () => audio.pause();
    s._ctl.resume = () => audio.play().catch(() => {});
    s._ctl.seek = t => { audio.currentTime = t; };
    cleanup(() => {
      for (const [k, f] of Object.entries(L)) audio.removeEventListener(k, f);
      document.removeEventListener('visibilitychange', onVis);
      clearTimeout(stallT);
      audio.pause(); audio.removeAttribute('src'); try { audio.load(); } catch { /* ignore */ }
      try { wakeLock?.release(); } catch { /* ignore */ }
    });
  }

  function setMuted(on) {
    if (video) video.muted = !!on;
    if (audio) audio.muted = !!on;
    if (yt) (on ? yt.mute() : yt.unMute());
  }

  return {
    unlock,
    prefetch,
    play,
    setMuted,
    engineMode: () => engine.mode(),
    hasMediaSource: () => !!mediaSourceClass(),
  };
}
