// Kids Corner player. Contract and behaviour: README.md in this folder.
// import { createPlayer } from './player/index.js'

import { rankStreams } from './select.js';
import { createDecoders } from './decoders.js';
import { FFMPEG_CODECS } from './decoders-ffmpeg.js';
import { decide } from './probe.js';
import { fetchStreams, fetchCinemeta, resolveViaWorker, scrubSecrets, listOutcome } from './sources.js';
import { createMseSink, isTypeSupported, mediaSourceClass } from './mse.js';
import { createYouTubeHost, YT_STATE, ytHostName, classifyAd, classifyYtError, desiredMute, holeFor } from './youtube.js';
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
  transcodeHoldSec: 6,   // a transcode starts playing once this much is converted ahead (or the file is done)
  ytNearEndSec: 15,      // a YouTube error this close to the end ends the video as watched ('ended' {nearEnd:true})
  nearEndSec: 60,        // a TorBox file that breaks this close to the end, with no other file left, ends as watched
  ytStallEndSec: 5,      // buffering this close to the end ...
  ytStallEndMs: 8000,    // ... for this long ends the video as watched ('ended' {nearEnd:true, reason:'stall'})
  ytShield: false,       // blocking layer over the YouTube player (Boss ruling 2026-11-25). Off until the app
                         // handles 'shield-tap': with it on, a tap no longer reaches YouTube (so no tap-to-pause)
  ytAdMute: true,        // mute while an ad plays; content always gets its sound back
  ytSkipHole: true,      // keep YouTube's Skip button reachable during an ad (after 5 s)
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

// What the transcode path can decode on this device (the worker holds the decoders; the wasm loads there on first use).
const localDecoders = createDecoders({ wasm: { has: c => FFMPEG_CODECS.has(c) } });
function caps() {
  return { isTypeSupported, av1: isTypeSupported('video/mp4; codecs="av01.0.08M.08"'), canDecode: c => localDecoders.has(c) };
}

