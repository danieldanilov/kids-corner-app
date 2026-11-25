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
export function audioFrameGuess(codec, sampleRate, codecString, firstPacket) {
  if (!(sampleRate > 0)) return null;
  if (codec === 'aac') return (/^mp4a\.40\.(5|29)$/.test(codecString || '') ? 2048 : 1024) / sampleRate;
  if (codec === 'ac3' || codec === 'eac3') return 1536 / sampleRate;
  if (codec === 'mp3' && firstPacket?.data?.length >= 4) {
    const v = (firstPacket.data[1] >> 3) & 3; // 3 = MPEG-1
    return (v === 3 ? 1152 : 576) / sampleRate;
  }
  return null;
}
export function createAudioGrid(frameGuess) {
  // Mediabunny's muxer never lets a decode step shrink below the previous one, so the placed timestamps must be
  // exactly regular from the first packet: with a known codec frame length the grid is locked to it; it is only
  // estimated (and then refined) when the codec doesn't say, or when the stream clearly disagrees with it.
  let anchor = null, k = 0, last = null, locked = frameGuess > 0, fd = locked ? frameGuess : null;
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
        last = raw;
        return { ts: predicted, jumped: false };
      }
      anchor = raw; k = 0; last = raw;
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
          if (!grid) grid = createAudioGrid(audioFrameGuess(audioTrack.codec, audioTrack.sampleRate, acfgString, pk));
          const g = grid.place(pk.timestamp);
          return { pkt: pk, timestamp: g.ts, jumped: g.jumped };
        }
      };
      const acfgString = as ? await audioTrack.getCodecParameterString().catch(() => null) : null;
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
