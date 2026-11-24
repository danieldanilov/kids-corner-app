// Stream selection: parse Torrentio results, apply the hard skips, score the rest.
// Spec: app/.work/research/playback.md section 3, plus the brief's Boss rulings
// (never an uncached stream; wrong show or episode is a skip, never a guess; prefer small files).
// Pure functions, no DOM: runs in the page, a Worker and Node tests alike.

const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya' };
const MEDIA_EXT = /\.(mkv|mp4|m4v|avi|wmv|ts|m2ts|mov|webm|iso|rar|zip|mpg|mpeg|flv)$/i;
const SKIP_CONTAINERS = new Set(['avi', 'wmv', 'iso', 'rar', 'zip', 'm2ts', 'flv', 'mpg', 'mpeg']);
const GB = '🇬🇧', RU = '🇷🇺';
const FOREIGN_WORDS = /tagalog|castellano|latino|dual[ ._-]?lat|truefrench|\bvff\b|\bvfq\b|\bvf2?\b|\bita\b|\bitalian[oa]?\b|\bgerman\b|\bdeutsch\b|\bswedish\b|\bhindi\b|\bspanish\b|\bespa[nñ]ol\b|\bfrench\b|\bportugu[eê]s\b|\bpolish\b|\bturkish\b|\bkorean\b|\bjapanese\b|\bdutch\b|\barabic\b|\bukr\b|\bukrainian\b|\btamil\b|\btelugu\b/i;
const DAY = 86400e3;

export function transliterate(s) {
  return s.replace(/[а-яё]/g, ch => CYR[ch] ?? ch);
}

