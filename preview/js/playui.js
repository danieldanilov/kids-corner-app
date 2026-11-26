// The player flow (spec 4.5-4.7, 5, 7): loading moment with the category toy, the rail, pause screen,
// stall state, goodbye card, sleeping card, limits at episode ends, progress, watch time and the play log.
import { playItemFor, kindOf, collectionData, collectionOf, titleClipId, COLLECTIONS, COLLECTION_TYPES } from './data.js';
import { failureCounts, youtubeHostFor, isSetupReason, isFinished, canStart, isLastOne, addWatchTime, recordEpisodeEnd, onEpisodeEnd, onPlaybackTick, recordFailure, todayKey } from './rules.js';
import { sanitizeReport, secretValues } from './secrets.js';
import { mountToy, toyFor } from './toys.js';
import { pom, ICONS, CHIP_ART } from './art.js';
import { createAutoHide } from './controls.js';

const $ = (s) => document.querySelector(s);
// The spoken title for what's playing: a song's own title (title.music.<videoId>), otherwise the show's.
// Songs and lessons (Music, Learn's subjects) follow the same rules: start at 0, no halfway spot, no show count.
const isColl = (c) => COLLECTION_TYPES.has(c.data?.title?.type ?? c.title?.type);
const titleClip = (c) => 'title.' + titleClipId(isColl(c) ? c.item.videoId : c.data.title.id);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const SAVE_EVERY_MS = 5000;
const SETUP = new Set(['not-configured', 'unauthorized', 'misconfigured', 'forbidden', 'no-player', 'app_token']);

