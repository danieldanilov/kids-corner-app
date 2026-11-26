// Loading toys (spec 5): ported from the Designer's prototype (design/mockup.html), wired to the real
// player progress. One fixed toy per home category; the Sleepy Moon for everything at bedtime.
// Each toy: set(p) for real progress 0..1, optional loop(on) when the player can't report a fraction,
// and handoff(done) for the match cut into the video playing underneath.
import { pom } from './art.js';

export const TOY_FOR = { shows: 'owl', movies: 'curtain', bedtime: 'moon', youtube: 'bubbles', music: 'bubbles', learn: 'bubbles', stories: 'sunflower', russian: 'jelly', british: 'train' };
export const toyFor = (cat, bedtime) => bedtime ? 'moon' : (TOY_FOR[cat] || 'owl');

// Display value eases toward the reported value (max 0.6/s) and never moves backwards (spec 5.4).
export function easeProgress(shown, target, dtSec) {
  if (target == null || target <= shown) return shown;
  return Math.min(target, shown + 0.6 * dtSec);
}

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
let SOUND = null, REVEAL = null;
const audio = () => {};
const under = () => {};
// One voice per element (review S2): a new tap on the same element within 250 ms makes no new tone,
// and a later tap fades out that element's previous tone first. The movement can still restart.
export const TONE_GAP_MS = 250;
export const toneAllowed = (lastAt, now) => lastAt == null || now - lastAt >= TONE_GAP_MS;
let TAPPED = null;          // the element whose tap handler is running
// tone(freq | [freqs], {dur, type, gap}): fixed pitches through the app's effects gain.
function tone(freqs, { dur = 0.22, type = 'sine', gap = 0.11 } = {}) {
  const el = TAPPED, now = performance.now();
  if (el) {
    if (!toneAllowed(el._toneAt, now)) return;
    el._toneAt = now;
    (el._voices || []).forEach(v => v?.fade());
    el._voices = [];
  }
  [].concat(freqs).forEach((f, i) => {
    const t = setTimeout(() => { const v = SOUND?.tone(f, type, dur); if (el && v) el._voices.push(v); }, i * gap * 1000);
    if (el) el._voices.push({ fade: () => clearTimeout(t) });
  });
}
const revealFrom = (el, done, shape) => REVEAL(el, done, shape);
function stage(inner) { return `<svg class="stage" viewBox="0 0 1000 1000">${inner}</svg>`; }
function onTap(root, sel, fn) { $$(sel, root).forEach(el => el.addEventListener('pointerdown', (e) => { e.preventDefault(); audio(); TAPPED = el; try { fn(el, e); } finally { TAPPED = null; } })); }
function retrigger(el, cls, ms) { el.classList.remove(cls); void el.getBoundingClientRect(); el.classList.add(cls); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove(cls), ms); }
const TOYS = {
 owl(root){ root.innerHTML=`<div class="toy-bg owl-sky owl-sky-l"></div>`+stage(`
   <g class="leaf" data-n="0"><ellipse cx="200" cy="700" rx="80" ry="40" fill="#5FA35A"/><circle class="hot" cx="200" cy="700" r="85"/></g>
   <rect x="40" y="700" width="920" height="40" rx="20" fill="#7A5236"/>
   <g class="leaf" data-n="1"><ellipse cx="800" cy="690" rx="80" ry="40" fill="#6BB565"/><circle class="hot" cx="800" cy="690" r="85"/></g>
   <g class="owl"><g class="wing l"><ellipse cx="335" cy="540" rx="60" ry="120" fill="#7E5439"/></g><g class="wing r"><ellipse cx="665" cy="540" rx="60" ry="120" fill="#7E5439"/></g>
    <path d="M370 330l30-70 50 60zM630 330l-30-70-50 60z" fill="#7E5439"/>
    <ellipse cx="500" cy="510" rx="185" ry="200" fill="#9B6B4A"/><ellipse cx="500" cy="580" rx="110" ry="120" fill="#F2DDBF"/>
    <defs><clipPath id="eL"><circle cx="430" cy="450" r="62"/></clipPath><clipPath id="eR"><circle cx="570" cy="450" r="62"/></clipPath></defs>
    <circle cx="430" cy="450" r="62" fill="#fff"/><circle cx="570" cy="450" r="62" fill="#fff"/><circle cx="438" cy="458" r="27" fill="#2B2541"/><circle cx="562" cy="458" r="27" fill="#2B2541"/>
    <rect class="lid" clip-path="url(#eL)" x="368" y="388" width="124" height="124" fill="#8A5D3F"/><rect class="lid" clip-path="url(#eR)" x="508" y="388" width="124" height="124" fill="#8A5D3F"/>
    <path d="M480 505h40l-20 30z" fill="#F2A33A"/><ellipse cx="450" cy="712" rx="30" ry="14" fill="#F2A33A"/><ellipse cx="550" cy="712" rx="30" ry="14" fill="#F2A33A"/>
    <ellipse class="hot" cx="500" cy="510" rx="190" ry="210"/></g>`);
  const sv=$('.stage',root);
  onTap(sv,'.owl .hot',()=>{retrigger($('.owl',sv),'ruffle',520);tone([392,330],{gap:.18,dur:.25});});
  onTap(sv,'.leaf',(el)=>{retrigger(el,'wig',520);tone(el.dataset.n==='0'?220:247,{type:'triangle',dur:.18});});
  return {set(p){$$('.lid',sv).forEach(l=>l.style.transform=`scaleY(${1-.92*p})`);},
   handoff(done){under();root.classList.add('owl-go');setTimeout(done,1200);}};},

 curtain(root,item){ root.innerHTML=`<div class="cur l"><span class="rope"></span><span class="cur-hit"></span></div><div class="peek">${pom()}</div><div class="cur r"><span class="rope"></span><span class="cur-hit"></span></div><div class="valance"></div><div class="bulbs">${'<i class="bulb"></i>'.repeat(7)}</div>`;
  onTap(root,'.cur',el=>{retrigger(el,'sway',620);tone(220,{dur:.3});});
  onTap(root,'.peek',el=>{el.classList.add('out');retrigger($('.pom',el),'wave',900);tone([330,392],{gap:.12});clearTimeout(el._o);el._o=setTimeout(()=>el.classList.remove('out'),1100);});
  return {set(p){$$('.bulb',root).forEach((b,i)=>b.classList.toggle('on',p>=(i+1)/7-.001));},
   loop(on){$('.bulbs',root).classList.toggle('loop',on);},
   handoff(done){under();root.classList.add('cur-go');setTimeout(done,1100);}};},

 moon(root){ const stars=[[160,180],[840,160],[120,560],[880,520],[300,790],[720,805]];
  root.innerHTML=`<div class="toy-bg moon-sky"></div>`+stage(`
   ${stars.map(([x,y],i)=>`<g class="star" data-n="${i}"><circle class="glow" cx="${x}" cy="${y}" r="95" fill="url(#sg)"/><path class="sp" transform="translate(${x} ${y})" d="M0-48 13-15 48-12 21 10 30 46 0 26-30 46-21 10-48-12-13-15z" fill="#E9E2B8" stroke="#E9E2B8" stroke-width="8" stroke-linejoin="round"/><circle class="hot" cx="${x}" cy="${y}" r="85"/></g>`).join('')}
   <defs><radialGradient id="sg"><stop offset="0" stop-color="#FFF6C8" stop-opacity=".9"/><stop offset="1" stop-color="#FFF6C8" stop-opacity="0"/></radialGradient>
    <clipPath id="mL"><circle cx="445" cy="440" r="26"/></clipPath><clipPath id="mR"><circle cx="555" cy="440" r="26"/></clipPath></defs>
   <circle cx="500" cy="470" r="190" fill="#F3EFD6"/><circle cx="430" cy="380" r="26" fill="#E6E0BF"/><circle cx="590" cy="560" r="34" fill="#E6E0BF"/>
   <circle cx="445" cy="440" r="26" fill="#2B2541"/><circle cx="555" cy="440" r="26" fill="#2B2541"/>
   <rect class="mlid" clip-path="url(#mL)" x="417" y="412" width="56" height="56" fill="#F3EFD6"/><rect class="mlid" clip-path="url(#mR)" x="527" y="412" width="56" height="56" fill="#F3EFD6"/>
   <path d="M465 520q35 25 70 0" stroke="#2B2541" stroke-width="9" fill="none" stroke-linecap="round"/><ellipse cx="410" cy="500" rx="22" ry="13" fill="#F2C9B8"/><ellipse cx="590" cy="500" rx="22" ry="13" fill="#F2C9B8"/>`);
  onTap(root,'.star',el=>{ if(el._lit)return; el._lit=1; el.classList.add('lit'); setTimeout(()=>el.classList.remove('lit'),1000); setTimeout(()=>el._lit=0,2000); });
  return {set(p){$$('.mlid',root).forEach(l=>l.style.transform=`scaleY(${p})`);},
   loop(on){root.classList.toggle('moonloop',on);},
   handoff(done){under();root.classList.add('moon-go');setTimeout(done,1500);}};},

 bubbles(root){ const B=[[330,330,105,'#FFD6E3',392],[560,250,95,'#D9F2FF',440],[780,360,115,'#FFF0C2',494],[420,600,100,'#DFF7E9',523],[660,620,110,'#E9E1FF',587],[860,700,90,'#FFE1D4',659]];
  root.innerHTML=`<div class="toy-bg bub-sky"></div>`+stage(`
   <defs><radialGradient id="bg1" cx=".35" cy=".3"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".25" stop-color="#fff" stop-opacity=".3"/><stop offset="1" stop-color="#fff" stop-opacity=".05"/></radialGradient>
    <clipPath id="wh"><rect x="-22" y="-10" width="44" height="300" rx="22"/></clipPath></defs>
   <g transform="translate(190 640) rotate(35)"><circle cx="0" cy="-60" r="58" fill="none" stroke="#DE7658" stroke-width="16"/><rect x="-22" y="-10" width="44" height="300" rx="22" fill="#FFE9E0" stroke="#DE7658" stroke-width="5"/>
    <g clip-path="url(#wh)"><rect class="wandfill" x="-22" y="290" width="44" height="300" fill="#DE7658"/></g></g>
   ${B.map(([x,y,r,t,f],i)=>`<g class="bub" data-f="${f}"><g class="bb"><circle cx="${x}" cy="${y}" r="${r}" fill="${t}" opacity=".75"/><circle cx="${x}" cy="${y}" r="${r}" fill="url(#bg1)" stroke="#fff" stroke-width="5" stroke-opacity=".9"/></g>
     <g class="puff">${[0,1,2,3,4,5].map(k=>`<circle cx="${x+Math.cos(k)*r*.8}" cy="${y+Math.sin(k)*r*.8}" r="12" fill="#fff"/>`).join('')}</g><circle class="hot" cx="${x}" cy="${y}" r="${Math.max(r,80)}"/></g>`).join('')}
   <g class="bigbub"><circle cx="500" cy="480" r="200" fill="url(#bg1)" stroke="#fff" stroke-width="8"/></g>`);
  onTap(root,'.bub',el=>{ if(el._p)return; el._p=1; el.classList.add('popped'); tone(+el.dataset.f,{dur:.14}); setTimeout(()=>{el.classList.remove('popped');el.classList.add('regrow');void el.getBoundingClientRect();el.classList.remove('regrow');el._p=0;},1200);});
  const wf=$('.wandfill',root);
  return {set(p){wf.setAttribute('y',290-300*p);},
   loop(on){wf.classList.toggle('wandloop',on); if(on) wf.setAttribute('y',90);},
   handoff(done){root.classList.add('bub-go');setTimeout(()=>revealFrom($('.bigbub circle',root),done),500);}};},

 sunflower(root,item){ const poster=item.poster||'';
  root.innerHTML=`<div class="toy-bg sun-bg"></div>`+stage(`
   <defs><clipPath id="fc"><circle cx="0" cy="0" r="62"/></clipPath></defs><g transform="translate(0 -70)">
   <g class="sprout"><g class="stem"><rect x="490" y="420" width="20" height="380" rx="10" fill="#5FA35A"/></g>
    <g class="leafx" style="transform-origin:0% 60%"><path d="M500 640c40-40 110-40 130-10-40 40-100 40-130 10z" fill="#6BB565"/></g>
    <g class="leafx" style="transform-origin:100% 60%"><path d="M500 540c-40-40-110-40-130-10 40 40 100 40 130 10z" fill="#6BB565"/></g>
    <g class="flower"><g transform="translate(500 420)"><g class="petals" transform="scale(.55)">${Array.from({length:12},(_,k)=>`<ellipse cx="0" cy="-105" rx="34" ry="62" fill="#FFC93C" transform="rotate(${k*30})"/>`).join('')}</g>
      <circle r="66" fill="#8A5A2B"/><image href="${poster}" x="-62" y="-62" width="124" height="124" clip-path="url(#fc)" preserveAspectRatio="xMidYMid slice" opacity=".0" class="fimg"/></g></g></g>
   <path d="M360 800h280l-30 170H390z" fill="#D9784E"/><rect x="340" y="770" width="320" height="50" rx="14" fill="#C86A43"/>
   <g class="can"><path d="M140 640h150v110a20 20 0 0 1-20 20H160a20 20 0 0 1-20-20z" fill="#72B7E0"/><path d="M290 670l90-50 10 18-90 52z" fill="#72B7E0"/><path d="M160 640q55-70 110 0" stroke="#5A9CC4" stroke-width="16" fill="none"/></g>
   <g class="drops"><circle class="drop" cx="395" cy="640" r="10" fill="#72B7E0"/><circle class="drop" cx="410" cy="660" r="9" fill="#72B7E0"/><circle class="drop" cx="385" cy="670" r="8" fill="#72B7E0"/></g>
   <rect class="hot canhot" x="120" y="580" width="290" height="210"/><rect class="hot pothot" x="340" y="770" width="320" height="200"/></g>`);
  const sv=$('.stage',root), can=$('.can',sv);
  const tip=()=>{can.classList.remove('tip');void can.getBoundingClientRect();can.classList.add('tip');setTimeout(()=>can.classList.remove('tip'),650);
    retrigger($('.sprout',sv),'wig',520);tone([523,587],{gap:.16,dur:.12});};
  onTap(sv,'.canhot',tip); onTap(sv,'.pothot',tip);
  return {set(p){$('.stem',sv).style.transform=`scaleY(${.15+.85*p})`; $('.flower',sv).style.transform=`translateY(${(1-p)*.85*380}px)`;
     const lx=$$('.leafx',sv); lx[0].classList.toggle('on',p>=.4); lx[1].classList.toggle('on',p>=.7);},
   handoff(done){root.classList.add('sun-go');const pe=$('.petals',sv),t0=performance.now();const st=()=>{const k=Math.min(1,(performance.now()-t0)/300);pe.setAttribute('transform',`scale(${.55+.45*(1-(1-k)*(1-k))})`);if(k<1)requestAnimationFrame(st);};requestAnimationFrame(st);$('.fimg',sv).setAttribute('opacity','1');setTimeout(()=>revealFrom($('.flower circle',sv),done),350);}};},

 jelly(root){ const J=[[330,800,'#F59A9A',247],[450,830,'#FFD064',277],[570,815,'#8F91E4',311],[680,790,'#7CC4F0',330],[500,720,'#A8D56E',370]];
  root.innerHTML=`<div class="toy-bg jelly-bg"></div>`+stage(`
   <defs><clipPath id="bowl"><circle cx="500" cy="600" r="320"/></clipPath></defs>
   <circle cx="500" cy="600" r="320" fill="rgba(255,255,255,.45)"/>
   <g clip-path="url(#bowl)"><g class="water"><rect x="160" y="280" width="680" height="700" fill="#9FD8F0" opacity=".55"/><path d="M160 280q85-24 170 0t170 0 170 0 170 0v20H160z" fill="#BFE6F7"/></g></g>
   ${J.map(([x,y,col,f],i)=>`<g class="blob" data-f="${f}"><path d="M${x-75} ${y}c0-70 30-110 75-110s75 40 75 110q0 20-75 20t-75-20z" fill="${col}"/><circle cx="${x-24}" cy="${y-50}" r="9" fill="#2B2541"/><circle cx="${x+24}" cy="${y-50}" r="9" fill="#2B2541"/><ellipse cx="${x-30}" cy="${y-80}" rx="14" ry="8" fill="#fff" opacity=".55"/><rect class="hot" x="${x-85}" y="${y-120}" width="170" height="150"/></g>`).join('')}
   <circle cx="500" cy="600" r="320" fill="none" stroke="#fff" stroke-width="14" opacity=".9"/><rect x="250" y="905" width="500" height="34" rx="17" fill="#fff" opacity=".9"/>`);
  onTap(root,'.blob',el=>{retrigger(el,'squish',620);tone(+el.dataset.f,{type:'triangle',dur:.2});});
  const w=$('.water',root);
  return {set(p){w.style.transform=`translateY(${(1-p)*560+40}px)`;},
   handoff(done){w.style.transform='translateY(0)';setTimeout(()=>revealFrom($('circle',$('.stage',root)),done),250);}};},

 train(root){ root.innerHTML=`<div class="toy-bg train-bg"></div>`+stage(`
   <rect x="-400" y="742" width="1800" height="14" fill="#8D6E5A"/>${Array.from({length:30},(_,k)=>`<rect x="${-400+k*62}" y="756" width="34" height="14" fill="#A3846E"/>`).join('')}
   <g class="station" style="transform:translateX(460px)"><g transform="translate(-80 0)"><rect x="770" y="600" width="230" height="140" fill="#FFF7EA"/><path d="M740 600l145-80 145 80z" fill="#E8736A"/><rect x="800" y="640" width="60" height="100" fill="#7CC4F0"/><rect x="900" y="640" width="70" height="50" fill="#BFE6FF"/><rect x="750" y="740" width="270" height="18" fill="#C9B9A6"/>
    <rect x="975" y="420" width="10" height="180" fill="#6A6380"/><path d="M985 420h70l-20 25 20 25h-70z" fill="#72D0AF"/></g></g>
   <g class="trainmove"><g class="trainset">
    <g class="car c2" data-f="392"><rect x="40" y="610" width="190" height="120" rx="20" fill="#7CC4F0"/><rect x="70" y="635" width="56" height="50" rx="10" fill="#E8F7FF"/><rect x="146" y="635" width="56" height="50" rx="10" fill="#E8F7FF"/><circle cx="85" cy="740" r="24" fill="#2B2541"/><circle cx="185" cy="740" r="24" fill="#2B2541"/><rect class="hot" x="30" y="590" width="210" height="180"/></g>
    <g class="car c1" data-f="330"><rect x="250" y="610" width="190" height="120" rx="20" fill="#FFD064"/><rect class="win" x="280" y="632" width="130" height="64" rx="12" fill="#FFF6DA"/><circle cx="295" cy="740" r="24" fill="#2B2541"/><circle cx="395" cy="740" r="24" fill="#2B2541"/><rect class="hot" x="240" y="590" width="210" height="180"/></g>
    <g class="car c0" data-f="262"><rect x="460" y="580" width="230" height="150" rx="22" fill="#E8736A"/><rect x="590" y="530" width="100" height="90" rx="16" fill="#E8736A"/><rect x="606" y="548" width="68" height="48" rx="10" fill="#E8F7FF"/><rect x="490" y="520" width="44" height="70" rx="10" fill="#6A6380"/><circle cx="510" cy="740" r="28" fill="#2B2541"/><circle cx="640" cy="740" r="28" fill="#2B2541"/><path d="M690 690l40 40h-40z" fill="#C9564F"/>
     <g class="puffc"><circle cx="512" cy="480" r="34" fill="#fff"/><circle cx="540" cy="460" r="24" fill="#fff"/></g><rect class="hot" x="450" y="510" width="290" height="260"/></g>
   </g></g>`);
  onTap(root,'.car',el=>{retrigger(el,'bounce',470);tone(+el.dataset.f,{dur:.3,type:'triangle'}); if(el.classList.contains('c0'))retrigger($('.puffc',el),'go',920);});
  const st=$('.station',root);
  return {set(p){st.style.transform=`translateX(${(1-p)*460}px)`;},
   handoff(done){root.classList.add('train-go');setTimeout(()=>revealFrom($('.win',root),done,'rect'),600);}};},
};

