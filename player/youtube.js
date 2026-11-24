// YouTube's own IFrame player on youtube-nocookie.com, logo untouched.
// Approach (closest to YouTube's terms that still keeps suggestion panels away from her): the player is
// never covered or altered; instead the whole iframe is HIDDEN (visibility:hidden) whenever it is not
// playing or buffering. Pause, the end, and the moments before playback starts are therefore our own
// screens. We also stop a fraction of a second before the end so the end panel never renders.
// One YT.Player instance is kept for the whole session, so skipping to another video is loadVideoById
// on a warm player (fast start), never a new iframe.

export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
let apiPromise = null;

export function loadYouTubeApi() {
  if (globalThis.YT?.Player) return Promise.resolve(globalThis.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prev = globalThis.onYouTubeIframeAPIReady;
    globalThis.onYouTubeIframeAPIReady = () => { try { prev?.(); } catch { /* ignore */ } resolve(globalThis.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { apiPromise = null; reject(new Error('yt_api')); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

export const YT_PLAYER_VARS = {
  playsinline: 1, rel: 0, iv_load_policy: 3, fs: 0, disablekb: 1, controls: 0, cc_load_policy: 0,
  autoplay: 0, enablejsapi: 1,
};

export function createYouTubeHost(container, { muted = false } = {}) {
  const mount = document.createElement('div');
  mount.style.cssText = 'width:100%;height:100%';
  container.appendChild(mount);
  let player = null, ready = false, handler = null;
  const show = on => { container.style.visibility = on ? 'visible' : 'hidden'; container.dataset.kcVisible = on ? '1' : '0'; };
  show(false);

  const readyP = loadYouTubeApi().then(YT => new Promise(resolve => {
    player = new YT.Player(mount, {
      host: 'https://www.youtube-nocookie.com',
      width: '100%', height: '100%',
      playerVars: { ...YT_PLAYER_VARS, origin: location.origin },
      events: {
        onReady: () => { if (muted) { try { player.mute(); } catch { /* ignore */ } } ready = true; resolve(); },
        onStateChange: e => handler?.onState?.(e.data),
        onError: e => handler?.onError?.(e.data),
      },
    });
  }));
  readyP.catch(() => {});

  return {
    readyP,
    get ready() { return ready; },
    show,
    setHandler(h) { handler = h; },
    // Call synchronously inside a tap when the player is ready, so iOS treats it as user-initiated.
    load(videoId, startSeconds = 0) {
      const go = () => player.loadVideoById({ videoId, startSeconds });
      if (ready) { go(); return true; }
      readyP.then(go);
      return false;
    },
    // Diagnostic: show YouTube's own start screen (testbed ways-out check). Never used for her.
    cue(videoId) {
      const go = () => player.cueVideoById({ videoId });
      if (ready) { go(); return true; }
      readyP.then(go);
      return false;
    },
    play() { player?.playVideo(); },
    mute() { muted = true; try { player?.mute(); } catch { /* ignore */ } },
    unMute() { muted = false; try { player?.unMute(); } catch { /* ignore */ } },
    isMuted() { try { return !!player?.isMuted(); } catch { return null; } },
    pause() { player?.pauseVideo(); },
    seek(t) { player?.seekTo(t, true); },
    time() { try { return player?.getCurrentTime?.() || 0; } catch { return 0; } },
    duration() { try { return player?.getDuration?.() || 0; } catch { return 0; } },
    state() { try { return player?.getPlayerState?.(); } catch { return undefined; } },
  };
}
