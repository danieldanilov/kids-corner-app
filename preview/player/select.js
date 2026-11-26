// Stream selection: parse Torrentio results, skip only what can't be fetched, score the rest.
// Ruling (brief, Stream choice): Torrentio's list for the title and episode is trusted as the right show and
// episode. Nothing is skipped on a name, title, year or episode number; skips are technical only (not cached on
// TorBox, no URL). Everything else is ranking: a file that is less suitable plays last, but it still plays.
// Pure functions, no DOM: runs in the page, a Worker and Node tests alike.

const MEDIA_EXT = /\.(mkv|mp4|m4v|avi|wmv|asf|ts|m2ts|mov|webm|iso|rar|zip|mpg|mpeg|vob|flv)$/i;
// Containers the remux path can't read: they go through the on-device transcode.
const TRANSCODE_CONTAINERS = new Set(['avi', 'wmv', 'asf', 'mpg', 'mpeg', 'vob', 'flv']);
// Disc images and archives: nothing here opens them yet, so they are tried after every other file.
const NOT_OPENED = new Set(['iso', 'rar', 'zip']);
// Video codecs Safari can't decode: Xvid/DivX and MS-MPEG4 (MPEG-4 Part 2), MPEG-2, VC-1.
const TRANSCODE_VIDEO = new Set(['xvid', 'mpeg2', 'vc1']);
const GB = '🇬🇧', RU = '🇷🇺';
const FOREIGN_WORDS = /tagalog|castellano|latino|dual[ ._-]?lat|truefrench|\bvff\b|\bvfq\b|\bvf2?\b|\bita\b|\bitalian[oa]?\b|\bgerman\b|\bdeutsch\b|\bswedish\b|\bhindi\b|\bspanish\b|\bespa[nñ]ol\b|\bfrench\b|\bportugu[eê]s\b|\bpolish\b|\bturkish\b|\bkorean\b|\bjapanese\b|\bdutch\b|\barabic\b|\bukr\b|\bukrainian\b|\btamil\b|\btelugu\b/i;
const DAY = 86400e3;

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

  const videoCodec = /\bav1\b/.test(low) ? 'av1' : /xvid|divx|\bmp4[23]\b|msmpeg4/.test(low) ? 'xvid' : /mpeg-?2/.test(low) ? 'mpeg2'
    : /\bvc-?1\b/.test(low) ? 'vc1' : /x265|hevc|h[ .]?265/.test(low) ? 'hevc' : /x264|h[ .]?264|\bavc\b/.test(low) ? 'h264' : 'unknown';
  const tenBit = /10.?bit|\bhdr(10\+?)?\b/.test(low);
  const dolbyVision = /\b(dv|dovi)\b|dolby[ ._-]?vision/.test(low);
  const threeD = /\b3d\b|\bh-?sbs\b|\bhalf-?(sbs|ou)\b/.test(low);
  const cam = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|telecine|scr|screener|dvdscr)\b/.test(lowNoExt);
  const audioCodec = /truehd|atmos/.test(low) ? 'truehd' : /\bdts/.test(low) ? 'dts' : /e-?ac-?3|ddp|dd\+/.test(low) ? 'eac3'
    : /\bac-?3|\bdd[ ._]?[25][ ._]?[01]\b|dolby digital/.test(low) ? 'ac3' : /he[ ._-]?aac|aac[ ._-]?he|aac[ ._-]?v2/.test(low) ? 'heaac' : /\baac/.test(low) ? 'aac'
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

  return {
    raw: s, name, filename, torrent, text, url, key, infoHash, fileIdx, sizeMB, mbps, res, container, videoCodec, tenBit,
    dolbyVision, threeD, cam, audioCodec, flags: [...flags], ru, en, enExplicit, foreign, cached, uncached,
  };
}

// Whether a candidate needs the on-device transcode (its container or video codec can't be remuxed for Safari).
export function needsTranscode(c) {
  return TRANSCODE_CONTAINERS.has(c.container) || TRANSCODE_VIDEO.has(c.videoCodec);
}

// The only skips: a stream TorBox hasn't cached (never started: it would add a download to the account), or one
// with no URL to resolve.
export function hardSkip(c) {
  if (c.uncached || !c.cached) return 'uncached';
  if (!c.url) return 'no_url';
  return null;
}

export function candidateKey(c) { return c.key; }

export function scoreCandidate(c, item = {}, learned = {}, caps = {}) {
  let s = 100;
  s += { mp4: 25, mkv: 10, webm: 0, ts: -10, m2ts: -10 }[c.container] ?? -20;
  s += c.videoCodec === 'h264' ? 15 : c.videoCodec === 'hevc' ? (c.tenBit ? 2 : 8) : 0;
  // HE-AAC plays about 70 ms late (its decoder delay, unsignalled in MKV): it loses a close call to AAC-LC, AC-3
  // or E-AC-3 (half a point below AC-3, worth 0.25 Mbps), never enough to pick a much bigger file.
  s += { aac: 12, ac3: 8, eac3: 8, heaac: 7.5, unknown: 4, mp3: 6, opus: 0, dts: -30, truehd: -40 }[c.audioCodec] ?? 0;
  s += { '1080p': 10, '720p': 8, '576p': 0, '480p': 0 }[c.res] ?? -10;
  if (c.mbps != null) {
    s += c.mbps < 0.4 ? -15 : c.mbps <= 4 ? 10 : c.mbps <= 8 ? -5 : -20;
    s -= 2 * c.mbps; // within a band the lighter file still starts sooner
  }
  if (item.lang === 'ru' ? c.ru : c.en) s += 10;
  if (c.ru && c.enExplicit) s += 6;
  // Last resorts, still playable: below every ordinary file.
  if (needsTranscode(c)) s -= 200;
  if (NOT_OPENED.has(c.container)) s -= 400;
  if (c.videoCodec === 'av1' && !caps.av1) s -= 150;
  if (c.threeD) s -= 100;
  if (c.cam) s -= 100;
  if (c.dolbyVision) s -= 100;
  if (c.res === '2160p' || c.res === '4k') s -= 100;
  if (c.mbps != null && c.mbps > 16) s -= 80;
  if (c.foreign) s -= 60;
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
    const why = hardSkip(c);
    if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
    c.score = scoreCandidate(c, item, learned, caps);
    ranked.push(c);
  }
  // Higher score first; on a tie the smaller file wins (speed comes from small files).
  ranked.sort((a, b) => b.score - a.score || (a.sizeMB ?? 1e9) - (b.sizeMB ?? 1e9));
  ranked.forEach((c, i) => { c.rank = i + 1; });
  return { ranked, skipped };
}