// Mount a toy into host. Returns { setProgress(f|null), handoff(ms) -> Promise, destroy() }.
export function mountToy(host, name, { sound, reduced, item = {}, reveal }) {
  SOUND = sound;
  REVEAL = reveal;
  host.innerHTML = '<div class="mtoy"></div>';
  const root = host.firstElementChild;
  const toy = (TOYS[name] || TOYS.owl)(root, item);
  let shown = 0, target = null, last = performance.now(), raf = 0, alive = true, looping = false;
  const setLoop = (on) => { if (looping !== on) { looping = on; toy.loop?.(on); } };
  const frame = (now) => {
    if (!alive) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (target == null) setLoop(true);
    else { setLoop(false); const next = easeProgress(shown, target, dt); if (next !== shown) { shown = next; toy.set(shown); } }
    raf = requestAnimationFrame(frame);
  };
  toy.set(0);
  raf = requestAnimationFrame(frame);
  return {
    el: root,
    setProgress(f) { if (f == null) return; target = Math.max(target ?? 0, Math.min(1, f)); },
    get shown() { return shown; },
    handoff() {
      setLoop(false); shown = 1; toy.set(1);
      return new Promise((res) => { if (reduced) res(); else setTimeout(() => toy.handoff(res), 200); });
    },
    destroy() { alive = false; cancelAnimationFrame(raf); host.innerHTML = ''; },
  };
}
