// Test double for the player, used only when localStorage 'kcFakePlayer' is set (Playwright runs).
// Emits the real event names on a fixed timeline so screens can be driven without the network.
export function createFakePlayer({ fake }) {
  const cfg = typeof fake === 'object' ? fake : {};
  const loadMs = cfg.loadMs ?? 2400, failAll = cfg.failAll ?? false;
  return {
    source: 'fake',
    unlock() {},
    prefetch() {},
    play(item, { startAt = 0, youtubeHost } = {}) {
      globalThis.__kcLastPlay = { kind: item.kind, youtubeHost, videoId: item.videoId, startAt };   // tests read what the app asked for
      const lengthS = cfg.lengths?.[item.videoId] ?? cfg.lengthS ?? 6;
      const t = new EventTarget();
      const emit = (type, detail) => t.dispatchEvent(new CustomEvent(type, { detail }));
      let pos = startAt, playing = false, timers = [];
      const later = (ms, fn) => timers.push(setTimeout(fn, ms));
      const steps = 6;
      for (let i = 0; i <= steps; i++) later((loadMs / steps) * i, () => emit('progress', { fraction: i / steps, stage: i < 3 ? 'resolving' : 'buffering' }));
      const needsTap = (cfg.needsTapFor || []).includes(item.kind);
      if (needsTap) later(Math.min(1500, loadMs / 2), () => emit('needs-tap', { state: -1, reason: 'unstarted' }));
      later(loadMs + 10 + (needsTap ? 4000 : 0), () => {
        if (failAll) { emit('failed-all', { reasons: ['probe-duration', 'no-cached-stream'] }); return; }
        emit('ready'); playing = true;
        emit('report', { ttffMs: loadMs, fileSize: 141000000, container: 'mp4', path: 'direct', candidate: { name: '[TB+] Torrentio 1080p', filename: 'Fake.S01E01.mp4', url: 'https://cdn.example/x' }, fallbacks: [{ reason: 'probe-duration', filename: 'Wrong.mkv' }], failures: [] });
        const tick = setInterval(() => {
          if (!playing) return;
          pos += 0.5;
          emit('time', { position: pos, duration: lengthS });
          if (pos >= lengthS) { clearInterval(tick); playing = false; emit('ended'); }
        }, 500);
        timers.push(tick);
      });
      globalThis.__kcFakeSession = t;   // tests can act as YouTube's own pause (a touch on the iframe)
      return Object.assign(t, {
        pause() { if (playing) { playing = false; emit('paused'); } }, resume() { playing = true; emit('resumed'); },   // like the real player
        seek(s) { pos = Math.max(0, Math.min(lengthS, s)); emit('time', { position: pos, duration: lengthS }); },
        stop() { playing = false; timers.forEach(x => { clearTimeout(x); clearInterval(x); }); },
      });
    },
  };
}
