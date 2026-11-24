// Pure rules: progress, Keep watching, My shows, limits that land at episode ends, bedtime.

export const MIN_START_S = 10;
export const KEEP_MAX = 4;

export function isFinished(p) {
  if (p.finished) return true;
  if (!p.duration || p.duration <= 0) return false;
  return p.duration - p.position <= Math.max(15, p.duration * 0.05);
}

// One entry per title: the latest record decides. Unfinished and really started only. Newest first.
export function keepWatching(progress, { hidden = new Set(), max = KEEP_MAX } = {}) {
  const latest = new Map();
  for (const p of progress) {
    const cur = latest.get(p.titleId);
    if (!cur || p.updatedAt > cur.updatedAt) latest.set(p.titleId, p);
  }
  return [...latest.values()]
    .filter(p => !hidden.has(p.titleId) && !isFinished(p) && p.position >= MIN_START_S)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, max);
}

// Pinned by a parent first (in pin order), then her hearts in the order she added them.
export function myShows(favs, pinned = [], hidden = new Set()) {
  const out = [];
  for (const id of pinned) if (!hidden.has(id) && !out.includes(id)) out.push(id);
  for (const f of [...favs].sort((a, b) => a.addedAt - b.addedAt)) if (!hidden.has(f.id) && !out.includes(f.id)) out.push(f.id);
  return out;
}

export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const freshUsage = (date) => ({ date, seconds: 0, episodesEnded: 0, extraMinutes: 0, extraShows: 0 });

export function rollUsage(u, date = todayKey()) {
  return !u || u.date !== date ? freshUsage(date) : u;
}

export function addWatchTime(u, seconds, date) {
  const base = date ? rollUsage(u, date) : u;
  return { ...base, seconds: base.seconds + Math.max(0, seconds) };
}

export function recordEpisodeEnd(u) {
  return { ...u, episodesEnded: u.episodesEnded + 1 };
}

// Shows allowed today: 0 means no limit. Mode 'ask' uses her pick for the day; no mode set means fixed.
export function showsAllowed(u, settings) {
  const l = settings.limits || {};
  const mode = l.showsMode ?? (l.showsPerDay > 0 ? 'fixed' : 'off');
  if (mode === 'fixed') return l.showsPerDay > 0 ? l.showsPerDay : 0;
  if (mode === 'ask') return u.chosenShows > 0 ? u.chosenShows : 0;
  return 0;
}

export const needsHowMany = (u, settings) => (settings.limits || {}).showsMode === 'ask' && !(u.chosenShows > 0);

export function limitState(u, settings) {
  const l = settings.limits || {};
  const allowed = showsAllowed(u, settings);
  const timeUp = l.dailyMinutes > 0 && u.seconds >= (l.dailyMinutes + (u.extraMinutes || 0)) * 60;
  const showsUp = allowed > 0 && u.episodesEnded >= allowed + (u.extraShows || 0);
  return { timeUp, showsUp, done: timeUp || showsUp };
}

// While something plays: a series episode always finishes; a movie follows the parent's choice.
export function onPlaybackTick(u, settings, item) {
  const s = limitState(u, settings);
  if (s.timeUp && item.type === 'movie' && settings.limits.movieAtLimit === 'pause') return 'pause';
  return 'continue';
}

// At an episode's end (pass usage that already counts this ending).
export function onEpisodeEnd(u, settings) {
  return limitState(u, settings).done ? 'rest' : 'goodbye';
}

export function canStart(u, settings) {
  return !limitState(u, settings).done;
}

export function isLastOne(u, settings) {
  const allowed = showsAllowed(u, settings);
  return allowed > 0 && u.episodesEnded === allowed + (u.extraShows || 0) - 1;
}

const mins = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); return m ? +m[1] * 60 + +m[2] : null; };

export function bedtimeWanted(settings, now = new Date()) {
  const b = settings.bedtime || {};
  if (b.manual) return true;
  const s = mins(b.start), e = mins(b.end);
  if (s == null || e == null || s === e) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return s < e ? t >= s && t < e : t >= s || t < e;
}

// The look changes only when nothing is playing.
export function applyBedtime(current, wanted, { playing }) {
  return playing ? current : wanted;
}

// Failures: titleId -> { videos: { videoId: at }, type }. Setup problems are not the title's fault.
export const FAIL_TTL_MS = 7 * 86400000;
export const SERIES_FAILS_TO_HIDE = 3;
const SETUP_REASONS = new Set(['not-configured', 'unauthorized', 'misconfigured', 'forbidden', 'no-player', 'app_token']);

export function recordFailure(failed, item, reasons = [], now = Date.now()) {
  if (reasons.some(r => SETUP_REASONS.has(r))) return failed;
  const cur = failed[item.titleId] || { type: item.type, videos: {} };
  return { ...failed, [item.titleId]: { ...cur, videos: { ...cur.videos, [item.videoId]: now } } };
}

export function hiddenByFailure(failed, now = Date.now()) {
  const titles = new Set(), videos = new Set();
  for (const [titleId, f] of Object.entries(failed || {})) {
    const live = Object.entries(f.videos || {}).filter(([, at]) => now - at < FAIL_TTL_MS).map(([v]) => v);
    live.forEach(v => videos.add(v));
    if (!live.length) continue;
    if (f.type !== 'series' || live.length >= SERIES_FAILS_TO_HIDE) titles.add(titleId);
  }
  return { titles, videos };
}
