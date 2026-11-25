// Network helpers that run on the device: Torrentio stream lists, Cinemeta runtime, Worker resolve.
// The Torrentio config holds the TorBox key, so it only ever travels in a request path to Torrentio
// itself and in the Worker POST body; nothing here logs or returns it.

const TORRENTIO = 'https://torrentio.strem.fun';

export function torrentioBase(config) {
  let c = typeof config === 'string' ? config.trim() : '';
  if (!c) throw new Error('missing Torrentio config');
  c = c.replace(/^stremio:\/\//, 'https://');
  if (/^https?:\/\//.test(c)) {
    const u = new URL(c);
    if (u.hostname !== 'torrentio.strem.fun') throw new Error('config is not a torrentio URL');
    c = u.pathname;
  }
  c = c.replace(/\/manifest\.json$/, '').replace(/^\/+|\/+$/g, '');
  if (!c) throw new Error('missing Torrentio config');
  return `${TORRENTIO}/${c}`;
}

function withLanguage(base, lang) {
  const i = base.lastIndexOf('/');
  let seg = base.slice(i + 1);
  try { seg = decodeURIComponent(seg); } catch { /* keep raw */ }
  const parts = seg.split('|').filter(Boolean);
  if (lang === 'ru' && !parts.some(p => p.startsWith('language='))) parts.push('language=russian');
  return base.slice(0, i + 1) + parts.join('|');
}

export function streamListUrl(config, item) {
  const base = withLanguage(torrentioBase(config), item.lang);
  if (!/^tt\d+$/.test(item.imdbId || '')) throw new Error('bad imdb id');
  if (item.type === 'series') {
    if (!(item.season >= 0) || !(item.episode >= 1)) throw new Error('series needs season and episode');
    return `${base}/stream/series/${item.imdbId}:${item.season}:${item.episode}.json`;
  }
  return `${base}/stream/movie/${item.imdbId}.json`;
}

export function parseRuntime(s) {
  if (typeof s !== 'string') return null;
  const h = /(\d+)\s*h/i.exec(s), m = /(\d+)\s*m/i.exec(s);
  if (!h && !m) return null;
  return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
}

async function timed(fetchFn, url, init, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetchFn(url, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}

export async function fetchStreams(config, item, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
  const r = await timed(fetchFn, streamListUrl(config, item), {}, timeoutMs);
  if (!r.ok) throw new Error('stream list http ' + r.status);
  const j = await r.json();
  return Array.isArray(j?.streams) ? j.streams : [];
}

export async function fetchCinemeta(item, { fetchFn = fetch, timeoutMs = 6000 } = {}) {
  const r = await timed(fetchFn, `https://v3-cinemeta.strem.io/meta/${item.type === 'series' ? 'series' : 'movie'}/${item.imdbId}.json`, {}, timeoutMs);
  if (!r.ok) return {};
  const meta = (await r.json())?.meta || {};
  const year = parseInt(String(meta.year || meta.releaseInfo || ''), 10);
  const videos = Array.isArray(meta.videos) ? meta.videos : [];
  const seasons = new Set(videos.map(v => +v.season).filter(n => n > 0));
  const ep = videos.find(v => +v.season === +item.season && +v.episode === +item.episode);
  return {
    runtimeMin: parseRuntime(meta.runtime), year: Number.isFinite(year) ? year : null,
    seasonCount: item.type === 'series' && seasons.size ? seasons.size : null,
    episodeName: item.type === 'series' ? (ep?.name || ep?.title || null) : null,
  };
}

// -> {status:'ok', url, expires} | {status:'skip', reason} | {status:'fatal', reason}
export async function resolveViaWorker({ workerUrl, appToken, url, fetchFn = fetch, timeoutMs = 8000 }) {
  let r;
  try {
    r = await timed(fetchFn, workerUrl.replace(/\/+$/, '') + '/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Token': appToken },
      body: JSON.stringify({ url }),
    }, timeoutMs);
  } catch {
    return { status: 'skip', reason: 'network' };
  }
  let j = {};
  try { j = await r.json(); } catch { /* keep empty */ }
  if (r.status === 401) return { status: 'fatal', reason: 'app_token' };
  if (r.status === 403) return { status: 'fatal', reason: 'origin' };
  if (r.status === 200 && j.status === 'ok' && typeof j.url === 'string') return { status: 'ok', url: j.url, expires: j.expires };
  if (r.status === 200 && j.status === 'downloading') return { status: 'skip', reason: 'downloading' };
  if (r.status === 200 && j.status === 'failed' && j.reason === 'torbox_auth') return { status: 'fatal', reason: 'torbox_auth' };
  if (r.status === 200 && j.status === 'failed') return { status: 'skip', reason: String(j.reason || 'failed') };
  if (j.status === 'upstream_error') return { status: 'skip', reason: 'upstream_' + (j.reason || r.status) };
  return { status: 'skip', reason: r.status === 200 ? 'bad_response' : 'http_' + r.status };
}

export const scrubSecrets = s => String(s ?? '').replace(/[a-z]+:\/\/\S+/gi, '<url>').replace(/[A-Za-z0-9_-]{20,}/g, '<redacted>').slice(0, 200);

// Why a stream list produced nothing to try. Setup-type codes (list_failed, list_empty, none_cached) point at the
// config, the key or an outage and must not hide a title; no_candidates means real streams all failed the guards.
const NOT_CONTENT = new Set(['uncached', 'no_url', 'junk']);
export function listOutcome({ error, streams, ranked, skipped } = {}) {
  if (error) return 'list_failed';
  if (!streams || !streams.length) return 'list_empty';
  if (ranked && ranked.length) return null;
  const reasons = Object.keys(skipped || {});
  return reasons.length && reasons.every(r => NOT_CONTENT.has(r)) ? 'none_cached' : 'no_candidates';
}
