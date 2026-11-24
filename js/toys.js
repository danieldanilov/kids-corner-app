// Loading toys (spec 5). One fixed toy per home category; Sleepy Moon for everything at bedtime.
// Each toy: a 1000x1000 SVG stage, tappable parts that answer on pointerdown with a fixed movement and sound,
// one progress element driven by the player's real progress, and a hand-off that reveals the video.
import { pom } from './art.js';

export const TOY_FOR = { shows: 'owl', movies: 'curtain', bedtime: 'moon', youtube: 'bubbles', stories: 'flower', russian: 'jelly', british: 'train' };
export const toyFor = (cat, bedtime) => bedtime ? 'moon' : (TOY_FOR[cat] || 'den');

// Display value eases toward the reported value (max 0.6/s) and never moves backwards (spec 5.4).
export function easeProgress(shown, target, dtSec) {
  if (target == null || target <= shown) return shown;
  return Math.min(target, shown + 0.6 * dtSec);
}

const TOYS = {
  owl: {
    bg: 'linear-gradient(#3E5C8A, #7CC4F0)',
    svg: () => `
      <path d="M0 720 Q500 640 1000 700" stroke="#6B4A33" stroke-width="40" fill="none" stroke-linecap="round"/>
      <g class="tap leaf" data-tone="196"><ellipse cx="200" cy="660" rx="80" ry="40" fill="#79B46A"/></g>
      <g class="tap leaf" data-tone="220"><ellipse cx="780" cy="640" rx="80" ry="40" fill="#79B46A"/></g>
      <g class="tap leaf" data-tone="247"><ellipse cx="880" cy="720" rx="70" ry="36" fill="#8CC57A"/></g>
      <g class="tap owl" data-tones="392,330">
        <ellipse cx="500" cy="480" rx="190" ry="220" fill="#9B6B4A"/>
        <ellipse cx="500" cy="540" rx="120" ry="140" fill="#F3E3C8"/>
        <path d="M360 300l40 70 40-60zM640 300l-40 70-40-60z" fill="#9B6B4A"/>
        <circle cx="430" cy="420" r="62" fill="#fff"/><circle cx="570" cy="420" r="62" fill="#fff"/>
        <circle cx="430" cy="420" r="28" fill="#2B2541"/><circle cx="570" cy="420" r="28" fill="#2B2541"/>
        <rect class="lid" x="366" y="356" width="128" height="128" rx="64" fill="#8A5C3E"/>
        <rect class="lid" x="506" y="356" width="128" height="128" rx="64" fill="#8A5C3E"/>
        <path d="M480 480l20 30 20-30z" fill="#F5A96A"/>
      </g>`,
    progress(el, p) { el.querySelectorAll('.lid').forEach(l => l.style.transform = `translateY(${-p * 120}px) scaleY(${1 - p})`); },
  },
  curtain: {
    bg: '#4A2A4F',
    svg: () => `
      <rect x="0" y="0" width="1000" height="140" fill="#7A3550"/>
      ${Array.from({ length: 7 }, (_, i) => `<circle class="bulb" cx="${140 + i * 120}" cy="80" r="26" fill="#6A4A40"/>`).join('')}
      <g class="pom-peek tap" data-tones="440,523"><foreignObject x="400" y="360" width="200" height="200">${pom('day')}</foreignObject></g>
      <g class="tap curtain-l" data-tone="196"><path d="M0 140h500v860H0z" fill="#B84A63"/><path d="M80 140v860M200 140v860M320 140v860M440 140v860" stroke="#9A3A52" stroke-width="22"/><rect x="40" y="560" width="120" height="30" rx="15" fill="#E7B64A"/></g>
      <g class="tap curtain-r" data-tone="185"><path d="M500 140h500v860H500z" fill="#B84A63"/><path d="M560 140v860M680 140v860M800 140v860M920 140v860" stroke="#9A3A52" stroke-width="22"/><rect x="840" y="560" width="120" height="30" rx="15" fill="#E7B64A"/></g>`,
    progress(el, p) { el.querySelectorAll('.bulb').forEach((b, i) => b.setAttribute('fill', p >= (i + 1) / 7 ? '#FFE9A8' : '#6A4A40')); },
  },
  moon: {
    bg: '#14163A',
    svg: () => `
      ${[[150, 200], [820, 160], [260, 700], [760, 640], [120, 480], [880, 430]].map(([x, y]) => `<g class="tap star" data-glow="1"><path transform="translate(${x} ${y}) scale(2.2)" d="M0-30l9 19 21 3-15 15 4 21-19-10-19 10 4-21-15-15 21-3z" fill="#F7E7A8"/></g>`).join('')}
      <circle cx="500" cy="400" r="190" fill="#F3EEDC"/>
      <circle cx="430" cy="380" r="22" fill="#2B2541"/><circle cx="570" cy="380" r="22" fill="#2B2541"/>
      <rect class="lid" x="400" y="320" width="60" height="0" fill="#E2DCC4"/><rect class="lid" x="540" y="320" width="60" height="0" fill="#E2DCC4"/>
      <path d="M450 470q50 30 100 0" stroke="#2B2541" stroke-width="12" fill="none" stroke-linecap="round"/>`,
    progress(el, p) { el.querySelectorAll('.lid').forEach(l => l.setAttribute('height', String(Math.round(p * 82)))); },
  },
  bubbles: {
    bg: '#DDF1FF',
    svg: () => `
      <g><rect x="80" y="700" width="40" height="260" rx="20" fill="#fff" stroke="#2B2541" stroke-width="10"/><rect class="handle" x="85" y="955" width="30" height="0" rx="14" fill="#FF9E7C"/>
      <circle cx="100" cy="660" r="56" fill="none" stroke="#2B2541" stroke-width="12"/></g>
      ${[[300, 520, 100, 330], [480, 300, 115, 392], [640, 560, 90, 440], [800, 260, 105, 494], [380, 140, 85, 523], [860, 600, 95, 587]].map(([x, y, r, f], i) =>
        `<g class="tap bubble drift d${i}" data-tone="${f}"><circle cx="${x}" cy="${y}" r="${r}" fill="rgba(255,255,255,.55)" stroke="#9CCDF0" stroke-width="8"/><circle cx="${x - r / 3}" cy="${y - r / 3}" r="${r / 5}" fill="#fff"/></g>`).join('')}`,
    progress(el, p) { const h = Math.round(p * 250); const r = el.querySelector('.handle'); r.setAttribute('height', String(h)); r.setAttribute('y', String(955 - h)); },
  },
  flower: {
    bg: '#FFF1D6',
    svg: () => `
      <g class="tap can" data-tones="523,587"><path d="M120 560h180v140H120z" fill="#7CC4F0" stroke="#2B2541" stroke-width="10"/><path d="M300 590l110-60" stroke="#2B2541" stroke-width="18" stroke-linecap="round"/><path d="M120 600q-60 0-40 60" stroke="#2B2541" stroke-width="14" fill="none"/></g>
      <rect class="stem" x="488" y="740" width="24" height="0" fill="#5B9A3A"/>
      <ellipse class="leaf1" cx="450" cy="600" rx="60" ry="26" fill="#79B46A" opacity="0"/>
      <ellipse class="leaf2" cx="550" cy="480" rx="60" ry="26" fill="#79B46A" opacity="0"/>
      <g class="tap sprout" data-tone="440"><circle class="bud" cx="500" cy="730" r="34" fill="#FFD064" stroke="#2B2541" stroke-width="8"/></g>
      <path d="M360 740h280l-40 200H400z" fill="#D9774E" stroke="#2B2541" stroke-width="10" stroke-linejoin="round"/>`,
    progress(el, p) {
      const h = Math.round(p * 420);
      const s = el.querySelector('.stem'); s.setAttribute('height', String(h)); s.setAttribute('y', String(740 - h));
      el.querySelector('.bud').setAttribute('cy', String(730 - h));
      el.querySelector('.leaf1').setAttribute('opacity', p >= 0.4 ? '1' : '0');
      el.querySelector('.leaf2').setAttribute('opacity', p >= 0.7 ? '1' : '0');
    },
  },
  jelly: {
    bg: '#D9F4EA',
    svg: () => `
      <defs><clipPath id="bowl"><circle cx="500" cy="560" r="330"/></clipPath></defs>
      <rect class="water" x="170" y="890" width="660" height="0" fill="#9FD9F5" opacity=".7" clip-path="url(#bowl)"/>
      ${[[360, 720, '#F5A3B8', 262], [500, 760, '#FFD064', 294], [640, 720, '#A8D56E', 330], [430, 600, '#8F91E4', 349], [580, 600, '#FF9E7C', 392]].map(([x, y, c, f]) =>
        `<g class="tap blob" data-tone="${f}"><ellipse cx="${x}" cy="${y}" rx="78" ry="62" fill="${c}"/><circle cx="${x - 22}" cy="${y - 10}" r="9" fill="#2B2541"/><circle cx="${x + 22}" cy="${y - 10}" r="9" fill="#2B2541"/></g>`).join('')}
      <circle cx="500" cy="560" r="330" fill="none" stroke="#fff" stroke-width="22" opacity=".9"/>`,
    progress(el, p) { const h = Math.round(p * 600); const w = el.querySelector('.water'); w.setAttribute('height', String(h)); w.setAttribute('y', String(890 - h)); },
  },
  train: {
    bg: 'linear-gradient(#CFEFFF, #CFEFFF 60%, #A8D56E 60%)',
    svg: () => `
      <rect x="0" y="760" width="1000" height="16" fill="#7A6A5A"/>
      <g class="station"><rect x="0" y="560" width="180" height="200" fill="#fff" stroke="#2B2541" stroke-width="10"/><path d="M-10 560l100-70 100 70z" fill="#EE8FAB" stroke="#2B2541" stroke-width="10"/><path d="M150 490v-120" stroke="#2B2541" stroke-width="10"/><path d="M150 370h70l-20 30 20 30h-70z" fill="#FFD064"/></g>
      <g class="tap car" data-tone="392"><rect x="420" y="620" width="200" height="130" rx="20" fill="#7CC4F0" stroke="#2B2541" stroke-width="10"/><rect x="455" y="645" width="130" height="60" rx="12" fill="#fff"/><circle cx="470" cy="760" r="24" fill="#2B2541"/><circle cx="570" cy="760" r="24" fill="#2B2541"/></g>
      <g class="tap car" data-tone="330"><rect x="200" y="620" width="200" height="130" rx="20" fill="#FFD064" stroke="#2B2541" stroke-width="10"/><rect x="235" y="645" width="130" height="60" rx="12" fill="#fff"/><circle cx="250" cy="760" r="24" fill="#2B2541"/><circle cx="350" cy="760" r="24" fill="#2B2541"/></g>
      <g class="tap car engine" data-tone="262"><rect x="640" y="580" width="240" height="170" rx="24" fill="#EE8FAB" stroke="#2B2541" stroke-width="10"/><rect x="660" y="520" width="60" height="70" fill="#2B2541"/><circle class="puff" cx="690" cy="470" r="0" fill="#fff"/><circle cx="700" cy="760" r="28" fill="#2B2541"/><circle cx="830" cy="760" r="28" fill="#2B2541"/></g>`,
    progress(el, p) { el.querySelector('.station').setAttribute('transform', `translate(${Math.round(1000 - p * 180)} 0)`); },
  },
  den: {
    bg: '#F6E8D3',
    svg: () => `
      <circle cx="800" cy="220" r="110" fill="#fff" stroke="#2B2541" stroke-width="10"/><path class="clock" d="M800 220L800 120A100 100 0 0 1 800 120Z" fill="#FFD064"/>
      <g class="tap ball" data-tone="330"><circle cx="230" cy="780" r="80" fill="#7CC4F0" stroke="#2B2541" stroke-width="10"/></g>
      <g class="tap drum" data-tone="220"><rect x="720" y="700" width="180" height="140" rx="30" fill="#EE8FAB" stroke="#2B2541" stroke-width="10"/></g>
      <foreignObject x="380" y="520" width="260" height="260">${pom('day')}</foreignObject>`,
    progress(el, p) {
      const a = p * 2 * Math.PI - 1e-4, x = 800 + 100 * Math.sin(a), y = 220 - 100 * Math.cos(a);
      el.querySelector('.clock').setAttribute('d', `M800 220L800 120A100 100 0 ${p > 0.5 ? 1 : 0} 1 ${x.toFixed(1)} ${y.toFixed(1)}Z`);
    },
  },
};