export function createPlayUI(app) {
  const layer = $('#player'), toyLayer = $('#toy-layer'), overlay = $('#overlay');
  const area = $('#video-area'), pauseEl = $('#pause-screen'), stallEl = $('#stall'), cover = $('#kc-cover');
  const rail = $('#rail');
  let ctx = null;            // { data, videos, index, item, session, ... }
  let wakeLock = null;
  // Full-screen player with controls that fade (spec v4, 4.5).
  const catcher = document.getElementById('touch-catcher');
  const autoHide = createAutoHide({
    onChange: (v) => layer.classList.toggle('controls-hidden', !v),
    onGuard: (g) => layer.classList.toggle('tap-guard', g),
  });
  // TorBox video and audio: a touch on the picture only reveals the controls; it never pauses or presses a button.
  catcher.addEventListener('pointerdown', (e) => { e.preventDefault(); autoHide.touchVideo(); });
  // A tap on the scrim between buttons only restarts the 3 s count; the controls never vanish under her finger.
  rail.addEventListener('pointerdown', (e) => { if (e.target === rail) autoHide.touchVideo(); });
  const playingNow = (c) => {          // playback runs: TorBox and audio start the 3 s count, YouTube hides at once
    autoHide.setPlaying(true);
    if (c?.item.kind === 'youtube') autoHide.hideNow();
  };

  rail.innerHTML = `
    <button class="rail-btn tapable" data-r="back" aria-label="back">${ICONS.back}</button>
    <button class="rail-btn tapable" data-r="toggle" aria-label="pause">${ICONS.pause}</button>
    <button class="rail-btn tapable" data-r="back15" aria-label="back 15 seconds">${ICONS.back15}</button>
    <button class="rail-btn tapable" data-r="fwd15" aria-label="forward 15 seconds">${ICONS.fwd15}</button>
    <button class="rail-btn tapable" data-r="next" aria-label="next">${ICONS.next}</button>
    <div class="pause-tiles"></div>
    <div class="pause-pom" aria-hidden="true"></div>
    <div class="stall-pom" aria-hidden="true">${pom('day', 'breathe')}</div>
    <div class="skip-pop rew" aria-hidden="true">−15</div>
    <div class="skip-pop fwd" aria-hidden="true">+15</div>
    <div class="pos-bar" aria-hidden="true"><div class="trk"><div class="fil"></div></div><div class="tm"></div></div>
    <div class="rail-dots"></div>`;

  function itemFor(data, v) {
    const t = data.title;
    let stream = null;
    if (t.type === 'YouTube') {
      const m = /\/vi\/([^/]+)\//.exec(v.thumbnail || '');
      stream = m ? { ytId: m[1] } : app.streamReady.get(`${t.type}/${v.id}`) || null;
    } else if (t.type === 'Audio') stream = app.streamReady.get(`${t.type}/${v.id}`) || null;
    else if (COLLECTION_TYPES.has(t.type)) stream = { ytId: v.ytId };   // <prefix><videoId>: the id is the YouTube id
    return playItemFor(t, v, { lang: app.langOf(t.id), stream });
  }

  // Skip feedback (4.5): the "+15" / "−15" pill restarts on every tap. The position bar (4.6) shows where she is.
  const mmss = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function popSkip(dir) {
    const e = rail.querySelector(`.skip-pop.${dir}`);
    e.classList.remove('go'); void e.offsetWidth; e.classList.add('go');
  }
  function setBar(c) {
    if (!c) return;
    const b = rail.querySelector('.pos-bar'), dur = c.duration || 0;
    b.classList.toggle('nodur', !(dur > 0));
    if (!(dur > 0)) return;
    const own = typeof c.session?.position === 'function' ? c.session.position() : NaN;
    const pos = Math.max(0, Math.min(dur, Number.isFinite(own) ? own : c.position || 0));
    b.querySelector('.fil').style.width = `${(100 * pos / dur).toFixed(2)}%`;
    b.querySelector('.tm').textContent = `${mmss(pos)} / ${mmss(dur)}`;
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
    if (isColl(ctx) && !final) return;   // a song or lesson keeps no halfway spot; only its end (the check mark)
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

  const windowSize = () => `${innerWidth}x${innerHeight} @${devicePixelRatio}x ${matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'home screen' : 'tab'}`;
  async function logPlay(extra, c = ctx) {
    if (!c) return;                       // capture now: ctx may be gone after the await below
    const clean = sanitizeReport(extra, await reportSecrets());
    await app.store.putPlay({
      ...clean,
      playId: c.playId, at: c.startedAt, date: todayKey(new Date(c.startedAt)),
      titleId: c.data.title.id, titleName: c.data.title.name, kind: c.item.kind,
      episodeLabel: c.item.season != null ? `S${c.item.season}E${c.item.episode}` : (c.item.episodeTitle || '').slice(0, 60),
      watchedSec: Math.round(c.watched), source: app.player.source,
      viewport: windowSize(),   // her iPad's real window size, never recorded anywhere else
    });
  }

  function show(on) {
    layer.classList.toggle('open', on);
    layer.classList.toggle('audio', on && ctx?.item.kind === 'audio');
    layer.classList.toggle('youtube', on && ctx?.item.kind === 'youtube');
    if (!on) { pauseEl.classList.remove('open'); layer.classList.remove('paused', 'stalled'); cover.innerHTML = ''; area.classList.remove('dim-night'); }
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
    layer.classList.remove('needs-tap', 'yt-ad', 'ad-paused', 'controls-hidden', 'paused', 'stalled', 'tap-guard');
    autoHide.setPlaying(false);
    document.getElementById('kc-yt').style.visibility = '';
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
    const song = isColl({ data });
    const startAt = !song && prev && !isFinished(prev) ? Math.max(0, prev.position - 2) : 0;   // songs always start from the beginning
    const cat = isColl({ data }) ? COLLECTIONS[data.title.id].cat : app.catOf(data.title.id) || (data.title.type === 'YouTube' ? 'youtube' : data.title.type === 'Audio' ? 'stories' : 'shows');
    const returnTo = ctx?.returnTo || (location.hash || '#/');
    ctx = { data, videos, index, item, cat, fromKeep, returnTo, playId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, startedAt: Date.now(),
      position: startAt, duration: 0, paused: false, ready: false, lastTick: 0, lastPos: startAt, lastSave: 0, watched: 0 };
    layer.dataset.cat = app.bedtime ? 'bedtime' : cat;
    toyLayer.dataset.cat = layer.dataset.cat;
    delete toyLayer.dataset.progress;
    show(true);
    setRail();
    if (from) { from.classList.add('launch'); setTimeout(() => from.classList.remove('launch'), 400); }

    // YouTube v2 (player/README.md, spec 4.5): the clear layer over every YouTube play, so no tap reaches YouTube's
    // out-links (a tap comes back as 'shield-tap'), and ads muted with the sound back for the content.
    const yt = item.kind === 'youtube';
    const s = app.player.play(item, { startAt, youtubeHost: youtubeHostFor(app.settings), ...(yt ? { ytShield: true, ytAdMute: true } : {}) });   // the host switch applies from the next play
    ctx.session = s;
    app.playing = true;
    if (item.kind === 'audio') { cover.innerHTML = `<div class="cover-art" data-cat="${cat}"><img src="${item.artwork || data.title.poster || ''}" alt="" onerror="this.remove()"></div>`; setupMedia(item, data); wake(true); }
    else if (item.kind === 'torbox') wake(true);

    // Loading moment: no toy under 1 s; from 1 s the category toy (Sleepy Moon at bedtime).
    ctx.toyTimer = setTimeout(() => showToy(ctx), 1000);
    if (isLastOne(u, app.settings)) app.speak('ui.lastone');

    const my = ctx;
    const on = (type, fn) => s.addEventListener(type, (e) => { if (ctx === my) fn(e.detail || {}); });
    // The transcode path (player contract): 'decoder' (ffmpeg.wasm downloading and compiling, the first converted file
    // of a session) and 'convert' (seconds converted ahead) share the toy half and half, so it is full only when the
    // video can start; the toy stays up through both. Progress never moves back.
    on('progress', (d) => {
      if (d.stage === 'decoder' || d.stage === 'convert') my.stages = { ...my.stages, [d.stage]: d.fraction };
      const st = my.stages;
      const f = !st ? d.fraction : st.decoder != null ? 0.5 * st.decoder + 0.5 * (st.convert || 0) : (st.convert ?? d.fraction);
      my.lastProgress = Math.max(my.lastProgress || 0, Math.min(1, f));
      toyLayer.dataset.progress = String(my.lastProgress);
      my.toy?.setProgress(my.lastProgress);
    });
    on('ready', () => { if (my.item.kind === 'torbox') app.torboxKeyProven = true; playingNow(my); onReady(my); });   // proof the TorBox key works this session
    on('time', (d) => onTime(my, d));
    on('paused', (d) => { autoHide.setPlaying(false); onPaused(my, d); });
    // Stalled more than 1 s (4.7): the controls show and stay, Pom breathes small bottom-right. YouTube buffers inside its own player.
    on('stalled', () => { if (my.item.kind === 'youtube') return; clearTimeout(my.stallTimer); my.stallTimer = setTimeout(() => { if (ctx === my) { layer.classList.add('stalled'); autoHide.setPlaying(false); } }, 1000); });
    // A 'resumed' while our pause screen is up never came from her: doResume() clears my.paused before it resumes. It
    // is YouTube playing on after a pause it never took (a stall that cleared; review app-v9 S1, QA #20), so pause
    // again and keep the screen. Nothing moves on by itself (spec 4.6, 4.9).
    on('resumed', () => {
      clearTimeout(my.stallTimer); layer.classList.remove('stalled');
      if (my.paused) { my.session.pause(); layer.classList.remove('yt-ad'); onPaused(my, {}); return; }   // the full pause screen
      layer.classList.remove('needs-tap'); playingNow(my);
    });
    on('ended', (d) => onEnded(my, d));   // also YouTube failing in the last 15 s ({nearEnd:true}): watched, never the sleeping card (QA #19)
    on('needs-tap', () => showYouTubeOwn(my));
    // A tap on the playing YouTube video lands on the clear layer: pause through the session, as a touch on TorBox
    // video does; the 'paused' that follows hides the frame and shows our overlay (4.5, 4.6).
    // The pause screen shows at once through doPause(), whether or not YouTube confirms: buffering, it may never
    // answer pauseVideo(), and she must never be left on black with no way back (review app-v8 S1).
    on('shield-tap', () => { if (my.ready && !my.paused && !layer.classList.contains('needs-tap')) { autoHide.guardTaps(); doPause(); } });
    // An ad (4.8): YouTube's own screen with only our back arrow, muted by the player; when it ends, the content
    // plays with its sound back and nothing of ours over it.
    on('ad', (d) => {
      // An ad that starts while she's paused, which she didn't start (her play clears my.paused first): the player's
      // retry reloaded and its pre-roll began by itself (QA #24). Hold it paused and keep our pause screen; the ad
      // waits hidden until her play.
      if (d.active && my.paused) { my.session.pause(); onPaused(my, { ad: true }); return; }
      if (d.active) { showYouTubeOwn(my); layer.classList.add('yt-ad'); return; }
      layer.classList.remove('yt-ad');   // YouTube's own screen stays until the content plays ('ready' or 'resumed', QA #15)
      if (my.paused) onPaused(my, {});   // an ad that ran out under our pause screen: the full screen again
    });
    on('failed-all', (d) => fail(d.reasons || [], my, d));
    on('report', (d) => { if (d.playId && !my.playerPlayId) { my.playerPlayId = d.playId; } const { playId, ...rest } = d; logPlay({ ...rest, playerPlayId: playId }, my); });
  }

  // YouTube's own screen (spec 4.8): its start screen waiting for her tap, or an ad. The toy fades out over 300 ms
  // (no match cut: the content isn't playing yet); only our back arrow shows, in the top band.
  async function showYouTubeOwn(my) {
    clearTimeout(my.toyTimer);
    if (my.toy) {
      toyLayer.style.setProperty('--fade', '300ms'); toyLayer.classList.add('fading');
      await wait(300);
      if (ctx !== my) return;
      my.toy?.destroy(); my.toy = null;
    }
    toyLayer.classList.remove('open', 'fading');
    pauseEl.classList.remove('open'); layer.classList.remove('paused', 'stalled');
    autoHide.setPlaying(false);
    layer.classList.add('needs-tap');
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
    toyLayer.dataset.toy = name;
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
    layer.classList.remove('needs-tap');
    clearTimeout(c.toyTimer);
    if (c.fromKeep) app.speak(titleClip(c));
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
    if (c.paused && c === ctx) setBar(c);
    if (Date.now() - c.lastSave > SAVE_EVERY_MS) { saveProgress(); app.saveUsage(); }
    // A movie set to "pause at the limit" stops here; a series episode always finishes.
    if (onPlaybackTick(app.usage, app.settings, c.item) === 'pause') leave('limit');
  }

  function onPaused(c, d = {}) {
    // Paused in an ad (leaving the app, QA bug 3): YouTube's own screen gives way to our pause screen with play; on
    // play the player carries the ad on and sends 'ad' again, which brings its screen back.
    const inAd = c.item.kind === 'youtube' && (d.ad || c.session?.inAd || layer.classList.contains('yt-ad'));
    layer.classList.remove('needs-tap', 'yt-ad');   // whatever an ad left behind, the pause screen is drawn whole (QA #24)
    layer.classList.toggle('ad-paused', !!inAd);   // QA #14: no ±15 or position bar while an ad waits
    if (c.item.kind === 'youtube' && !c.paused) autoHide.guardTaps();
    c.paused = true;
    autoHide.setPlaying(false);   // paused (4.6): the controls show and stay
    setRail();
    layer.classList.add('paused');
    const v = c.videos;
    const tile = (i, dir) => i < 0 || i >= v.length ? '' :
      `<button class="pause-tile tapable" data-i="${i}" data-dir="${dir}" data-cat="${c.cat}" aria-label="${dir}"><span class="fallback">${CHIP_ART[c.cat] || ''}</span>${v[i].thumbnail ? `<img src="${v[i].thumbnail}" alt="" onerror="this.remove()">` : ''}<span class="pause-arrow">${dir === 'previous' ? ICONS.prev : ICONS.next}</span></button>`;
    rail.querySelector('.pause-tiles').innerHTML = tile(c.index - 1, 'previous') + tile(c.index + 1, 'next');
    rail.querySelector('.pause-pom').innerHTML = pom(app.bedtime ? 'night' : 'day');
    setBar(c);
    if (c.item.kind === 'youtube') {   // the iframe is hidden, never covered; its own still fills the screen
      document.getElementById('kc-yt').style.visibility = 'hidden';
      const still = v[c.index].thumbnail || c.data.title.background || c.data.title.poster || '';
      pauseEl.innerHTML = `<div class="pause-still" style="background-image:url('${still.replace(/'/g, '%27')}')"></div>`;
      pauseEl.classList.add('open');
    }
  }

  function endPause() {
    layer.classList.remove('paused', 'ad-paused');
    rail.querySelector('.pause-tiles').innerHTML = '';
    pauseEl.classList.remove('open'); pauseEl.innerHTML = '';
    document.getElementById('kc-yt').style.visibility = '';
  }


  function doPause() { if (!ctx) return; ctx.session.pause(); if (!ctx.paused) onPaused(ctx); saveProgress(); app.saveUsage(); }
  function doResume() { if (!ctx) return; ctx.paused = false; endPause(); setRail(); playingNow(ctx); ctx.session.resume(); }

  rail.addEventListener('click', (e) => {
    const t = e.target.closest('.pause-tile');
    if (t && ctx) { app.effect('poster'); const c = ctx; saveProgress(); logPlay({ endReason: 'switched' }); start({ data: c.data, videos: c.videos, index: +t.dataset.i, from: t }); }
  });

  rail.addEventListener('pointerdown', () => autoHide.interact());   // touching a control keeps them up
  rail.addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (!b || !ctx || b.disabled) return;
    const r = b.dataset.r;
    if (r === 'back') { app.effect('button'); leave('back'); }
    else if (r === 'toggle') { app.effect('button'); ctx.paused ? doResume() : doPause(); }
    else if ((r === 'back15' || r === 'fwd15') && !layer.classList.contains('ad-paused')) {
      app.effect('tick');
      // From the real position at the tap (QA bug 10): the player's seekBy reads its own clock (or the held target).
      const d = r === 'fwd15' ? 15 : -15;
      const to = typeof ctx.session.seekBy === 'function' ? ctx.session.seekBy(d) : Math.max(0, Math.min((ctx.duration || Infinity) - 1, ctx.position + d));
      if (typeof ctx.session.seekBy !== 'function') ctx.session.seek(to);
      ctx.position = to; ctx.lastPos = to;
      popSkip(d > 0 ? 'fwd' : 'rew');
      if (ctx.paused) setBar(ctx);   // paused, the fill moves at once (YouTube's seek lands on play)
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
    app.go(c.returnTo);
  }

  async function onEnded(c, d = {}) {
    c.position = c.duration || c.position;
    await saveProgress(true);
    if (!isColl(c)) app.usage = recordEpisodeEnd(app.today());   // songs and lessons never count toward a show limit
    const oneStory = app.bedtime && app.settings.bedtime.oneStory;
    if (oneStory) app.usage = { ...app.usage, goodnight: true };
    await app.saveUsage();
    logPlay({ endReason: 'ended', ...(d.nearEnd ? { endedNearEnd: true, [/^yt_/.test(String(d.reason)) ? 'ytError' : 'nearEndReason']: d.reason } : {}) });
    teardown();
    ctx = null; app.playing = false;
    const action = onEpisodeEnd(app.usage, app.settings);
    // Goodbye card: 5 s in the category colour, Pom waving (spec 7).
    overlay.innerHTML = `<div class="goodbye" data-cat="${app.bedtime ? 'bedtime' : c.cat}">
      <button class="round-btn card-back tapable" aria-label="back">${ICONS.back}</button>
      <div class="goodbye-pom pom-pokeable">${pom(app.bedtime ? 'night' : 'day', 'wavel')}</div></div>`;
    overlay.classList.add('open');
    show(false);
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      overlay.classList.remove('open'); overlay.innerHTML = '';
      app.justEnded = action === 'goodbye' && !oneStory ? c.item.videoId : null;
      if (action === 'rest' || oneStory) app.go('#/');   // go() draws it once
      else if (isColl(c)) app.go(COLLECTIONS[c.data.title.id].route);      // its own page, that video checked with "again"
      else app.go(`#/t/${c.data.title.type}/${c.data.title.id}`);
    };
    overlay.querySelector('.card-back').onclick = () => { app.effect('button'); app.sound.stopVoice(); finish(); };
    (async () => { await app.speak(oneStory ? 'ui.goodnight' : 'ui.bye'); if (!done && !oneStory) await app.speak(titleClip(c)); })();
    setTimeout(finish, 5000);
  }

  // Every candidate failed: Pom's sleeping card for 3 s, then the show page (spec 5.6).
  async function fail(reasons, c, verdict = {}) {
    if (c.failed) return;
    c.failed = true;
    const keyProven = !!app.torboxKeyProven;
    const setup = reasons.some(r => isSetupReason(r, { keyProven }));
    if (setup) app.setupHint = reasons.find(r => isSetupReason(r, { keyProven }));
    else if (failureCounts(c.item.kind, { ...verdict, reasons })) {   // a transient YouTube error hides nothing (QA bug 4)
      // A song that fails hides only itself, never the whole Music page.
      const failTitle = isColl(c) ? c.item.videoId : c.data.title.id;
      const label = `${c.data.title.name || ''}${c.item.season != null ? ` S${c.item.season}E${c.item.episode}` : ''}${c.item.episodeTitle ? ` · ${c.item.episodeTitle}` : ''}`.trim();
      app.failed = recordFailure(app.failed, { titleId: failTitle, videoId: c.item.videoId, type: c.data.title.type, label }, reasons, Date.now(), { keyProven });
      await app.store.saveFailed(app.failed);
    }
    logPlay({ endReason: 'failed', failures: reasons }, c);
    if (ctx === c) { teardown(); ctx = null; }
    app.playing = false;
    overlay.innerHTML = `<div class="sleeping-card" data-cat="${app.bedtime ? 'bedtime' : c.cat}"><button class="round-btn card-back tapable" aria-label="back">${ICONS.back}</button><div class="goodbye-pom pom-pokeable">${pom('sleep')}</div></div>`;
    overlay.classList.add('open');
    show(false);
    let skip;
    const skipped = new Promise(r => { skip = r; });
    overlay.querySelector('.card-back').onclick = () => { app.effect('button'); app.sound.stopVoice(); skip(); };
    await Promise.race([Promise.all([app.speak('ui.sleeping').then(() => wait(1000)), wait(3000)]), skipped]);
    overlay.classList.remove('open'); overlay.innerHTML = '';
    // The failed item stays visible this time; from the next session it's hidden (spec 5.6).
    app.go(c.returnTo || `#/t/${c.data.title.type}/${c.data.title.id}`);
  }

  // Straight into the loading moment for one video of a title, no show page on the way; the title clip plays at
  // the hand-off. Keep watching and search episode tiles (spec 4.1, 4.10). Back returns to the launching screen.
  async function playVideo(type, titleId, videoId, from) {
    let data = app.titleReady.get(`${type}/${titleId}`);
    if (!data) { try { data = await app.title(type, titleId); } catch { return; } }
    const index = data.videos.findIndex(v => v.id === videoId);
    if (index < 0) { app.go(`#/t/${type}/${titleId}`); return; }
    start({ data, videos: data.videos, index, from, fromKeep: true });
  }
  // A song from the Music page or search (spec 4.11): straight into the YouTube player, its neighbours in the
  // page's order for next and the pause tiles; the song's title clip at the hand-off.
  function playSong(songId, from) {
    const hid = app.hidden(), key = collectionOf(songId);
    if (!key) return;
    const data = collectionData(key, app.catalogs, { hidden: new Set([...hid.titles, ...hid.videos]) });
    const index = data.videos.findIndex(v => v.id === songId);
    if (index < 0) return;
    start({ data, videos: data.videos, index, from, fromKeep: true });
  }
  function resume(key, from) {
    const p = app.progress.get(key);
    if (p) return playVideo(p.titleType, p.titleId, key, from);
  }

  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) {
      saveProgress(); app.saveUsage();
      if (ctx.item.kind !== 'audio') doPause();      // stories may keep playing (spec 8.3)
    } else if (ctx.item.kind !== 'youtube' && kindOf(ctx.data.title.type) !== 'youtube') wake(true);
  });
  window.addEventListener('pagehide', () => { if (ctx) { saveProgress(); app.saveUsage(); } });

  return { start, resume, playVideo, playSong, itemFor, get active() { return !!ctx; } };
}
