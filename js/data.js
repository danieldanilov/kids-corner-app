// Kids Corner data: only the published Kids Corner addon, plus Cinemeta meta for movies and series.
export const ADDON = 'https://danieldanilov.github.io/kids-stremio-catalog/';
export const CINEMETA = 'https://v3-cinemeta.strem.io/';

// The seven approved chips. Each row is one of the addon's own catalogs.
// lang: the audio language a title in that row should play in.
export const CATEGORIES = [
  { id: 'shows', label: 'Shows', rows: [{ type: 'series', id: 'shows' }, { type: 'series', id: 'streaming' }] },
  { id: 'movies', label: 'Movies', rows: [{ type: 'movie', id: 'movies' }, { type: 'movie', id: 'streaming' }] },
  { id: 'bedtime', label: 'Bedtime', rows: [{ type: 'series', id: 'bedtime' }, { type: 'Audio', id: 'bedtime' }, { type: 'YouTube', id: 'bedtime' }] },
  { id: 'youtube', label: 'YouTube', rows: [{ type: 'YouTube', id: 'shows' }, { type: 'YouTube', id: 'songs' }, { type: 'YouTube', id: 'learning' }, { type: 'YouTube', id: 'read-aloud' }] },
  { id: 'stories', label: 'Stories', rows: [{ type: 'Audio', id: 'stories' }, { type: 'movie', id: 'stories' }] },
  { id: 'russian', label: 'По-русски', lang: 'ru', rows: [{ type: 'series', id: 'ru-series' }, { type: 'movie', id: 'ru-movies' }, { type: 'YouTube', id: 'russian' }] },
  { id: 'british', label: 'British', rows: [{ type: 'series', id: 'british' }, { type: 'movie', id: 'british' }] },
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

export async function defaultFetchJson(url, { timeoutMs = 12000 } = {}) {
  if (!isAllowedDataUrl(url)) throw new Error('blocked data url');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error('http ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

export const rowKey = (r) => `${r.type}/${r.id}`;

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
  if (type === 'YouTube') return 'youtube';
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
      videoId: isSeries ? video.id : title.id, runtimeMin: parseRuntime(title.runtime), episodeTitle: video?.title || '' };
  }
  if (kind === 'youtube') return { ...base, videoId: video.id, ytId: stream?.ytId, episodeTitle: video.title || stream?.title || '' };
  return { ...base, videoId: video.id, url: stream?.url, episodeTitle: video.title || stream?.title || '', artwork: video.thumbnail || title.poster };
}

export async function loadTitle(type, id, { fetchJson = defaultFetchJson, now = new Date() } = {}) {
  const meta = (await fetchJson(metaUrl(type, id))).meta || {};
  const title = { id, type, name: meta.name, poster: meta.poster, posterShape: meta.posterShape || 'poster', background: meta.background, runtime: meta.runtime, year: meta.year, releaseInfo: meta.releaseInfo };
  const videos = type === 'series' ? orderEpisodes(meta.videos, now)
    : type === 'movie' ? [{ id, title: meta.name, thumbnail: meta.background || meta.poster }]
      : channelVideos(meta);
  return { title, videos };
}

export async function loadStream(type, videoId, { fetchJson = defaultFetchJson } = {}) {
  const d = await fetchJson(streamUrl(type, videoId));
  return (d.streams || [])[0] || null;
}
