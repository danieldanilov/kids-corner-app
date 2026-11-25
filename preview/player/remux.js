// Packet-copy remux to fragmented MP4 with Mediabunny's low-level API. No re-encoding.
// Each emitted segment is either the init segment (ftyp+moov) or one whole fragment (moof+mdat)
// that starts on a video keyframe, which is exactly what one MSE appendBuffer wants.
// Environment-agnostic: runs in a Web Worker, on the main thread, or in Node tests.

function concat(a, b) {
  const out = new Uint8Array((a?.byteLength || 0) + b.byteLength);
  if (a) out.set(a, 0);
  out.set(b, a?.byteLength || 0);
  return out;
}

const ISO1 = { en: 'eng', ru: 'rus', he: 'heb', iw: 'heb', uk: 'ukr', fr: 'fra', de: 'deu', es: 'spa', it: 'ita', pt: 'por',
  ja: 'jpn', ko: 'kor', zh: 'zho', pl: 'pol', tr: 'tur', nl: 'nld', sv: 'swe', ar: 'ara', hi: 'hin', cs: 'ces', hu: 'hun' };
// Mediabunny only accepts three-letter ISO 639-2 codes on output.
export function iso639_2(code) {
  if (typeof code !== 'string') return undefined;
  const c = code.toLowerCase().split(/[-_]/)[0];
  if (ISO1[c]) return ISO1[c];
  return /^[a-z]{3}$/.test(c) && c !== 'und' ? c : undefined;
}

// Audio timing. MKV block timestamps are rounded to the millisecond, so a 21.333 ms AAC frame arrives 21 or 22 ms
// after the last. Mediabunny's MP4 muxer gives each audio packet its own decode group and never lets a decode
// step shrink, so one 22 ms step made every later step 22 ms: the decode timeline ran 3% fast, patched with
// growing negative composition offsets (13.7 s by the end of a Bluey episode), and browsers played the audio
// early, drifting 31 ms a second. So every audio packet is put on an exactly regular frame grid, and each one's
// duration is the distance to the next: decode time equals presentation time. A real jump re-anchors.
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
// Frame length from an AAC AudioSpecificConfig: core sampling rate (HE-AAC's SBR runs at twice it) and the
// 960-sample flag. Mediabunny reports HE-AAC in MKV as mp4a.40.2 at the output rate, so this is the reliable source.
export function aacFrameFromAsc(desc) {
  if (!desc) return null;
  const b = desc instanceof Uint8Array ? desc : new Uint8Array(desc.buffer ? desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength) : desc);
  if (b.length < 2) return null;
  let pos = 0;
  const bits = n => { let v = 0; for (let i = 0; i < n; i++) { const byte = b[pos >> 3]; if (byte === undefined) throw new Error('short'); v = v * 2 + ((byte >> (7 - (pos & 7))) & 1); pos++; } return v; };
  try {
    let aot = bits(5); if (aot === 31) aot = 32 + bits(6);
    const sfi = bits(4); const rate = sfi === 15 ? bits(24) : AAC_RATES[sfi];
    bits(4); // channel configuration
    if (aot === 5 || aot === 29) { // explicit SBR/PS: extension rate, then the core object type
      if (bits(4) === 15) bits(24);
      aot = bits(5); if (aot === 31) aot = 32 + bits(6);
    }
    let frame = 1024;
    if ([1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23].includes(aot) && bits(1)) frame = 960;
    return rate > 0 ? frame / rate : null;
  } catch { return null; }
}

export function audioFrameGuess(codec, sampleRate, codecString, firstPacket, description) {
  if (codec === 'aac') {
    const asc = aacFrameFromAsc(description);
    if (asc) return asc;
    if (!(sampleRate > 0)) return null;
    return (/^mp4a\.40\.(5|29)$/.test(codecString || '') ? 2048 : 1024) / sampleRate;
  }
  if (!(sampleRate > 0)) return null;
  if (codec === 'ac3') return 1536 / sampleRate;
  if (codec === 'eac3') {
    const d = firstPacket?.data;
    if (d?.length >= 5 && d[0] === 0x0b && d[1] === 0x77) {
      const fscod = d[4] >> 6, numblk = (d[4] >> 4) & 3;
      return (fscod === 3 ? 6 : [1, 2, 3, 6][numblk]) * 256 / sampleRate;
    }
    return 1536 / sampleRate;
  }
  if (codec === 'mp3' && firstPacket?.data?.length >= 4) {
    const v = (firstPacket.data[1] >> 3) & 3; // 3 = MPEG-1
    return (v === 3 ? 1152 : 576) / sampleRate;
  }
  return null;
}

