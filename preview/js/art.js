// Inline SVG art, ported from the Designer's prototype (design/mockup.html): Pom, chip pictures, row signs, icons.
const I = {
 tv:`<svg viewBox="0 0 72 72"><circle cx="20" cy="15" r="8" fill="#4D97C6"/><circle cx="52" cy="15" r="8" fill="#4D97C6"/><rect x="8" y="18" width="56" height="42" rx="12" fill="#fff"/><rect x="15" y="25" width="42" height="28" rx="7" fill="#2B2541"/><circle cx="29" cy="37" r="3" fill="#fff"/><circle cx="43" cy="37" r="3" fill="#fff"/><path d="M31 44q5 4 10 0" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/><rect x="22" y="60" width="6" height="7" rx="2" fill="#fff"/><rect x="44" y="60" width="6" height="7" rx="2" fill="#fff"/></svg>`,
 popcorn:`<svg viewBox="0 0 72 72"><circle cx="24" cy="22" r="10" fill="#FFF6DA"/><circle cx="36" cy="16" r="11" fill="#FFF6DA"/><circle cx="48" cy="22" r="10" fill="#FFF6DA"/><circle cx="30" cy="26" r="9" fill="#FFE8A8"/><circle cx="43" cy="27" r="9" fill="#FFE8A8"/><path d="M14 30h44l-6 36H20z" fill="#fff"/><path d="M22 30h7l1 36h-7zM36 30h7l-1 36h-7z" fill="#E35E7E"/></svg>`,
 moon:`<svg viewBox="0 0 72 72"><path d="M44 10a26 26 0 1 0 18 40A22 22 0 0 1 44 10z" fill="#FFF3C4"/><circle cx="34" cy="38" r="2.6" fill="#6466BA"/><path d="M24 44q4 3 8 0" stroke="#6466BA" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M56 12l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8z" fill="#FFF3C4"/></svg>`,
 yt:`<svg viewBox="0 0 72 72"><rect x="6" y="14" width="60" height="44" rx="16" fill="#fff"/><path d="M30 26l16 10-16 10z" fill="#DE7658"/><circle cx="24" cy="24" r="3" fill="#2B2541"/><circle cx="48" cy="24" r="3" fill="#2B2541"/></svg>`,
 book:`<svg viewBox="0 0 72 72"><path d="M36 26c-8-6-18-6-28-4v34c10-2 20-2 28 4z" fill="#fff"/><path d="M36 26c8-6 18-6 28-4v34c-10-2-20-2-28 4z" fill="#FFF6DA"/><path d="M36 26v34" stroke="#DDA634" stroke-width="2.5"/><path d="M28 14q8-6 16 0M24 8q12-9 24 0" stroke="#fff" stroke-width="3.5" fill="none" stroke-linecap="round"/></svg>`,
 doll:`<svg viewBox="0 0 72 72"><ellipse cx="36" cy="48" rx="20" ry="20" fill="#E8736A"/><circle cx="36" cy="24" r="15" fill="#E8736A"/><circle cx="36" cy="25" r="10" fill="#FFE3CF"/><circle cx="32" cy="24" r="1.8" fill="#2B2541"/><circle cx="40" cy="24" r="1.8" fill="#2B2541"/><circle cx="30.5" cy="28" r="2" fill="#F59A9A"/><circle cx="41.5" cy="28" r="2" fill="#F59A9A"/><ellipse cx="36" cy="50" rx="11" ry="12" fill="#FFF6DA"/><circle cx="36" cy="48" r="5" fill="#FFD064"/></svg>`,
 bus:`<svg viewBox="0 0 72 72"><rect x="8" y="10" width="56" height="48" rx="10" fill="#E8736A"/><rect x="14" y="16" width="12" height="10" rx="3" fill="#E8F7FF"/><rect x="30" y="16" width="12" height="10" rx="3" fill="#E8F7FF"/><rect x="46" y="16" width="12" height="10" rx="3" fill="#E8F7FF"/><rect x="14" y="33" width="12" height="10" rx="3" fill="#E8F7FF"/><rect x="30" y="33" width="12" height="10" rx="3" fill="#E8F7FF"/><rect x="46" y="33" width="12" height="16" rx="3" fill="#E8F7FF"/><rect x="8" y="29" width="56" height="2.5" fill="#C9564F"/><circle cx="22" cy="60" r="7" fill="#2B2541"/><circle cx="52" cy="60" r="7" fill="#2B2541"/></svg>`,
 heart:`<svg viewBox="0 0 64 64"><path class="hf" d="M32 54S8 40 8 23a12 12 0 0 1 24-4 12 12 0 0 1 24 4c0 17-24 31-24 31z" fill="#F2708F" stroke="#F2708F" stroke-width="4" stroke-linejoin="round"/></svg>`,
 heartO:`<svg viewBox="0 0 64 64"><path class="hf" d="M32 54S8 40 8 23a12 12 0 0 1 24-4 12 12 0 0 1 24 4c0 17-24 31-24 31z" stroke="#F2708F" stroke-width="5" stroke-linejoin="round"/></svg>`,
 half:`<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="24" fill="none" stroke="currentColor" stroke-width="5" opacity=".35"/><path d="M32 8a24 24 0 0 1 0 48" fill="none" stroke="#4D97C6" stroke-width="6" stroke-linecap="round"/><path d="M26 22l14 10-14 10z" fill="currentColor"/></svg>`,
 sprout:`<svg viewBox="0 0 64 64"><path d="M32 56V30" stroke="#41A684" stroke-width="5" stroke-linecap="round"/><path d="M32 34c-2-12-12-16-20-14 0 10 8 16 20 14zM32 30c2-12 12-16 20-14 0 10-8 16-20 14z" fill="#72D0AF"/><path d="M18 56h28" stroke="#C88F5A" stroke-width="5" stroke-linecap="round"/></svg>`,
 house:`<svg viewBox="0 0 64 64"><path d="M10 30L32 11l22 19" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 27v24a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3V27" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/><rect x="27" y="38" width="10" height="16" rx="3" fill="currentColor"/></svg>`,
 backA:`<svg viewBox="0 0 64 64"><path d="M52 32H18" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><path d="M32 16L16 32l16 16" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
 prev:`<svg viewBox="0 0 64 64"><path d="M48 16L24 32l24 16z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><rect x="12" y="14" width="8" height="36" rx="3" fill="currentColor"/></svg>`,
 back:`<svg viewBox="0 0 64 64"><path d="M38 14L20 32l18 18" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
 left:`<svg viewBox="0 0 64 64"><path d="M38 14L20 32l18 18" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
 right:`<svg viewBox="0 0 64 64"><path d="M26 14l18 18-18 18" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
 play:`<svg viewBox="0 0 64 64"><path d="M22 14l28 18-28 18z" fill="currentColor" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/></svg>`,
 pause:`<svg viewBox="0 0 64 64"><rect x="16" y="14" width="11" height="36" rx="4" fill="currentColor"/><rect x="37" y="14" width="11" height="36" rx="4" fill="currentColor"/></svg>`,
 rew:`<svg viewBox="0 0 64 64"><path d="M18 22A18 18 0 1 1 14 36" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M10 12l8 12 12-6" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><text x="34" y="40" font-size="15" font-weight="900" text-anchor="middle" fill="currentColor" font-family="Nunito">15</text></svg>`,
 fwd:`<svg viewBox="0 0 64 64"><path d="M46 22A18 18 0 1 0 50 36" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M54 12l-8 12-12-6" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><text x="30" y="40" font-size="15" font-weight="900" text-anchor="middle" fill="currentColor" font-family="Nunito">15</text></svg>`,
 next:`<svg viewBox="0 0 64 64"><path d="M16 16l24 16-24 16z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><rect x="44" y="14" width="8" height="36" rx="3" fill="currentColor"/></svg>`,
 again:`<svg viewBox="0 0 64 64"><path d="M49 34A17 17 0 1 1 43 21" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/><path d="M49 27L36 25L46 14z" fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg>`,
 check:`<svg viewBox="0 0 64 64"><path d="M14 34l12 12 24-26" fill="none" stroke="#41A684" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
 lock:`<svg class="lk" viewBox="0 0 40 40"><rect x="8" y="17" width="24" height="18" rx="5" fill="currentColor"/><path d="M13 17v-4a7 7 0 0 1 14 0v4" fill="none" stroke="currentColor" stroke-width="3.5"/></svg>`,
 speaker:`<svg viewBox="0 0 32 32"><path d="M6 12h5l7-6v20l-7-6H6z" fill="#2B2541"/><path d="M22 11q4 5 0 10M25 8q7 8 0 16" stroke="#2B2541" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>`,
};

const withClass = (s, cls) => /^<svg class="/.test(s) ? s.replace('<svg class="', `<svg class="${cls} `) : s.replace('<svg ', `<svg class="${cls}" `);

// Pom, the companion (spec 3). mood: 'day' | 'night' | 'sleep' | 'wave'
function pomSvg(cls = '') {return `<svg class="pom ${cls}" viewBox="0 0 200 200" aria-label="Pom">
 <g class="pom-b">
  <g class="sprout-top"><path d="M100 62C100 48 99 38 102 26" stroke="#3E8F70" stroke-width="7" fill="none" stroke-linecap="round"/>
   <path d="M102 30C90 12 70 8 58 16c8 17 28 22 44 14z" fill="#5FBF97" stroke="#3E8F70" stroke-width="4" stroke-linejoin="round"/>
   <path d="M102 27c10-19 30-25 44-17-6 18-26 25-44 17z" fill="#5FBF97" stroke="#3E8F70" stroke-width="4" stroke-linejoin="round"/>
   <path d="M98 26C88 20 76 17 66 18M106 23c10-7 22-10 32-9" stroke="#A6E3C6" stroke-width="3" fill="none" stroke-linecap="round"/></g>
  <g class="arm-l"><ellipse cx="34" cy="138" rx="14" ry="20" fill="#5FBF97" stroke="#3E8F70" stroke-width="4"/></g>
  <ellipse cx="72" cy="182" rx="20" ry="11" fill="#5FBF97" stroke="#3E8F70" stroke-width="4"/><ellipse cx="128" cy="182" rx="20" ry="11" fill="#5FBF97" stroke="#3E8F70" stroke-width="4"/>
  <ellipse cx="100" cy="120" rx="72" ry="64" fill="#A6E3C6" stroke="#3E8F70" stroke-width="5"/>
  <ellipse cx="100" cy="146" rx="40" ry="28" fill="#DDF6EA"/>
  <g class="arm-r"><ellipse cx="164" cy="140" rx="14" ry="20" fill="#5FBF97" stroke="#3E8F70" stroke-width="4"/></g>
  <g class="eyes"><circle cx="78" cy="110" r="7.5" fill="#2B2541"/><circle cx="122" cy="110" r="7.5" fill="#2B2541"/><circle cx="80.5" cy="107.5" r="2.4" fill="#fff"/><circle cx="124.5" cy="107.5" r="2.4" fill="#fff"/></g>
  <g class="eyes-c" style="display:none"><path d="M70 111q8 6 16 0M114 111q8 6 16 0" stroke="#2B2541" stroke-width="4" fill="none" stroke-linecap="round"/></g>
  <ellipse cx="62" cy="128" rx="11" ry="7" fill="#F59A9A"/><ellipse cx="138" cy="128" rx="11" ry="7" fill="#F59A9A"/>
  <path d="M92 127q8 8 16 0" stroke="#2B2541" stroke-width="4" fill="none" stroke-linecap="round"/>
 </g>
 <g class="cap"><path d="M44 74C50 30 110 14 150 52c8 8 4 18-4 16C120 52 80 50 50 82z" fill="#4B4FA8"/><path d="M146 52c16 4 24 20 22 36" fill="none" stroke="#4B4FA8" stroke-width="14" stroke-linecap="round"/><circle cx="168" cy="94" r="12" fill="#EDE8FF"/><path d="M80 44l2.4 4.8 5.2.7-3.8 3.7.9 5.2-4.7-2.5-4.7 2.5.9-5.2-3.8-3.7 5.2-.7z" fill="#FFF3C4"/><path d="M112 34l2 4 4.4.6-3.2 3.1.8 4.4-4-2.1-4 2.1.8-4.4-3.2-3.1 4.4-.6z" fill="#FFF3C4"/></g>
</svg>`}
export function pom(mood = 'day', cls = '') {
  const m = { day: '', night: 'night', sleep: 'asleep night', wave: 'wave' }[mood] ?? '';
  return pomSvg(`${m} ${cls}`.trim());
}

export const CHIP_ART = { shows: I.tv, movies: I.popcorn, bedtime: I.moon, youtube: I.yt, stories: I.book, russian: I.doll, british: I.bus };
export const ROW_ART = { myshows: I.heart, keep: I.half, new: I.sprout, stories: I.book, sleepyshows: I.moon, sleepyvideos: I.yt };
export const ROW_LABEL = { myshows: 'My shows', keep: 'Keep watching', new: 'New', stories: 'Stories', sleepyshows: 'Sleepy shows', sleepyvideos: 'Sleepy videos' };
export const ICONS = Object.fromEntries(Object.entries({
  home: I.house, back: I.backA, play: I.play, prev: I.prev, pause: I.pause, back15: I.rew, fwd15: I.fwd, next: I.next, again: I.again,
  heart: I.heartO, heartFull: I.heart, lock: I.lock, left: I.left, right: I.right, check: I.check,
}).map(([k, v]) => [k, withClass(v, 'icon')]));

// Cushion for the end of a shelf and the sleeping screens.
export const CUSHION = '<svg viewBox="0 0 200 60" class="cushion" aria-hidden="true"><ellipse cx="100" cy="36" rx="92" ry="22" fill="#C9B6E8"/><ellipse cx="100" cy="30" rx="84" ry="16" fill="#DCCDF5"/></svg>';

