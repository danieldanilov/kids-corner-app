// Kids Corner app: boot, state, routing. Screens live in views.js, the player flow in playui.js,
// the grown-up gate and parent screen in parent.js.
import { openStore } from './store.js';
import { ALL_ROWS, loadCatalogs, homeCategories, languageOf, loadTitle, loadStream, defaultFetchJson, titleOrder } from './data.js';
import { migrateFailures, rollUsage, todayKey, hiddenByFailure, bedtimeWanted, applyBedtime, needsHowMany, canStart, updateSeen, youtubeHostFor } from './rules.js';
import { guardConsole, secretValues, urlCarriesSecret } from './secrets.js';
import { createSound } from './sound.js';
import { createPlayback } from './playback.js';
import { renderHome, renderCategory, renderTitle, renderRest, renderGoodnight, renderHowMany, renderSearch, runSearch } from './views.js';
import { createPlayUI } from './playui.js';
import { renderParent, openGate } from './parent.js';
import { buildIndex, search as searchIndex, loadSearchDocs, docsFromCatalogs } from './search.js';
import { crawlEpisodes } from './episodes-index.js';

const $ = (s, r = document) => r.querySelector(s);

export const app = {
  store: null, sound: null, player: null, playui: null,
  settings: null, usage: null, favs: [], progress: new Map(), failed: {}, catalogs: {}, home: {},
  bedtime: false, playing: false, justEnded: null, parentOpen: false, rowPages: {},
  metaCache: new Map(), streamCache: new Map(), titleReady: new Map(), streamReady: new Map(),
};

let secretList = [];   // only for redaction; never rendered, logged or put in a URL
export const setSecretList = (s) => { secretList = secretValues(s); };
guardConsole(console, () => secretList);

app.reduced = () => app.settings.motion === 'reduced' || (app.settings.motion !== 'normal' && matchMedia('(prefers-reduced-motion: reduce)').matches);

app.hidden = () => {
  const f = hiddenByFailure(app.failed);
  return { titles: new Set([...app.settings.hidden, ...f.titles]), videos: f.videos, failedTitles: f.titles };
};

app.saveSettings = async (s) => {
  app.settings = s;
  await app.store.saveSettings(s);
  applyLook();
};

app.saveUsage = async () => { await app.store.saveUsage(app.usage); };
app.today = () => { app.usage = rollUsage(app.usage, todayKey()); return app.usage; };

app.title = async (type, id) => {
  const k = type + '/' + id;
  if (!app.metaCache.has(k)) app.metaCache.set(k, loadTitle(type, id).then((v) => { app.titleReady.set(k, v); return v; }).catch((e) => { app.metaCache.delete(k); throw e; }));
  return app.metaCache.get(k);
};
app.stream = async (type, videoId) => {
  const k = type + '/' + videoId;
  if (!app.streamCache.has(k)) app.streamCache.set(k, loadStream(type, videoId).then((v) => { app.streamReady.set(k, v); return v; }).catch((e) => { app.streamCache.delete(k); throw e; }));
  return app.streamCache.get(k);
};
app.langOf = (id) => languageOf(id, app.catalogs);
app.catOf = (id) => app.home[id] || null;

app.speak = (key) => app.sound.say(key);
app.effect = (name) => app.sound.effect(name);

function applyLook() {
  const root = document.documentElement;
  root.dataset.theme = app.bedtime ? 'bedtime' : app.settings.theme === 'light' ? 'light' : 'dark';   // dark unless the grown-up chose Light
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', app.bedtime ? '#15111A' : app.settings.theme === 'light' ? '#FFF7EA' : '#1A1830');
  root.dataset.motion = app.reduced() ? 'reduced' : 'normal';
  app.sound?.configure(app.settings.sounds, app.bedtime);
}

// Bedtime switches only at a boundary (nothing playing). Announced if she's on home.
app.checkBedtime = () => {
  const want = bedtimeWanted(app.settings);
  const next = applyBedtime(app.bedtime, want, { playing: app.playing });
  if (next === app.bedtime) return false;
  app.bedtime = next;
  applyLook();
  return true;
};

// ---------- one gesture, one level (QA bug 8) ----------
// Back and the house sit in the same spot on every screen, so the second tap of a double tap would land on the next
// screen's house. A back or house tap within 600 ms of the last one is swallowed.
const NAV_SEL = '.home-btn, .rail-btn[data-r="back"], .card-back, .toy-back, .gate-home';
let navUntil = 0;
window.addEventListener('click', (e) => {
  if (!e.target.closest?.(NAV_SEL)) return;
  const now = performance.now();
  if (now < navUntil) { e.stopPropagation(); e.preventDefault(); return; }
  navUntil = now + 600;
}, true);

// ---------- routing ----------
app.go = (hash) => {
  if (urlCarriesSecret(hash, secretList)) return;     // belt and braces: never put a secret in the URL
  if (location.hash === hash) render(); else location.hash = hash;
};

