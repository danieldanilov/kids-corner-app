// Test double for the player, used only when localStorage 'kcFakePlayer' is set (Playwright runs).
// Emits the real event names on a fixed timeline so screens can be driven without the network.
export function createFakePlayer({ fake, ytContainer = null }) {
  const cfg = typeof fake === 'object' ? fake : {};
  const loadMs = cfg.loadMs ?? 2400, failAll = cfg.failAll ?? false;
  return {
    source: 'fake',
    unlock() {},
    prefetch() {},
    play(item, { startAt = 0, youtubeHost, ytShield = false, ytAdMute = true } = {}) {
      globalThis.__kcLastPlay = { kind: item.kind, youtubeHost, videoId: item.videoId, startAt, ytShield, ytAdMute };   // tests read what the app asked for
      const lengthS = cfg.lengths?.[item.videoId] ?? cfg.lengthS ?? 6;
      const t = new EventTarget();
      const emit = (type, detail) => t.dispatchEvent(new CustomEvent(type, { detail }));
      let pos = startAt, playing = false, timers = [];
      const later = (ms, fn) => timers.push(setTimeout(fn, ms));
      const steps = 6;
      for (let i = 0; i <= steps; i++) later((loadMs / steps) * i, () => emit('progress', { fraction: i / steps, stage: i < 3 ? 'resolving' : 'buffering' }));
      const needsTap = (cfg.needsTapFor || []).includes(item.kind);
      if (needsTap) later(Math.min(1500, loadMs / 2), () => emit('needs-tap', { state: -1, reason: 'unstarted' }));
      // YouTube stand-in, like the real player (player/README.md): a box that counts the taps it receives and pauses
      // on a tap (YouTube's own tap-to-pause); with ytShield, a clear layer over it takes every tap as 'shield-tap'.
      // cfg.adMs: a pre-roll ad before the content ('ad' true, muted under ytAdMute; 'ad' false, sound back).
      const yt = item.kind === 'youtube' && ytContainer;
      const setMuted = (m) => { globalThis.__ytMuted = m; (globalThis.__ytMuteLog = globalThis.__ytMuteLog || []).push(m); };
      // During an ad the layer leaves YouTube's Skip reachable: the bottom-right quadrant, from the ad's first moment.
      const skipHole = (on) => { const sh = yt && ytContainer.querySelector('.fake-yt-shield'); if (sh) sh.style.clipPath = on ? 'polygon(0 0, 100% 0, 100% 50%, 50% 50%, 50% 100%, 0 100%)' : ''; };
      if (yt) {
        ytContainer.innerHTML = '<div class="fake-yt" style="position:absolute;inset:0;background:#2b2b2b"></div>' + (ytShield ? '<div class="fake-yt-shield" style="position:absolute;inset:0;z-index:2"></div>' : '');
        ytContainer.querySelector('.fake-yt').addEventListener('pointerdown', (e) => { globalThis.__ytTaps = (globalThis.__ytTaps || 0) + 1; if (inAd) { const r = ytContainer.getBoundingClientRect(); globalThis.__ytSkipTaps = (globalThis.__ytSkipTaps || 0) + ((e.clientX - r.left) / r.width > .5 && (e.clientY - r.top) / r.height > .5 ? 1 : 0); return; } t.pause?.(); });
        ytContainer.querySelector('.fake-yt-shield')?.addEventListener('pointerdown', (e) => {
          e.stopPropagation(); globalThis.__shieldTaps = (globalThis.__shieldTaps || 0) + 1;
          const r = ytContainer.getBoundingClientRect(); emit('shield-tap', { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
        });
      }
      const adMs = yt ? (cfg.adMs || 0) : 0;
      let inAd = false;
      const adStart = () => { inAd = true; skipHole(true); if (ytAdMute) setMuted(true); emit('ad', { active: true }); };
      const adEnd = () => { inAd = false; skipHole(false); if (ytAdMute) setMuted(false); emit('ad', { active: false }); };
      // cfg.midAd {afterMs, ms}: an ad partway into the content (no 'ready' after it, only 'ad' false).
      if (yt && cfg.midAd) {
        later(loadMs + 10 + cfg.midAd.afterMs, () => { playing = false; adStart(); });
        later(loadMs + 10 + cfg.midAd.afterMs + cfg.midAd.ms, () => { adEnd(); playing = true; });
      }
      if (adMs) {
        later(loadMs / 2, adStart);
        later(loadMs / 2 + adMs, adEnd);
      }
      later(loadMs + 10 + (needsTap ? 4000 : 0) + adMs, () => {
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
        stop() { playing = false; timers.forEach(x => { clearTimeout(x); clearInterval(x); }); if (yt) ytContainer.innerHTML = ''; },
      });
    },
  };
}
