// Kids Corner data: only the published Kids Corner addon, plus Cinemeta meta for movies and series.
export const ADDON = 'https://danieldanilov.github.io/kids-stremio-catalog/';
export const CINEMETA = 'https://v3-cinemeta.strem.io/';

// The seven approved chips. Each row is one of the addon's own catalogs.
// lang: the audio language a title in that row should play in.

// Collections (spec 4.11, 4.12): Music and Learn's subjects, each fed only by its own Kids Corner catalogs, in this
// order, each row's English name for its divider. Items are YouTube videos with ids <prefix><videoId>.
export const COLLECTIONS = {
  music: { type: 'Music', prefix: 'kc.music.', clip: 'music', cat: 'music', label: 'Music', route: '#/c/music', rows: [
    { type: 'Music', id: 'music.favourites', label: 'Favourites' },
    { type: 'Music', id: 'music.kpop-demon-hunters', label: 'KPop Demon Hunters' },
    { type: 'Music', id: 'music.disney', label: 'Disney' },
    { type: 'Music', id: 'music.super-simple', label: 'Super Simple Songs & Scratch Garden' },
    { type: 'Music', id: 'music.russian', label: 'По-русски' },
    { type: 'Music', id: 'music.holidays', label: 'Christmas & New Year' },
  ] },
  draw: { type: 'Drawing', prefix: 'kc.draw.', clip: 'drawing', cat: 'learn', label: 'Drawing', icon: 'draw', route: '#/c/learn/draw', rows: [
    { type: 'Drawing', id: 'draw.first-shapes', label: 'First lines and shapes' },
    { type: 'Drawing', id: 'draw.easy-animals', label: 'Easy animals' },
    { type: 'Drawing', id: 'draw.things', label: 'Food, flowers and things that go' },
    { type: 'Drawing', id: 'draw.letters', label: 'Draw with letters and numbers' },
    { type: 'Drawing', id: 'draw.characters', label: 'Characters she knows' },
    { type: 'Drawing', id: 'draw.holidays', label: 'Christmas and New Year' },
    { type: 'Drawing', id: 'draw.ru-first', label: 'По-русски: first drawings' },
    { type: 'Drawing', id: 'draw.ru-animals', label: 'По-русски: animals and cars' },
  ] },
  piano: { type: 'Piano', prefix: 'kc.piano.', clip: 'piano', cat: 'learn', label: 'Piano', icon: 'piano', route: '#/c/learn/piano', rows: [
    { type: 'Piano', id: 'piano.first-steps', label: 'Meet the keyboard' },
    { type: 'Piano', id: 'piano.sing-notes', label: 'Sing the notes' },
    { type: 'Piano', id: 'piano.first-notes', label: 'First notes' },
    { type: 'Piano', id: 'piano.high-low-loud-soft', label: 'High and low, loud and soft' },
    { type: 'Piano', id: 'piano.rhythm', label: 'Rhythm and clapping' },
    { type: 'Piano', id: 'piano.first-songs', label: 'First songs' },
    { type: 'Piano', id: 'piano.ru-first-steps', label: 'In Russian: meet the music' },
    { type: 'Piano', id: 'piano.ru-notes', label: 'In Russian: first notes' },
    { type: 'Piano', id: 'piano.ru-rhythm', label: 'In Russian: rhythm' },
    { type: 'Piano', id: 'piano.ru-first-songs', label: 'In Russian: first songs' },
    { type: 'Piano', id: 'piano.ru-cartoons', label: 'Cartoons about music' },
  ] },
};
// Learn's doors, in order: a new subject is one more entry here and in COLLECTIONS.
export const SUBJECTS = ['draw', 'piano'];
export const COLLECTION_TYPES = new Set(Object.values(COLLECTIONS).map(c => c.type));
export const collectionOf = (id) => Object.keys(COLLECTIONS).find(k => String(id).startsWith(COLLECTIONS[k].prefix)) || null;
export const isCollectionId = (id) => collectionOf(id) !== null;

