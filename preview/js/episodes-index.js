// Series episode names for search (Boss: "the Bluey one with the xylophone"). Cinemeta metas are fetched in the
// background, two at a time, only while nothing plays and the app is in front; the episode list is kept in
// IndexedDB and refreshed weekly or when the Kids Corner catalog version changes. Search answers on titles at once;
// onProgress hands over the episodes as each show arrives.
import { orderEpisodes } from './data.js';

export const EPISODE_TTL_MS = 7 * 86400000;
export const CRAWL_CONCURRENCY = 2;
const CINEMETA = 'https://v3-cinemeta.strem.io/meta/series/';

// Aired episodes only, judged by the real date (now() is the cache clock, injectable for tests).
const toDocs = (id, meta) => orderEpisodes(meta?.videos || [], new Date()).filter(e => e.title).map(e => ({
  id: e.id, kind: 'episode', type: 'series', name: e.title, parent: id, parentName: meta.name || '',
  season: e.season, episode: e.episode, thumbnail: e.thumbnail,
}));

// store: { get(), set(value) } over IndexedDB (kv 'episodeIndex'): { version, series: { [id]: { at, docs } } }.
export async function crawlEpisodes({ seriesIds, version, fetchJson, store, isBusy = () => false, now = () => Date.now(), onProgress = () => {}, idlePollMs = 2000 }) {
  let saved = (await store.get()) || null;
  if (!saved || saved.version !== version) saved = { version, series: {} };
  const fresh = (id) => saved.series[id] && now() - saved.series[id].at < EPISODE_TTL_MS;
  const all = () => seriesIds.flatMap(id => saved.series[id]?.docs || []);
  const todo = seriesIds.filter(id => /^tt\d+$/.test(id) && !fresh(id));
  if (!todo.length) { onProgress(all()); return all(); }
  const waitIdle = async () => { while (isBusy()) await new Promise(r => setTimeout(r, idlePollMs)); };
  let dirty = 0;
  const failed = [];
  const worker = async (queue) => {
    while (queue.length) {
      await waitIdle();
      const id = queue.shift();
      if (!id) break;   // the other worker took the last show while this one waited for idle
      try {
        const j = await fetchJson(`${CINEMETA}${id}.json`, { cache: 'no-store' });   // kept once, as docs; the service worker skips it
        saved.series[id] = { at: now(), docs: toDocs(id, j.meta) };
        if (++dirty >= 10) { dirty = 0; await store.set(saved); }   // save as it goes, so a closed app keeps its progress
        onProgress(all());
      } catch { if (queue === todo) failed.push(id); /* tried once more at the end; after that, at the next open */ }
    }
  };
  await Promise.all(Array.from({ length: CRAWL_CONCURRENCY }, () => worker(todo)));
  if (failed.length) await Promise.all(Array.from({ length: CRAWL_CONCURRENCY }, () => worker(failed)));
  await store.set(saved);
  onProgress(all());
  return all();
}