const FRAME_SAMPLES = [120, 240, 256, 480, 512, 576, 768, 960, 1024, 1152, 1536, 1920, 2048, 2304, 2880, 3072, 4096];
function snapFrame(obs, sampleRate) {
  let best = null;
  for (const rate of sampleRate > 0 ? [sampleRate, sampleRate / 2] : []) {
    for (const n of FRAME_SAMPLES) { const c = n / rate; if (best == null || Math.abs(c - obs) < Math.abs(best - obs)) best = c; }
  }
  return best != null && Math.abs(best - obs) / obs <= 0.03 ? best : obs;
}
// Check the guess against the first packets before anything is emitted (one wrong early step would ratchet the
// muxer's decode steps). Steady spacing that disagrees with the guess wins, snapped to a real codec frame length.
export function chooseFrameDuration(guess, timestamps, sampleRate) {
  const t = (timestamps || []).filter(Number.isFinite);
  if (t.length < 4) return guess;
  const d = t.slice(1).map((x, i) => x - t[i]);
  const med = [...d].sort((a, b) => a - b)[Math.floor(d.length / 2)];
  if (!(med > 0)) return guess;
  const tol = Math.max(0.0015, med * 0.25);
  if (d.filter(x => Math.abs(x - med) <= tol).length < d.length * 0.8) return guess; // irregular: keep the guess
  const obs = (t[t.length - 1] - t[0]) / (t.length - 1);
  if (guess > 0 && Math.abs(obs - guess) / guess <= 0.05) return guess;
  return snapFrame(obs, sampleRate);
}

export function createAudioGrid(frameGuess, sampleRate) {
  // Mediabunny's muxer never lets a decode step shrink below the previous one, so the placed timestamps must be
  // exactly regular from the first packet: with a known frame length the grid is locked to it; it is only
  // estimated (and then refined) when nothing says, or when the stream clearly disagrees with it. A steady
  // spacing that keeps missing the grid is a wrong frame length, never a stream of jumps: the grid re-locks.
  let anchor = null, k = 0, last = null, locked = frameGuess > 0, fd = locked ? frameGuess : null;
  let jumpRun = 0, jumpSpacing = null;
  return {
    get frame() { return fd; },
    // -> { ts, jumped }
    place(raw) {
      if (anchor == null) { anchor = raw; k = 0; last = raw; return { ts: raw, jumped: false }; }
      k++;
      const step = fd ?? (raw - last);
      const predicted = anchor + k * step;
      if (step > 0 && Math.abs(raw - predicted) <= Math.max(0.004, step * 0.25)) {
        const observed = (raw - anchor) / k;
        if (!locked || (k >= 20 && Math.abs(observed - fd) / fd > 0.02)) { locked = false; fd = observed; }
        last = raw; jumpRun = 0;
        return { ts: predicted, jumped: false };
      }
      const spacing = raw - last;
      jumpRun = jumpSpacing != null && spacing > 0 && Math.abs(spacing - jumpSpacing) <= Math.max(0.0015, spacing * 0.05) ? jumpRun + 1 : 1;
      jumpSpacing = spacing;
      anchor = raw; k = 0; last = raw;
      if (jumpRun >= 2) { fd = snapFrame(spacing, sampleRate); locked = true; jumpRun = 0; return { ts: raw, jumped: false }; }
      return { ts: raw, jumped: true };
    },
  };
}