export const CATEGORIES = [
  { id: 'shows', label: 'Shows', rows: [{ type: 'series', id: 'shows' }, { type: 'series', id: 'streaming' }] },
  { id: 'movies', label: 'Movies', rows: [{ type: 'movie', id: 'movies' }, { type: 'movie', id: 'streaming' }] },
  { id: 'bedtime', label: 'Bedtime', rows: [{ type: 'series', id: 'bedtime' }, { type: 'Audio', id: 'bedtime' }, { type: 'YouTube', id: 'bedtime' }] },
  { id: 'youtube', label: 'YouTube', rows: [{ type: 'YouTube', id: 'shows' }, { type: 'YouTube', id: 'songs' }, { type: 'YouTube', id: 'learning' }, { type: 'YouTube', id: 'read-aloud' }, { type: 'YouTube', id: 'hebrew' }] },
  { id: 'music', label: 'Music', music: true, rows: COLLECTIONS.music.rows },
  { id: 'stories', label: 'Stories', rows: [{ type: 'Audio', id: 'stories' }, { type: 'movie', id: 'stories' }] },
  { id: 'russian', label: 'По-русски', lang: 'ru', rows: [{ type: 'series', id: 'ru-series' }, { type: 'movie', id: 'ru-movies' }, { type: 'YouTube', id: 'russian' }] },
  { id: 'british', label: 'British', rows: [{ type: 'series', id: 'british' }, { type: 'movie', id: 'british' }] },
  // Learn (spec 4.12): the ninth chip, doors to its subjects; their catalogs load with the rest.
  { id: 'learn', label: 'Learn', learn: true, rows: SUBJECTS.flatMap(k => COLLECTIONS[k].rows) },
];

// Bedtime home rows (spec 8.1), always in this order.
export const BEDTIME_ROWS = [
  { key: 'stories', sign: 'row.stories', type: 'Audio', id: 'bedtime' },
  { key: 'sleepyshows', sign: 'row.sleepyshows', type: 'series', id: 'bedtime' },
  { key: 'sleepyvideos', sign: 'row.sleepyvideos', type: 'YouTube', id: 'bedtime' },
];

// Every catalog the app reads, once each.
export const ALL_ROWS = [...new Map([...CATEGORIES.flatMap(c => c.rows), ...BEDTIME_ROWS].map(r => [`${r.type}/${r.id}`, { type: r.type, id: r.id }])).values()];

// Category shelves keep same types together: shows, films, channels, podcasts.
export const TYPE_ORDER = ['series', 'movie', 'YouTube', 'Audio'];

// A title's home category is the first chip it belongs to, in chip order: it fixes its toy and colour.
export function homeCategories(catalogs) {
  const home = {};
  for (const c of CATEGORIES) for (const r of c.rows) for (const m of catalogs[`${r.type}/${r.id}`] || []) if (m?.id && !home[m.id]) home[m.id] = c.id;
  return home;
}

// Russian rows ask for Russian audio wherever the title shows up.
export function languageOf(titleId, catalogs) {
  const ru = CATEGORIES.find(c => c.id === 'russian');
  return ru.rows.some(r => (catalogs[`${r.type}/${r.id}`] || []).some(m => m.id === titleId)) ? 'ru' : 'en';
}

const CINEMETA_TYPES = new Set(['movie', 'series']);

export const catalogUrl = (type, id) => `${ADDON}catalog/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
export const metaUrl = (type, id) => CINEMETA_TYPES.has(type) && /^tt\d+$/.test(id)
  ? `${CINEMETA}meta/${type}/${id}.json`
  : `${ADDON}meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
