// Per-file history for scoring (+50 played well, -100 failed in the last 7 days), kept on the device
// in IndexedDB 'kc-player'. Falls back to memory when storage is blocked (private mode, previews).

const DB = 'kc-player', STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function createLearned() {
  const mem = {};
  let dbp = null;
  try { dbp = typeof indexedDB !== 'undefined' ? openDb() : null; } catch { dbp = null; }
  const ready = (async () => {
    if (!dbp) return;
    try {
      const db = await dbp;
      await new Promise(res => {
        const tx = db.transaction(STORE, 'readonly');
        const cur = tx.objectStore(STORE).openCursor();
        cur.onsuccess = () => { const c = cur.result; if (c) { mem[c.key] = c.value; c.continue(); } else res(); };
        cur.onerror = () => res();
      });
    } catch { dbp = null; }
  })();
  async function put(key, value) {
    mem[key] = value;
    if (!dbp) return;
    try { const db = await dbp; db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key); } catch { /* memory only */ }
  }
  return {
    ready,
    snapshot: () => mem,
    good: key => put(key, { ...(mem[key] || {}), good: Date.now(), failed: undefined }),
    failed: key => put(key, { ...(mem[key] || {}), failed: Date.now() }),
  };
}
