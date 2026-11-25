// Search over Kids Corner's own data only (hard rule 3): titles from the catalogs, YouTube channels' videos and audio
// stories' episodes from the addon's meta files, and series episode names from Cinemeta (episodes-index.js).
// Matching and ranking follow spec v5 4.10: answers as you type; Cyrillic and Latin meet in the middle ("masha"
// finds Маша, "ezhik" finds Ёжик); Hebrew as typed; typos forgiven from three characters.

const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' };

// Lowercase, strip accents and Hebrew points, ё to е, punctuation to spaces, single spaces.
export function normalize(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f\u0591-\u05c7]/g, '').normalize('NFC')
    .replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Cyrillic to Latin per spec v5 (х as kh); other characters stay as they are.
export function toLatin(s) {
  return [...String(s ?? '').toLowerCase()].map(c => CYR[c] ?? c).join('');
}

// A looser Latin form, so the usual alternatives for one Russian sound meet: kh/h, iy/i, j/y, w/v.
const loose = (s) => s.replace(/kh/g, 'h').replace(/iy|yi|ij/g, 'i').replace(/j/g, 'y').replace(/ck/g, 'k').replace(/w/g, 'v');

// Every written form of a text: as written, in Latin, and in loose Latin.
function forms(text) {
  const n = normalize(text);
  const out = new Set([n, normalize(toLatin(n)), loose(normalize(toLatin(n)))]);
  return [...out].filter(Boolean).map(f => ({ f, words: f.split(' ') }));
}

// Optimal string alignment distance (swapped neighbours count as one edit), banded: gives up past k.
function osa(a, b, k) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > k) return k + 1;
  let prev2 = null, prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      if (prev2 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > k) return k + 1;
    prev2 = prev; prev = cur;
  }
  return prev[n];
}

// A query word within one edit (two for 7+ letters) of the start of a title word.
function typoMatch(w, t) {
  const k = w.length >= 7 ? 2 : 1;
  if (t.length < w.length - k) return false;
  for (const L of [w.length - 1, w.length, w.length + 1]) if (L > 0 && osa(w, t.slice(0, L), k) <= k) return true;
  return false;
}

// Titles first, then episodes (of shows and stories), then channel videos.
const KIND_RANK = { title: 0, episode: 1, video: 2 };

// The index: each entry keeps its written forms; a vocabulary maps every word (of the entry's own name and, for an
// episode or video, its show's name) to the entries that hold it, so word matching, typos included, runs once per
// distinct word instead of once per entry. Forms are cached per document, so rebuilding as episodes arrive is cheap.
const formCache = new WeakMap();
const formsOf = (d) => {
  let c = formCache.get(d);
  if (!c) { c = { f: forms(d.name), pf: d.parentName ? forms(d.parentName) : [] }; formCache.set(d, c); }
  return c;
};
export function buildIndex(docs) {
  const index = docs.map(d => ({ ...d, ...formsOf(d) }));
  const vocab = new Map();
  index.forEach((e, i) => {
    for (const { words } of [...e.f, ...e.pf]) for (const w of words) {
      let list = vocab.get(w);
      if (!list) vocab.set(w, list = []);
      if (list[list.length - 1] !== i) list.push(i);
    }
  });
  Object.defineProperty(index, 'vocab', { value: vocab, enumerable: false });
  return index;
}

// Entries in which every query word matches some word (own or show's), by the given word test.
function everyWord(index, qw, test) {
  const n = index.length, count = new Uint16Array(n);
  qw.forEach((w, k) => {
    const seen = new Uint8Array(n);
    for (const [t, list] of index.vocab) if (test(w, t)) for (const i of list) if (!seen[i]) { seen[i] = 1; if (count[i] === k) count[i]++; }
  });
  const out = [];
  for (let i = 0; i < n; i++) if (count[i] === qw.length) out.push(i);
  return out;
}