// splitAudio: audio packets are not muxed; they come out as raw frames ({kind:'audio'}) for a second
// SourceBuffer (used for MP3, which WebKit's MSE refuses inside MP4 but accepts as audio/mpeg).
export function createRemuxer(M, input, { videoTrack, audioTrack, fragmentSec = 1, splitAudio = false }) {
  return {
    // demand(ts) may return a promise to hold the producer before the fragment starting at ts.
    async run({ startSec = 0, endSec = Infinity, onSegment, demand, signal } = {}) {
      const vs = new M.EncodedPacketSink(videoTrack);
      const as = audioTrack ? new M.EncodedPacketSink(audioTrack) : null;
      const vk = (await vs.getKeyPacket(startSec)) ?? (await vs.getFirstPacket());
      if (!vk) return { done: true, aborted: false, empty: true };
      const ak = as ? ((await as.getPacket(vk.timestamp)) ?? (await as.getFirstPacket())) : null;

      let ftyp = null, moof = null, moofTs = 0, mdat = null, lastTs = vk.timestamp, lastEnd = vk.timestamp;
      const flush = () => {
        if (moof && mdat) {
          onSegment({ kind: 'media', data: concat(moof, mdat), startSec: moofTs, endSec: lastTs });
          moof = null; mdat = null;
        }
      };
      const output = new M.Output({
        format: new M.Mp4OutputFormat({
          fastStart: 'fragmented', minimumFragmentDuration: fragmentSec,
          onFtyp: d => { ftyp = d.slice(); },
          onMoov: d => { onSegment({ kind: 'init', data: concat(ftyp, d.slice()) }); ftyp = null; },
          onMoof: (d, _pos, ts) => { moof = d.slice(); moofTs = ts; flush(); },
          onMdat: d => { mdat = d.slice(); flush(); },
        }),
        target: new M.NullTarget(),
      });
      const vsrc = new M.EncodedVideoPacketSource(videoTrack.codec);
      output.addVideoTrack(vsrc);
      let asrc = null;
      if (as && !splitAudio) {
        asrc = new M.EncodedAudioPacketSource(audioTrack.codec);
        const lc = iso639_2(audioTrack.languageCode);
        output.addAudioTrack(asrc, lc ? { languageCode: lc } : {});
      }
      let aBuf = [], aStart = null, aEnd = null, aDisc = false;
      const flushAudio = () => {
        if (!aBuf.length) return;
        const total = aBuf.reduce((n, d) => n + d.byteLength, 0);
        const data = new Uint8Array(total); let off = 0;
        for (const d of aBuf) { data.set(d, off); off += d.byteLength; }
        // discontinuity: the source timestamps jumped here, so the sink re-sets its offset to startSec.
        onSegment({ kind: 'audio', data, startSec: aStart, endSec: aEnd, ...(aDisc ? { discontinuity: true } : {}) });
        aBuf = []; aStart = null; aDisc = false;
      };
      await output.start();
      const vcfg = await videoTrack.getDecoderConfig();
      const acfg = as && !splitAudio ? await audioTrack.getDecoderConfig() : null;

      const vIt = vs.packets(vk), aIt = as ? as.packets(ak) : null;
      let grid = null;
      // Next audio packet, placed on the grid. Frames before 0 (encoder priming) are dropped: a SourceBuffer offset
      // can't be negative, and Mediabunny would otherwise shift the whole audio track late by their length.
      const nextAudio = async () => {
        for (;;) {
          const pk = (await aIt.next()).value;
          if (!pk) return undefined;
          if (pk.timestamp < 0) continue; // priming before 0: Mediabunny would shift the whole track to start at 0
          if (!grid) grid = createAudioGrid(chooseFrameDuration(audioFrameGuess(audioTrack.codec, audioTrack.sampleRate, acfgString, pk, adesc), prescan, audioTrack.sampleRate), audioTrack.sampleRate);
          const g = grid.place(pk.timestamp);
          return { pkt: pk, timestamp: g.ts, jumped: g.jumped };
        }
      };
      const acfgString = as ? await audioTrack.getCodecParameterString().catch(() => null) : null;
      const adesc = as ? (await audioTrack.getDecoderConfig().catch(() => null))?.description : null;
      const prescan = [];
      if (as) { for await (const p of as.packets(ak)) { prescan.push(p.timestamp); if (prescan.length >= 16) break; } }
      let v = (await vIt.next()).value, a = aIt ? await nextAudio() : undefined;
      let firstV = true, firstA = true, stoppedAt = null;
      const aborted = () => signal?.aborted;
      try {
        while (v || a) {
          if (aborted()) { await output.cancel(); return { done: false, aborted: true }; }
          const takeVideo = v && (!a || v.timestamp <= a.timestamp);
          if (takeVideo) {
            if (v.type === 'key' && !firstV) {
              if (v.timestamp >= endSec) { stoppedAt = v.timestamp; break; }
              const wait = demand?.(v.timestamp);
              if (wait) await wait;
              if (aborted()) { await output.cancel(); return { done: false, aborted: true }; }
            }
            lastTs = v.timestamp;
            lastEnd = Math.max(lastEnd, v.timestamp + (v.duration || 0));
            await vsrc.add(v, firstV ? { decoderConfig: vcfg } : undefined);
            firstV = false;
            v = (await vIt.next()).value;
          } else {
            if (stoppedAt == null && a.timestamp >= endSec && (!v || v.timestamp >= endSec)) { stoppedAt = a.timestamp; break; }
            const after = await nextAudio();
            const frame = grid.frame || a.pkt.duration || 0.02;
            let dur = after && !after.jumped ? after.timestamp - a.timestamp : frame;
            if (!(dur > 0)) dur = frame;
            if (after && after.jumped && after.timestamp > a.timestamp) dur = Math.max(frame, after.timestamp - a.timestamp);
            if (splitAudio) {
              if (a.jumped && aBuf.length) { flushAudio(); }
              if (aStart == null) { aStart = a.timestamp; aDisc = a.jumped && !firstA; }
              aBuf.push(a.pkt.data.slice());
              aEnd = a.timestamp + dur;
              if (aEnd - aStart >= 1) flushAudio();
            } else {
              const p = a.pkt;
              await asrc.add(new M.EncodedPacket(p.data, p.type, a.timestamp, dur, p.sequenceNumber, p.byteLength, p.sideData), firstA ? { decoderConfig: acfg } : undefined);
            }
            firstA = false;
            a = after;
          }
        }
        lastTs = Math.max(lastTs, lastEnd);
        await output.finalize();
        flush();
        flushAudio();
      } catch (e) {
        if (aborted()) return { done: false, aborted: true };
        try { await output.cancel(); } catch { /* already broken */ }
        throw e;
      }
      return stoppedAt != null ? { done: false, aborted: false, endSec: stoppedAt } : { done: true, aborted: false };
    },
  };
}