export const streamUrl = (type, id) => `${ADDON}stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;

// Anything from the addon, and only meta from Cinemeta (never its catalogs).
export function isAllowedDataUrl(u) {
  if (typeof u !== 'string') return false;
  if (u.startsWith(ADDON)) return true;
  return u.startsWith(CINEMETA + 'meta/movie/') || u.startsWith(CINEMETA + 'meta/series/');
}

// cache: 'no-store' also tells the service worker to leave the response out of its data cache (the search crawl).
export async function defaultFetchJson(url, { timeoutMs = 12000, cache } = {}) {
  if (!isAllowedDataUrl(url)) throw new Error('blocked data url');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, cache ? { signal: ctl.signal, cache } : { signal: ctl.signal });
    if (!res.ok) throw new Error('http ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

export const rowKey = (r) => `${r.type}/${r.id}`;

// A collection's page (Music 4.11, a Learn subject 4.12): its catalogs' rows in order, each item once (the first
// row it appears in), hidden or failed items left out, empty rows dropped. `videos` is the page order, which next
// and the pause tiles follow. An item's YouTube id is the end of its id (<prefix><videoId>).
export function collectionData(key, catalogs, { hidden = new Set() } = {}) {
  const col = COLLECTIONS[key];
  const seen = new Set(), rows = [];
  for (const r of col.rows) {
    const songs = [];
    for (const m of catalogs[rowKey(r)] || []) {
      if (!m?.id?.startsWith(col.prefix) || seen.has(m.id) || hidden.has(m.id)) continue;
      seen.add(m.id);
      songs.push({ id: m.id, title: m.name || '', artist: m.description || '', thumbnail: m.poster || '', ytId: m.id.slice(col.prefix.length) });
    }
    if (songs.length) rows.push({ key: rowKey(r), label: r.label, songs });
  }
  const videos = rows.flatMap(r => r.songs);
  return { title: { id: key, type: col.type, name: col.label, poster: videos[0]?.thumbnail || '' }, videos, rows };
}
export const MUSIC_PREFIX = COLLECTIONS.music.prefix;
export const musicData = (catalogs, opts) => collectionData('music', catalogs, opts);

// A song's still (review S3): YouTube's 1280x720 hq720 first, since tiles are 416x234 CSS px (832x468 on her iPad);
// the catalog's 320x180 mqdefault when hq720 is missing.
export const songThumb = (ytId) => ({ hi: `https://i.ytimg.com/vi/${ytId}/hq720.jpg`, lo: `https://i.ytimg.com/vi/${ytId}/mqdefault.jpg` });

// The spoken-title clip for a title or a collection item (spec 2.6): title/music.<videoId>, title/drawing.<videoId>,
// title/piano.<videoId>.
export const titleClipId = (id) => { const k = collectionOf(id); return k ? COLLECTIONS[k].clip + '.' + String(id).slice(COLLECTIONS[k].prefix.length) : id; };

// Every title in catalog order, for the New row: songs are not titles and never count as new.
export function titleOrder(catalogs) {
  return [...new Set(ALL_ROWS.filter(r => !COLLECTION_TYPES.has(r.type)).flatMap(r => (catalogs[rowKey(r)] || []).map(m => m.id)).filter(id => !isCollectionId(id)))];
}

// Rows for a category: hidden and failed titles out, a title only once per category, empty rows dropped.
export function buildRows(cat, catalogs, { hidden = new Set(), failed = new Set() } = {}) {
  const seen = new Set();
  const rows = [];
  const ordered = [...cat.rows].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
  for (const r of ordered) {
    const metas = catalogs[rowKey(r)] || [];
    const items = [];
    for (const m of metas) {
      if (!m || !m.id || seen.has(m.id) || hidden.has(m.id) || failed.has(m.id)) continue;
      seen.add(m.id);
      items.push({ id: m.id, type: m.type || r.type, name: m.name, poster: m.poster, posterShape: m.posterShape || 'poster', rowType: r.type, lang: cat.lang || 'en' });
    }
    if (items.length) rows.push({ key: rowKey(r), type: r.type, id: r.id, items });
  }
  return rows;
}

export async function loadCatalogs(rows, { fetchJson = defaultFetchJson } = {}) {
  const catalogs = {};
  await Promise.all(rows.map(async (r) => {
    try { catalogs[rowKey(r)] = (await fetchJson(catalogUrl(r.type, r.id))).metas || []; }
    catch { catalogs[rowKey(r)] = []; }
  }));
  return catalogs;
}

