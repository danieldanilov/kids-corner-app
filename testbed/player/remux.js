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
      let aBuf = [], aStart = null, aEnd = null;
      const flushAudio = () => {
        if (!aBuf.length) return;
        const total = aBuf.reduce((n, d) => n + d.byteLength, 0);
        const data = new Uint8Array(total); let off = 0;
        for (const d of aBuf) { data.set(d, off); off += d.byteLength; }
        onSegment({ kind: 'audio', data, startSec: aStart, endSec: aEnd });
        aBuf = []; aStart = null;
      };
      await output.start();
      const vcfg = await videoTrack.getDecoderConfig();
      const acfg = as && !splitAudio ? await audioTrack.getDecoderConfig() : null;

      const vIt = vs.packets(vk), aIt = as ? as.packets(ak) : null;
      let v = (await vIt.next()).value, a = aIt ? (await aIt.next()).value : undefined;
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
            if (splitAudio) {
              if (aStart == null) aStart = a.timestamp;
              aBuf.push(a.data.slice());
              aEnd = a.timestamp + (a.duration || 0);
              if (aEnd - aStart >= 1) flushAudio();
            } else {
              await asrc.add(a, firstA ? { decoderConfig: acfg } : undefined);
            }
            firstA = false;
            a = (await aIt.next()).value;
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
