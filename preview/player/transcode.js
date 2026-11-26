// Transcode for inputs the remux path can't take (brief, Stream choice: every container and codec plays).
// Input: a transcode input (inputs.js: an AVI, or an MKV/MP4 whose video Safari can't play). Video is decoded by a
// pluggable decoder (decoders.js: raw I420 and H.264 built in, the rest by ffmpeg.wasm in windows of a GOP) and
// re-encoded to H.264 by WebCodecs, at no more than 1280x720. Audio passes through where Safari plays it: muxed
// into the fMP4 (AAC, AC-3, E-AC-3 ...; an AVI's AC-3 cut into sync frames first), or MP3 to the separate
// audio/mpeg buffer. Output: the same segments the remuxer gives ({kind:'init'|'media'|'audio', data, startSec,
// endSec}), so the MSE sink is shared.

import { aviInput } from './inputs.js';

// AC-3 frame sizes in 16-bit words, by frmsizecod (0..37) and fscod (48, 44.1, 32 kHz).
const AC3_WORDS = [
  [64, 69, 96], [64, 70, 96], [80, 87, 120], [80, 88, 120], [96, 104, 144], [96, 105, 144], [112, 121, 168], [112, 122, 168],
  [128, 139, 192], [128, 140, 192], [160, 174, 240], [160, 175, 240], [192, 208, 288], [192, 209, 288], [224, 243, 336], [224, 244, 336],
  [256, 278, 384], [256, 279, 384], [320, 348, 480], [320, 349, 480], [384, 417, 576], [384, 418, 576], [448, 487, 672], [448, 488, 672],
  [512, 557, 768], [512, 558, 768], [640, 696, 960], [640, 697, 960], [768, 835, 1152], [768, 836, 1152], [896, 975, 1344], [896, 976, 1344],
  [1024, 1114, 1536], [1024, 1115, 1536], [1152, 1253, 1728], [1152, 1254, 1728], [1280, 1393, 1920], [1280, 1394, 1920],
];
// Split a byte run into AC-3 sync frames; an unfinished frame at the end is returned as `rest` for the next run.
export function splitAc3(buf) {
  const frames = [];
  let o = 0;
  while (o + 6 <= buf.length) {
    if (buf[o] !== 0x0b || buf[o + 1] !== 0x77) { o++; continue; } // resync
    const fscod = buf[o + 4] >> 6, frmsizecod = buf[o + 4] & 0x3f;
    if (fscod > 2 || frmsizecod > 37) { o++; continue; }
    const len = AC3_WORDS[frmsizecod][fscod] * 2;
    if (o + len > buf.length) break;
    frames.push(buf.subarray(o, o + len));
    o += len;
  }
  return { frames, rest: buf.subarray(o) };
}

// What the encoder is asked for: H.264 High, level 3.1 (up to 1280x720 at 30 fps); probe.js gives MSE the same.
export const TRANSCODE_CODEC = 'avc1.64001F';
const MAX_LEADING = 8; // more missing frames than this at a GOP's start is a failed decode, not leading B-frames
const MAX_BAD_SEC = 20; // this much video in a row that won't decode fails the run; less is held on the last good picture

const concat = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; };
const fit = (w, h, maxW, maxH) => { const k = Math.min(1, maxW / w, maxH / h); return [Math.max(2, Math.round(w * k / 2) * 2), Math.max(2, Math.round(h * k / 2) * 2)]; };
// Mediabunny's codec names for audio passed through (its EncodedAudioPacketSource), from ours.
const MUX_AUDIO = { aac: 'aac', ac3: 'ac3', eac3: 'eac3', opus: 'opus', flac: 'flac', mp3: 'mp3', vorbis: 'vorbis' };