let renderToken = 0;
async function render() {
  // A deferred update applies when she's back on home (the show page after an episode keeps its "again").
  if (app.updateReady && (location.hash || '#/') === '#/' && app.safeToReload()) { app.maybeReload(); return; }
  const token = ++renderToken;
  const view = $('#view');
  const h = location.hash || '#/';
  const parts = h.slice(2).split('/').map(decodeURIComponent);
  const switched = app.checkBedtime();
  if (parts[0] === 'grownups') {
    if (!app.parentOpen) { app.go('#/'); return; }
    return renderParent(view, app);
  }
  app.parentOpen = false;
  const u = app.today();
  if (app.settings.bedtime.oneStory && app.bedtime && u.goodnight) return renderGoodnight(view, app);
  if (!canStart(u, app.settings)) return renderRest(view, app);
  if (token !== renderToken) return;
  if (parts[0] === 'c' && parts[1] === 'music' && app.bedtime) history.replaceState(null, '', '#/');   // Music is hidden at bedtime (spec 4.11)
  else if (parts[0] === 'c' && parts[1]) return renderCategory(view, app, parts[1]);
  if (parts[0] === 't' && parts[1] === 'Music') { app.go(app.bedtime ? '#/' : '#/c/music'); return; }   // a song has no page of its own
  if (parts[0] === 't' && parts[1] && parts[2]) return renderTitle(view, app, parts[1], parts[2]);
  if (parts[0] === 's') {
    if (!app.bedtime) return renderSearch(view, app);      // already open (the magnifier's tap, or back from the player): kept as it is
    history.replaceState(null, '', '#/');                   // search is hidden in bedtime (spec 4.10)
  }
  await renderHome(view, app, { announceBedtime: switched && app.bedtime });
  if (needsHowMany(u, app.settings) && !app.howManyAsked) { app.howManyAsked = true; renderHowMany(app); }
}
app.render = render;

// ---------- updates: a new build lands on the next open ----------
// The new service worker skips waiting and claims this page; when it takes over, the page reloads once, but only
// when nothing is playing and no card, toy, gate or parent screen is open. Otherwise at the next safe moment
// (back on home after the video, for example). Opening the app, or bringing it back from the background, checks.
app.updateReady = false;
app.safeToReload = () => !app.playing && !app.playui?.active && !app.parentOpen
  && !document.getElementById('overlay')?.classList.contains('open') && !document.getElementById('toy-layer')?.classList.contains('open');
app.maybeReload = () => { if (app.updateReady && app.safeToReload()) { app.updateReady = false; location.reload(); } };

function setupUpdates() {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;            // the first install: this page is already the newest build
    app.updateReady = true;
    app.maybeReload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}

