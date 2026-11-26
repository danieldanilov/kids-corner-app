// Probe a resolved file with Mediabunny (range requests only) and decide how, or whether, it plays.
// Spec: playback.md sections 1-3. The probed duration is checked against the runtime, and the checks on content
// (duration, audio) are soft (brief, Stream choice): a file that fails one is tried after the others, and plays
// when nothing else does. Video Safari can't play goes to the transcode path (decoded here, re-encoded to H.264).

import { rawVideoTrackInfo } from './inputs.js';
import { FFMPEG_AUDIO } from './decoders-ffmpeg.js';

const LANGS = { en: ['eng', 'en'], ru: ['rus', 'ru'] };
const AUDIO_PREF = ['aac', 'eac3', 'ac3', 'mp3', 'opus', 'flac'];
const DIRECT_AUDIO = new Set(['aac', 'ac3', 'eac3', 'mp3']);
// Mediabunny reports these lowercase; MSE wants the MP4 sample-entry names.
const MP4_AUDIO_NAME = { opus: 'Opus', flac: 'fLaC' };
// Tracks the transcode path's own demuxers read (AVI, MPEG-PS, ASF, FLV) come with no codec string: the MP4 names
// of what it passes through. Audio in FFMPEG_AUDIO is converted to MP3 instead.
const AVI_AUDIO_NAME = { ac3: 'ac-3', mp3: 'mp3', aac: 'mp4a.40.2' };
const OWN_CONTAINERS = new Set(['avi', 'mpg', 'asf', 'flv']);
// What the transcode path's encoder writes (H.264 High, level 3.1, up to 1280x720).
export const TRANSCODE_VIDEO = 'avc1.64001F';
export const DURATION_TOLERANCE = 0.25;

const CONTAINERS = [[/matroska/i, 'mkv'], [/webm/i, 'webm'], [/quicktime|\bmov\b/i, 'mov'], [/mp4|isobmff/i, 'mp4'], [/mpeg-?ts|transport/i, 'ts']];

export function openInput(M, url, { fetchFn, maxCacheSize = 32 << 20 } = {}) {
  return new M.Input({
    source: new M.UrlSource(url, {
      maxCacheSize, parallelism: 2, fetchFn,
      getRetryDelay: n => (n < 2 ? 0.5 : null),
      handleUnhandledError: () => {},
    }),
    formats: M.ALL_FORMATS,
  });
}

export async function probeInput(M, input) {
  const fmt = await input.getFormat();
  const container = (CONTAINERS.find(([re]) => re.test(fmt.name || '')) || [null, 'other'])[1];
  const video = await input.getPrimaryVideoTrack();
  const audioTracks = await input.getAudioTracks();
  let durationSec = null;
  try { durationSec = await input.getDurationFromMetadata(); } catch { /* keep null */ }
  if (durationSec == null && (container === 'mp4' || container === 'mov')) {
    try { durationSec = await input.computeDuration(); } catch { /* keep null */ }
  }
  const safe = async f => { try { return await f(); } catch { return null; } };
  // A video track Mediabunny reads but can't name (MPEG-4 Part 2, MPEG-1/2, VC-1, a VfW FourCC): its codec from
  // the container's own codec id, marked for decoding on the device.
  const raw = video && !video.codec ? rawVideoTrackInfo(video) : null;
  return {
    container,
    durationSec: Number.isFinite(durationSec) ? durationSec : null,
    videoTrack: video,
    video: video && {
      codec: video.codec || raw?.codec || null, codecString: video.codec ? await safe(() => video.getCodecParameterString()) : null,
      ...(raw ? { needsDecode: true, raw } : {}),
      width: video.displayWidth, height: video.displayHeight,
    },
    audio: await Promise.all(audioTracks.map(async (a, index) => ({
      index, track: a, codec: a.codec, codecString: await safe(() => a.getCodecParameterString()),
      lang: (a.languageCode || 'und').toLowerCase(), name: a.name || '', channels: a.numberOfChannels,
      isDefault: !!a.disposition?.default, commentary: !!a.disposition?.commentary,
    }))),
  };
}

export const toHvc1 = s => (typeof s === 'string' ? s.replace(/^hev1\./, 'hvc1.') : s);