// input: inputs.js (aviInput / mediabunnyInput); an avi.js object is accepted and wrapped.
export function createTranscoder(M, input, { audioIndex = null, split = false, audioMp3 = false, decoders, maxWidth = 1280, maxHeight = 720, fragmentSec = 1, windowFrames = null, windowBytes = 48 << 20 } = {}) {
  if (input && !input.gops && input.packetsOf) input = aviInput(input);
  const vs = input.video;
  const as = audioIndex != null ? input.audio[audioIndex] || null : null; // audioIndex: position among the input's audio tracks
  const stats = { frames: 0, padded: 0, badWindows: 0 }; // frames encoded; how many repeat a neighbour to fill a slot; windows that failed to decode
  return {
    stats,
    async run({ startSec = 0, endSec = Infinity, onSegment, demand, signal } = {}) {
      const gops = input.gops(startSec);
      let next = await gops.next();
      if (next.done) return { done: true, aborted: false, empty: true };
      const t0 = next.value[0].pts;
      const audioIt = as ? input.audioPackets(audioIndex, t0) : null;
      let aNext = audioIt ? (await audioIt.next()).value : null;
      const [ow, oh] = fit(vs.width, vs.height, maxWidth, maxHeight);
      const decoder = await decoders.create(vs.codec, { width: vs.width, height: vs.height, extradata: vs.extradata, fps: vs.fps, aviHeader: input.aviHeader, outWidth: ow, outHeight: oh });
      const frameDur = 1 / vs.fps;
      const closeAll = async () => { decoder.close(); try { encoder.close(); } catch { /* closed */ } try { await output.cancel(); } catch { /* gone */ } try { await gops.return?.(); await audioIt?.return?.(); } catch { /* done */ } };

      let ftyp = null, moof = null, moofTs = 0, mdat = null, lastTs = t0;
      const flush = () => { if (moof && mdat) { onSegment({ kind: 'media', data: concat(moof, mdat), startSec: moofTs, endSec: lastTs }); moof = null; mdat = null; } };
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
      // H.264 through WebCodecs directly, with at most a few frames queued (each frame holds its own copy of the
      // picture, so an unbounded queue is what makes memory grow), muxed as encoded packets.
      const vsrc = new M.EncodedVideoPacketSource('avc');
      output.addVideoTrack(vsrc, { frameRate: vs.fps });
      const encoded = [];
      let encError = null, firstPacket = true, nextKey = -Infinity;
      const encoder = new VideoEncoder({ output: (chunk, meta) => encoded.push({ chunk, meta }), error: e => { encError = e; } });
      encoder.configure({ codec: TRANSCODE_CODEC, width: ow, height: oh, framerate: vs.fps, bitrate: Math.round(ow * oh * vs.fps * 0.12), hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' } });
      const drain = async () => {
        while (encoded.length) {
          const { chunk, meta } = encoded.shift();
          await vsrc.add(M.EncodedPacket.fromEncodedChunk(chunk), firstPacket ? meta : undefined);
          firstPacket = false;
        }
      };
      // Audio: an AVI's AC-3 comes in arbitrary chunks and is cut into sync frames; framed audio (MKV, MP4) is
      // muxed packet by packet with the track's decoder config; MP3 can instead go to the audio/mpeg buffer.
      if (audioMp3 && !decoders.toMp3) throw new Error('needs_audio_decoder');
      const ac3Chunks = as && !split && as.codec === 'ac3' && !as.framed;
      const muxFramed = as && !split && as.framed && MUX_AUDIO[as.codec];
      const asrc = ac3Chunks ? new M.EncodedAudioPacketSource('ac3') : muxFramed ? new M.EncodedAudioPacketSource(MUX_AUDIO[as.codec]) : null;
      if (asrc) output.addAudioTrack(asrc);
      await output.start();

      // Presentation timestamps: decoders give frames back in display order, so the n-th frame out takes the n-th
      // smallest pending input time (the frame slots), which also undoes B-frame reordering.
      const pending = [];
      const pushPts = p => { let i = pending.length; while (i > 0 && pending[i - 1] > p) i--; pending.splice(i, 0, p); };
      let outFrames = 0, firstAudio = true, ac3Rest = new Uint8Array(0), ac3Next = null;
      let aBuf = [], aStart = null, aEnd = null;
      // Audio Safari can't play goes to ffmpeg in batches and comes back as MP3 for the audio/mpeg buffer; each
      // batch is placed at its own time (discontinuity), so the encoder's padding never adds up into drift.
      let mp3Batch = [], mp3First = true;
      const flushMp3 = async () => {
        if (!mp3Batch.length) return;
        const batch = mp3Batch; mp3Batch = [];
        const last = batch[batch.length - 1];
        try {
          const data = await decoders.toMp3({ makeFile: () => input.audioFile(audioIndex, batch), channels: as.channels, signal });
          if (data.length) onSegment({ kind: 'audio', data, startSec: batch[0].pts, endSec: last.pts + (last.dur || 0), discontinuity: true });
        } catch (e) {
          if (e?.aborted || aborted()) throw e;
          stats.badAudio = (stats.badAudio || 0) + 1; // a damaged stretch of audio: silence there, the picture goes on
        }
        mp3First = false;
      };
      const aborted = () => signal?.aborted;
      const emitFrames = async frames => {
        for (const f of frames) {
          const ts = pending.length ? pending.shift() : t0 + outFrames * frameDur;
          const us = Math.round(ts * 1e6), dur = Math.round(frameDur * 1e6);
          let frame = f.data
            ? new VideoFrame(f.data, { format: 'I420', codedWidth: f.width, codedHeight: f.height, timestamp: us, duration: dur })
            : new VideoFrame(f, { timestamp: us, duration: dur });
          f.close?.();
          if (frame.codedWidth !== ow || frame.codedHeight !== oh) {
            // Scale down on a canvas (a decoder that gives full size frames): the output is at most 1280x720.
            const cv = new OffscreenCanvas(ow, oh); cv.getContext('2d').drawImage(frame, 0, 0, ow, oh); frame.close();
            frame = new VideoFrame(cv, { timestamp: us, duration: dur });
          }
          const key = ts >= nextKey; if (key) nextKey = ts + 2; // a keyframe every 2 s, so fragments and seeks stay short
          encoder.encode(frame, { keyFrame: key }); frame.close();
          while (encoder.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 1));
          if (encError) throw encError;
          await drain();
          outFrames++; stats.frames++; lastTs = Math.max(lastTs, ts + frameDur);
        }
      };
      const finishVideo = async () => { await encoder.flush(); await drain(); if (encError) throw encError; encoder.close(); };
      const flushAudio = () => {
        if (!aBuf.length) return;
        const total = aBuf.reduce((n, d) => n + d.byteLength, 0);
        const data = new Uint8Array(total); let off = 0;
        for (const d of aBuf) { data.set(d, off); off += d.byteLength; }
        onSegment({ kind: 'audio', data, startSec: aStart, endSec: aEnd });
        aBuf = []; aStart = null;
      };
      // Audio up to a time, interleaved with the video.
      const audioUntil = async t => {
        while (aNext && aNext.pts <= t) {
          const e = aNext;
          aNext = (await audioIt.next()).value || null;
          if (audioMp3) {
            mp3Batch.push(e);
            if (e.pts + (e.dur || 0) - mp3Batch[0].pts >= (mp3First ? 6 : 20)) await flushMp3();
          } else if (split) {
            if (aStart == null) aStart = e.pts;
            aBuf.push(e.data);
            aEnd = aNext ? aNext.pts : e.pts + (e.dur || 0);
            if (aEnd - aStart >= 1) flushAudio();
          } else if (ac3Chunks) {
            const { frames, rest } = splitAc3(ac3Rest.length ? concat(ac3Rest, e.data) : e.data);
            if (ac3Next == null) ac3Next = e.pts;
            const fd = 1536 / (as.sampleRate || 48000);
            for (const fr of frames) {
              await asrc.add(new M.EncodedPacket(fr.slice(), 'key', ac3Next, fd), firstAudio ? { decoderConfig: { codec: 'ac-3', numberOfChannels: as.channels || 2, sampleRate: as.sampleRate || 48000 } } : undefined);
              firstAudio = false; ac3Next += fd;
            }
            ac3Rest = rest.slice();
          } else if (muxFramed) {
            if (e.pts < 0) continue; // encoder priming before the start
            const cfg = as.decoderConfig || { codec: as.codec, numberOfChannels: as.channels || 2, sampleRate: as.sampleRate || 48000 };
            await asrc.add(new M.EncodedPacket(e.data, 'key', e.pts, e.dur || 0), firstAudio ? { decoderConfig: cfg } : undefined);
            firstAudio = false;
          }
        }
      };

      let stoppedAt = null, nextDemand = t0 + 1;
      const holdFor = async t => { // the player asks for no more than it needs ahead
        if (t < nextDemand) return true;
        nextDemand = t + 1;
        const wait = demand?.(t);
        if (wait) await wait;
        return !aborted();
      };
      const finishAll = async () => {
        if (stoppedAt == null) await audioUntil(Infinity); else await audioUntil(stoppedAt);
        if (audioMp3) await flushMp3();
        await finishVideo();
        decoder.close();
        await output.finalize();
        flush();
        flushAudio();
        try { await gops.return?.(); await audioIt?.return?.(); } catch { /* done */ }
        return stoppedAt != null ? { done: false, aborted: false, endSec: stoppedAt } : { done: true, aborted: false };
      };
      try {
        let first = true;
        if (decoder.window) {
          // Window decoders (ffmpeg.wasm) take runs of packets: each GOP is decoded from its keyframe in chunks of
          // at most W output frames, so memory stays bounded; a later chunk re-decodes from the keyframe and skips
          // the frames already given. The window is sized by its raw output (windowBytes, ~111 frames at 720x400,
          // ~34 at 1280x720): longer windows re-decode less of each GOP (faster), shorter ones hold less memory.
          const W = windowFrames || Math.max(16, Math.min(125, Math.floor(windowBytes / (ow * oh * 1.5))));
          // The last picture given, kept as a copy (the decoder's views go stale): it stands in for windows that
          // return nothing. Black until the first one.
          let held = null, badSec = 0;
          const blackFrame = () => { const d = new Uint8Array(ow * oh * 1.5); d.fill(16, 0, ow * oh); d.fill(128, ow * oh); return { data: d, width: ow, height: oh }; };
          for (; !next.done; next = await gops.next(), first = false) {
            const gop = next.value;
            if (!first && gop[0].pts >= endSec) { stoppedAt = gop[0].pts; break; }
            let dropped = 0;
            for (let c = 0; c < gop.length; c += W) {
              if (aborted() || !(await holdFor(gop[c].pts))) { await closeAll(); return { done: false, aborted: true }; }
              const end = Math.min(gop.length, c + W);
              await audioUntil(gop[end - 1].pts);
              let frames;
              try {
                frames = await decoder.decodeWindow(gop.slice(0, end), { skip: Math.max(0, c - dropped), signal });
                if (frames.length) badSec = 0;
              } catch (e) {
                if (e?.aborted || aborted()) throw e;
                // A damaged stretch (a bad block in a torrent): its slots hold the last good picture, the audio
                // plays on, and the next window or GOP decodes again. Only a long run of them fails the run.
                stats.badWindows++;
                badSec += (end - c) * frameDur;
                if (badSec > MAX_BAD_SEC) throw e;
                frames = [];
              }
              const missing = end - c - frames.length;
              if (!frames.length && missing > 0) { stats.padded += missing; frames = Array(missing).fill(held || blackFrame()); }
              else if (missing > 0) {
                // An open GOP's leading B-frames need the previous GOP and don't decode: the keyframe holds their
                // slots, and later chunks skip that many fewer. Any other shortfall repeats the last frame, so the
                // video track never has a hole for playback to stall on.
                stats.padded += missing;
                if (c === 0) { if (missing <= MAX_LEADING) dropped = missing; frames = [...Array(missing).fill(frames[0]), ...frames]; }
                else frames = [...frames, ...Array(missing).fill(frames[frames.length - 1])];
              }
              for (const e of gop.slice(c, end)) pushPts(e.pts);
              const given = frames.slice(0, end - c);
              const last = given[given.length - 1];
              if (last && last !== held) held = { data: last.data.slice(), width: last.width, height: last.height };
              await emitFrames(given);
              pending.length = 0; // pts belong to their own chunk
            }
          }
          return await finishAll();
        }
        for (; !next.done; next = await gops.next(), first = false) {
          const gop = next.value;
          if (!first && gop[0].pts >= endSec) { stoppedAt = gop[0].pts; break; }
          for (const e of gop) {
            if (aborted() || !(await holdFor(e.pts))) { await closeAll(); return { done: false, aborted: true }; }
            await audioUntil(e.pts);
            pushPts(e.pts);
            await emitFrames(await decoder.decode({ data: e.data, key: e.key, pts: e.pts }));
          }
        }
        await emitFrames(await decoder.flush());
        return await finishAll();
      } catch (err) {
        await closeAll();
        if (aborted()) return { done: false, aborted: true };
        throw err;
      }
    },
  };
}
