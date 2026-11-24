// Inline SVG art: Pom the companion, chip pictures, row signs and the control icons (spec 3, 4.1, 4.5).
const svg = (vb, body, cls = '') => `<svg viewBox="${vb}" class="${cls}" aria-hidden="true" focusable="false">${body}</svg>`;

// Pom: a round apricot puff. mood: 'day' | 'night' | 'sleep' | 'wave'
export function pom(mood = 'day', cls = '') {
  const night = mood === 'night' || mood === 'sleep';
  const eyes = mood === 'sleep'
    ? '<path d="M70 104q8 6 16 0M114 104q8 6 16 0" stroke="#2B2541" stroke-width="5" fill="none" stroke-linecap="round"/>'
    : night
      ? '<path d="M70 102h16M114 102h16" stroke="#2B2541" stroke-width="6" stroke-linecap="round"/><circle cx="78" cy="106" r="5" fill="#2B2541"/><circle cx="122" cy="106" r="5" fill="#2B2541"/>'
      : '<circle cx="78" cy="102" r="7" fill="#2B2541"/><circle cx="122" cy="102" r="7" fill="#2B2541"/><circle cx="80" cy="99" r="2.2" fill="#fff"/><circle cx="124" cy="99" r="2.2" fill="#fff"/>';
  const cap = night
    ? `<path d="M52 70Q60 18 128 22q30 4 44 40Q130 40 52 70z" fill="#4A4C9A"/><path d="M52 70q60-26 120-8" stroke="#3A3C82" stroke-width="8" fill="none" stroke-linecap="round"/>
       <circle cx="176" cy="66" r="11" fill="#EDE8FF"/><path d="M100 36l3 6 6 1-5 4 1 6-5-3-5 3 1-6-5-4 6-1z" fill="#FFE9A8"/><path d="M134 40l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z" fill="#FFE9A8"/>` : '';
  const arm = mood === 'wave'
    ? '<g class="pom-arm"><ellipse cx="166" cy="104" rx="13" ry="22" fill="#F5A96A" transform="rotate(-30 166 124)"/></g>'
    : '<ellipse cx="168" cy="132" rx="12" ry="18" fill="#F5A96A" transform="rotate(-20 168 132)"/>';
  return svg('0 0 200 200', `
    <g class="pom-body">
      <ellipse cx="100" cy="178" rx="64" ry="9" fill="rgba(43,37,65,.12)"/>
      <circle cx="58" cy="58" r="17" fill="#DE8C4E"/><circle cx="142" cy="58" r="17" fill="#DE8C4E"/>
      <ellipse cx="100" cy="112" rx="74" ry="64" fill="#F5A96A"/>
      <path d="M92 52q8-18 20-6" stroke="#DE8C4E" stroke-width="7" fill="none" stroke-linecap="round"/>
      <ellipse cx="32" cy="132" rx="12" ry="18" fill="#F5A96A" transform="rotate(20 32 132)"/>
      ${arm}
      ${eyes}
      <ellipse cx="62" cy="124" rx="11" ry="7" fill="#F59A9A" opacity=".85"/><ellipse cx="138" cy="124" rx="11" ry="7" fill="#F59A9A" opacity=".85"/>
      <path d="M90 122q10 10 20 0" stroke="#2B2541" stroke-width="5" fill="none" stroke-linecap="round"/>
      ${cap}
    </g>`, 'pom ' + cls);
}