// Tiers (spec v5): 100 the whole name starts with the query; 80 every query word starts a word (for episodes and
// videos, of the episode or of its show, so "bluey xylophone" works); 60 the query inside the name (3+ characters);
// 40 typo matches (3+ characters). One or two characters need 80 or more. Then titles before episodes, shorter first.
export function search(index, query, { limit = 200 } = {}) {
  const q0 = normalize(query);
  if (!q0) return [];
  if (!index.vocab) index = buildIndex(index);
  const short = q0.replace(/ /g, '').length < 3;
  const score = new Uint8Array(index.length);
  const raise = (i, s) => { if (score[i] < s) score[i] = s; };
  for (const q of forms(q0).map(x => x.f)) {
    const qw = q.split(' ');
    index.forEach((e, i) => { for (const { f } of e.f) { if (f.startsWith(q)) { raise(i, 100); break; } if (f.includes(q)) raise(i, 60); } });
    for (const i of everyWord(index, qw, (w, t) => t.startsWith(w))) raise(i, 80);
    if (!short) for (const i of everyWord(index, qw, (w, t) => (w.length < 3 ? t.startsWith(w) : t.startsWith(w) || typoMatch(w, t)))) raise(i, 40);
  }
  const out = [];
  score.forEach((s, i) => { if (s >= (short ? 80 : 40)) out.push(i); });
  out.sort((a, b) => score[b] - score[a] || KIND_RANK[index[a].kind] - KIND_RANK[index[b].kind] || index[a].name.length - index[b].name.length);
  return out.slice(0, limit).map(i => { const { f, pf, ...r } = index[i]; return { ...r, score: score[i] }; });
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
// the service worker caches these JSON files, which the channel and story pages read too). Two at a time, and only
// while nothing plays and the app is in front, like the series crawl. A file that fails is skipped.
const ADDON = 'https://danieldanilov.github.io/kids-stremio-catalog/';
export const META_CONCURRENCY = 2;
export async function loadSearchDocs(catalogs, { fetchJson, isBusy = () => false, idlePollMs = 2000 }) {
  const titles = docsFromCatalogs(catalogs);
  const todo = titles.filter(t => t.type === 'YouTube' || t.type === 'Audio');
  const lists = [];
  const worker = async () => {
    while (todo.length) {
      while (isBusy()) await new Promise(r => setTimeout(r, idlePollMs));
      const t = todo.shift();
      if (!t) break;
      lists.push(await fetchJson(`${ADDON}meta/${encodeURIComponent(t.type)}/${encodeURIComponent(t.id)}.json`).then(j => docsFromMeta(j.meta)).catch(() => []));
    }
  };
  await Promise.all(Array.from({ length: META_CONCURRENCY }, worker));
  return [...titles, ...lists.flat()];
}

// The search screen's groups (spec v5 4.10), in this order; a group with no match is absent; at most 30 each, best
// first. Hidden titles, their episodes and hidden videos are left out. An episode or video shows its show's tile,
// so one whose show isn't in the catalogs any more is left out too.
export const SEARCH_GROUPS = [
  { type: 'series', label: 'Shows', cat: 'shows' },
  { type: 'movie', label: 'Movies', cat: 'movies' },
  { type: 'YouTube', label: 'YouTube', cat: 'youtube' },
  { type: 'Audio', label: 'Stories', cat: 'stories' },
];
export function groupResults(hits, { hidden, metaOf, perGroup = 30 }) {
  const groups = SEARCH_GROUPS.map(g => ({ ...g, items: [] }));
  const byType = Object.fromEntries(groups.map(g => [g.type, g]));
  for (const hit of hits) {
    const g = byType[hit.type];
    if (!g || g.items.length >= perGroup) continue;
    const titleId = hit.kind === 'title' ? hit.id : hit.parent;
    if (!titleId || hidden.titles.has(titleId) || hidden.videos.has(hit.id)) continue;
    const meta = metaOf(titleId) || (hit.kind === 'title' ? hit : null);
    if (!meta) continue;
    g.items.push({ hit, meta });
  }
  return groups.filter(g => g.items.length);
}