// Mount a toy into `host`. sound: the app's sound engine. Returns { setProgress(f|null), handoff(ms), destroy() }.
export function mountToy(host, name, { sound, reduced }) {
  const def = TOYS[name] || TOYS.den;
  host.innerHTML = `<div class="toy toy-${name}" style="background:${def.bg}"><svg class="stage" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet">${def.svg()}</svg></div>`;
  const el = host.firstElementChild;
  let shown = 0, target = null, last = performance.now(), raf = 0, looping = true;
  def.progress(el, 0);

  const onDown = (e) => {
    const part = e.target.closest('.tap');
    if (!part || !el.contains(part)) return;
    const tones = part.dataset.tones ? part.dataset.tones.split(',').map(Number) : part.dataset.tone ? [Number(part.dataset.tone)] : [];
    tones.forEach((f, i) => setTimeout(() => sound?.tone(f, 'sine', 0.22), i * 180));
    part.classList.remove('poke'); void part.getBoundingClientRect(); part.classList.add('poke');
    if (part.classList.contains('engine')) { const p = el.querySelector('.puff'); p.classList.remove('puffing'); void p.getBoundingClientRect(); p.classList.add('puffing'); }
  };
  el.addEventListener('pointerdown', onDown);

  const frame = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (target == null) {
      el.classList.add('looping');            // no fraction: a slow "getting close" cue, nothing fake moves toward done
    } else {
      el.classList.remove('looping');
      const next = easeProgress(shown, target, dt);
      if (next !== shown) { shown = next; def.progress(el, shown); }
    }
    if (looping) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    el,
    setProgress(f) { if (f == null) return; target = Math.max(target ?? 0, Math.min(1, f)); },
    get shown() { return shown; },
    async handoff(ms) {
      shown = 1; def.progress(el, 1);
      el.classList.add(reduced ? 'handoff-fade' : 'handoff', 'handoff-' + name);
      el.style.setProperty('--handoff', ms + 'ms');
      await new Promise(r => setTimeout(r, ms));
    },
    destroy() { looping = false; cancelAnimationFrame(raf); el.removeEventListener('pointerdown', onDown); host.innerHTML = ''; },
  };
}
