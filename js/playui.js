// The player flow (spec 4.5-4.7, 5, 7): loading moment with the category toy, the rail, pause screen,
// stall state, goodbye card, sleeping card, limits at episode ends, progress, watch time and the play log.
import { playItemFor, kindOf } from './data.js';
import { isFinished, canStart, isLastOne, addWatchTime, recordEpisodeEnd, onEpisodeEnd, onPlaybackTick, recordFailure, todayKey } from './rules.js';
import { sanitizeReport, secretValues } from './secrets.js';
import { mountToy, toyFor } from './toys.js';
import { pom, ICONS, CHIP_ART } from './art.js';

const $ = (s) => document.querySelector(s);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const SAVE_EVERY_MS = 5000;
const SETUP = new Set(['not-configured', 'unauthorized', 'misconfigured', 'forbidden', 'no-player', 'app_token']);

export function createPlayUI(app) {
  const layer = $('#player'), toyLayer = $('#toy-layer'), overlay = $('#overlay');
  const area = $('#video-area'), pauseEl = $('#pause-screen'), stallEl = $('#stall'), cover = $('#kc-cover');
  const rail = $('#rail');
  let ctx = null;            // { data, videos, index, item, session, ... }
  let wakeLock = null;

  rail.innerHTML = `
    <button class="rail-btn tapable" data-r="back" aria-label="back">${ICONS.back}</button>
    <button class="rail-btn tapable" data-r="toggle" aria-label="pause">${ICONS.pause}</button>
    <button class="rail-btn tapable" data-r="back15" aria-label="back 15 seconds">${ICONS.back15}</button>
    <button class="rail-btn tapable" data-r="fwd15" aria-label="forward 15 seconds">${ICONS.fwd15}</button>
    <button class="rail-btn tapable" data-r="next" aria-label="next">${ICONS.next}</button>
    <div class="rail-dots"></div>`;
  stallEl.innerHTML = `<div class="stall-pom">${pom('day', 'breathe')}</div>`;

  function itemFor(data, v) {
    const t = data.title;
    let stream = null;
    if (t.type === 'YouTube') {
      const m = /\/vi\/([^/]+)\//.exec(v.thumbnail || '');
      stream = m ? { ytId: m[1] } : app.streamReady.get(`${t.type}/${v.id}`) || null;
    } else if (t.type === 'Audio') stream = app.streamReady.get(`${t.type}/${v.id}`) || null;
    return playItemFor(t, v, { lang: app.langOf(t.id), stream });
  }

  const reportSecrets = async () => secretValues(await app.store.getSecrets());

  function setRail() {
    if (!ctx) return;
    const next = rail.querySelector('[data-r="next"]');
    const hasNext = ctx.index < ctx.videos.length - 1;
    next.classList.toggle('inert', !hasNext); next.disabled = !hasNext;
    const t = rail.querySelector('[data-r="toggle"]');
    t.innerHTML = ctx.paused ? ICONS.play : ICONS.pause;
    t.setAttribute('aria-label', ctx.paused ? 'play' : 'pause');
    rail.querySelector('.rail-dots').innerHTML = document.querySelector('.show-dots')?.innerHTML || '';
  }

  async function saveProgress(final = false) {
    if (!ctx || !ctx.duration) return;
    const { item, data } = ctx;
    const rec = {
      key: item.videoId, titleId: data.title.id, titleType: data.title.type, titleName: data.title.name,
      poster: data.title.poster, posterShape: data.title.type === 'YouTube' || data.title.type === 'Audio' ? 'square' : 'poster',
      kind: item.kind, season: item.season, episode: item.episode,
      position: ctx.position, duration: ctx.duration, updatedAt: Date.now(), finished: final,
    };
    app.progress.set(rec.key, rec);
    ctx.lastSave = Date.now();
    await app.store.putProgress(rec);
  }

  async function logPlay(extra, c = ctx) {
    if (!c) return;                       // capture now: ctx may be gone after the await below
    const clean = sanitizeReport(extra, await reportSecrets());
    await app.store.putPlay({
      ...clean,
      playId: c.playId, at: c.startedAt, date: todayKey(new Date(c.startedAt)),
      titleId: c.data.title.id, titleName: c.data.title.name, kind: c.item.kind,
      episodeLabel: c.item.season != null ? `S${c.item.season}E${c.item.episode}` : (c.item.episodeTitle || '').slice(0, 60),
      watchedSec: Math.round(c.watched), source: app.player.source,
    });
  }

  function show(on) {
    layer.classList.toggle('open', on);
    layer.classList.toggle('audio', on && ctx?.item.kind === 'audio');
    layer.classList.toggle('youtube', on && ctx?.item.kind === 'youtube');
    if (!on) { pauseEl.classList.remove('open'); stallEl.classList.remove('open'); cover.innerHTML = ''; area.classList.remove('dim-night'); }
  }

  async function wake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener?.('release', () => { wakeLock = null; }); }
      if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch { wakeLock = null; }
  }

  function setupMedia(item, data) {
    if (item.kind !== 'audio' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: item.episodeTitle || data.title.name, artist: data.title.name, album: 'Kids Corner', artwork: item.artwork ? [{ src: item.artwork, sizes: '512x512' }] : [] });
      navigator.mediaSession.setActionHandler('play', () => doResume());
      navigator.mediaSession.setActionHandler('pause', () => doPause());
    } catch { /* optional */ }
  }

  function teardown() {
    if (!ctx) return;
    clearTimeout(ctx.toyTimer); clearTimeout(ctx.stallTimer); clearTimeout(ctx.nightTimer);
    try { ctx.session.stop(); } catch { /* already stopped */ }
    ctx.toy?.destroy();
    toyLayer.classList.remove('open', 'fading');
    wake(false);
  }

  // Start an item: called synchronously from her tap so the player can start inside the gesture.
  function start({ data, videos, index, from, fromKeep = false }) {
    const u = app.today();
    if (!canStart(u, app.settings)) { app.render(); return; }
    const v = videos[index];
    const item = itemFor(data, v);
    if ((item.kind === 'youtube' && !item.ytId) || (item.kind === 'audio' && !item.url)) {
      // Stream not warmed yet: fetch it, then start (the persistent elements are already unlocked).
      app.stream(data.title.type, v.id).then(() => start({ data, videos, index, from, fromKeep })).catch(() => fail(['no-stream'], { data, videos, index, item }));
      return;
    }
    teardown();
    const prev = app.progress.get(item.videoId);
    const startAt = prev && !isFinished(prev) ? Math.max(0, prev.position - 2) : 0;
    const cat = app.catOf(data.title.id) || (data.title.type === 'YouTube' ? 'youtube' : data.title.type === 'Audio' ? 'stories' : 'shows');
    ctx = { data, videos, index, item, cat, fromKeep, playId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, startedAt: Date.now(),
      position: startAt, duration: 0, paused: false, ready: false, lastTick: 0, lastPos: startAt, lastSave: 0, watched: 0 };
    layer.dataset.cat = app.bedtime ? 'bedtime' : cat;
    toyLayer.dataset.cat = layer.dataset.cat;
    show(true);
    setRail();
    if (from) { from.classList.add('launch'); setTimeout(() => from.classList.remove('launch'), 400); }

    const s = app.player.play(item, { startAt });
    ctx.session = s;
    app.playing = true;
    if (item.kind === 'audio') { cover.innerHTML = `<div class="cover-art" data-cat="${cat}"><img src="${item.artwork || data.title.poster || ''}" alt="" onerror="this.remove()"></div>`; setupMedia(item, data); wake(true); }
    else if (item.kind === 'torbox') wake(true);

    // Loading moment: no toy under 1 s; from 1 s the category toy (Sleepy Moon at bedtime).
    ctx.toyTimer = setTimeout(() => showToy(ctx), 1000);
    if (isLastOne(u, app.settings)) app.speak('ui.lastone');

    const my = ctx;
    const on = (type, fn) => s.addEventListener(type, (e) => { if (ctx === my) fn(e.detail || {}); });
    on('progress', (d) => { my.lastProgress = d.fraction; my.toy?.setProgress(d.fraction); });
    on('ready', () => onReady(my));
    on('time', (d) => onTime(my, d));
    on('paused', () => onPaused(my));
    on('stalled', () => { clearTimeout(my.stallTimer); my.stallTimer = setTimeout(() => stallEl.classList.add('open'), 1000); });
    on('resumed', () => { clearTimeout(my.stallTimer); stallEl.classList.remove('open'); if (my.paused) { my.paused = false; pauseEl.classList.remove('open'); setRail(); } });
    on('ended', () => onEnded(my));
    on('failed-all', (d) => fail(d.reasons || [], my));
    on('report', (d) => { if (d.playId && !my.playerPlayId) { my.playerPlayId = d.playId; } const { playId, ...rest } = d; logPlay({ ...rest, playerPlayId: playId }, my); });
  }

  // Match cut (spec 5.5): the player, already playing underneath, is revealed from a point in the toy.
  function reveal(el, done, shape = 'circle') {
    const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const start = shape === 'circle' ? `circle(${Math.max(20, r.width / 2)}px at ${cx}px ${cy}px)` : `inset(${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px round 24px)`;
    const end = shape === 'circle' ? `circle(150% at ${cx}px ${cy}px)` : 'inset(0px 0px 0px 0px round 0px)';
    layer.style.zIndex = '25';
    layer.style.clipPath = layer.style.webkitClipPath = start;
    void layer.offsetWidth;
    layer.style.transition = 'clip-path .6s ease-in-out, -webkit-clip-path .6s ease-in-out';
    requestAnimationFrame(() => { layer.style.clipPath = layer.style.webkitClipPath = end; });
    setTimeout(() => { layer.style.transition = layer.style.clipPath = layer.style.webkitClipPath = layer.style.zIndex = ''; done(); }, 650);
  }

  function showToy(c) {
    if (ctx !== c || c.ready || c.failed) return;
    const name = toyFor(c.cat, app.bedtime);
    toyLayer.classList.add('open');
    toyLayer.innerHTML = `<div class="toy-host"></div><button class="round-btn toy-back tapable" aria-label="back">${ICONS.back}</button>`;
    c.toy = mountToy(toyLayer.querySelector('.toy-host'), name, { sound: app.sound, reduced: app.reduced(), item: { ...c.item, poster: c.item.artwork || c.data.title.poster }, reveal });
    c.toyShownAt = performance.now();
    if (c.lastProgress != null) c.toy.setProgress(c.lastProgress);
    toyLayer.querySelector('.toy-back').onclick = () => { app.effect('button'); leave('back-loading'); };
  }

  async function onReady(c) {
    if (c.ready) return;
    c.ready = true;
    clearTimeout(c.toyTimer);
    if (c.fromKeep) app.speak('title.' + c.data.title.id);
    if (c.toy) {
      const brief = performance.now() - c.toyShownAt < 1000;
      const ms = brief || app.reduced() ? 400 : (app.bedtime ? 1500 : 1200);
      if (brief || app.reduced()) { toyLayer.classList.add('fading'); toyLayer.style.setProperty('--fade', ms + 'ms'); await wait(ms); }
      else await c.toy.handoff();
      if (ctx !== c) return;
      c.toy.destroy(); c.toy = null;
      toyLayer.classList.remove('open', 'fading');
    }
    if (c.item.kind === 'audio' && app.bedtime) c.nightTimer = setTimeout(() => area.classList.add('dim-night'), 20000);
  }

  function onTime(c, { position, duration }) {
    if (!Number.isFinite(position)) return;
    const now = performance.now();
    if (!c.paused && position > c.lastPos && c.lastTick) {
      const dt = Math.min(2, (now - c.lastTick) / 1000);
      c.watched += dt;
      app.usage = addWatchTime(app.today(), dt);
    }
    c.lastTick = now; c.lastPos = position;
    c.position = position;
    if (duration > 0) c.duration = duration;
    if (Date.now() - c.lastSave > SAVE_EVERY_MS) { saveProgress(); app.saveUsage(); }
    // A movie set to "pause at the limit" stops here; a series episode always finishes.
    if (onPlaybackTick(app.usage, app.settings, c.item) === 'pause') leave('limit');
  }

  function onPaused(c) {
    c.paused = true;
    setRail();
    if (c.item.kind === 'audio') return;            // a story shows its cover; the rail's play button resumes
    const v = c.videos;
    const still = c.videos[c.index].thumbnail || c.data.title.background || c.data.title.poster || '';
    const tile = (i, dir) => i < 0 || i >= v.length ? '<span class="pause-gap" aria-hidden="true"></span>' :
      `<button class="pause-tile tapable" data-i="${i}" aria-label="${dir}"><span class="fallback">${CHIP_ART[c.cat] || ''}</span>${v[i].thumbnail ? `<img src="${v[i].thumbnail}" alt="" onerror="this.remove()">` : ''}<span class="pause-arrow">${dir === 'previous' ? ICONS.left : ICONS.right}</span></button>`;
    pauseEl.innerHTML = `<div class="pause-still" style="background-image:url('${still.replace(/'/g, '%27')}')"></div>
      <div class="pause-row">${tile(c.index - 1, 'previous')}<button class="pause-play tapable" data-cat="${c.cat}" aria-label="play">${ICONS.play}</button>${tile(c.index + 1, 'next')}</div>
      <div class="pause-pom">${pom(app.bedtime ? 'night' : 'day')}</div>`;
    pauseEl.classList.add('open');
  }

  function doPause() { if (!ctx) return; ctx.session.pause(); if (!ctx.paused) onPaused(ctx); saveProgress(); app.saveUsage(); }
  function doResume() { if (!ctx) return; ctx.paused = false; pauseEl.classList.remove('open'); setRail(); ctx.session.resume(); }

  pauseEl.addEventListener('click', (e) => {
    if (e.target.closest('.pause-play')) { app.effect('button'); doResume(); return; }
    const t = e.target.closest('.pause-tile');
    if (t && ctx) { app.effect('poster'); const c = ctx; saveProgress(); logPlay({ endReason: 'switched' }); start({ data: c.data, videos: c.videos, index: +t.dataset.i, from: t }); }
  });

  rail.addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (!b || !ctx || b.disabled) return;
    const r = b.dataset.r;
    if (r === 'back') { app.effect('button'); leave('back'); }
    else if (r === 'toggle') { app.effect('button'); ctx.paused ? doResume() : doPause(); }
    else if (r === 'back15' || r === 'fwd15') {
      app.effect('tick');
      const to = Math.max(0, Math.min((ctx.duration || Infinity) - 1, ctx.position + (r === 'fwd15' ? 15 : -15)));
      ctx.position = to; ctx.lastPos = to;
      ctx.session.seek(to);
    } else if (r === 'next' && ctx.index < ctx.videos.length - 1) {
      app.effect('button');
      const c = ctx; saveProgress(); logPlay({ endReason: 'next' });
      start({ data: c.data, videos: c.videos, index: c.index + 1, from: b });
    }
  });

  // Leave the player for the show page, saving the exact spot (spec 4.5 "Back").
  async function leave(reason) {
    const c = ctx;
    if (!c) return;
    await saveProgress();
    await app.saveUsage();
    logPlay({ endReason: reason });
    teardown();
    ctx = null; app.playing = false;
    show(false);
    if (reason === 'limit') { app.render(); return; }
    app.go(`#/t/${c.data.title.type}/${c.data.title.id}`);
  }

  async function onEnded(c) {
    c.position = c.duration || c.position;
    await saveProgress(true);
    app.usage = recordEpisodeEnd(app.today());
    const oneStory = app.bedtime && app.settings.bedtime.oneStory;
    if (oneStory) app.usage = { ...app.usage, goodnight: true };
    await app.saveUsage();
    logPlay({ endReason: 'ended' });
    teardown();
    ctx = null; app.playing = false;
    const action = onEpisodeEnd(app.usage, app.settings);
    // Goodbye card: 5 s in the category colour, Pom waving (spec 7).
    overlay.innerHTML = `<div class="goodbye" data-cat="${app.bedtime ? 'bedtime' : c.cat}">
      <button class="round-btn card-back tapable" aria-label="back">${ICONS.back}</button>
      <div class="goodbye-pom">${pom(app.bedtime ? 'night' : 'day', 'wavel')}</div></div>`;
    overlay.classList.add('open');
    show(false);
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      overlay.classList.remove('open'); overlay.innerHTML = '';
      app.justEnded = action === 'goodbye' && !oneStory ? c.item.videoId : null;
      if (action === 'rest' || oneStory) { app.go('#/'); app.render(); }
      else app.go(`#/t/${c.data.title.type}/${c.data.title.id}`);
    };
    overlay.querySelector('.card-back').onclick = () => { app.effect('button'); app.sound.stopVoice(); finish(); };
    (async () => { await app.speak(oneStory ? 'ui.goodnight' : 'ui.bye'); if (!done && !oneStory) await app.speak('title.' + c.data.title.id); })();
    setTimeout(finish, 5000);
  }

  // Every candidate failed: Pom's sleeping card for 3 s, then the show page (spec 5.6).
  async function fail(reasons, c) {
    if (c.failed) return;
    c.failed = true;
    const setup = reasons.some(r => SETUP.has(r));
    if (setup) app.setupHint = reasons.find(r => SETUP.has(r));
    else {
      app.failed = recordFailure(app.failed, { titleId: c.data.title.id, videoId: c.item.videoId, type: c.data.title.type }, reasons);
      await app.store.saveFailed(app.failed);
    }
    logPlay({ endReason: 'failed', failures: reasons }, c);
    if (ctx === c) { teardown(); ctx = null; }
    app.playing = false;
    overlay.innerHTML = `<div class="sleeping-card" data-cat="${app.bedtime ? 'bedtime' : c.cat}"><div class="goodbye-pom">${pom('sleep')}</div></div>`;
    overlay.classList.add('open');
    show(false);
    app.speak('ui.sleeping');
    await wait(3000);
    overlay.classList.remove('open'); overlay.innerHTML = '';
    // The failed item stays visible this time; from the next session it's hidden (spec 5.6).
    app.go(`#/t/${c.data.title.type}/${c.data.title.id}`);
  }

  // Resume from Keep watching: straight into the loading moment, no show page on the way.
  async function resume(key, from) {
    const p = app.progress.get(key);
    if (!p) return;
    const k = `${p.titleType}/${p.titleId}`;
    let data = app.titleReady.get(k);
    if (!data) { try { data = await app.title(p.titleType, p.titleId); } catch { return; } }
    const index = data.videos.findIndex(v => v.id === key);
    if (index < 0) { app.go(`#/t/${p.titleType}/${p.titleId}`); return; }
    start({ data, videos: data.videos, index, from, fromKeep: true });
  }

  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) {
      saveProgress(); app.saveUsage();
      if (ctx.item.kind !== 'audio') doPause();      // stories may keep playing (spec 8.3)
    } else if (ctx.item.kind !== 'youtube' && kindOf(ctx.data.title.type) !== 'youtube') wake(true);
  });
  window.addEventListener('pagehide', () => { if (ctx) { saveProgress(); app.saveUsage(); } });

  return { start, resume, itemFor, get active() { return !!ctx; } };
}
