// Auto-hiding player controls (Daniel 2026-11-25 (2)): visible until playback runs, hidden about 3 s after it
// does, revealed by a touch on the video (that touch never pauses), kept up while paused or stalled, and kept up
// for another 3 s after she touches a control. Timers are injectable so the rules are unit-tested.
export const HIDE_AFTER_MS = 3000;

export function createAutoHide({ onChange = () => {}, timers = globalThis, delay = HIDE_AFTER_MS } = {}) {
  let visible = true, playing = false, timer = null;
  const set = (v) => { if (v !== visible) { visible = v; onChange(v); } };
  const clear = () => { if (timer != null) { timers.clearTimeout(timer); timer = null; } };
  const arm = () => { clear(); if (playing) timer = timers.setTimeout(() => { timer = null; if (playing) set(false); }, delay); };
  return {
    get visible() { return visible; },
    // Playing (true) arms the hide timer; paused, stalled or not started (false) shows the controls and keeps them.
    setPlaying(p) { playing = !!p; if (playing) arm(); else { clear(); set(true); } },
    // A touch on the video: reveals hidden controls, or hides visible ones early. Never pauses.
    touchVideo() {
      if (!visible) { set(true); arm(); return 'revealed'; }
      if (playing) { clear(); set(false); return 'hidden'; }
      return 'kept';
    },
    // A touch on a control: keep them up for another full delay.
    interact() { set(true); arm(); },
    destroy() { clear(); },
  };
}