const ink = '#2B2541';
// Chip pictures, picture first (spec 4.1).
export const CHIP_ART = {
  shows: svg('0 0 100 100', `<path d="M36 22l-10-12M64 22l10-12" stroke="${ink}" stroke-width="5" stroke-linecap="round"/><circle cx="25" cy="10" r="5" fill="${ink}"/><circle cx="75" cy="10" r="5" fill="${ink}"/>
    <rect x="12" y="24" width="76" height="56" rx="14" fill="#fff" stroke="${ink}" stroke-width="5"/><rect x="22" y="33" width="56" height="38" rx="8" fill="#BFE6FF"/>
    <circle cx="40" cy="50" r="4" fill="${ink}"/><circle cx="60" cy="50" r="4" fill="${ink}"/><path d="M43 60q7 6 14 0" stroke="${ink}" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M30 80l-6 10M70 80l6 10" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>`),
  movies: svg('0 0 100 100', `<circle cx="34" cy="26" r="12" fill="#FFF6D8"/><circle cx="52" cy="20" r="13" fill="#FFF6D8"/><circle cx="68" cy="28" r="12" fill="#FFF6D8"/><circle cx="46" cy="32" r="10" fill="#FFF0BF"/>
    <path d="M22 34h56l-8 56H30z" fill="#fff" stroke="${ink}" stroke-width="5" stroke-linejoin="round"/><path d="M38 36l3 52M60 36l-3 52" stroke="#EE8FAB" stroke-width="8"/>`),
  bedtime: svg('0 0 100 100', `<path d="M62 14a36 36 0 1 0 24 56A30 30 0 0 1 62 14z" fill="#FFF3C4" stroke="${ink}" stroke-width="5" stroke-linejoin="round"/>
    <path d="M74 20l3 7 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" fill="#fff" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/><path d="M38 58q5 4 10 0" stroke="${ink}" stroke-width="4" fill="none" stroke-linecap="round"/>`),
  youtube: svg('0 0 100 100', `<rect x="10" y="22" width="80" height="58" rx="18" fill="#fff" stroke="${ink}" stroke-width="5"/><path d="M42 36l24 15-24 15z" fill="#FF9E7C" stroke="${ink}" stroke-width="4" stroke-linejoin="round"/>
    <circle cx="28" cy="40" r="3.5" fill="${ink}"/><circle cx="28" cy="58" r="3.5" fill="${ink}" opacity="0"/>`),
  stories: svg('0 0 100 100', `<path d="M50 34q-16-10-38-8v50q22-2 38 8q16-10 38-8V26q-22-2-38 8z" fill="#fff" stroke="${ink}" stroke-width="5" stroke-linejoin="round"/><path d="M50 34v50" stroke="${ink}" stroke-width="4"/>
    <path d="M70 14q8 6 0 14M78 8q14 12 0 26" stroke="${ink}" stroke-width="4" fill="none" stroke-linecap="round"/>`),
  russian: svg('0 0 100 100', `<ellipse cx="50" cy="66" rx="28" ry="26" fill="#fff" stroke="${ink}" stroke-width="5"/><circle cx="50" cy="30" r="20" fill="#fff" stroke="${ink}" stroke-width="5"/>
    <circle cx="50" cy="32" r="11" fill="#FFE3CF"/><circle cx="46" cy="31" r="2" fill="${ink}"/><circle cx="54" cy="31" r="2" fill="${ink}"/><circle cx="44" cy="36" r="2.5" fill="#F59A9A"/><circle cx="56" cy="36" r="2.5" fill="#F59A9A"/>
    <path d="M40 66q10-12 20 0q-10 14-20 0z" fill="#72D0AF"/><circle cx="50" cy="66" r="4" fill="#FFD064"/>`),
  british: svg('0 0 100 100', `<rect x="12" y="18" width="76" height="62" rx="12" fill="#fff" stroke="${ink}" stroke-width="5"/><path d="M12 48h76" stroke="${ink}" stroke-width="4"/>
    <rect x="20" y="26" width="16" height="14" rx="3" fill="#BFE6FF"/><rect x="42" y="26" width="16" height="14" rx="3" fill="#BFE6FF"/><rect x="64" y="26" width="16" height="14" rx="3" fill="#BFE6FF"/>
    <rect x="20" y="55" width="16" height="14" rx="3" fill="#BFE6FF"/><rect x="42" y="55" width="16" height="14" rx="3" fill="#BFE6FF"/><circle cx="30" cy="84" r="8" fill="${ink}"/><circle cx="70" cy="84" r="8" fill="${ink}"/>`),
};