// ---------- boot ----------
async function boot() {
  app.preview = location.pathname.includes('/preview/');
  app.store = await openStore(indexedDB, app.preview ? 'kids-corner-preview' : 'kids-corner');   // never April's live data
  app.settings = await app.store.getSettings();
  // v1 ships without "how many shows" and daily time (no child-facing design yet): both stay off.
  app.settings.limits = { ...app.settings.limits, dailyMinutes: 0, showsMode: 'off', showsPerDay: 0 };
  app.usage = rollUsage(await app.store.getUsage(), todayKey());
  app.failed = await app.store.getFailed();
  if (!(await app.store.getKV('failuresV2'))) { app.failed = migrateFailures(app.failed); await app.store.saveFailed(app.failed); await app.store.setKV('failuresV2', true); }   // QA bug 4
  app.favs = await app.store.allFavs();
  for (const p of await app.store.allProgress()) app.progress.set(p.key, p);
  const secrets = await app.store.getSecrets();
  setSecretList(secrets);
  app.bedtime = bedtimeWanted(app.settings);
  applyLook();

  app.sound = createSound();
  app.sound.configure(app.settings.sounds, app.bedtime);
  app.sound.loadIndex();

  let fake = null;
  try { const f = localStorage.getItem('kcFakePlayer'); if (f) fake = JSON.parse(f); } catch { /* storage blocked */ }
  app.player = await createPlayback({
    video: $('#kc-video'), ytContainer: $('#kc-yt'), audio: $('#kc-audio'),
    workerUrl: app.settings.workerUrl,
    getSecrets: () => app.store.getSecrets(),
    lang: 'en', fake,
    options: { youtubeHost: youtubeHostFor(app.settings) },
  });
  app.playui = createPlayUI(app);

  // Her first tap anywhere: start the AudioContext and unlock the persistent <video> (spec 2.5, P §2).
  const unlock = () => {
    app.sound.unlock();
    try { app.player.unlock(); } catch { /* player decides */ }
    document.removeEventListener('pointerdown', unlock, true);
  };
  document.addEventListener('pointerdown', unlock, true);

  // Tap feedback on pointerdown (spec 11).
  document.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('.tapable');
    if (!t) return;
    t.classList.add('pressed');
    const up = () => { t.classList.remove('pressed'); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  });

  // A Pom that isn't a button (shelf end, goodbye, sleeping card) still answers a tap: a small silent wave.
  document.addEventListener('pointerdown', (e) => {
    const svg = e.target.closest('.pom-pokeable')?.querySelector('svg.pom');
    if (!svg) return;
    svg.classList.remove('wave'); void svg.getBoundingClientRect(); svg.classList.add('wave');
    clearTimeout(svg._w); svg._w = setTimeout(() => svg.classList.remove('wave'), 950);
  });

  // Grown-up lock: hold, then PIN. Works from any screen that shows it.
  document.addEventListener('pointerdown', (e) => { const l = e.target.closest('.lock'); if (l) openGate(app, l); });

  window.addEventListener('hashchange', render);
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', applyLook);
  setInterval(() => { if (!app.playing && app.checkBedtime()) render(); }, 30000);

  try {
    const loaded = await loadCatalogs(ALL_ROWS, { fetchJson: defaultFetchJson });
    app.catalogs = loaded;
    // A title's home category is stored the first time it's seen and never changes, so its toy never changes.
    const stored = (await app.store.getKV('homeCats')) || {};
    app.home = { ...homeCategories(loaded), ...stored };
    if (Object.keys(app.home).length !== Object.keys(stored).length) await app.store.setKV('homeCats', app.home);
    // Which titles are new: the first run is the baseline; later arrivals keep their first-seen time.
    app.catalogOrder = titleOrder(loaded);   // songs never count as new titles
    const seenBefore = await app.store.getKV('seen');
    if (app.catalogOrder.length) { app.seen = updateSeen(seenBefore, app.catalogOrder); await app.store.setKV('seen', app.seen); }
    else app.seen = seenBefore || {};
  } catch { /* offline: rows come up empty */ }

  if (navigator.storage?.persist) navigator.storage.persist().then((ok) => { app.persisted = ok; }).catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) setupUpdates();
  document.documentElement.classList.add('ready');
  render();
  scheduleSearchIndex();
}

// ---------- search index (spec 4.10) ----------
// Titles, channel videos and story episodes load once the app has been idle a few seconds, or at once when she
// opens search; series episode names follow in the background, two shows at a time, paused whenever something
// plays or the app is in the background. An open search screen refreshes its results as more arrives.
app.searchIndex = buildIndex([]);
app.search = (q, opts) => searchIndex(app.searchIndex, q, opts);
let indexStarted = false, indexTimer = null;
function setIndex(docs) {
  app.searchIndex = buildIndex(docs);
  const view = $('#view');
  if (view.querySelector('#sq')?.value.trim()) runSearch(view, app, { refresh: true });
}
async function loadIndex() {
  if (indexStarted) return;
  if (app.playing || document.hidden) { indexTimer = setTimeout(() => loadIndex().catch(() => {}), 5000); return; }
  indexStarted = true; clearTimeout(indexTimer);
  const docs = await loadSearchDocs(app.catalogs, { fetchJson: defaultFetchJson, isBusy: () => app.playing || document.hidden });
  setIndex(docs);
  const version = (await defaultFetchJson('https://danieldanilov.github.io/kids-stremio-catalog/manifest.json').catch(() => ({}))).version || 'unknown';
  const seriesIds = [...new Set(Object.entries(app.catalogs).filter(([k]) => k.startsWith('series/')).flatMap(([, list]) => (list || []).map(m => m.id)))];
  let pending = null, rebuildTimer = null;
  const rebuild = () => { rebuildTimer = null; if (pending) { setIndex([...docs, ...pending]); pending = null; } };
  await crawlEpisodes({
    seriesIds, version, fetchJson: defaultFetchJson,
    store: { get: () => app.store.getKV('episodeIndex'), set: (v) => app.store.setKV('episodeIndex', v) },
    isBusy: () => app.playing || document.hidden,
    onProgress: (eps) => { pending = eps; if (!rebuildTimer) rebuildTimer = setTimeout(rebuild, 3000); },   // rebuild at most every 3 s
  });
  clearTimeout(rebuildTimer); rebuild();
  app.searchReady = true;
}
function scheduleSearchIndex() {
  let delay = 8000;
  try { delay = +localStorage.getItem('kcIndexDelay') || delay; } catch { /* default */ }
  indexTimer = setTimeout(() => loadIndex().catch(() => {}), delay);
}
// Opening search: titles answer at once from the catalogs already in memory, and the full load starts now.
app.ensureSearchIndex = () => {
  if (!app.searchIndex.length) app.searchIndex = buildIndex(docsFromCatalogs(app.catalogs));
  if (!indexStarted) loadIndex().catch(() => {});
};

boot();
