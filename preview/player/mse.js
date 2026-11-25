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

export function createMseSink(video, mime, { audioMime = null, onEvicted, onStreamingChange } = {}) {
  const MS = mediaSourceClass();
  if (!MS) throw new Error('no MediaSource');
  const managed = MS === globalThis.ManagedMediaSource;
  const ms = new MS();
  let sb = null, asb = null, url = null, closed = false, streaming = true;
  const queue = [];
  let pumping = false;

  video.disableRemotePlayback = true;
  const opened = new Promise((resolve, reject) => {
    ms.addEventListener('sourceopen', () => {
      try {
        sb = ms.addSourceBuffer(mime);
        sb.mode = 'segments';
        if (audioMime) asb = ms.addSourceBuffer(audioMime); // audio/mpeg: sequence mode, placed by timestampOffset
        if (managed) {
          sb.addEventListener('bufferedchange', e => {
            const removed = e.removedRanges;
            if (!removed || !removed.length) return;
            const t = video.currentTime;
            for (let i = 0; i < removed.length; i++) if (removed.end(i) > t + 0.5) { onEvicted?.(Math.max(t, removed.start(i))); break; }
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
        const { data, which, offset, resolve, reject } = queue.shift();
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