export const ROW_ART = {
  myshows: svg('0 0 100 100', `<path d="M50 82S14 60 14 36a18 18 0 0 1 36-6a18 18 0 0 1 36 6c0 24-36 46-36 46z" fill="#F59A9A" stroke="${ink}" stroke-width="5" stroke-linejoin="round"/>`),
  keep: svg('0 0 100 100', `<circle cx="50" cy="50" r="36" fill="#fff" stroke="${ink}" stroke-width="5"/><path d="M50 14a36 36 0 0 1 0 72z" fill="#BFE6FF"/><circle cx="50" cy="50" r="36" fill="none" stroke="${ink}" stroke-width="5"/><path d="M42 36l20 14-20 14z" fill="${ink}"/>`),
  new: svg('0 0 100 100', `<path d="M50 86V48" stroke="#5B9A3A" stroke-width="6" stroke-linecap="round"/><path d="M50 56q-30 0-30-26q28 0 30 26z" fill="#A8D56E" stroke="${ink}" stroke-width="4"/><path d="M50 48q24-2 28-26q-26 0-28 26z" fill="#A8D56E" stroke="${ink}" stroke-width="4"/><path d="M30 86h40" stroke="${ink}" stroke-width="5" stroke-linecap="round"/>`),
  stories: null, sleepyshows: null, sleepyvideos: null,
};
ROW_ART.stories = CHIP_ART.stories;
ROW_ART.sleepyshows = CHIP_ART.bedtime;
ROW_ART.sleepyvideos = CHIP_ART.youtube;

const icon = (body) => svg('0 0 64 64', body, 'icon');
const st = 'stroke="currentColor" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"';
export const ICONS = {
  home: icon(`<path d="M10 30L32 12l22 18" ${st}/><path d="M16 26v24h32V26" ${st}/><path d="M27 50V38h10v12" ${st}/>`),
  back: icon(`<path d="M40 12L20 32l20 20" ${st}/>`),
  play: icon('<path d="M22 12l28 20-28 20z" fill="currentColor" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>'),
  pause: icon('<rect x="16" y="12" width="11" height="40" rx="4" fill="currentColor"/><rect x="37" y="12" width="11" height="40" rx="4" fill="currentColor"/>'),
  back15: icon(`<path d="M18 22a20 20 0 1 1-4 18" ${st}/><path d="M12 10v14h14" ${st}/><text x="33" y="40" text-anchor="middle" font-size="16" font-weight="900" fill="currentColor" font-family="Nunito,system-ui">15</text>`),
  fwd15: icon(`<path d="M46 22a20 20 0 1 0 4 18" ${st}/><path d="M52 10v14H38" ${st}/><text x="31" y="40" text-anchor="middle" font-size="16" font-weight="900" fill="currentColor" font-family="Nunito,system-ui">15</text>`),
  next: icon('<path d="M14 12l26 20-26 20z" fill="currentColor"/><rect x="42" y="12" width="9" height="40" rx="3" fill="currentColor"/>'),
  again: icon(`<path d="M50 32a18 18 0 1 1-6-13.4" ${st}/><path d="M46 8v12H34" ${st}/>`),
  heart: icon('<path d="M32 54S8 40 8 23a12 12 0 0 1 24-4a12 12 0 0 1 24 4c0 17-24 31-24 31z" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/>'),
  heartFull: icon('<path d="M32 54S8 40 8 23a12 12 0 0 1 24-4a12 12 0 0 1 24 4c0 17-24 31-24 31z" fill="#F07A8E" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/>'),
  lock: icon('<rect x="14" y="28" width="36" height="26" rx="6" fill="currentColor"/><path d="M22 28v-8a10 10 0 0 1 20 0v8" stroke="currentColor" stroke-width="6" fill="none"/>'),
  left: icon(`<path d="M38 14L20 32l18 18" ${st}/>`),
  right: icon(`<path d="M26 14l18 18-18 18" ${st}/>`),
  check: icon('<path d="M14 34l12 12 24-26" stroke="currentColor" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
};

// Cushion for the end of a shelf and the good night screen.
export const CUSHION = svg('0 0 200 60', '<ellipse cx="100" cy="36" rx="92" ry="22" fill="#C9B6E8"/><ellipse cx="100" cy="30" rx="84" ry="16" fill="#DCCDF5"/>', 'cushion');
