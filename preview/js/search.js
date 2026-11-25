// Search over Kids Corner's own data only (hard rule 3): titles from the catalogs, plus YouTube channels' videos and
// audio stories' episodes from the addon's meta files. Answers as you type (prefix match on every word), across
// English, Russian and Hebrew, and reads Cyrillic in Latin so "masha" finds Маша. The index is plain data, built
// in memory from JSON the service worker already caches.

const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' };

// Lowercase, strip accents and Hebrew points, ё to е, punctuation to spaces, single spaces.
export function normalize(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-֑ͯ-ׇ]/g, '').normalize('NFC')
    .replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Cyrillic to the Latin people type (х as h, not kh); other characters stay as they are.
export function toLatin(s) {
  return [...String(s ?? '').toLowerCase()].map(c => CYR[c] ?? c).join('');
}

// A looser Latin form for matching: the common alternatives typed for the same Russian sound fold together.
const loose = (s) => s.replace(/kh/g, 'h').replace(/iy|yi|ij/g, 'i').replace(/j/g, 'y').replace(/ck/g, 'k').replace(/w/g, 'v');

function keysOf(text) {
  const n = normalize(text);
  const latin = loose(normalize(toLatin(n)));
  const words = new Set([...n.split(' '), ...latin.split(' ')].filter(Boolean));
  return { words: [...words], compact: [n.replace(/ /g, ''), latin.replace(/ /g, '')] };
}

// Titles first, then episodes (of shows and stories), then channel videos.
const KIND_RANK = { title: 0, episode: 1, video: 1.3 };

export function buildIndex(docs) {
  return docs.map(d => ({ ...d, keys: keysOf(d.name), parentKeys: d.parentName ? keysOf(d.parentName) : null }));
}

// Each query word must start a word of the item (or of its channel/podcast, for videos and episodes), or appear
// inside the run-together name. Ranked: a title that starts with the query, then word-start matches, then the
// rest; titles before videos and episodes; shorter names first.
export function search(index, query, { limit = 60 } = {}) {
  const q = normalize(query);
  if (!q) return [];
  const qWords = [...new Set([...q.split(' '), ...loose(normalize(toLatin(q))).split(' ')])].filter(Boolean);
  const qLatin = loose(normalize(toLatin(q))).split(' ').filter(Boolean);
  const qOwn = q.split(' ');
  const out = [];
  for (const d of index) {
    let score = 0;
    const words = d.parentKeys ? [...d.keys.words, ...d.parentKeys.words] : d.keys.words;
    const matchWordSet = (set) => set.every(w => words.some(x => x.startsWith(w)) || d.keys.compact.some(c => c.includes(w)));
    if (!(matchWordSet(qOwn) || matchWordSet(qLatin))) continue;
    const own = d.keys.compact[0], lat = d.keys.compact[1], qc = q.replace(/ /g, ''), qlc = qLatin.join('');
    if (own.startsWith(qc) || lat.startsWith(qlc)) score += 100;
    if (qWords.every(w => words.some(x => x.startsWith(w)))) score += 40;   // every word starts a word of the item or its show
    score -= KIND_RANK[d.kind] * 60;
    score -= Math.min(30, d.name.length / 4);
    out.push({ ...d, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map(({ keys, parentKeys, ...r }) => r);
}

// Titles from the catalogs, each once (the first catalog it appears in decides its type).
export function docsFromCatalogs(catalogs) {
  const seen = new Set(), docs = [];
  for (const list of Object.values(catalogs || {})) for (const m of list || []) {
    if (!m?.id || seen.has(m.id) || !m.name) continue;
    seen.add(m.id);
    docs.push({ id: m.id, kind: 'title', type: m.type, name: m.name, poster: m.poster, posterShape: m.posterShape });
  }
  return docs;
}

// A YouTube channel's videos or an audio story's episodes, from its meta file.
export function docsFromMeta(meta) {
  if (!meta?.videos) return [];
  const kind = meta.type === 'Audio' ? 'episode' : 'video';
  return meta.videos.filter(v => v?.id && (v.title || v.name)).map(v => ({
    id: v.id, kind, type: meta.type, name: v.title || v.name, thumbnail: v.thumbnail, parent: meta.id, parentName: meta.name,
  }));
}

// Everything search covers: catalog titles, then each YouTube channel's and audio story's meta file (addon only;
// the service worker caches these JSON files). A file that fails is skipped; search still answers for the rest.
const ADDON = 'https://danieldanilov.github.io/kids-stremio-catalog/';
export async function loadSearchDocs(catalogs, { fetchJson }) {
  const titles = docsFromCatalogs(catalogs);
  const parents = titles.filter(t => t.type === 'YouTube' || t.type === 'Audio');
  const lists = await Promise.all(parents.map(t => fetchJson(`${ADDON}meta/${encodeURIComponent(t.type)}/${encodeURIComponent(t.id)}.json`)
    .then(j => docsFromMeta(j.meta)).catch(() => [])));
  return [...titles, ...lists.flat()];
}