// --- player ----------------------------------------------------------------------------------
export function createPlayer({ video, ytContainer, audio, workerUrl, getSecrets, lang = 'en', youtubeHost, options = {} } = {}) {
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
  // YouTube host: 'nocookie' (default) or 'youtube'. Set at boot, by setYouTubeHost(), or per play; a change
  // takes effect at the next play (a new IFrame player), never under a video that is playing.
  let wantedYtHost = ytHostName(youtubeHost ?? o.youtubeHost);
  let ytBusy = false;
  function ensureYt(name) {
    if (!ytContainer) return null;
    if (yt && yt.host === name) return yt;
    if (yt) yt.destroy();
    try { yt = createYouTubeHost(ytContainer, { muted: mutedNow, host: name }); } catch { yt = null; }
    return yt;
  }
  let mutedNow = !!o.muted; // options.muted is the starting state; setMuted() changes it
  let ytAdHeld = false;     // a YouTube ad is playing under the ad-mute rule: setMuted(false) must not unmute it
  // Created early so the first YouTube tap lands on a ready player.
  ensureYt(wantedYtHost);
  if (o.debug) Object.defineProperty(globalThis, '__kcYt', { get: () => yt, configurable: true });
  function setYouTubeHost(h) {
    wantedYtHost = ytHostName(h);
    if (!ytBusy) ensureYt(wantedYtHost); // warm the new host now, so its first tap is fast
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
    // The runtime ranks files by bitrate and checks the probed length (both soft); nothing else is needed.
    if (!(it.runtimeMin > 0)) {
      try { const m = await fetchCinemeta(it); it.runtimeMin ||= m.runtimeMin; } catch { /* unknown: no bitrate term, no length check */ }
    }
    let streams;
    try { streams = await fetchStreams(secrets.torrentioConfig, it); } catch (error) {
      return { it, ranked: [], skipped: {}, outcome: listOutcome({ error }) };
    }
    const { ranked, skipped } = rankStreams(streams, it, caps(), learned.snapshot());
    return { it, ranked, skipped, outcome: listOutcome({ streams, ranked, skipped }) };
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
          else if (msg.op === 'decoder') emit('progress', { fraction: msg.fraction, stage: 'decoder' });
        });
        engine.probe(id, r.url);
      }).catch(e => { engine.close(id); throw e; });
      const d = decide(info, it, caps(), { lenient: !!c.lenient });
      if (!d.ok) { engine.close(id); const e = new Error(d.reason); e.durationCheck = d.durationCheck; e.soft = !!d.soft; throw e; }
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
          engine.remux(win.id, runId, { audioIndex: win.d.audioIndex, startSec: 0, endSec: o.prefetchSec, split: !!win.d.split, audioMp3: !!win.d.audioMp3 });
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
  function play(item, { startAt = 0, keepAwake = true, ytCueOnly = false, youtubeHost: hostForPlay, ytShield, ytAdMute } = {}) {
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
    const finish = (reason, extra, more) => {
      if (finished) return;
      finished = true;
      rep.endReason = reason;
      if (reason === 'failed-all') { emit('failed-all', { reasons: extra || rep.failures, ...(more || {}) }); }
      if (reason === 'ended') emit('ended', more || {});
      if (!readyEmitted && reason === 'failed-all') report(false);
      report(true);
    };
    s._ctl = { pause() {}, resume() {}, seek() {}, position: () => 0, duration: () => 0, inAd: () => false };
    // Where the play is now (YouTube's own clock, the media element's, or a seek still held while paused), and a
    // relative jump from there, clamped to the start and to a second short of the end. Returns the new target.
    s.position = () => s._ctl.position();
    s.seekBy = d => {
      const dur = s._ctl.duration();
      let t = Math.max(0, s._ctl.position() + d);
      if (dur > 1) t = Math.min(t, dur - 1);
      s._ctl.seek(t);
      return t;
    };
    Object.defineProperty(s, 'inAd', { get: () => !!s._ctl.inAd(), enumerable: true });
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
    if (kind === 'youtube') {
      ensureYt(hostForPlay != null ? ytHostName(hostForPlay) : wantedYtHost);
      rep.youtubeHost = yt?.host;
      // Per-play overrides of the player's YouTube policy (the testbed turns the layer on for one play).
      const pol = { shield: !!(ytShield ?? o.ytShield), adMute: !!(ytAdMute ?? o.ytAdMute) };
      rep.ytShield = pol.shield;
      playYouTube(item, startAt, s, { emit, rep, markReady, finish, cleanup: f => cleanup.push(f), cueOnly: ytCueOnly, pol });
    }
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
    // A run that fails after playback started (a damaged stretch the transcoder couldn't get past, a dropped
    // connection): what's buffered plays out, then the next file takes over from the same spot. With no file left
    // the play ends: as watched near the end, else with failed-all. Never a frame held for good.
    let broken = null;
    const onBroken = reason => {
      if (broken || isStopped()) return;
      broken = reason;
      const end = bufferedEnd();
      if (end == null || end - video.currentTime < 0.5) failOver();
    };
    async function failOver() {
      const reason = broken;
      if (!reason || isStopped() || !state.win) return;
      broken = null;
      clearStall();
      const at = video.currentTime;
      rep.fallbacks.push({ rank: state.win.c.rank, reason: 'midplay:' + reason });
      learned.failed(state.win.c.key);
      media?.teardown(); media = null; state.win.release(); state.win = null;
      if (state.nextIdx >= state.ranked.length) {
        const dur = rep.durationCheck?.probedSec || 0;
        rep.failures.push('midplay:' + reason);
        if (dur > 0 && at >= dur - o.nearEndSec) { rep.endedNearEnd = true; finish('ended', null, { nearEnd: true, reason: 'broken' }); }
        else finish('failed-all', ['midplay:' + reason]);
        teardownAll();
        return;
      }
      await runFrom(state.nextIdx, at);
    }
    const onWaiting = () => {
      if (broken) { failOver(); return; }
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
      if (end == null) return;
      const convert = rep.path === 'transcode'; // a transcode starts once transcodeHoldSec are converted
      emit('progress', { fraction: Math.min(1, Math.max(0, (end - startAt) / (convert ? o.transcodeHoldSec : o.startBufferSec))), stage: convert ? 'convert' : 'buffer' });
    };
    const bufferedEnd = () => {
      const b = video.buffered, t = Math.max(video.currentTime, startAt);
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return b.end(i);
      return null;
    };
    // Frozen-playhead watchdog: WebKit occasionally reports playing with data ahead while the clock stands
    // still (seen after a resume point). One still second with data ahead: nudge it.
    let lastT = -1, still = 0;
    const freeze = setInterval(() => {
      // Gap jump: a source whose audio timestamps jump leaves a hole in the buffer, and MSE waits at a hole forever.
      // Step over a hole shorter than a second when data follows it.
      if (media && !video.paused && !video.ended && video.readyState < 3) {
        const t = video.currentTime, b = video.buffered;
        let inRange = false, next = null;
        for (let i = 0; i < b.length; i++) { if (b.start(i) <= t && b.end(i) > t + 0.1) inRange = true; if (b.start(i) > t && b.start(i) - t < 1 && next == null) next = b.start(i); }
        if (!inRange && next != null) { rep.gapJumps = (rep.gapJumps || 0) + 1; video.currentTime = next + 0.01; video.play().catch(() => {}); still = 0; lastT = next; return; }
      }
      if (!media || video.paused || video.ended || video.readyState < 3) { still = 0; lastT = video.currentTime; return; }
      const t = video.currentTime, end = bufferedEnd();
      if (Math.abs(t - lastT) < 0.02 && end != null && end - t > 1) {
        if (++still >= 2) { still = 0; rep.nudges = (rep.nudges || 0) + 1; try { video.currentTime = t + 0.01; } catch { /* ignore */ } video.play().catch(() => {}); }
      } else still = 0;
      lastT = t;
    }, 500);
    cleanup(() => clearInterval(freeze));
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
    s._ctl.position = () => video.currentTime || 0;
    s._ctl.duration = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : rep.durationCheck?.probedSec || 0);

    async function attach(win, at, segments) {
      rep.path = win.d.path; rep.container = win.info.container; rep.durationCheck = win.d.durationCheck;
      rep.candidate = { rank: win.c.rank, score: win.c.score, container: win.c.container, res: win.c.res, videoCodec: win.c.videoCodec, audioCodec: win.c.audioCodec, filename: win.c.filename };
      rep.sizeMB = win.c.sizeMB != null ? Math.round(win.c.sizeMB) : null;
      rep.fileSize = win.c.sizeMB != null ? Math.round(win.c.sizeMB * 1048576) : null;
      emit('progress', { fraction: 0, stage: win.d.path === 'transcode' ? 'convert' : 'buffer' });
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
      let runId = null, ended = false, firstMedia = false, until = at + 10, audioStarted = false, failNow, played = false;
      const transcode = win.d.path === 'transcode';
      const startPlay = () => { played = true; video.play().catch(() => {}); };
      const failed = new Promise(r => { failNow = r; });
      const split = !!win.d.split;
      const sink = createMseSink(video, win.d.mime, {
        audioMime: split ? win.d.audioMime : null,
        onEvicted: t => startRun(t),
        onStreamingChange: () => pushDemand(),
        durationSec: win.info.durationSec,
      });
      try {
        await Promise.race([sink.opened, new Promise((_, rej) => setTimeout(() => rej(new Error('sourceopen_timeout')), o.canplayMs))]);
      } catch (e) {
        rep.failures.push(scrubSecrets(e?.message));
        sink.destroy();
        return { kind: 'remux', failed: Promise.resolve(false), teardown() {} };
      }
      if (o.debug) globalThis.__kcSink = sink;
      // Seek before any data: the first fragment then satisfies a pending seek, rather than being seeked into.
      if (at > 0) { sink.ensureDuration(at); try { video.currentTime = at; } catch { /* set again after the first append */ } }
      // The end of the stream is signalled only when playback reaches it: after endOfStream WebKit drops later
      // appends, so a seek back into time not buffered would hang. Ending there means the video ends and the
      // play finishes, so nothing seeks afterwards.
      let endPending = false;
      const maybeEnd = () => {
        if (!endPending) return;
        const t = video.currentTime, end = sink.bufferedEndAt(t);
        if (end != null && end - t < 0.6) { endPending = false; sink.end(); }
      };
      const pushDemand = () => {
        maybeEnd();
        if (!runId) return;
        const t = video.currentTime;
        const end = sink.bufferedEndAt(t) ?? t;
        until = !sink.managed || sink.streaming ? Math.max(t, at) + o.aheadSec : Math.max(end, t + 5);
        engine.demand(win.id, runId, until);
      };
      const onSeg = msg => {
        if (msg.op === 'decoder') { if (!rep.ttffMs) emit('progress', { fraction: msg.fraction, stage: 'decoder' }); return; }
        if (msg.runId !== runId) return;
        if (msg.op === 'segment') {
          let which = 'main', offset = null;
          // audio/mpeg runs in sequence mode: its offset is set at the start of a run and after a source jump.
          // The remuxer drops frames before 0, since WebKit drops everything after a negative timestampOffset.
          if (msg.kind === 'audio') { which = 'audio'; if (!audioStarted || msg.discontinuity) { audioStarted = true; offset = Math.max(0, msg.startSec || 0); } }
          sink.append(msg.data, which, offset).then(() => {
            if (msg.kind === 'media' && !firstMedia) {
              firstMedia = true; mark('firstAppend');
              if (at > 0 && Math.abs(video.currentTime - at) > 0.5) video.currentTime = at;
            }
            // Remux plays at once; a transcode waits until enough is converted to play smoothly (the loading toy
            // stays up meanwhile), or until the whole file is done.
            if (msg.kind === 'media' && !played && (!transcode || (sink.bufferedEndAt(video.currentTime) ?? 0) - video.currentTime >= o.transcodeHoldSec)) startPlay();
            onProgress();
          }, e => { if (!firstMedia) { rep.failures.push('append:' + scrubSecrets(e?.message)); failNow(false); } });
        } else if (msg.op === 'done' && msg.result?.done) { ended = true; endPending = true; maybeEnd(); if (firstMedia && !played) startPlay(); }
        else if (msg.op === 'error') { rep.failures.push('remux:' + scrubSecrets(msg.error)); if (!firstMedia) failNow(false); else { if (!played) startPlay(); onBroken(scrubSecrets(msg.error)); } }
      };
      engine.route(win.id, onSeg);
      function startRun(from) {
        broken = null; // a new run from a new spot may well get past it
        endPending = false;
        if (runId) engine.abort(win.id, runId);
        sink.dropQueued();
        runId = uid(); ended = false; audioStarted = false;
        engine.remux(win.id, runId, { audioIndex: win.d.audioIndex, startSec: from, until: from + 10, split, audioMp3: !!win.d.audioMp3 });
      }
      // Warm segments from prefetch go in first; the live run continues from where they stopped.
      if (segments.length && at <= 0.5) {
        runId = segments[0].runId;
        for (const m of segments) onSeg(m);
        const last = segments[segments.length - 1];
        const nextFrom = segments.stoppedAt ?? last.endSec ?? o.prefetchSec;
        runId = uid(); audioStarted = false;
        engine.remux(win.id, runId, { audioIndex: win.d.audioIndex, startSec: nextFrom, until: nextFrom + 10, split, audioMp3: !!win.d.audioMp3 });
      } else {
        startRun(at);
      }
      return {
        kind: 'remux',
        failed,
        onTime: pushDemand,
        onWaiting() { maybeEnd(); const t = video.currentTime; if (sink.bufferedEndAt(t) == null && !ended) startRun(t); },
        seek(t) {
          const go = () => { try { video.currentTime = t; } catch { /* set again when data arrives */ } };
          if (sink.bufferedEndAt(t) != null) { go(); return; }
          if (!sink.ensureDuration(t)) sink.whenIdle().then(() => { if (sink.ensureDuration(t) && Math.abs(video.currentTime - t) > 0.5) go(); });
          go();
          startRun(t);
          sink.dropFarFrom(t, 15, o.aheadSec + 30).then(() => { if (video.seeking && Math.abs(video.currentTime - t) < 0.5) go(); });
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
      // Files turned down only on a content check (length, no or foreign audio) are kept, in rank order, and played
      // anyway when every other file has failed (brief, Stream choice: they play last, but they play).
      const softFails = [];
      let list = state.ranked, lenientRound = false;
      while (!isStopped()) {
        if (!win) {
          win = await race(list, idx, makeTry(state.it, state.secrets, rep, emit).tryOne, (c, e) => {
            const reason = scrubSecrets(e.message);
            rep.fallbacks.push({ rank: c.rank, reason });
            if (e?.soft && !lenientRound) { softFails.push(c); return; }
            if (!/app_token|origin/.test(reason)) learned.failed(c.key);
          });
          if (!win && !lenientRound && softFails.length) {
            lenientRound = true;
            list = softFails.sort((a, b) => a.rank - b.rank).map(c => ({ ...c, lenient: true }));
            idx = 0;
            continue;
          }
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
        const { it, ranked, skipped, outcome } = await listCandidates(item, secrets, emit);
        state.it = it; state.ranked = ranked; rep.skipped = skipped;
        if (outcome) { rep.failures.push(outcome); return finish('failed-all', [outcome]); }
        await runFrom(0, startAt);
      } catch (e) {
        rep.failures.push(scrubSecrets(e?.message));
        finish('failed-all', [scrubSecrets(e?.message)]);
      }
    })();
  }

  // ---- YouTube ----
  function playYouTube(item, startAt, s, ctx) {
    const { emit, rep, markReady, finish, cleanup, cueOnly, pol } = ctx;
    rep.path = 'youtube';
    if (!yt) { rep.failures.push('no_yt_container'); queueMicrotask(() => finish('failed-all', ['no_yt_container'])); return; }
    let started = false, paused = false, endedByUs = false, stopping = false, lastSeek = null, seekRetried = false;
    let stallT = null, seekT = null, needsTapT = null, lastEmit = -1;
    let ad = false, adStart = 0, needsTapShown = false, lastClock = null, seekOnMove = null, adPaused = false, errRetried = false, lastContent = startAt, pendingSeek = null;
    let pauseWanted = false, repausedAt = 0, stallSince = null, firstDuration = 0, liveLike = false, adAnnounced = false, retryHeld = null;
    rep.ads = 0; rep.adSeconds = 0;
    yt.resetProgress();
    yt.shield(pol.shield);
    if (!pol.adMute) (mutedNow ? yt.mute() : yt.unMute()); // a stopped play leaves the host muted
    // Early mute, only where a mid-roll can start before YouTube says so: after a seek (ours, or a clock jump we
    // didn't make) until her video has played about a second at the new spot. Plain buffering never mutes.
    // The window counts from wherever YouTube actually landed (the first PLAYING after it moved or buffered), and
    // closes after about 3 s of her video playing whatever the clock says. Any ad clears it, start or end.
    let quietWin = null, lastPlaying = null, jumpGraceUntil = 0;
    const openQuiet = (to, landed = false, jump = false) => { quietWin = { to, from: yt.time(), base: landed ? to : null, moved: landed, playMs: 0, at: null, jump }; };
    const applyPolicy = () => {
      const st = yt.state(), t = yt.time();
      const clockRunning = lastClock != null && t > lastClock + 0.05;
      lastClock = t;
      const nowAd = !endedByUs && classifyAd({ state: st, contentDuration: yt.duration(), progress: yt.progress(), clockRunning });
      if (nowAd !== ad) {
        ad = nowAd;
        quietWin = null; lastPlaying = null; jumpGraceUntil = performance.now() + 1500; // YouTube's clock is the ad's for a moment either side
        stallSince = null; // a stall clock never runs across an ad
        if (ad) {
          adStart = performance.now(); rep.ads++; clearT(); // the buffering before an ad is no stall; the ad itself is muted
          // An ad that starts while she is paused (YouTube ignored her pause, then played into a mid-roll) waits,
          // hidden and unannounced, so our pause screen stays; her play brings it on with 'ad' {active:true}.
          if (pauseWanted && started) { adPaused = true; adAnnounced = false; yt.show(false); yt.pause(); }
          else { adAnnounced = true; if (!paused && !adPaused) yt.show(true); }
        } else {
          rep.adSeconds = Math.round(rep.adSeconds + (performance.now() - adStart) / 1000); adPaused = false;
          if (pendingSeek != null && !paused) { const to = pendingSeek; pendingSeek = null; queueMicrotask(() => { if (!stopping) seekNow(to); }); } // ±15 pressed during the ad
        }
        if (adAnnounced) emit('ad', { active: ad });
        if (!ad) adAnnounced = false;
        // YouTube can report PLAYING before its last ad message is replaced: re-read the state once the ad clears.
        if (!ad) queueMicrotask(() => { if (!stopping) onStateImpl(yt.state()); });
      }
      // A clock jump we didn't make (a seek inside YouTube's frame): forward by more than the time passed plus 2 s,
      // or back by more than 2 s, between two samples of her video playing.
      const now = performance.now();
      const contentPlaying = !ad && st === YT_STATE.PLAYING && yt.progress()?.allowSeeking !== false;
      // Checked on every sample, buffering included: after a jump to an ad point YouTube can go from buffering
      // straight into the ad, with no PLAYING at the new spot to wait for.
      if (started && !ad && !paused && !endedByUs && !quietWin && now > jumpGraceUntil && lastPlaying && st !== YT_STATE.ENDED) {
        const passed = (now - lastPlaying.at) / 1000;
        if (t - lastPlaying.t > passed + 2 || lastPlaying.t - t > 2) openQuiet(t, contentPlaying, true);
      }
      lastPlaying = contentPlaying && !paused ? { t, at: now } : ad || paused ? null : lastPlaying;
      // The seek window closes once her video (not an ad) has played about a second where YouTube landed, and in any
      // case after about 3 s of her video playing.
      if (quietWin) {
        if (st !== YT_STATE.PLAYING || Math.abs(t - quietWin.from) > 1) quietWin.moved = true;
        if (contentPlaying) {
          if (quietWin.at != null) quietWin.playMs += now - quietWin.at;
          quietWin.at = now;
          if (quietWin.base == null && quietWin.moved) quietWin.base = t;
          if ((quietWin.base != null && t - quietWin.base >= 1) || quietWin.playMs >= 3000) quietWin = null;
        } else quietWin.at = null;
      }
      // Once her video has started, YouTube reporting unstarted or cued is a mid-roll starting before its first
      // message says so; so is anything inside a seek window. Muting at once keeps the ad silent from its first frame.
      const quiet = started && !endedByUs && (st === YT_STATE.UNSTARTED || st === YT_STATE.CUED || !!quietWin);
      // Paused by her (our pause screen is up): if YouTube plays anyway, pause it again; it stays hidden and muted.
      if (pauseWanted && started && ((!ad && st === YT_STATE.PLAYING) || (ad && adPaused && clockRunning))) {
        yt.show(false);
        if (now - repausedAt > 700) { repausedAt = now; yt.pause(); }
      }
      ytAdHeld = pol.adMute && (ad || quiet || pauseWanted);
      if (pol.adMute) {
        const want = desiredMute({ ad: ad || quiet || pauseWanted, appMuted: mutedNow });
        if (want !== yt.isMuted()) (want ? yt.mute() : yt.unMute());
      }
      if (pol.shield) yt.shield(true, holeFor({ ad, adElapsed: ad ? (performance.now() - adStart) / 1000 : 0, needsTap: needsTapShown && !started, skipHole: o.ytSkipHole }));
    };
    // "The last seconds" needs a known, fixed duration: never with duration 0, a growing one, or a live video.
    const nearEndOk = (d, at, within) => d > 0 && !liveLike && !yt.isLive?.() && at >= d - within;
    const endNearEnd = detail => {
      endedByUs = true; yt.show(false); yt.pause(); clearT();
      if (ad) { rep.adSeconds = Math.round(rep.adSeconds + (performance.now() - adStart) / 1000); ad = false; adPaused = false; emit('ad', { active: false }); }
      rep.endedNearEnd = true;
      finish('ended', null, { nearEnd: true, ...detail });
    };
    const clearT = () => { clearTimeout(stallT); clearTimeout(seekT); stallT = seekT = null; };
    const endNow = () => {
      if (endedByUs) return;
      endedByUs = true; yt.show(false); yt.pause(); clearT();
      finish('ended');
    };
    const poll = setInterval(() => {
      applyPolicy();
      if (ad) { stallSince = null; return; } // during an ad the clock is the ad's: no time events, no end guard, no stall clock
      const t = yt.time(), d = yt.duration();
      // Her spot: only from her video playing (an ad reported as PLAYING before its first message has seeking off or
      // jumps the clock, which opens a jump window), never while a jump we didn't make is unconfirmed.
      if (started && yt.state() === YT_STATE.PLAYING && yt.progress()?.allowSeeking !== false && !(quietWin && quietWin.jump)) lastContent = t;
      if (d > 0) { if (!firstDuration) firstDuration = d; else if (d > firstDuration + 1) liveLike = true; } // a duration that grows: live-like
      // A seek is done once her video plays near its target, even when YouTube showed no state change (a seek
      // inside what it had buffered): a later stall must never re-issue it.
      if (lastSeek != null && yt.state() === YT_STATE.PLAYING && Math.abs(t - lastSeek) <= 1.5) lastSeek = null; // near the target: a back seek's cached clock is still past it
      // Buffering in the last seconds for long enough is the end, as watched; never mid-video, never live-like.
      if (started && !paused && !endedByUs && yt.state() === YT_STATE.BUFFERING) {
        stallSince ??= performance.now();
        if (nearEndOk(d, Math.max(lastContent, t), o.ytStallEndSec) && performance.now() - stallSince >= o.ytStallEndMs) endNearEnd({ reason: 'stall' }); // the clock counts too: a stall right after a jump inside YouTube
      } else stallSince = null;
      if (started) rep.watchedSec = Math.max(rep.watchedSec, Math.round(t - startAt));
      if (started && Math.abs(t - lastEmit) >= 1) { lastEmit = t; emit('time', { position: t, duration: d || null }); }
      if (started && !endedByUs && d > 0 && t >= d - o.ytEndGuardSec && yt.state() === YT_STATE.PLAYING) endNow();
    }, 250);
    const onStateImpl = st => {
        if (ad && st !== YT_STATE.ENDED) { if (!adPaused) yt.show(true); return; } // an ad is shown (muted, shielded), never read as pause or start
        if (endedByUs || stopping) { if (st !== YT_STATE.PAUSED && st !== YT_STATE.ENDED) yt.show(false); return; }
        if (seekOnMove != null && (st === YT_STATE.PLAYING || st === YT_STATE.BUFFERING)) { const t = seekOnMove; seekOnMove = null; seekNow(t); }
        if (st === YT_STATE.PLAYING && pauseWanted && started) { yt.show(false); return; } // applyPolicy pauses it again
        if (st === YT_STATE.PLAYING) {
          clearTimeout(needsTapT); clearT(); yt.show(true);
          lastSeek = null; // the seek is done: a later stall must never re-issue it
          if (!started) { started = true; markReady(); }
          else if (paused) { paused = false; emit('resumed', {}); }
          else emit('resumed', {});
        } else if (st === YT_STATE.BUFFERING) {
          if (started && !pauseWanted) yt.show(true);
          if (!stallT) stallT = setTimeout(() => { rep.stalls++; emit('stalled', {}); }, o.stallNoticeMs);
          if (lastSeek != null && !seekRetried && !seekT) {
            seekT = setTimeout(() => { seekRetried = true; openQuiet(lastSeek); yt.seek(lastSeek); }, 8000);
          }
        } else if (st === YT_STATE.PAUSED) {
          yt.show(false); clearT();
          if (started && !paused) { paused = true; emit('paused', {}); }
        } else if (st === YT_STATE.ENDED) {
          endNow();
        } else {
          yt.show(false);
        }
    };
    yt.setHandler({
      onShieldTap(pt) { emit('shield-tap', pt); },
      onInfo() { applyPolicy(); },
      onState(st) { applyPolicy(); onStateImpl(st); },
      onError(code) {
        yt.show(false); clearT();
        const kind = classifyYtError(code);
        // In the last seconds of her video an error is the end, not a failure: the app shows its goodbye, as watched.
        if (started && nearEndOk(yt.duration(), lastContent, o.ytNearEndSec) && !stopping && !endedByUs) {
          rep.ytError = { code, kind };
          endNearEnd({ reason: 'yt_' + code, kind, code });
          return;
        }
        // A passing fault (error 5: often a mid-roll that failed to load) is retried once, from where her video was.
        if (kind === 'transient' && !errRetried && !stopping && !endedByUs) {
          errRetried = true; rep.ytRetries = (rep.ytRetries || 0) + 1;
          // While she is paused the reload waits for her play: it would start playback, or its pre-roll.
          if (pauseWanted) {
            if (ad) { rep.adSeconds = Math.round(rep.adSeconds + (performance.now() - adStart) / 1000); ad = false; adPaused = false; if (adAnnounced) emit('ad', { active: false }); adAnnounced = false; }
            yt.resetProgress(); lastClock = null; retryHeld = { at: started ? lastContent : startAt || 0 };
            return;
          }
          if (ad) { rep.adSeconds = Math.round(rep.adSeconds + (performance.now() - adStart) / 1000); ad = false; adPaused = false; emit('ad', { active: false }); }
          yt.resetProgress(); lastClock = null;
          if (started) emit('stalled', {});
          openQuiet(started ? lastContent : startAt || 0);
          yt.load(item.ytId || item.videoId, started ? lastContent : startAt || 0);
          return;
        }
        // 153: YouTube refuses an embed that sends no Referer, which a no-referrer policy on the page causes.
        const noRef = /no-referrer/i.test(document.querySelector('meta[name="referrer"]')?.content || '');
        const reason = code === 153 && noRef ? 'yt_153_referrer_policy' : 'yt_' + code;
        rep.failures.push(reason);
        rep.ytError = { code, kind };
        finish('failed-all', [reason], { kind, code });
      },
    });
    emit('progress', { fraction: null, stage: 'buffer' });
    const sync = cueOnly ? yt.cue(item.ytId || item.videoId) : yt.load(item.ytId || item.videoId, startAt || 0);
    if (!sync) rep.ytLoadedLate = true;
    // If the video hasn't reached PLAYING after a moment, show the player: either iOS refused the programmatic
    // start (she taps YouTube's play button) or YouTube is showing a pre-roll ad, which the API reports as
    // unstarted. Ads may not be hidden under YouTube's terms, and showing them lets her press Skip.
    // While it is buffering it is simply loading, so keep waiting a little longer.
    let tapChecks = 0;
    const checkTap = () => {
      if (started) return;
      const st = yt.state();
      if ((st === YT_STATE.BUFFERING || st === undefined) && ++tapChecks < 6) { needsTapT = setTimeout(checkTap, 1500); return; }
      if (ad) { needsTapT = setTimeout(checkTap, 1500); return; } // an ad is playing: not a refused start
      if (st === YT_STATE.UNSTARTED || st === YT_STATE.CUED || tapChecks >= 6) {
        rep.needsTap = true; needsTapShown = true; yt.show(true); applyPolicy();
        emit('needs-tap', { state: st, reason: st === YT_STATE.CUED ? 'tap' : 'tap_or_ad' });
      }
    };
    needsTapT = setTimeout(checkTap, o.ytNeedsTapMs + (sync ? 0 : 3000));
    // Paused during an ad (her tap on the layer, the app going to the background): the ad waits, hidden, and the
    // app gets 'paused' {ad:true} so it can show its pause screen; resume brings the ad back with 'ad' {active:true}.
    // Her pause: hidden, muted and 'paused' at once, whether or not YouTube confirms (it may ignore a pause while it
    // buffers). YouTube's late PAUSED adds nothing; if it plays anyway, applyPolicy pauses it again.
    s._ctl.pause = () => {
      if (endedByUs) return;
      const adNow = ad && !adPaused;
      if (adNow) adPaused = true; // before pausing: YouTube's state change may come back synchronously
      pauseWanted = true; // also during an ad she can see: if YouTube ignores it, her video stays paused after the ad
      yt.show(false);
      if (!adNow && !pol.adMute) yt.mute();
      yt.pause();
      if (adNow) emit('paused', { ad: true });
      else if (started && !paused) { paused = true; clearT(); emit('paused', {}); }
      applyPolicy();
    };
    s._ctl.inAd = () => ad;
    s._ctl.duration = () => yt.duration();
    const seekNow = t => { lastSeek = t; lastContent = t; seekRetried = false; clearTimeout(seekT); seekT = null; if (started) { openQuiet(t); applyPolicy(); } yt.seek(t); };
    // A seek while paused (the app's +15/-15 live on its pause screen) is held and made at resume: YouTube may
    // ignore a seek on a paused player, or start playing on it, and either would lose the jump or our pause screen.
    // At resume it is made once YouTube is moving again (buffering or playing), since a paused player may ignore it.
    // After our own end nothing may play again: the end panel would be one frame away.
    s._ctl.resume = () => {
      if (endedByUs) return;
      pauseWanted = false; // before the ad branch: an ad held under her pause must not keep her video paused after it
      if (adPaused) { adPaused = false; adAnnounced = true; yt.show(true); yt.play(); emit('ad', { active: true }); return; }
      if (!pol.adMute && !mutedNow) yt.unMute();
      if (retryHeld) { // the error retry held while she was paused: reload now, from her spot (or a seek she made)
        const at = pendingSeek ?? retryHeld.at; retryHeld = null; pendingSeek = null;
        openQuiet(at); yt.load(item.ytId || item.videoId, at);
        return;
      }
      if (pendingSeek != null) { seekOnMove = pendingSeek; pendingSeek = null; }
      yt.play();
      if (yt.state() === YT_STATE.BUFFERING) yt.show(true); // buffering is content on screen
    };
    // During an ad (playing or paused) YouTube's clock is the ad's and it won't seek: hold the jump, from her video's
    // spot, and make it when the ad is over.
    s._ctl.seek = t => { if ((paused || ad) && !endedByUs) { pendingSeek = t; return; } seekNow(t); };
    s._ctl.position = () => (ad ? pendingSeek ?? lastContent : seekOnMove ?? pendingSeek ?? yt.time());
    ytBusy = true;
    const host = yt;
    cleanup(() => {
      stopping = true; clearInterval(poll); clearTimeout(needsTapT); clearT(); host.show(false); host.release(); // stopVideo, and kill anything it starts after
      host.shield(false);
      if (ad) rep.adSeconds = Math.round(rep.adSeconds + (performance.now() - adStart) / 1000);
      ytAdHeld = false;
      ytBusy = false;
      if (wantedYtHost !== host.host) ensureYt(wantedYtHost); // a switch made during the video applies now
    });
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
    s._ctl.position = () => audio.currentTime || 0;
    s._ctl.duration = () => (Number.isFinite(audio.duration) ? audio.duration : 0);
    cleanup(() => {
      for (const [k, f] of Object.entries(L)) audio.removeEventListener(k, f);
      document.removeEventListener('visibilitychange', onVis);
      clearTimeout(stallT);
      audio.pause(); audio.removeAttribute('src'); try { audio.load(); } catch { /* ignore */ }
      try { wakeLock?.release(); } catch { /* ignore */ }
    });
  }

  function setMuted(on) {
    mutedNow = !!on;
    if (video) video.muted = !!on;
    if (audio) audio.muted = !!on;
    if (yt) (on || ytAdHeld ? yt.mute() : yt.unMute()); // an ad stays muted until the content plays
  }

  return {
    unlock,
    prefetch,
    play,
    setMuted,
    setYouTubeHost,
    engineMode: () => engine.mode(),
    hasMediaSource: () => !!mediaSourceClass(),
  };
}
