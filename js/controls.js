// Auto-hiding player controls (spec v4, 4.5): shown until playback runs, faded out 3 s after the last touch while
// playing, revealed by a touch on the picture (that touch never pauses or presses anything: the buttons take taps
// only 250 ms later), kept up while paused or stalled, and a tap on the scrim between buttons only restarts the
// count. YouTube tucks them away at once while it plays (hideNow), since nothing may sit over a playing iframe.
// Timers are injectable so the rules are unit-tested.
export const HIDE_AFTER_MS = 3000;
export const TAP_GUARD_MS = 250;

export function createAutoHide({ onChange = () => {}, onGuard = () => {}, timers = globalThis, delay = HIDE_AFTER_MS } = {}) {
  let visible = true, playing = false, timer = null, guarded = false, guardTimer = null;
  const set = (v) => { if (v !== visible) { visible = v; onChange(v); } };
  const clear = () => { if (timer != null) { timers.clearTimeout(timer); timer = null; } };
  const arm = () => { clear(); if (playing) timer = timers.setTimeout(() => { timer = null; if (playing) set(false); }, delay); };
  const guard = () => {
    if (guardTimer != null) timers.clearTimeout(guardTimer);
    guarded = true; onGuard(true);
    guardTimer = timers.setTimeout(() => { guardTimer = null; guarded = false; onGuard(false); }, TAP_GUARD_MS);
  };
  return {
    get visible() { return visible; },
    get guarded() { return guarded; },
    // Playing (true) arms the hide timer; paused, stalled or not started (false) shows the controls and keeps them.
    setPlaying(p) { playing = !!p; if (playing) arm(); else { clear(); set(true); } },
    // A touch on the picture: hidden controls fade in (buttons guarded for 250 ms); shown ones just restart the count.
    touchVideo() {
      if (!visible) { set(true); guard(); arm(); return 'revealed'; }
      arm(); return 'kept';
    },
    // After a YouTube pause (a shield tap): the buttons ignore taps for 250 ms, so neither the same tap's click nor a
    // second tap lands on play (QA bug 7, review B1).
    guardTaps() { guard(); },
    // A touch on a control or the scrim: keep them up for another full delay.
    interact() { set(true); arm(); },
    // YouTube while it plays: nothing of ours over the iframe.
    hideNow() { clear(); if (playing) set(false); },
    destroy() { clear(); if (guardTimer != null) timers.clearTimeout(guardTimer); },
  };
}
