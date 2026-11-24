// Thin adapter over the Player engineer's module (./player/index.js, contract in app/player/README.md).
// Until it lands, a small built-in stand-in plays YouTube and audio and reports TorBox titles as
// 'no-player' (a setup reason, so nothing gets hidden). Same events either way:
// progress {fraction, stage}, ready, stalled, resumed, time {position, duration}, ended, failed-all {reasons}, report {...}.

export const EVENTS = ['progress', 'ready', 'stalled', 'resumed', 'time', 'ended', 'failed-all', 'report'];

export async function createPlayback(opts) {
  if (opts.fake) return (await import('./fake-player.js')).createFakePlayer(opts);
  try {
    const mod = await import('../player/index.js');
    if (typeof mod.createPlayer === 'function') return wrap(mod.createPlayer(opts), 'player');
  } catch { /* module not deployed yet */ }
  return wrap(createStandIn(opts), 'stand-in');
}

function wrap(p, source) {
  p.source = source;
  return p;
}

const emit = (t, type, detail) => t.dispatchEvent(new CustomEvent(type, { detail }));

// ---------- stand-in ----------
let ytApi = null;
function loadYouTubeApi() {
  if (ytApi) return ytApi;
  ytApi = new Promise((res, rej) => {
    if (window.YT?.Player) return res(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); res(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApi = null; rej(new Error('yt api')); };
    document.head.appendChild(s);
  });
  return ytApi;
}

function createStandIn({ video, ytContainer, audio }) {
  let current = null;
  return {
    unlock() {
      try { video.muted = true; const p = video.play(); p?.catch?.(() => {}); video.pause(); video.muted = false; } catch { /* ignore */ }
      loadYouTubeApi().catch(() => {});
    },
    prefetch() {},
    play(item, { startAt = 0 } = {}) {
      current?.stop();
      const t = new EventTarget();
      const t0 = performance.now();
      let timer = null, stopped = false, yt = null;
      const stop = () => {
        stopped = true; clearInterval(timer);
        try { yt?.destroy(); } catch { /* ignore */ }
        if (item.kind === 'audio') { audio.pause(); audio.removeAttribute('src'); audio.load(); }
      };
      const s = Object.assign(t, {
        pause() { item.kind === 'youtube' ? yt?.pauseVideo() : audio.pause(); },
        resume() { item.kind === 'youtube' ? yt?.playVideo() : audio.play().catch(() => {}); },
        seek(sec) { item.kind === 'youtube' ? yt?.seekTo(sec, true) : (audio.currentTime = sec); },
        stop,
      });
      current = s;
      queueMicrotask(() => emit(t, 'progress', { fraction: null, stage: 'starting' }));

      if (item.kind === 'audio') {
        audio.src = item.url;
        audio.currentTime = startAt || 0;
        audio.play().catch(() => {});
        audio.oncanplay = () => { if (stopped) return; emit(t, 'ready'); emit(t, 'report', { ttffMs: Math.round(performance.now() - t0), path: 'audio', fallbacks: [], failures: [] }); audio.oncanplay = null; };
        audio.onwaiting = () => emit(t, 'stalled');
        audio.onplaying = () => emit(t, 'resumed');
        audio.onended = () => { emit(t, 'ended'); };
        audio.onerror = () => { emit(t, 'failed-all', { reasons: ['audio-error'] }); };
        timer = setInterval(() => emit(t, 'time', { position: audio.currentTime, duration: audio.duration || 0 }), 1000);
      } else if (item.kind === 'youtube') {
        loadYouTubeApi().then((YT) => {
          if (stopped) return;
          const host = document.createElement('div');
          ytContainer.replaceChildren(host);
          yt = new YT.Player(host, {
            host: 'https://www.youtube-nocookie.com', videoId: item.ytId, width: '100%', height: '100%',
            playerVars: { playsinline: 1, rel: 0, iv_load_policy: 3, fs: 0, disablekb: 1, controls: 0, start: Math.floor(startAt || 0), origin: location.origin },
            events: {
              onReady: () => { yt.playVideo(); },
              onStateChange: (e) => {
                if (e.data === 1) { if (!s._ready) { s._ready = true; emit(t, 'ready'); emit(t, 'report', { ttffMs: Math.round(performance.now() - t0), path: 'youtube', fallbacks: [], failures: [] }); } else emit(t, 'resumed'); }
                if (e.data === 3 && s._ready) emit(t, 'stalled');
                if (e.data === 0) emit(t, 'ended');
              },
              onError: (e) => emit(t, 'failed-all', { reasons: ['youtube-' + e.data] }),
            },
          });
          timer = setInterval(() => { try { emit(t, 'time', { position: yt.getCurrentTime(), duration: yt.getDuration() }); } catch { /* not ready */ } }, 1000);
        }).catch(() => emit(t, 'failed-all', { reasons: ['youtube-api'] }));
      } else {
        queueMicrotask(() => emit(t, 'failed-all', { reasons: ['no-player'] }));
      }
      return s;
    },
  };
}