export function normalizeName(s) {
  if (typeof s !== 'string') return '';
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’`]/g, '')
    .replace(/[^a-z0-9а-яё]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// Whole-word phrase match of any of the names in the text, comparing transliterated forms.
export function nameMatches(text, names) {
  const hay = ' ' + transliterate(normalizeName(text)) + ' ';
  if (hay.trim() === '') return false;
  for (const raw of names || []) {
    let n = transliterate(normalizeName(raw));
    if (!n) continue;
    if (hay.includes(' ' + n + ' ')) return true;
    if (n.startsWith('the ') && n.length > 6 && hay.includes(' ' + n.slice(4) + ' ')) return true;
  }
  return false;
}

export function parseEpisode(fn) {
  if (typeof fn !== 'string' || !fn) return null;
  const base = fn.split(/[\\/]/).pop();
  let m = /\bs(\d{1,2})[ ._-]?e(\d{1,3})(?:-?e(\d{1,3})|-(\d{1,3})\b)?/i.exec(base);
  if (m) return ep(+m[1], +m[2], m[3] ?? m[4]);
  m = /\b(\d{1,2})x(\d{2,3})\b/i.exec(base);
  if (m) return ep(+m[1], +m[2]);
  m = /(?:серия|серии|эпизод)\s*(\d{1,3})/i.exec(base) || /\b(\d{1,3})\s*(?:-?я\s*)?серия/i.exec(base);
  if (m) {
    const s = /сезон\s*(\d{1,2})/i.exec(base) || /(\d{1,2})\s*сезон/i.exec(base);
    return ep(s ? +s[1] : null, +m[1]);
  }
  m = /^(\d{1,2})\.(\d{2})\s/.exec(base);
  if (m) return ep(+m[1], +m[2]);
  m = /^(\d{2,3})[ ._-]/.exec(base);
  if (m) return ep(null, +m[1]);
  m = /\b(?:ep|episode)[ ._-]?(\d{1,3})\b/i.exec(base) || /\be(\d{2,3})\b/i.exec(base);
  if (m) return ep(null, +m[1]);
  return null;
}
function ep(season, episode, end) {
  const r = { season, episode };
  if (end != null && +end > episode) r.episodeEnd = +end;
  return r;
}

function flagsOf(t) {
  return new Set(t.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) || []);
}

export function parseStream(s, item = {}) {
  const name = typeof s?.name === 'string' ? s.name : '';
  const title = typeof s?.title === 'string' ? s.title : (typeof s?.description === 'string' ? s.description : '');
  const lines = title.split('\n').map(l => l.trim());
  const torrent = lines[0] || '';
  const hinted = typeof s?.behaviorHints?.filename === 'string' ? s.behaviorHints.filename : '';
  const filename = hinted || lines.find(l => MEDIA_EXT.test(l) && !/👤|💾/.test(l)) || torrent;
  const text = `${torrent} ${filename}`;
  const low = text.toLowerCase();
  const lowNoExt = `${torrent.replace(MEDIA_EXT, '')} ${filename.replace(MEDIA_EXT, '')}`.toLowerCase();

  let sizeMB = null;
  const sm = /💾\s*([\d.]+)\s*(GB|MB|KB)/i.exec(title);
  if (sm) sizeMB = +sm[1] * ({ GB: 1024, MB: 1, KB: 1 / 1024 }[sm[2].toUpperCase()]);
  else if (+s?.behaviorHints?.videoSize > 0) sizeMB = +s.behaviorHints.videoSize / 1048576;

  const resM = /(2160p|4k|1440p|1080p|720p|576p|480p|360p)/i.exec(name) || /(2160p|4k|1440p|1080p|720p|576p|480p|360p)/i.exec(low);
  const res = resM ? resM[1].toLowerCase() : 'other';
  const em = /\.([a-z0-9]{2,4})$/i.exec(filename);
  const container = em ? em[1].toLowerCase().replace('m4v', 'mp4') : 'unknown';

  const videoCodec = /\bav1\b/.test(low) ? 'av1' : /xvid|divx/.test(low) ? 'xvid' : /mpeg-?2/.test(low) ? 'mpeg2'
    : /\bvc-?1\b/.test(low) ? 'vc1' : /x265|hevc|h[ .]?265/.test(low) ? 'hevc' : /x264|h[ .]?264|\bavc\b/.test(low) ? 'h264' : 'unknown';
  const tenBit = /10.?bit|\bhdr(10\+?)?\b/.test(low);
  const dolbyVision = /\b(dv|dovi)\b|dolby[ ._-]?vision/.test(low);
  const threeD = /\b3d\b|\bh-?sbs\b|\bhalf-?(sbs|ou)\b/.test(low);
  const cam = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|telecine|scr|screener|dvdscr)\b/.test(lowNoExt);
  const audioCodec = /truehd|atmos/.test(low) ? 'truehd' : /\bdts/.test(low) ? 'dts' : /e-?ac-?3|ddp|dd\+/.test(low) ? 'eac3'
    : /\bac-?3|\bdd[ ._]?[25][ ._]?[01]\b|dolby digital/.test(low) ? 'ac3' : /\baac/.test(low) ? 'aac'
    : /\bopus\b/.test(low) ? 'opus' : /\bmp3\b/.test(low) ? 'mp3' : 'unknown';

  const flags = flagsOf(title);
  const ru = flags.has(RU) || /[а-яё]/.test(low) || /\b(rus|russian)\b/.test(low);
  const enExplicit = flags.has(GB) || /\beng(lish)?\b/.test(low);
  const en = enExplicit || flags.size === 0;
  const foreign = (flags.size > 0 && !flags.has(GB) && !flags.has(RU)) || (FOREIGN_WORDS.test(low) && !enExplicit && !ru);

  const cached = name.startsWith('[TB+]');
  const uncached = name.includes('[TB download]') || (name.startsWith('[TB') && !cached);
  const url = typeof s?.url === 'string' ? s.url : null;
  const hm = url && /\/resolve\/torbox\/[^/]+\/([a-f0-9]{40}|[a-z]+-\d+-\d+)\/[^/]+\/(\d+|null)\//i.exec(url);
  const infoHash = hm ? hm[1].toLowerCase() : (typeof s?.infoHash === 'string' ? s.infoHash.toLowerCase() : null);
  const fileIdx = hm ? hm[2] : (s?.fileIdx ?? 'null');
  const key = infoHash ? `${infoHash}:${fileIdx}` : `fn:${filename}`;

  const runtimeMin = +item.runtimeMin > 0 ? +item.runtimeMin : null;
  const mbps = sizeMB && runtimeMin ? (sizeMB * 8) / (runtimeMin * 60) : null;
  const years = [...text.matchAll(/(?:^|[^0-9])(19[3-9]\d|20[0-4]\d)(?![0-9])/g)].map(m => +m[1]);

  return {
    raw: s, name, filename, torrent, text, url, key, infoHash, fileIdx, sizeMB, mbps, res, container, videoCodec, tenBit,
    dolbyVision, threeD, cam, audioCodec, flags: [...flags], ru, en, enExplicit, foreign, cached, uncached,
    ep: parseEpisode(filename), torrentEp: parseEpisode(torrent), years,
  };
}

export function hardSkip(c, item = {}, caps = {}) {
  if (c.uncached || !c.cached) return 'uncached';
  if (!c.url) return 'no_url';
  if (SKIP_CONTAINERS.has(c.container)) return 'container';
  const names = [item.showName, ...(item.altNames || [])].filter(n => typeof n === 'string' && n.trim());
  if (!nameMatches(c.text, names)) return 'wrong_show';
  if (item.type === 'series') {
    const e = c.ep || (c.torrentEp && !c.torrentEp.episodeEnd ? c.torrentEp : null);
    if (!e) return 'episode_unverified';
    if (e.season != null && item.season != null && e.season !== +item.season) return 'wrong_episode';
    const want = +item.episode;
    if (!(want >= e.episode && want <= (e.episodeEnd || e.episode))) return 'wrong_episode';
    // A file whose years all predate the show is a different show with the same name (Bluey 1976 vs 2018).
    if (item.year && c.years.length && c.years.every(y => y < +item.year - 1)) return 'wrong_year';
  } else if (item.year && c.years.length && !c.years.some(y => Math.abs(y - +item.year) <= 1)) {
    return 'wrong_year';
  }
  if (['xvid', 'mpeg2', 'vc1'].includes(c.videoCodec)) return 'video_codec';
  if (c.videoCodec === 'av1' && !caps.av1) return 'video_codec';
  if (c.dolbyVision) return 'dolby_vision';
  if (c.threeD) return '3d';
  if (c.cam) return 'cam';
  if (c.foreign) return 'foreign_dub';
  if (c.res === '2160p' || c.res === '4k') return '4k';
  if (c.mbps != null && c.mbps > 16) return 'bitrate';
  return null;
}

export function candidateKey(c) { return c.key; }

export function scoreCandidate(c, item = {}, learned = {}) {
  let s = 100;
  s += { mp4: 25, mkv: 10, webm: 0, ts: -10 }[c.container] ?? -20;
  s += c.videoCodec === 'h264' ? 15 : c.videoCodec === 'hevc' ? (c.tenBit ? 2 : 8) : 0;
  s += { aac: 12, ac3: 8, eac3: 8, unknown: 4, mp3: 6, opus: 0, dts: -30, truehd: -40 }[c.audioCodec] ?? 0;
  s += { '1080p': 10, '720p': 8, '576p': 0, '480p': 0 }[c.res] ?? -10;
  if (c.mbps != null) {
    s += c.mbps < 0.4 ? -15 : c.mbps <= 4 ? 10 : c.mbps <= 8 ? -5 : -20;
    s -= 2 * c.mbps; // within a band the lighter file still starts sooner
  }
  if (item.lang === 'ru' ? c.ru : c.en) s += 10;
  if (c.ru && c.enExplicit) s += 6;
  const h = learned?.[c.key];
  if (h?.good) s += 50;
  if (h?.failed && Date.now() - h.failed < 7 * DAY) s -= 100;
  return s;
}

// Returns { ranked: [candidate + score + rank], skipped: { reason: count } }.
export function rankStreams(streams, item = {}, caps = {}, learned = {}) {
  const skipped = {};
  const ranked = [];
  for (const s of Array.isArray(streams) ? streams : []) {
    if (!s || typeof s !== 'object') { skipped.junk = (skipped.junk || 0) + 1; continue; }
    const c = parseStream(s, item);
    const why = hardSkip(c, item, caps);
    if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
    c.score = scoreCandidate(c, item, learned);
    ranked.push(c);
  }
  // Higher score first; on a tie the smaller file wins (speed comes from small files).
  ranked.sort((a, b) => b.score - a.score || (a.sizeMB ?? 1e9) - (b.sizeMB ?? 1e9));
  ranked.forEach((c, i) => { c.rank = i + 1; });
  return { ranked, skipped };
}