// Returns { ok:false, reason, soft? } or { ok:true, path:'direct'|'remux', mime, audioIndex, durationCheck }.
// Content checks are soft (brief, Stream choice): a wrong or unknown length, no audio or only foreign audio come
// back as { ok:false, soft:true } so other files are tried first; with { lenient:true } they play anyway.
export function decide(info, item = {}, caps = {}, { lenient = false } = {}) {
  const soft = (reason, durationCheck) => ({ ok: false, reason, soft: true, durationCheck });
  const isType = typeof caps.isTypeSupported === 'function' ? caps.isTypeSupported : () => false;
  if (!info?.video) return { ok: false, reason: 'no_video' };

  const runtimeSec = +item.runtimeMin > 0 ? +item.runtimeMin * 60 : null;
  let durationCheck;
  if (runtimeSec == null) {
    durationCheck = { status: 'no_runtime', probedSec: info.durationSec, runtimeSec: null, ratio: null };
  } else if (info.durationSec == null) {
    durationCheck = { status: 'unknown', probedSec: null, runtimeSec, ratio: null };
    if (!lenient) return soft('duration_unknown', durationCheck);
  } else {
    const ratio = info.durationSec / runtimeSec;
    durationCheck = { status: Math.abs(ratio - 1) <= DURATION_TOLERANCE ? 'ok' : 'mismatch', probedSec: info.durationSec, runtimeSec, ratio: +ratio.toFixed(3) };
    if (durationCheck.status !== 'ok' && !lenient) return soft('duration_mismatch', durationCheck);
  }

  // An AVI, or video Safari can't play in another container, goes through the transcode path: decoded on the
  // device and re-encoded to H.264.
  const transcode = OWN_CONTAINERS.has(info.container) || !!info.video.needsDecode;
  if (transcode && !(typeof caps.canDecode === 'function' && caps.canDecode(info.video.codec))) return { ok: false, reason: 'needs_decoder', durationCheck };
  const vstr = transcode ? TRANSCODE_VIDEO : toHvc1(info.video.codecString);
  if (!vstr || !isType(`video/mp4; codecs="${vstr}"`)) return { ok: false, reason: 'unsupported_codec', durationCheck };

  if (!info.audio?.length) {
    if (!lenient) return soft('no_audio', durationCheck);
    const mime = `video/mp4; codecs="${vstr}"`; // the picture alone
    const direct = info.container === 'mp4' && info.video.codec === 'avc';
    return { ok: true, path: transcode ? 'transcode' : direct ? 'direct' : 'remux', mime, audioIndex: null, durationCheck };
  }
  const wanted = LANGS[item.lang] || LANGS.en;
  let pool = info.audio.filter(a => wanted.includes(a.lang));
  if (!pool.length && item.lang !== 'ru') pool = info.audio.filter(a => !a.lang || a.lang === 'und');
  if (!pool.length) { if (!lenient) return soft('no_wanted_audio', durationCheck); pool = info.audio; }
  if (pool.some(a => !a.commentary)) pool = pool.filter(a => !a.commentary);
  // How each track could reach MSE: muxed into the MP4, or (MP3) as a separate audio/mpeg buffer.
  const plan = a => {
    const astr = OWN_CONTAINERS.has(info.container) ? AVI_AUDIO_NAME[a.codec] : MP4_AUDIO_NAME[a.codec] || a.codecString;
    if (transcode && FFMPEG_AUDIO.has(a.codec) && isType('audio/mpeg')) return { mime: `video/mp4; codecs="${vstr}"`, split: true, audioMime: 'audio/mpeg', audioMp3: true };
    if (!astr) return null;
    const muxed = `video/mp4; codecs="${vstr}, ${astr}"`;
    if (isType(muxed)) return { mime: muxed };
    if (a.codec === 'mp3' && isType('audio/mpeg')) return { mime: `video/mp4; codecs="${vstr}"`, split: true, audioMime: 'audio/mpeg' };
    return null;
  };
  const playable = pool.map(a => ({ a, p: plan(a) })).filter(x => x.p);
  if (!playable.length && transcode) {
    // Audio nothing here can play or convert (LPCM in a VOB, for now): soft, then the picture alone.
    if (!lenient) return soft('audio_codec', durationCheck);
    return { ok: true, path: 'transcode', mime: `video/mp4; codecs="${vstr}"`, audioIndex: null, durationCheck };
  }
  if (!playable.length) return { ok: false, reason: 'audio_codec', durationCheck };
  const rank = ({ a, p }) => { const i = AUDIO_PREF.indexOf(a.codec); return (i < 0 ? 99 : i) + (p.split ? 50 : 0) + (p.audioMp3 ? 50 : 0) - (a.isDefault ? 0.5 : 0); };
  const best = [...playable].sort((x, y) => rank(x) - rank(y) || x.a.index - y.a.index)[0];
  const chosen = best.a;
  const { mime } = best.p;

  const direct = info.container === 'mp4' && info.video.codec === 'avc' && chosen.index === 0 && DIRECT_AUDIO.has(chosen.codec);
  if (direct) return { ok: true, path: 'direct', mime, audioIndex: chosen.index, durationCheck };
  return { ok: true, path: transcode ? 'transcode' : 'remux', mime, audioIndex: chosen.index, durationCheck, ...(best.p.split ? { split: true, audioMime: best.p.audioMime } : {}), ...(best.p.audioMp3 ? { audioMp3: true } : {}) };
}
