// Player testbed: device checks for the Kids Corner player. Runs the same player code the app ships
// (testbed/player is a copy made by app/player/tools/sync-testbed.sh).
// Secrets are typed on this page and kept in IndexedDB only; results never contain URLs, keys or tokens.
import { createPlayer } from './player/index.js';
import { rankStreams } from './player/select.js';
import { streamListUrl, resolveViaWorker, scrubSecrets } from './player/sources.js';
import { isTypeSupported, mediaSourceClass } from './player/mse.js';

const WORKER = 'https://resolver.kidscorner-app.workers.dev';
const YT_IDS = ['DmGNBJzWvBU', 'SdOQ62zPJRY']; // Alphablocks compilations from Kids Corner's YouTube rows
const STORY_STREAM = '/kids-stremio-catalog/stream/Audio/kc.pod.dremota-podcast.01213e73de9f.json';
const BLUEY = { kind: 'torbox', type: 'series', imdbId: 'tt7678620', showName: 'Bluey', altNames: ['Блуи'], year: 2018, runtimeMin: 7 };
const $ = s => document.querySelector(s);

// ---------- storage ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('kc-testbed', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function kv(op, key, val) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', op === 'get' ? 'readonly' : 'readwrite');
    const st = tx.objectStore('kv');
    const r = op === 'get' ? st.get(key) : op === 'put' ? st.put(val, key) : st.delete(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const getSecrets = async () => (await kv('get', 'settings')) || {};

// ---------- results ----------
let results = { env: {}, steps: {} };
async function loadResults() { results = (await kv('get', 'results')) || results; results.steps ||= {}; renderSummary(); for (const [id, r] of Object.entries(results.steps)) setStatus(id, r.status); }
function record(id, status, data = {}) {
  results.steps[id] = { ...data, status, at: new Date().toISOString() };
  setStatus(id, status);
  kv('put', 'results', results).catch(() => {});
  renderSummary();
}
function renderSummary() { $('#summary').textContent = JSON.stringify(results, null, 1); }
const SECTION_OF = { resolve: 's-resolve', 'audio-lock': 's-audio', settings: 's-settings', env: 's-env' };
function setStatus(id, status) {
  const sub = document.querySelector(`[data-sub="${id}"]`);
  const el = sub || document.querySelector(`#${SECTION_OF[id] || 's-' + id} h2 .status`);
  if (!el) return;
  el.textContent = { pass: 'pass', fail: 'fail', warn: 'check', run: 'running', waiting: 'waiting' }[status] || status;
  el.className = 'status ' + status;
  rollup();
}
function rollup() {
  for (const [sec, ids] of Object.entries({ 's-direct': ['direct-sample', 'direct-live'], 's-remux': ['remux-sample', 'remux-eac3', 'remux-hevc', 'remux-mp3', 'remux-live', 'remux-live-ru'], 's-yt': ['yt-start', 'yt-pause', 'yt-seek', 'yt-skip', 'yt-end', 'yt-exits', 'yt-screens'] })) {
    const st = ids.map(i => results.steps[i]?.status).filter(Boolean);
    const el = document.querySelector(`#${sec} h2 .status`);
    const v = !st.length ? 'waiting' : st.includes('fail') ? 'fail' : st.includes('run') ? 'run' : st.length === ids.length && st.every(s => s === 'pass') ? 'pass' : 'warn';
    el.textContent = { pass: 'pass', fail: 'fail', warn: 'partial', run: 'running', waiting: 'waiting' }[v]; el.className = 'status ' + v;
  }
}
const log = (id, msg) => { const el = document.querySelector(`[data-log="${id}"]`); if (el) el.textContent += (el.textContent ? '\n' : '') + scrubSecrets(msg); };
const clearLog = id => { const el = document.querySelector(`[data-log="${id}"]`); if (el) el.textContent = ''; };

// ---------- environment ----------
function env() {
  const ua = navigator.userAgent;
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const t = m => isTypeSupported(m);
  const e = {
    device: ipad ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : 'other',
    safariVersion: /Version\/([\d.]+)/.exec(ua)?.[1] || null,
    webkit: /AppleWebKit\/([\d.]+)/.exec(ua)?.[1] || null,
    osFromUA: (/OS ([\d_]+) like Mac/.exec(ua)?.[1] || '').replace(/_/g, '.') || (ipad ? 'iPadOS (UA reports desktop mode; Safari version tracks iPadOS)' : null),
    displayMode: matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'home screen app' : 'browser tab',
    screen: `${screen.width}x${screen.height} @${devicePixelRatio}x, viewport ${innerWidth}x${innerHeight}`,
    managedMediaSource: !!globalThis.ManagedMediaSource,
    mediaSource: !!mediaSourceClass(),
    mediaSourceHandle: 'MediaSourceHandle' in globalThis,
    moduleWorker: typeof Worker === 'function',
    wakeLock: !!navigator.wakeLock,
    mse: {
      'H.264 + AAC': t('video/mp4; codecs="avc1.64001f, mp4a.40.2"'),
      'HEVC (hvc1) Main': t('video/mp4; codecs="hvc1.1.6.L93.B0"'),
      'HEVC Main10': t('video/mp4; codecs="hvc1.2.4.L120.B0"'),
      'AC-3': t('video/mp4; codecs="avc1.64001f, ac-3"'),
      'E-AC-3': t('video/mp4; codecs="avc1.64001f, ec-3"'),
      'Opus in MP4': t('video/mp4; codecs="avc1.64001f, Opus"'),
      'FLAC in MP4': t('video/mp4; codecs="avc1.64001f, fLaC"'),
      'MP3 (audio/mpeg)': t('audio/mpeg'),
      AV1: t('video/mp4; codecs="av01.0.08M.08"'),
      'VP9 in MP4': t('video/mp4; codecs="vp09.00.10.08"'),
    },
  };
  return e;
}
async function showEnv() {
  const e = env();
  try { e.storagePersisted = await navigator.storage?.persisted?.(); } catch { e.storagePersisted = null; }
  results.env = e;
  const rows = [];
  for (const [k, v] of Object.entries(e)) {
    if (k === 'mse') for (const [c, ok] of Object.entries(v)) rows.push([`MSE: ${c}`, ok ? 'yes' : 'no']);
    else rows.push([k, String(v)]);
  }
  $('#env').innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  record('env', e.mediaSource && e.mse['H.264 + AAC'] ? 'pass' : 'fail', {});
}

// ---------- player ----------
const video = $('#video'), audio = $('#audio');
const player = createPlayer({ video, ytContainer: $('#yt'), audio, workerUrl: WORKER, getSecrets, lang: 'en', options: { muted: true } });
let soundOn = false;
$('#sound').onclick = () => { soundOn = !soundOn; player.setMuted(!soundOn); $('#sound').textContent = 'Sound: ' + (soundOn ? 'on' : 'off'); };
document.addEventListener('pointerdown', () => player.unlock(), { once: true, capture: true });

let session = null;
function startSession(item, opts) {
  if (session) session.stop();
  const s = player.play(item, opts);
  s.events = [];
  for (const t of ['progress', 'ready', 'stalled', 'resumed', 'time', 'ended', 'failed-all', 'report', 'paused', 'needs-tap']) s.addEventListener(t, e => s.events.push({ t, d: e.detail, at: performance.now() }));
  session = s;
  return s;
}
function waitFor(s, types, ms) {
  return new Promise(res => {
    const hit = s.events.find(e => types.includes(e.t));
    if (hit) return res(hit);
    const fns = types.map(t => { const f = e => done({ t, d: e.detail }); s.addEventListener(t, f); return [t, f]; });
    const timer = setTimeout(() => done(null), ms);
    function done(v) { clearTimeout(timer); for (const [t, f] of fns) s.removeEventListener(t, f); res(v); }
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lastReport = s => s.events.filter(e => e.t === 'report').map(e => e.d).pop();
const metrics = r => r && { ttffMs: r.ttffMs, path: r.path, container: r.container, sizeMB: r.sizeMB, rank: r.candidate?.rank, fallbacks: r.fallbacks, marks: r.marks, durationRatio: r.durationCheck?.ratio, engine: r.engine };

function askHeard(id, base) {
  const el = document.querySelector(`[data-log="${id}"]`);
  const row = document.createElement('div'); row.className = 'row';
  row.innerHTML = '<span class="hint">With Sound on, did you hear the tone?</span><button>Yes</button><button>No</button><button>Sound was off</button>';
  const [yes, no, off] = row.querySelectorAll('button');
  yes.onclick = () => { record(id, base.status, { ...base, heard: 'yes' }); row.remove(); };
  no.onclick = () => { record(id, 'fail', { ...base, heard: 'no' }); row.remove(); };
  off.onclick = () => { record(id, base.status === 'pass' ? 'warn' : base.status, { ...base, heard: 'not checked' }); row.remove(); };
  el.after(row);
}

function askAd(id) {
  const el = document.querySelector(`[data-log="${id}"]`);
  const row = document.createElement('div'); row.className = 'row';
  row.innerHTML = '<span class="hint">Did an ad play before the video?</span><button>Yes</button><button>No</button>';
  const [yes, no] = row.querySelectorAll('button');
  const save = v => { record('yt-ads', v === 'yes' ? 'warn' : 'pass', { adBeforeVideo: v }); row.remove(); };
  yes.onclick = () => save('yes'); no.onclick = () => save('no');
  el.after(row);
}

async function playCheck(id, item, { expectPath, listen = true } = {}) {
  clearLog(id); record(id, 'run');
  const s = startSession(item);
  const r = await waitFor(s, ['ready', 'failed-all'], 30000);
  if (!r || r.t === 'failed-all') {
    const rep = lastReport(s);
    log(id, 'did not start: ' + JSON.stringify(r?.d?.reasons || 'timeout'));
    record(id, 'fail', { reasons: r?.d?.reasons || ['timeout'], ...metrics(rep) });
    return;
  }
  const rep = lastReport(s);
  const t1 = video.currentTime; await sleep(3000); const t2 = video.currentTime;
  const advancing = t2 - t1 > 2;
  const pathOk = !expectPath || rep?.path === expectPath;
  const status = advancing && pathOk ? 'pass' : advancing ? 'warn' : 'fail';
  log(id, `first frame ${rep?.ttffMs} ms via ${rep?.path} (${rep?.container}${rep?.sizeMB != null ? ', ' + rep.sizeMB + ' MB' : ''}), playhead ${t1.toFixed(1)} -> ${t2.toFixed(1)} s` + (pathOk ? '' : `, expected ${expectPath}`));
  const base = { status, advancedSec: +(t2 - t1).toFixed(2), ...metrics(rep) };
  record(id, status, base);
  if (listen) askHeard(id, base);
  await sleep(2000);
  s.stop();
}

const sample = f => new URL('media/' + f, location.href).href;
const RUNS = {
  async resolve() {
    const id = 'resolve'; clearLog(id); record(id, 'run');
    const sec = await getSecrets();
    if (!sec.torrentioConfig || !sec.appToken) { log(id, 'enter the settings first'); return record(id, 'fail', { reason: 'no settings' }); }
    try {
      const item = { ...BLUEY, season: 1, episode: 1, lang: 'en' };
      let t = performance.now();
      const list = await (await fetch(streamListUrl(sec.torrentioConfig, item))).json();
      const listMs = Math.round(performance.now() - t);
      const { ranked } = rankStreams(list.streams, item, { av1: false });
      if (!ranked.length) { log(id, 'no usable cached stream for Bluey S1E1'); return record(id, 'fail', { listMs, streams: list.streams?.length || 0 }); }
      t = performance.now();
      const r = await resolveViaWorker({ workerUrl: WORKER, appToken: sec.appToken, url: ranked[0].url });
      const resolveMs = Math.round(performance.now() - t);
      if (r.status !== 'ok') { log(id, 'worker said ' + r.reason); return record(id, 'fail', { listMs, resolveMs, reason: r.reason }); }
      t = performance.now();
      const g = await fetch(r.url, { headers: { Range: 'bytes=0-65535' } });
      const bytes = (await g.arrayBuffer()).byteLength;
      const firstByteMs = Math.round(performance.now() - t);
      const ok = g.status === 206 && bytes === 65536;
      log(id, `list ${listMs} ms (${list.streams.length} streams, ${ranked.length} usable) · resolve ${resolveMs} ms · CDN range read from this iPad: HTTP ${g.status}, ${bytes} bytes in ${firstByteMs} ms`);
      record(id, ok ? 'pass' : 'fail', { listMs, resolveMs, firstByteMs, cdnStatus: g.status, bytes, streams: list.streams.length, usable: ranked.length });
    } catch (e) { log(id, 'error: ' + e.message); record(id, 'fail', { error: scrubSecrets(e.message) }); }
  },
  'direct-sample': () => playCheck('direct-sample', { kind: 'file', url: sample('sample.mp4'), lang: 'en' }, { expectPath: 'direct' }),
  'direct-live': () => playCheck('direct-live', { ...BLUEY, season: 2, episode: 5, lang: 'en' }, { expectPath: 'direct', listen: false }),
  'remux-sample': () => playCheck('remux-sample', { kind: 'file', url: sample('sample_en_ru.mkv'), lang: 'en' }, { expectPath: 'remux' }),
  'remux-eac3': () => playCheck('remux-eac3', { kind: 'file', url: sample('sample_en_ru.mkv'), lang: 'ru' }, { expectPath: 'remux' }),
  'remux-hevc': () => playCheck('remux-hevc', { kind: 'file', url: sample('sample_hevc10_ac3.mkv'), lang: 'en' }, { expectPath: 'remux' }),
  'remux-mp3': () => playCheck('remux-mp3', { kind: 'file', url: sample('sample_ru_mp3.mkv'), lang: 'ru' }, { expectPath: 'remux' }),
  'remux-live': () => playCheck('remux-live', { ...BLUEY, season: 1, episode: 1, lang: 'en' }, { listen: false }),
  'remux-live-ru': () => playCheck('remux-live-ru', { ...BLUEY, season: 1, episode: 1, lang: 'ru' }, { listen: true }),

  // ---- YouTube ----
  async 'yt-start'() {
    const id = 'yt-start'; clearLog(id); record(id, 'run');
    const t0 = performance.now();
    const s = startSession({ kind: 'youtube', ytId: YT_IDS[0] }); // called inside the tap
    const r = await waitFor(s, ['ready', 'needs-tap', 'failed-all'], 12000);
    if (r?.t === 'ready') { const ms = Math.round(performance.now() - t0); log(id, `playing ${ms} ms after the tap`); record(id, 'pass', { startMs: ms, tapOnPlayerNeeded: false }); askAd(id); return; }
    if (r?.t === 'needs-tap') {
      log(id, 'The video did not start by itself. Look at the YouTube box: if an ad is playing, wait or press Skip; if you see a play button, tap it.');
      record(id, 'warn', { tapOnPlayerNeeded: true });
      const r2 = await waitFor(s, ['ready', 'failed-all'], 30000);
      if (r2?.t === 'ready') { log(id, 'the video itself is playing now'); record(id, 'warn', { tapOnPlayerNeeded: true, startedAfterTap: true }); askAd(id); return; }
    }
    log(id, 'did not start: ' + JSON.stringify(r?.d?.reasons || 'timeout'));
    record(id, 'fail', { reasons: r?.d?.reasons || ['timeout'] });
  },
  async 'yt-pause'() {
    const id = 'yt-pause'; clearLog(id);
    if (!ytPlaying()) { log(id, 'start a video first (6a)'); return; }
    session.pause();
    const p = await waitFor(session, ['paused'], 4000);
    await sleep(300);
    const hidden = $('#yt').style.visibility === 'hidden';
    log(id, `paused event: ${!!p}, player hidden: ${hidden}. Now tap Resume.`);
    record(id, p && hidden ? 'warn' : 'fail', { pausedEvent: !!p, hiddenOnPause: hidden, resumed: null });
  },
  async 'yt-resume'() {
    const id = 'yt-pause';
    if (!session) return;
    const before = session.events.length;
    session.resume();
    await sleep(3000);
    const resumed = session.events.slice(before).some(e => e.t === 'resumed' || e.t === 'ready');
    const visible = $('#yt').style.visibility === 'visible';
    const prev = results.steps[id] || {};
    log(id, `resumed: ${resumed}, visible again: ${visible}`);
    record(id, prev.pausedEvent && prev.hiddenOnPause && resumed && visible ? 'pass' : 'fail', { ...prev, resumed, visibleAfterResume: visible });
  },
  async 'yt-seek'() {
    const id = 'yt-seek'; clearLog(id); record(id, 'run');
    if (!ytPlaying()) { log(id, 'start a video first (6a)'); return record(id, 'fail', { reason: 'not playing' }); }
    const out = {};
    for (const [label, target] of [['forward', currentYtPos() + 60], ['back', currentYtPos() + 30]]) {
      const t0 = performance.now();
      session.seek(target);
      let ok = false;
      while (performance.now() - t0 < 10000) {
        await sleep(250);
        const pos = currentYtPos();
        if (Math.abs(pos - target) < 3 && session.events.at(-1)?.t !== 'stalled' && $('#yt').style.visibility === 'visible') { const p1 = pos; await sleep(1200); if (currentYtPos() > p1 + 0.5) { ok = true; break; } }
      }
      out[label] = { ok, ms: Math.round(performance.now() - t0), target: Math.round(target) };
      log(id, `seek ${label} to ${Math.round(target)} s: ${ok ? 'playing again' : 'STUCK'} after ${out[label].ms} ms`);
    }
    record(id, out.forward.ok && out.back.ok ? 'pass' : 'fail', out);
  },
  async 'yt-skip'() {
    const id = 'yt-skip'; clearLog(id); record(id, 'run');
    const t0 = performance.now();
    const s = startSession({ kind: 'youtube', ytId: YT_IDS[1] });
    const r = await waitFor(s, ['ready', 'needs-tap', 'failed-all'], 12000);
    const ms = Math.round(performance.now() - t0);
    log(id, r?.t === 'ready' ? `second video playing ${ms} ms after the tap` : 'did not start: ' + (r?.t || 'timeout'));
    record(id, r?.t === 'ready' ? 'pass' : r?.t === 'needs-tap' ? 'warn' : 'fail', { startMs: r?.t === 'ready' ? ms : null, outcome: r?.t || 'timeout' });
  },
  async 'yt-end'() {
    const id = 'yt-end'; clearLog(id); record(id, 'run');
    if (!ytPlaying()) { log(id, 'start a video first (6a)'); return record(id, 'fail', { reason: 'not playing' }); }
    const dur = session.events.filter(e => e.t === 'time').at(-1)?.d?.duration;
    if (!dur) { log(id, 'no duration yet, try again in a second'); return record(id, 'fail', { reason: 'no duration' }); }
    session.seek(dur - 5);
    const e = await waitFor(session, ['ended'], 15000);
    await sleep(200);
    const hidden = $('#yt').style.visibility === 'hidden';
    log(id, `ended event: ${!!e}, player hidden at the end: ${hidden}. Look at the YouTube box: it should be empty, with no suggestions.`);
    record(id, e && hidden ? 'pass' : 'fail', { endedEvent: !!e, hiddenAtEnd: hidden });
  },
  async 'yt-screens'() {
    const id = 'yt-screens'; clearLog(id); record(id, 'run');
    const s = startSession({ kind: 'youtube', ytId: YT_IDS[0] }, { ytCueOnly: true });
    const r = await waitFor(s, ['needs-tap', 'ready', 'failed-all'], 15000);
    if (r?.t === 'needs-tap') { log(id, "YouTube's start screen is showing. Arm each row and tap that part."); return record(id, 'warn', { startScreenShown: true, checked: 0, of: SCREEN_EXITS.length }); }
    log(id, 'the start screen did not show: ' + (r?.t || 'timeout'));
    record(id, 'fail', { startScreenShown: false, outcome: r?.t || 'timeout' });
  },
  'audio-stop': () => { if (session) session.stop(); },
  async 'audio-lock'() {
    const id = 'audio-lock'; clearLog(id); record(id, 'run');
    let url;
    try { url = (await (await fetch(STORY_STREAM)).json()).streams[0].url; } catch { url = null; }
    if (!url) { log(id, 'could not load the story list'); return record(id, 'fail', { reason: 'no story' }); }
    const s = startSession({ kind: 'audio', url, title: 'Testbed story' }, { keepAwake: false });
    const r = await waitFor(s, ['ready', 'failed-all'], 20000);
    if (r?.t !== 'ready') { log(id, 'story did not start'); return record(id, 'fail', { reason: 'no start' }); }
    log(id, 'story playing. Lock the iPad now, wait about 30 s, then unlock and come back here.');
    const mode = results.env.displayMode;
    let hiddenAt = null, posAt = 0;
    const onVis = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = performance.now(); posAt = audio.currentTime; return; }
      if (hiddenAt == null) return;
      const away = (performance.now() - hiddenAt) / 1000, advanced = audio.currentTime - posAt;
      const ok = away >= 10 && advanced >= 0.8 * away;
      log(id, `away ${away.toFixed(0)} s, story advanced ${advanced.toFixed(0)} s while locked (${mode})`);
      record(id + (mode === 'home screen app' ? '-homescreen' : '-safari'), away < 10 ? 'warn' : ok ? 'pass' : 'fail', { awaySec: +away.toFixed(1), advancedSec: +advanced.toFixed(1), displayMode: mode, stillPlaying: !audio.paused });
      record(id, away < 10 ? 'warn' : ok ? 'pass' : 'fail', { awaySec: +away.toFixed(1), advancedSec: +advanced.toFixed(1), displayMode: mode });
      document.removeEventListener('visibilitychange', onVis);
    };
    document.addEventListener('visibilitychange', onVis);
  },
};
const ytPlaying = () => session && session.events.some(e => e.t === 'ready') && !session.events.some(e => e.t === 'ended' || e.t === 'failed-all') && session.events.some(e => e.t === 'time');
const currentYtPos = () => session?.events.filter(e => e.t === 'time').at(-1)?.d?.position || 0;

// ---------- ways out ----------
const EXITS = [
  ['title', 'Video title (top of the player)'], ['avatar', 'Channel picture (top left)'], ['logo', 'YouTube logo (allowed to lead out)'],
  ['watch', '"Watch on YouTube" or share / watch later buttons'], ['video-tap', 'A tap on the picture itself'], ['long-press', 'A long press on the picture'],
  ['end', 'Anything shown at the very end (run 6e first)'],
];
const SCREEN_EXITS = [
  ['start-title', 'Start screen: the video title'], ['start-avatar', 'Start screen: the channel picture'],
  ['start-watch', 'Start screen: "Watch on YouTube", share or "More videos"'], ['start-play', 'Start screen: the big play button (should just play)'],
  ['ad-link', 'Ad: the advertiser name or "Visit advertiser" link'], ['ad-title', 'Ad: the ad title or its channel'],
  ['ad-info', 'Ad: the (i) or "Why this ad" button'], ['ad-skip', 'Ad: the Skip button (should just skip)'],
];
const STAYS = new Set(['logo', 'start-play', 'ad-skip']); // allowed: the logo may lead out; play and skip should act inside
function renderExits(tableSel, list, summaryId) {
  $(tableSel).innerHTML = list.map(([k, label]) => `<tr data-exit="${k}"><td>${label}</td><td><button data-arm="${k}">Arm</button></td><td class="res">${results.steps['exit-' + k]?.outcome || ''}</td></tr>`).join('');
  for (const b of $(tableSel).querySelectorAll('[data-arm]')) b.onclick = () => armExit(b.dataset.arm, list, summaryId);
}
function armExit(k, list, summaryId) {
  const row = document.querySelector(`[data-exit="${k}"] .res`);
  row.textContent = 'armed: tap it now (10 s)';
  let left = false;
  const onHide = () => { if (document.visibilityState === 'hidden') left = true; };
  const onPageHide = () => { left = true; };
  document.addEventListener('visibilitychange', onHide); addEventListener('pagehide', onPageHide);
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide); removeEventListener('pagehide', onPageHide);
    if (left) return saveExit(k, 'left the app', list, summaryId);
    row.innerHTML = '<button>Not there</button> <button>Nothing</button> <button>Changed inside the player</button>';
    const [a, b, c] = row.querySelectorAll('button');
    a.onclick = () => saveExit(k, 'not visible', list, summaryId); b.onclick = () => saveExit(k, 'nothing happened', list, summaryId);
    c.onclick = () => saveExit(k, 'changed inside the player', list, summaryId);
  }, 10000);
}
function saveExit(k, outcome, list, summaryId) {
  const leads = outcome === 'left the app' || (outcome === 'changed inside the player' && !STAYS.has(k));
  const okOut = k === 'logo' || !leads;
  record('exit-' + k, okOut ? 'pass' : 'fail', { outcome });
  document.querySelector(`[data-exit="${k}"] .res`).textContent = outcome;
  const done = list.map(([x]) => results.steps['exit-' + x]).filter(Boolean);
  const out = list.filter(([x]) => results.steps['exit-' + x]?.status === 'fail').map(([, l]) => l);
  record(summaryId, out.length ? 'fail' : done.length === list.length ? 'pass' : 'warn', { checked: done.length, of: list.length, waysOut: out });
  if (summaryId === 'yt-screens') {
    const ad = list.filter(([x]) => x.startsWith('ad-') && results.steps['exit-' + x]?.outcome === 'left the app').length;
    clearLog('yt-screens');
    log('yt-screens', out.length ? `Leads out of the app: ${out.join('; ')}.` : 'Nothing checked so far leads out of the app.');
    if (ad) log('yt-screens', 'Decision for Daniel: ads can lead out. Either show ads with their links (YouTube\'s terms) or keep the player hidden during ads, so she hears the ad behind the loading toy and cannot tap it (against the terms).');
  }
}

