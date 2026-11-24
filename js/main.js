// Kids Corner app: boot, state, routing. Screens live in views.js, the player flow in playui.js,
// the grown-up gate and parent screen in parent.js.
import { openStore } from './store.js';
import { ALL_ROWS, loadCatalogs, homeCategories, languageOf, loadTitle, loadStream, defaultFetchJson } from './data.js';
import { rollUsage, todayKey, hiddenByFailure, bedtimeWanted, applyBedtime, needsHowMany, canStart } from './rules.js';
import { guardConsole, secretValues, urlCarriesSecret } from './secrets.js';
import { createSound } from './sound.js';
import { createPlayback } from './playback.js';
import { renderHome, renderCategory, renderTitle, renderRest, renderGoodnight, renderHowMany } from './views.js';
import { createPlayUI } from './playui.js';
import { renderParent, openGate } from './parent.js';

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
  root.dataset.theme = app.bedtime ? 'bedtime' : 'day';
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

// ---------- routing ----------
app.go = (hash) => {
  if (urlCarriesSecret(hash, secretList)) return;     // belt and braces: never put a secret in the URL
  if (location.hash === hash) render(); else location.hash = hash;
};

let renderToken = 0;
async function render() {
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
  if (parts[0] === 'c' && parts[1]) return renderCategory(view, app, parts[1]);
  if (parts[0] === 't' && parts[1] && parts[2]) return renderTitle(view, app, parts[1], parts[2]);
  await renderHome(view, app, { announceBedtime: switched && app.bedtime });
  if (needsHowMany(u, app.settings) && !app.howManyAsked) { app.howManyAsked = true; renderHowMany(app); }
}
app.render = render;

// ---------- boot ----------
async function boot() {
  app.store = await openStore();
  app.settings = await app.store.getSettings();
  // v1 ships without "how many shows" and daily time (no child-facing design yet): both stay off.
  app.settings.limits = { ...app.settings.limits, dailyMinutes: 0, showsMode: 'off', showsPerDay: 0 };
  app.usage = rollUsage(await app.store.getUsage(), todayKey());
  app.failed = await app.store.getFailed();
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
  } catch { /* offline: rows come up empty */ }

  if (navigator.storage?.persist) navigator.storage.persist().then((ok) => { app.persisted = ok; }).catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  document.documentElement.classList.add('ready');
  render();
}

boot();
