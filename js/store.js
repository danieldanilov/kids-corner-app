// IndexedDB storage on the device: settings, secrets, PIN record, usage, progress, favourites, play log.
const VERSION = 1;
let lastAdded = 0; // strictly increasing, so same-millisecond hearts keep their order

export const DEFAULT_SETTINGS = {
  sounds: { all: true, names: 'quiet', effects: 'quiet', namesLang: 'en-ru' }, // off | quiet | normal; en-ru | en | ru
  motion: 'auto',            // 'auto' follows the iPad, 'reduced', 'normal'
  limits: { dailyMinutes: 0, showsMode: 'off', showsPerDay: 0, movieAtLimit: 'finish' },
  bedtime: { manual: false, start: '', end: '', oneStory: false },
  hidden: [],                // title ids hidden from her
  pinned: [],                // title ids pinned to My shows
  newRow: [],                // titles a parent put in New: {id, type, name, poster, posterShape}
  workerUrl: 'https://resolver.kidscorner-app.workers.dev',
};

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function open(idb, name) {
  return new Promise((res, rej) => {
    const r = idb.open(name, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('favs')) db.createObjectStore('favs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('plays')) db.createObjectStore('plays', { keyPath: 'playId' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function merge(def, val) {
  if (!val || typeof val !== 'object' || Array.isArray(def)) return val ?? def;
  const out = { ...def };
  for (const k of Object.keys(val)) out[k] = def[k] && typeof def[k] === 'object' && !Array.isArray(def[k]) ? merge(def[k], val[k]) : val[k];
  return out;
}

export async function openStore(idb = globalThis.indexedDB, name = 'kids-corner') {
  const db = await open(idb, name);
  const tx = (store, mode = 'readonly') => db.transaction(store, mode).objectStore(store);
  const kvGet = (k) => req(tx('kv').get(k));
  const kvSet = (k, v) => req(tx('kv', 'readwrite').put(v, k));

  return {
    async getSettings() { return merge(structuredClone(DEFAULT_SETTINGS), await kvGet('settings')); },
    saveSettings: (s) => kvSet('settings', s),
    async getSecrets() { return { torrentioConfig: '', appToken: '', ...(await kvGet('secrets')) }; },
    saveSecrets: (s) => kvSet('secrets', { torrentioConfig: s.torrentioConfig || '', appToken: s.appToken || '' }),
    getPin: () => kvGet('pin'),
    savePin: (rec) => kvSet('pin', rec),
    getGateState: async () => (await kvGet('gate')) || { fails: 0, lockedUntil: 0 },
    saveGateState: (s) => kvSet('gate', s),
    getUsage: () => kvGet('usage'),
    saveUsage: (u) => kvSet('usage', u),
    getFailed: async () => (await kvGet('failed')) || {},       // titleId -> {at, reasons}
    saveFailed: (f) => kvSet('failed', f),
    getKV: kvGet, setKV: kvSet,

    putProgress: (p) => req(tx('progress', 'readwrite').put(p)),
    getProgress: (key) => req(tx('progress').get(key)),
    allProgress: () => req(tx('progress').getAll()),

    async toggleFav(t) {
      const cur = await req(tx('favs').get(t.id));
      if (cur) { await req(tx('favs', 'readwrite').delete(t.id)); return false; }
      await req(tx('favs', 'readwrite').put({ id: t.id, type: t.type, name: t.name, poster: t.poster, addedAt: (lastAdded = Math.max(Date.now(), lastAdded + 1)) }));
      return true;
    },
    isFav: async (id) => !!(await req(tx('favs').get(id))),
    allFavs: () => req(tx('favs').getAll()),

    async putPlay(p) {                       // upsert: the player reports once when settled, once at the end
      const cur = await req(tx('plays').get(p.playId));
      return req(tx('plays', 'readwrite').put({ ...(cur || {}), ...p }));
    },
    async allPlays() { return (await req(tx('plays').getAll())).sort((a, b) => b.at - a.at); },
    clearPlays: () => req(tx('plays', 'readwrite').clear()),
  };
}