// ---------- wiring ----------
for (const b of document.querySelectorAll('[data-run]')) b.addEventListener('click', () => RUNS[b.dataset.run]?.());
$('#save').onclick = async () => {
  const cfg = $('#cfg').value.trim(), tok = $('#tok').value.trim();
  if (!cfg || !tok) return record('settings', 'fail', { reason: 'both fields needed' });
  await kv('put', 'settings', { torrentioConfig: cfg, appToken: tok });
  $('#cfg').value = ''; $('#tok').value = '';
  $('#cfg').placeholder = 'saved on this device'; $('#tok').placeholder = 'saved on this device';
  record('settings', 'pass', { saved: true });
};
$('#clear').onclick = async () => { await kv('del', 'settings'); $('#cfg').placeholder = 'https://torrentio.strem.fun/.../manifest.json'; $('#tok').placeholder = ''; record('settings', 'waiting', { saved: false }); };
$('#copy').onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify(results, null, 1)); $('#copy').textContent = 'Copied'; } catch { $('#copy').textContent = 'Select the text below'; } setTimeout(() => { $('#copy').textContent = 'Copy results'; }, 1500); };
$('#reset').onclick = async () => { results = { env: results.env, steps: {} }; await kv('put', 'results', results); location.reload(); };

(async () => {
  await loadResults();
  await showEnv();
  renderExits('#exits', EXITS, 'yt-exits');
  renderExits('#exits2', SCREEN_EXITS, 'yt-screens');
  const s = await getSecrets();
  if (s.torrentioConfig && s.appToken) { $('#cfg').placeholder = 'saved on this device'; $('#tok').placeholder = 'saved on this device'; record('settings', 'pass', { saved: true }); }
  try { await navigator.storage?.persist?.(); } catch { /* fine */ }
  window.__tb = { RUNS, kv, results: () => results, player, session: () => session }; // for automated runs
})();