export async function loadCategory(cat, { fetchJson = defaultFetchJson, hidden, failed } = {}) {
  return buildRows(cat, await loadCatalogs(cat.rows, { fetchJson }), { hidden, failed });
}

export function parseRuntime(s) {
  if (typeof s !== 'string') return null;
  const h = /(\d+)\s*h/.exec(s), m = /(\d+)\s*min/.exec(s);
  if (!h && !m) return null;
  return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
}

// Watch order: real seasons ascending, specials (season 0) last, nothing that hasn't aired yet.
export function orderEpisodes(videos = [], now = new Date()) {
  const t = now.getTime();
  return videos
    .filter(v => v && v.season != null && !(v.released && Date.parse(v.released) > t))
    .map(v => ({
      id: v.id, season: +v.season, episode: +(v.episode ?? v.number),
      title: v.name || v.title || '', thumbnail: v.thumbnail || '', released: v.released || null,
    }))
    .sort((a, b) => ((a.season === 0) - (b.season === 0)) || (a.season - b.season) || (a.episode - b.episode));
}

export function channelVideos(meta) {
  return (meta?.videos || []).map(v => ({ id: v.id, title: v.title || v.name || '', thumbnail: v.thumbnail || meta.poster || '', released: v.released || null }));
}

export function parseYear(y) {
  const m = /(\d{4})/.exec(String(y ?? ''));
  return m ? +m[1] : undefined;
}

export function kindOf(type) {
  if (type === 'YouTube' || COLLECTION_TYPES.has(type)) return 'youtube';   // songs and lessons play in the YouTube player
  if (type === 'Audio') return 'audio';
  return 'torbox';
}

// The item handed to the player (see the player contract).
export function playItemFor(title, video, { lang = 'en', stream = null, altNames = [] } = {}) {
  const kind = kindOf(title.type);
  const base = { kind, type: title.type, titleId: title.id, showName: title.name, altNames, lang, poster: title.poster || '',
    year: parseYear(title.year ?? title.releaseInfo), title: video?.title || title.name };
  if (kind === 'torbox') {
    const isSeries = title.type === 'series';
    return { ...base, imdbId: title.id, season: isSeries ? video.season : undefined, episode: isSeries ? video.episode : undefined,
      videoId: isSeries ? video.id : title.id, runtimeMin: parseRuntime(title.runtime), episodeTitle: video?.title || '',
      seasonCount: isSeries && title.seasonCount > 0 ? title.seasonCount : undefined, episodeName: isSeries ? (video?.title || undefined) : undefined };
  }
  if (kind === 'youtube') return { ...base, videoId: video.id, ytId: stream?.ytId || video.ytId, episodeTitle: video.title || stream?.title || '' };
  return { ...base, videoId: video.id, url: stream?.url, episodeTitle: video.title || stream?.title || '', artwork: video.thumbnail || title.poster };
}

export async function loadTitle(type, id, { fetchJson = defaultFetchJson, now = new Date() } = {}) {
  const meta = (await fetchJson(metaUrl(type, id))).meta || {};
  const title = { id, type, name: meta.name, poster: meta.poster, posterShape: meta.posterShape || 'poster', background: meta.background, runtime: meta.runtime, year: meta.year, releaseInfo: meta.releaseInfo,
    seasonCount: type === 'series' ? new Set((meta.videos || []).map(v => +v.season).filter(n => n > 0)).size : undefined };
  const videos = type === 'series' ? orderEpisodes(meta.videos, now)
    : type === 'movie' ? [{ id, title: meta.name, thumbnail: meta.background || meta.poster }]
      : channelVideos(meta);
  return { title, videos };
}

export async function loadStream(type, videoId, { fetchJson = defaultFetchJson } = {}) {
  const d = await fetchJson(streamUrl(type, videoId));
  return (d.streams || [])[0] || null;
}
