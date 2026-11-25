// YouTube's own IFrame player on youtube-nocookie.com, logo untouched.
// Approach (closest to YouTube's terms that still keeps suggestion panels away from her): the player is
// never covered or altered; instead the whole iframe is HIDDEN (visibility:hidden) whenever it is not
// playing or buffering. Pause, the end, and the moments before playback starts are therefore our own
// screens. We also stop a fraction of a second before the end so the end panel never renders.
// One YT.Player instance is kept for the whole session, so skipping to another video is loadVideoById
// on a warm player (fast start), never a new iframe.

export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

// ---- YouTube v2 (Boss ruling 2026-11-25: Daniel accepts breaking YouTube's terms on her iPad) ----
// Ad detection, from signals measured on real pre-roll and mid-roll ads: during an ad the API keeps the
// content's id and duration and reports state -1 (2 if paused), while the player's own progressState
// (sent in its postMessage "infoDelivery") carries the ad's duration with allowSeeking false.
export function classifyAd({ state, contentDuration, progress, clockRunning }) {
  if (state === YT_STATE.ENDED) return false;
  if (progress && Number.isFinite(progress.duration)) {
    if (progress.allowSeeking === false) return true;  // measured: false for every ad, true for content
    if (progress.allowSeeking === true) return false;  // content is never muted on a duration difference
    return contentDuration > 0 && Math.abs(progress.duration - contentDuration) > 1.5;
  }
  return state === YT_STATE.UNSTARTED && !!clockRunning;
}
// Muted while an ad plays; content always gets its sound back unless the app itself asked for silence.
export const desiredMute = ({ ad, appMuted }) => !!(ad || appMuted);

// The blocking layer covers the whole player. Holes, as fractions of the player box:
// - during an ad, the whole bottom-right quadrant, from the first moment. YouTube puts Skip a fixed number of
//   pixels from the box's bottom-right corner, so as a fraction it moves with the box's size (83-93 % down in a
//   360 px box, 94-97 % in the app's 962 px portrait box); the quadrant holds it at any size, while the ad's
//   title and advertiser link (top) and its "Sponsored" info button (bottom-left) stay covered;
// - YouTube's big play button, when it shows its own start screen because iOS refused the start.
export const SKIP_HOLE = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
export const PLAY_HOLE = { x: 0.4, y: 0.37, w: 0.2, h: 0.26 };
export function holeFor({ ad, adElapsed = 0, needsTap = false, skipHole = true }) {
  if (ad) return skipHole ? SKIP_HOLE : null; // adElapsed kept in the signature for callers; Skip's timing is YouTube's
  return needsTap ? PLAY_HOLE : null;
}
// Four rectangles around the hole (or one covering everything): blocks taps without covering pixels' meaning.
export function shieldRects(hole) {
  if (!hole) return [{ x: 0, y: 0, w: 1, h: 1 }];
  const { x, y, w, h } = hole;
  return [
    { x: 0, y: 0, w: 1, h: y },                 // above
    { x: 0, y: y + h, w: 1, h: 1 - y - h },     // below
    { x: 0, y, w: x, h },                       // left
    { x: x + w, y, w: 1 - x - w, h },           // right
  ].filter(r => r.w > 0 && r.h > 0);
}
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

export const YT_HOSTS = { nocookie: 'https://www.youtube-nocookie.com', youtube: 'https://www.youtube.com' };
export const ytHostName = h => (h === 'youtube' ? 'youtube' : 'nocookie');

// host: 'nocookie' (default) or 'youtube'. www.youtube.com is there so Daniel can test whether a signed-in
// YouTube Premium session removes ads; everything else (parameters, hiding, the end guard) is identical.
export function createYouTubeHost(container, { muted = false, host = 'nocookie' } = {}) {
  const mount = document.createElement('div');
  mount.style.cssText = 'width:100%;height:100%';
  container.appendChild(mount);
  if (!container.style.position && getComputedStyle(container).position === 'static') container.style.position = 'relative';
  let player = null, ready = false, handler = null;
  const show = on => { container.style.visibility = on ? 'visible' : 'hidden'; container.dataset.kcVisible = on ? '1' : '0'; };
  show(false);

  // Blocking layer: transparent rectangles over the player, all of it or all but one hole. A tap on it never
  // reaches YouTube; it goes to the session (onShieldTap) so the app can show its own overlay.
  const shield = document.createElement('div');
  shield.className = 'kc-yt-shield';
  shield.style.cssText = 'position:absolute;inset:0;z-index:2;pointer-events:none';
  container.appendChild(shield);
  let shieldOn = false, holeKey = 'none';
  function layout(hole) {
    const key = shieldOn ? JSON.stringify(hole) : 'off';
    if (key === holeKey) return;
    holeKey = key;
    shield.replaceChildren();
    if (!shieldOn) return;
    for (const r of shieldRects(hole)) {
      const d = document.createElement('div');
      d.style.cssText = `position:absolute;left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;` +
        'pointer-events:auto;background:transparent;touch-action:none;-webkit-tap-highlight-color:transparent;' +
        '-webkit-touch-callout:none;-webkit-user-select:none;user-select:none';
      d.addEventListener('pointerdown', e => {
        e.preventDefault(); e.stopPropagation();
        const b = container.getBoundingClientRect();
        handler?.onShieldTap?.({ x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height });
      });
      shield.appendChild(d);
    }
    shield.dataset.hole = hole ? 'open' : 'none';
  }

  // The player's own infoDelivery messages carry progressState (the ad's duration during an ad).
  let progress = null;
  addEventListener('message', e => {
    let frame = null;
    try { frame = player?.getIframe?.(); } catch { frame = null; }
    if (!frame || e.source !== frame.contentWindow) return;
    let d = e.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
    const info = d && typeof d === 'object' ? d.info : null;
    if (info && typeof info === 'object' && info.progressState && typeof info.progressState === 'object') {
      progress = { duration: +info.progressState.duration, allowSeeking: info.progressState.allowSeeking };
      handler?.onInfo?.(); // re-judge at once: an ad's first message must not wait for the next poll
    }
  });

  const readyP = loadYouTubeApi().then(YT => new Promise(resolve => {
    player = new YT.Player(mount, {
      host: YT_HOSTS[ytHostName(host)],
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
    host: ytHostName(host),
    shield(on, hole = null) { shieldOn = !!on; layout(hole); },
    progress() { return progress; },
    resetProgress() { progress = null; },
    destroy() { handler = null; try { player?.destroy(); } catch { /* ignore */ } container.replaceChildren(); },
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
