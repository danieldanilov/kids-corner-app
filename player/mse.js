// ManagedMediaSource sink on the persistent <video>: one muxed SourceBuffer, one append in flight
// (avoids WebKit bug 305712), MMS streaming events drive how far ahead the remuxer may run.
// Spec: playback.md section 2.

export function mediaSourceClass() {
  return globalThis.ManagedMediaSource || globalThis.MediaSource || null;
}

export function isTypeSupported(mime) {
  const MS = mediaSourceClass();
  try { return !!MS && MS.isTypeSupported(mime); } catch { return false; }
}

// durationSec: the probed length. Without a duration WebKit clamps currentTime to the end of what's appended, so
// a seek past it sticks there for good even after the data arrives; with an unknown length, ensureDuration(t)
// stretches it before each seek.
export function createMseSink(video, mime, { audioMime = null, onEvicted, onStreamingChange, durationSec = null } = {}) {
  const MS = mediaSourceClass();
  if (!MS) throw new Error('no MediaSource');
  const managed = MS === globalThis.ManagedMediaSource;
  const ms = new MS();
  let sb = null, asb = null, url = null, closed = false, streaming = true;
  let dropped = []; // ranges we removed ourselves: their bufferedchange is not the browser evicting
  const queue = [];
  let pumping = false;

  video.disableRemotePlayback = true;
  const opened = new Promise((resolve, reject) => {
    ms.addEventListener('sourceopen', () => {
      try {
        sb = ms.addSourceBuffer(mime);
        sb.mode = 'segments';
        if (audioMime) asb = ms.addSourceBuffer(audioMime); // audio/mpeg: sequence mode, placed by timestampOffset
        if (Number.isFinite(durationSec) && durationSec > 0) { try { ms.duration = durationSec; } catch { /* left to the appends */ } }
        if (managed) {
          sb.addEventListener('bufferedchange', e => {
            const removed = e.removedRanges;
            if (!removed || !removed.length) return;
            const t = video.currentTime;
            const ours = i => dropped.some(([a, b]) => removed.start(i) >= a - 0.5 && removed.end(i) <= b + 0.5);
            for (let i = 0; i < removed.length; i++) if (removed.end(i) > t + 0.5 && !ours(i)) { onEvicted?.(Math.max(t, removed.start(i))); break; }
          });
        }
        resolve();
      } catch (e) { reject(e); }
    }, { once: true });
  });
  if (managed) {
    streaming = false;
    ms.addEventListener('startstreaming', () => { streaming = true; onStreamingChange?.(true); });
    ms.addEventListener('endstreaming', () => { streaming = false; onStreamingChange?.(false); });
  }
  url = URL.createObjectURL(ms);
  video.src = url;

  const idleOf = b => (b && b.updating ? new Promise(r => b.addEventListener('updateend', r, { once: true })) : Promise.resolve());
  const waitIdle = async () => { await idleOf(sb); await idleOf(asb); };

  function appendOnce(data, target = sb) {
    const sb = target;
    return new Promise((resolve, reject) => {
      const done = () => { sb.removeEventListener('error', fail); resolve(); };
      const fail = () => { sb.removeEventListener('updateend', done); reject(new Error('append error')); };
      sb.addEventListener('updateend', done, { once: true });
      sb.addEventListener('error', fail, { once: true });
      try { sb.appendBuffer(data); } catch (e) { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); reject(e); }
    });
  }

  async function evictBehind() {
    const t = video.currentTime;
    if (t > 12) { for (const b of [sb, asb]) if (b) { await waitIdle(); b.remove(0, t - 10); } await waitIdle(); return true; }
    return false;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      await opened;
      while (queue.length && !closed) {
        const { data, which, offset, resolve, reject, keep } = queue.shift();
        if (keep) { // drop whole buffered ranges lying entirely outside [keep.from, keep.to]
          try {
            for (const b of [sb, asb]) {
              if (!b) continue;
              await waitIdle();
              const r = b.buffered, gone = [];
              for (let i = 0; i < r.length; i++) if (r.end(i) < keep.from || r.start(i) > keep.to) gone.push([r.start(i), r.end(i)]);
              for (const [s0, e0] of gone) { dropped.push([s0, e0]); if (dropped.length > 20) dropped.shift(); b.remove(s0, e0); await waitIdle(); }
            }
          } catch { /* the buffer went away */ }
          resolve();
          continue;
        }
        const target = which === 'audio' ? asb : sb;
        try {
          await waitIdle();
          if (!target) throw new Error('no buffer for ' + which);
          if (offset != null) target.timestampOffset = offset;
          try { await appendOnce(data, target); } catch (e) {
            if (e?.name === 'QuotaExceededError' && (await evictBehind())) await appendOnce(data, target);
            else throw e;
          }
          resolve();
        } catch (e) { reject(e); }
      }
    } finally { pumping = false; }
  }

  return {
    opened,
    managed,
    get streaming() { return streaming; },
    // which: 'main' (fMP4) or 'audio' (audio/mpeg); offset sets that buffer's timestampOffset first.
    append(data, which = 'main', offset = null) {
      if (closed) return Promise.reject(new Error('closed'));
      return new Promise((resolve, reject) => { queue.push({ data, which, offset, resolve, reject }); pump(); });
    },
    get split() { return !!asb; },
    // A seek to t that starts a new run: buffered ranges far from t are dropped first (40 seeks around a long file
    // otherwise pile ranges up in the media process: its memory went 96 -> 245 MB). Whole ranges only, queued
    // ahead of the new run's segments.
    dropFarFrom(t, behind = 30, ahead = 180) {
      if (closed) return Promise.resolve();
      return new Promise(resolve => { queue.push({ keep: { from: t - behind, to: t + ahead }, resolve, reject: resolve }); pump(); });
    },
    // Make sure a seek to t isn't clamped: true when the duration already reaches t (or was stretched to it now);
    // false while a buffer is updating, and then whenIdle() is the moment to try again.
    ensureDuration(t) {
      try {
        if (!(t > 0) || closed || ms.readyState === 'closed' || !sb) return true;
        const d = ms.duration;
        if (Number.isFinite(d) && d >= t + 0.5) return true;
        if (sb.updating || asb?.updating) return false;
        ms.duration = t + 1;
        return true;
      } catch { return true; } // a torn-down source: nothing to stretch
    },
    whenIdle: () => waitIdle(),
    debugRanges() {
      const r = b => { if (!b) return null; const out = []; for (let i = 0; i < b.buffered.length; i++) out.push([+b.buffered.start(i).toFixed(3), +b.buffered.end(i).toFixed(3)]); return out; };
      return { main: r(sb), audio: r(asb), audioMode: asb?.mode, readyState: video.readyState };
    },
    dropQueued() { while (queue.length) queue.shift().resolve(); },
    bufferedEndAt(t) {
      const b = video.buffered;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.3 && b.end(i) >= t) return b.end(i);
      return null;
    },
    async end() {
      await opened; await waitIdle();
      while (queue.length || pumping) { await new Promise(r => setTimeout(r, 50)); await waitIdle(); }
      if (ms.readyState === 'open') { try { ms.endOfStream(); } catch { /* ignore */ } }
    },
    destroy() {
      closed = true;
      this.dropQueued();
      try { if (ms.readyState === 'open') ms.endOfStream(); } catch { /* ignore */ }
      video.removeAttribute('src');
      try { video.load(); } catch { /* ignore */ }
      if (url) URL.revokeObjectURL(url);
    },
  };
}
