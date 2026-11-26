// Her screens: home, category, show/movie/channel pages, rest, good night, the how-many picker (spec 4, 8).
import { CATEGORIES, BEDTIME_ROWS, kindOf, collectionData, collectionOf, isCollectionId, songThumb, COLLECTIONS, SUBJECTS } from './data.js';
import { keepWatching, myShows, isFinished, showsAllowed, starterShows, newTitles } from './rules.js';
import { pom, CHIP_ART, SUBJECT_ART, ROW_ART, ROW_LABEL, ICONS, CUSHION } from './art.js';
import { groupResults } from './search.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const portrait = () => matchMedia('(orientation: portrait)').matches;
const catById = (id) => CATEGORIES.find(c => c.id === id);

export const lockHtml = () => `<button class="lock" aria-label="Grown-ups"><span class="lock-ring"></span>${ICONS.lock}</button>`;
const homeBtn = (label = 'Home') => `<button class="round-btn home-btn tapable" data-act="home" aria-label="${label}">${ICONS.home}</button>`;

function dots(app) {
  const u = app.today();
  const n = showsAllowed(u, app.settings);
  if (!n) return '';
  const total = n + (u.extraShows || 0);
  return `<div class="show-dots" aria-label="shows left">${Array.from({ length: total }, (_, i) => `<span class="${i < total - u.episodesEnded ? 'full' : ''}"></span>`).join('')}</div>`;
}

// Poster/tile with the category-colour fallback (spec 2.3).
export function posterHtml(t, app, { cls = '', progress = null, data = '', squareIn = false } = {}) {
  const cat = app.catOf(t.id) || 'shows';
  const square = t.posterShape === 'square' || t.type === 'YouTube' || t.type === 'Audio';
  const bar = progress != null ? `<span class="pbar"><span style="width:${Math.round(progress * 100)}%"></span></span>` : '';
  if (square && squareIn) {     // home rows: the square art on top of a poster-shaped tile, the category picture below
    return `<button class="poster tapable sqin ${cls}" data-cat="${cat}" ${data} aria-label="${esc(t.name)}">
      <span class="sqart">${t.poster ? `<img src="${esc(t.poster)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}</span>
      <span class="sqfoot">${CHIP_ART[cat] || CHIP_ART.shows}</span>${bar}</button>`;
  }
  return `<button class="poster tapable ${square ? 'square' : ''} ${cls}" data-cat="${cat}" ${data} aria-label="${esc(t.name)}">
    <span class="fallback">${CHIP_ART[cat] || CHIP_ART.shows}</span>
    ${t.poster ? `<img src="${esc(t.poster)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}${bar}</button>`;
}

function chipHtml(c, app, lit = false) {
  return `<button class="chip tapable ${lit ? 'lit' : ''}" data-cat="${c.id}" data-act="cat" data-id="${c.id}" aria-label="${esc(c.label)}">
    <span class="art">${CHIP_ART[c.id]}</span><span class="word">${esc(c.label)}</span></button>`;
}

function findMeta(app, id) {
  for (const list of Object.values(app.catalogs)) { const m = list.find(x => x.id === id); if (m) return m; }
  const f = app.favs.find(x => x.id === id); if (f) return f;
  return app.settings.newRow.find(x => x.id === id) || null;
}

// ---------- home ----------
export async function renderHome(view, app, { announceBedtime = false } = {}) {
  const hidden = app.hidden().titles;
  const slots = portrait() ? 4 : 6;   // spec 4.1 v6: rows end at x 1026 in landscape
  let rows;
  if (app.bedtime) {
    rows = BEDTIME_ROWS.map(r => ({ key: r.key, sign: r.sign, items: (app.catalogs[`${r.type}/${r.id}`] || []).filter(m => !hidden.has(m.id)).map(m => ({ t: m })) }));
  } else {
    const own = myShows(app.favs, app.settings.pinned, hidden).map(id => findMeta(app, id)).filter(Boolean);
    const starter = starterShows(app.catalogs['series/shows'], { favs: app.favs, pinned: app.settings.pinned, hidden });
    const mine = (own.length ? own : starter).map(t => ({ t }));
    const keep = keepWatching([...app.progress.values()], { hidden }).map(p => ({ t: { id: p.titleId, type: p.titleType, name: p.titleName, poster: p.poster, posterShape: p.posterShape }, p }));
    const picked = app.settings.newRow.filter(t => !hidden.has(t.id) && !isCollectionId(t.id));   // songs and lessons never sit in New
    const arrived = newTitles(app.catalogOrder || [], app.seen, Date.now()).filter(id => !hidden.has(id) && !picked.some(p => p.id === id)).map(id => findMeta(app, id)).filter(Boolean);
    const fresh = [...picked, ...arrived].map(t => ({ t }));
    rows = [{ key: 'myshows', sign: 'row.myshows', items: mine, ghost: true }, { key: 'keep', sign: 'row.keep', items: keep, keep: true }, { key: 'new', sign: 'row.new', items: fresh }];
  }
  const chips = app.bedtime ? CATEGORIES.filter(c => c.id === 'bedtime' || c.id === 'stories') : CATEGORIES;

  const rowHtml = (r) => {
    if (!r.items.length && !r.ghost) return `<div class="row empty" data-row="${r.key}" aria-hidden="true"></div>`;   // slot stays, nothing moves up
    // Pages of whole posters (spec 4.1 v2): all fit, or 6 / 3 per page plus one arrow tile that turns back on the last page.
    const paged = r.items.length > slots;
    const per = paged ? slots - 1 : slots;
    const pages = Math.max(1, Math.ceil(r.items.length / per));
    const page = Math.min(app.rowPages[r.key] || 0, pages - 1);
    const start = page * per;
    const last = page === pages - 1;
    const vis = r.items.slice(start, start + per);
    const tiles = vis.map(({ t, p }) => posterHtml(t, app, { squareIn: true, progress: p ? Math.min(1, p.position / (p.duration || 1)) : null, data: `data-act="${p ? 'resume' : 'title'}" data-type="${esc(t.type)}" data-id="${esc(t.id)}" ${p ? `data-key="${esc(p.key)}"` : ''}` })).join('');
    const ghost = r.ghost && !r.items.length ? `<div class="poster ghost">${ICONS.heart}</div>` : '';
    return `<div class="row" data-row="${r.key}">
      <button class="sign tapable" data-act="sign" data-key="${r.sign}" aria-label="${r.key}"><span class="art">${ROW_ART[r.key]}</span><span class="word">${ROW_LABEL[r.key]}</span></button>
      ${tiles}${ghost}
      ${paged ? `<button class="poster arrow-tile tapable" data-act="rowpage" data-row="${r.key}" data-pages="${pages}" aria-label="${last ? 'back to the start' : 'more'}">${last ? ICONS.left : ICONS.right}</button>` : ''}
    </div>`;
  };

  view.className = 'screen home';
  view.innerHTML = `<div class="home-frame">
    <header class="home-top">
      <button class="pom-tile tapable" data-act="pom" aria-label="Pom">${pom(app.bedtime ? 'night' : 'day', 'breathe')}</button>
      ${chips.map(c => chipHtml(c, app)).join('')}
      ${app.bedtime ? '' : `<button class="chip srch tapable" data-act="search" aria-label="Search"><span class="art">${ICONS.search}</span><span class="word">Search</span></button>`}
    </header>
    ${lockHtml()}${dots(app)}${app.preview ? '<span class="preview-tag" aria-hidden="true">preview</span>' : ''}
    <section class="rows">${rows.map(rowHtml).join('')}</section></div>`;

  view.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'pom') {
      const tile = b; tile.innerHTML = pom(app.bedtime ? 'night' : 'wave');
      app.speak('ui.hi');
      setTimeout(() => { tile.innerHTML = pom(app.bedtime ? 'night' : 'day', 'breathe'); }, 900);
    } else if (act === 'cat') { app.effect('chip'); app.speak('cat.' + b.dataset.id); app.go('#/c/' + b.dataset.id); }
    else if (act === 'search') { app.effect('chip'); renderSearch(view, app, { focus: true }); app.go('#/s'); }   // focus inside her tap: the keyboard opens
    else if (act === 'sign') { app.effect('sign'); app.speak(b.dataset.key); b.classList.remove('nod'); void b.offsetWidth; b.classList.add('nod'); }
    else if (act === 'rowpage') {
      app.effect('arrow');
      const cur = app.rowPages[b.dataset.row] || 0;
      app.rowPages[b.dataset.row] = cur + 1 >= +b.dataset.pages ? 0 : cur + 1;
      renderHome(view, app);
    } else if (act === 'title') { app.effect('poster'); app.go(`#/t/${b.dataset.type}/${b.dataset.id}`); }
    else if (act === 'resume') { app.effect('poster'); app.playui.resume(b.dataset.key, b); }
  };

  // Warm what Keep watching needs so her tap can start playback inside the gesture.
  for (const p of keepWatching([...app.progress.values()], { hidden })) {
    app.title(p.titleType, p.titleId).catch(() => {});
    if (p.kind === 'audio' || p.kind === 'youtube') app.stream(p.titleType, p.key).catch(() => {});
  }
  if (announceBedtime) {
    view.querySelector('.pom-tile')?.classList.add('yawn');
    app.speak('ui.bedtime');
  }
}

// ---------- search (spec 4.10) ----------
// Kids Corner only: the index in main.js holds the catalogs' titles, channel videos, story episodes and series
// episode names. Rendered once per visit; the query stays for the session. Called straight from the magnifier's
// tap so the field can take focus inside that gesture (iPadOS opens the keyboard only then).
export const SEARCH_DEBOUNCE_MS = 120;
export function renderSearch(view, app, { focus = false } = {}) {
  let input = view.querySelector('#sq');
  if (!input) {
    view.className = 'screen search';
    view.innerHTML = `${homeBtn()}
      <label class="sfield">${ICONS.search.replace('class="icon', 'class="icon mag')}<input id="sq" type="text" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Search Kids Corner"><button class="sclear tapable" data-act="clear" aria-label="Clear">${ICONS.clear}</button></label>
      <div class="sres" id="sres"></div>`;
    input = view.querySelector('#sq');
    const res = view.querySelector('#sres');
    let timer = null;
    input.value = app.searchQuery || '';
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => runSearch(view, app), SEARCH_DEBOUNCE_MS); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    res.addEventListener('pointerdown', () => { if (document.activeElement === input) input.blur(); });   // more results show
    view.onclick = (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'home') { app.effect('button'); app.go('#/'); }
      else if (act === 'clear') { app.effect('button'); clearTimeout(timer); input.value = ''; runSearch(view, app); input.focus(); }
      else if (act === 'title') { app.effect('poster'); app.go(`#/t/${b.dataset.type}/${b.dataset.id}`); }
      else if (act === 'ep') { app.effect('poster'); app.playui.playVideo(b.dataset.type, b.dataset.id, b.dataset.vid, b); }
      else if (act === 'song') { app.effect('poster'); app.playui.playSong(b.dataset.vid, b); }
    };
    app.ensureSearchIndex?.();
    runSearch(view, app);
  }
  if (focus) input.focus();
}

// A song or lesson in search (4.10): a poster-shaped tile, the 16:9 still on top, the collection's colour and
// picture below, the title under it.
function songTile(hit) {
  const col = COLLECTIONS[collectionOf(hit.id)] || COLLECTIONS.music;
  const art = col.icon ? SUBJECT_ART[col.icon] : CHIP_ART[col.cat];
  return `<div class="sitem"><button class="poster songin tapable" data-cat="${col.cat}" data-act="song" data-vid="${esc(hit.id)}" aria-label="${esc(hit.title)}"><span class="sart"><span class="fallback">${art}</span>${hit.poster ? `<img src="${esc(hit.poster)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}</span><span class="sqfoot">${art}</span></button><span class="epname">${esc(hit.title)}</span></div>`;
}

// Re-run the query in place (after a keystroke, or when more of the index arrives); keeps the scroll on a refresh.
export function runSearch(view, app, { refresh = false } = {}) {
  const input = view.querySelector('#sq'), res = view.querySelector('#sres');
  if (!input || !res) return;
  const q = input.value;
  app.searchQuery = q;
  view.querySelector('.sclear').classList.toggle('off', !q);
  if (!q.trim()) { res.innerHTML = `<div class="sempty">${pom('day', 'breathe')}<span class="lens">${ICONS.search}</span></div>`; return; }
  const metas = new Map();
  for (const list of Object.values(app.catalogs)) for (const m of list || []) if (m?.id && !metas.has(m.id)) metas.set(m.id, m);
  const groups = groupResults(app.search(q, { limit: Infinity, why: refresh ? 'refresh' : 'typed' }), { hidden: app.hidden(), metaOf: (id) => metas.get(id) || null });
  const html = groups.map(g => `<div class="sgroup" data-type="${g.type}"><h3><span class="art">${g.icon ? SUBJECT_ART[g.icon] : CHIP_ART[g.cat]}</span>${g.label}</h3><div class="sgrid">${
    g.items.map(({ hit, meta }) => hit.kind === 'song'
      ? songTile(hit)
      : hit.kind === 'title'
      ? `<div class="sitem">${posterHtml(meta, app, { squareIn: true, data: `data-act="title" data-type="${esc(meta.type)}" data-id="${esc(meta.id)}"` })}</div>`
      : `<div class="sitem">${posterHtml(meta, app, { squareIn: true, data: `data-act="ep" data-type="${esc(meta.type)}" data-id="${esc(meta.id)}" data-vid="${esc(hit.id)}"` }).replace(`aria-label="${esc(meta.name)}"`, `aria-label="${esc(meta.name + ': ' + hit.name)}"`)}<span class="epname">${esc(hit.name)}</span></div>`).join('')
  }</div></div>`).join('');
  const out = html || `<div class="sempty">${pom('day', 'breathe')}<span class="none">Nothing in Kids Corner matches</span></div>`;
  if (refresh && res._html === out) return;                 // nothing new arrived for this query: leave the tiles alone
  const top = res.scrollTop;
  res.innerHTML = res._html = out;
  res.scrollTop = refresh ? top : 0;
  // Warm the shows behind the first episode tiles, so her tap starts the player at once.
  const warm = new Set();
  for (const g of groups) for (const { hit, meta } of g.items) if (hit.kind !== 'title' && warm.size < 8 && !warm.has(meta.id)) { warm.add(meta.id); app.title(meta.type, meta.id).catch(() => {}); }
}

// ---------- category ----------
export async function renderCategory(view, app, catId, sub) {
  const cat = catById(catId);
  if (!cat) return app.go('#/');
  if (cat.music) return renderCollection(view, app, 'music', cat);
  if (cat.learn) return sub && SUBJECTS.includes(sub) ? renderCollection(view, app, sub, cat) : renderLearn(view, app, cat);
  const { buildRows } = await import('./data.js');
  const rows = buildRows(cat, app.catalogs, { hidden: app.hidden().titles });
  // Each type group (and the Hebrew channels) starts on a fresh column, so shapes never mix in a column.
  const perCol = portrait() ? 3 : 2;
  let html = '', count = 0, prevType = null;
  for (const r of rows) {
    if (count && (r.type !== prevType || r.id === 'hebrew')) { const pad = (perCol - (count % perCol)) % perCol; html += '<span class="shelf-pad" aria-hidden="true"></span>'.repeat(pad); count += pad; }
    if (r.id === 'hebrew') { html += '<div class="group-div" lang="he" aria-label="Hebrew">עב</div>'; count += perCol; }
    for (const t of r.items) { html += posterHtml(t, app, { data: `data-act="title" data-type="${esc(t.type)}" data-id="${esc(t.id)}"` }); count++; }
    prevType = r.type;
  }
  view.className = 'screen category';
  view.innerHTML = `
    <header class="page-top">${homeBtn()}${chipHtml(cat, app, true)}<h1 class="page-name">${esc(cat.label)}</h1>
      <div class="pager">${pagerHtml()}</div></header>
    <div class="shelf cat-shelf" data-cat="${cat.id}">
      ${html}
      <div class="shelf-end pom-pokeable" aria-hidden="true">${pom(app.bedtime ? 'sleep' : 'day')}${CUSHION}</div>
    </div>`;
  wireShelf(view, app);
  view.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'home') { app.effect('button'); app.go('#/'); }
    else if (b.dataset.act === 'cat') { app.effect('chip'); app.speak('cat.' + cat.id); }
    else if (b.dataset.act === 'title') { app.effect('poster'); app.go(`#/t/${b.dataset.type}/${b.dataset.id}`); }
  };
}

// ---------- Music page (spec 4.11) ----------
// hq720 first, mqdefault when YouTube has no hq720: a miss is either an error or YouTube's 404 placeholder, a
// 120x90 grey still the browser still loads, so the width decides. A second miss leaves the category fallback.
const songImg = (v) => {
  const t = songThumb(v.ytId);
  return `<img src="${esc(t.hi)}" data-lo="${esc(t.lo)}" alt="" loading="lazy" decoding="async" onload="if(this.naturalWidth<=120&&this.dataset.lo){this.src=this.dataset.lo;this.dataset.lo=''}" onerror="if(this.dataset.lo){this.src=this.dataset.lo;this.dataset.lo=''}else this.remove()">`;
};
// One sideways shelf (Music 4.11, a Learn subject 4.12): each row starts on a fresh column with a 120 px divider
// (the collection's picture and the row's name, for the grown-up), then its videos as landscape thumbnails at the
// episode-tile size; Pom on the cushion at the end. A tap plays the video in the YouTube player. After one ends,
// it's checked and carries a big "again".
function renderCollection(view, app, key, cat) {
  const col = COLLECTIONS[key];
  const art = col.icon ? SUBJECT_ART[col.icon] : CHIP_ART[col.cat];
  const hid = app.hidden();
  const data = collectionData(key, app.catalogs, { hidden: new Set([...hid.titles, ...hid.videos]) });
  const ended = app.justEnded;
  app.justEnded = null;
  const songs = data.rows.map(r => `<div class="mdiv" aria-hidden="true">${art}<span>${esc(r.label)}</span></div>` + r.songs.map(v => {
    const p = app.progress.get(v.id);
    const done = p && isFinished(p);
    const isEnded = ended === v.id;
    return `<button class="ep song tapable ${isEnded ? 'just-ended' : ''}" data-act="song" data-vid="${esc(v.id)}" data-cat="${col.cat}" aria-label="${esc(v.title)}">
      <span class="fallback">${art}</span>${songImg(v)}
      ${done ? `<span class="ep-check">${ICONS.check}</span>` : ''}${isEnded ? `<span class="again-btn" data-cat="${col.cat}">${ICONS.again}</span>` : ''}</button>`;
  }).join('')).join('');
  // A subject page shows the lit Learn chip with the subject's picture, and the subject's name.
  const chip = col.icon
    ? `<button class="chip tapable lit" data-cat="learn" data-act="cat" data-id="learn" aria-label="${esc(col.label)}"><span class="art">${art}</span><span class="word">Learn</span></button>`
    : chipHtml(cat, app, true);
  view.className = `screen category collection ${key}`;
  view.dataset.collection = key;
  view.innerHTML = `
    <header class="page-top">${homeBtn()}${chip}<h1 class="page-name">${esc(col.label)}</h1>
      <div class="pager">${pagerHtml()}</div></header>
    <div class="shelf music-shelf" data-cat="${col.cat}">
      ${songs}
      <div class="shelf-end pom-pokeable" aria-hidden="true">${pom('day')}${CUSHION}</div>
    </div>`;
  const { shelf, update } = wireShelf(view, app);
  const target = view.querySelector('.just-ended');
  if (target) { shelf.scrollLeft = Math.max(0, target.offsetLeft - 140); update(); }
  view.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'home') { app.effect('button'); app.go('#/'); }
    else if (b.dataset.act === 'cat') { app.effect('chip'); app.speak(col.icon ? 'learn.' + key : 'cat.' + col.cat); }
    else if (b.dataset.act === 'song') { app.effect('poster'); app.playui.playSong(b.dataset.vid, b); }
  };
}

// ---------- Learn page (spec 4.12) ----------
// One big door per subject, centred between the header and the bottom strip; nothing to page.
function renderLearn(view, app, cat) {
  view.className = 'screen category learn';
  delete view.dataset.collection;
  view.innerHTML = `
    <header class="page-top">${homeBtn()}${chipHtml(cat, app, true)}<h1 class="page-name">${esc(cat.label)}</h1></header>
    <div class="doors" data-cat="learn">${SUBJECTS.map(k => `<button class="door tapable" data-act="door" data-k="${k}" aria-label="${esc(COLLECTIONS[k].label)}">
      <span class="art">${SUBJECT_ART[COLLECTIONS[k].icon]}</span><span class="dname">${esc(COLLECTIONS[k].label)}</span></button>`).join('')}</div>`;
  view.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'home') { app.effect('button'); app.go('#/'); }
    else if (b.dataset.act === 'cat') { app.effect('chip'); app.speak('cat.learn'); }
    else if (b.dataset.act === 'door') { app.effect('chip'); app.speak('learn.' + b.dataset.k); app.go(COLLECTIONS[b.dataset.k].route); }
  };
}

const pagerHtml = () => `<button class="round-btn page-btn tapable" data-page="-1" aria-label="back">${ICONS.left}</button><button class="round-btn page-btn tapable" data-page="1" aria-label="more">${ICONS.right}</button>`;

// Page arrows: faded and inert at the ends, never removed (spec 4.2). Swiping also works.
function wireShelf(view, app) {
  const shelf = view.querySelector('.shelf');
  const [prev, next] = view.querySelectorAll('.page-btn');
  const pad = parseFloat(getComputedStyle(shelf).paddingLeft) || 0;
  const tiles = () => [...shelf.querySelectorAll('.poster, .ep')];
  const padRight = () => parseFloat(getComputedStyle(shelf).paddingRight) || 0;
  // The end is reached when every tile ends inside the visible page (the spacer after them is just room).
  const pastRight = () => tiles().filter(t => t.offsetLeft + t.offsetWidth > shelf.scrollLeft + shelf.clientWidth - padRight() + 1);
  const update = () => {
    const atStart = shelf.scrollLeft <= 2, atEnd = pastRight().length === 0;
    prev.classList.toggle('inert', atStart); next.classList.toggle('inert', atEnd);
    prev.disabled = atStart; next.disabled = atEnd;
    // The visible page is the shelf minus its side gutters, so a poster peeking into a gutter counts as cut.
    const sr = shelf.getBoundingClientRect(), padR = parseFloat(getComputedStyle(shelf).paddingRight) || 0;
    const lo = sr.left + pad - 1, hi = Math.min(sr.right, innerWidth) - padR + 1;
    // Spec 4.2 v7: a tile with less than 120 px showing at either edge takes no taps until it scrolls into view.
    for (const t of tiles()) { const r = t.getBoundingClientRect(); const shown = Math.min(r.right, hi) - Math.max(r.left, lo); t.classList.toggle('partial', shown < 120 && (r.left < lo || r.right > hi)); }
  };
  shelf.addEventListener('scroll', () => { cancelAnimationFrame(shelf._u); shelf._u = requestAnimationFrame(update); }, { passive: true });
  // Page by whole columns: next starts at the first column cut by the right edge; back ends where this page began.
  // A trailing spacer lets every column start reach the left edge, so the last page never cuts its first column.
  let spacer = shelf.querySelector('.shelf-spacer');
  if (!spacer) { spacer = document.createElement('div'); spacer.className = 'shelf-spacer'; spacer.setAttribute('aria-hidden', 'true'); shelf.appendChild(spacer); }
  const sizeSpacer = () => {
    const padR = parseFloat(getComputedStyle(shelf).paddingRight) || 0, gap = parseFloat(getComputedStyle(shelf).columnGap) || 0;
    const items = [...shelf.children].filter(c => c !== spacer && c.offsetWidth);
    const lastLeft = Math.max(...items.map(c => c.offsetLeft));
    const lastWidth = Math.max(...items.filter(c => c.offsetLeft === lastLeft).map(c => c.offsetWidth));
    spacer.style.width = Math.max(0, shelf.clientWidth - pad - padR - lastWidth - gap) + 'px';
  };
  sizeSpacer();
  const pageTo = (dir) => {
    const left = shelf.scrollLeft, width = shelf.clientWidth;
    const lefts = [...new Set(tiles().map(t => t.offsetLeft))].sort((a, b) => a - b);
    let target;
    if (dir > 0) {
      const cut = pastRight();
      if (!cut.length) return;
      target = Math.min(...cut.map(t => t.offsetLeft));
    }
    else {
      target = lefts.find(x => x - pad >= left - width + 2 * pad - 1) ?? 0;
      if (target <= lefts[0]) target = 0;   // landing in the first column: go to the very start (a divider may come first)
    }
    shelf.scrollTo({ left: Math.max(0, target - pad), behavior: app.reduced() ? 'auto' : 'smooth' });
  };
  for (const b of [prev, next]) b.addEventListener('click', (e) => { e.stopPropagation(); app.effect('arrow'); pageTo(+b.dataset.page); });
  // A rotation or window resize moves the edges without a scroll (QA #17): size the spacer and re-run the rule.
  // The listener goes away with the shelf.
  const onResize = () => {
    if (!shelf.isConnected) { removeEventListener('resize', onResize); removeEventListener('orientationchange', onResize); return; }
    cancelAnimationFrame(shelf._u); shelf._u = requestAnimationFrame(() => { sizeSpacer(); update(); });
  };
  addEventListener('resize', onResize); addEventListener('orientationchange', onResize);
  update();
  return { shelf, update };
}

// ---------- show / movie / channel page ----------
export async function renderTitle(view, app, type, id) {
  view.className = 'screen title-page loading';
  view.innerHTML = `<header class="page-top">${homeBtn()}</header>`;
  view.onclick = (e) => { if (e.target.closest('[data-act="home"]')) app.go('#/'); };
  let data;
  try { data = await app.title(type, id); } catch { view.innerHTML = `<header class="page-top">${homeBtn()}</header><div class="pom-center">${pom('sleep')}</div>`; return; }
  if (location.hash !== `#/t/${type}/${id}`) return;
  const { title } = data;
  const hid = app.hidden();
  const videos = data.videos.filter(v => !hid.videos.has(v.id));
  const cat = app.catOf(id) || (type === 'YouTube' ? 'youtube' : type === 'Audio' ? 'stories' : 'shows');
  const fav = app.favs.some(f => f.id === id);
  const ended = app.justEnded;
  app.justEnded = null;
  const prog = (vid) => app.progress.get(vid);
  const square = type === 'YouTube' || type === 'Audio' || title.posterShape === 'square';

  view.className = `screen title-page ${type === 'movie' ? 'movie' : 'show'}`;
  view.dataset.cat = cat;
  const heart = `<button class="round-btn heart-btn tapable ${fav ? 'on' : ''}" data-act="heart" aria-label="heart">${fav ? ICONS.heartFull : ICONS.heart}</button>`;
  const poster = `<div class="big-poster ${square ? 'square' : ''}" data-cat="${cat}"><span class="fallback">${CHIP_ART[cat]}</span>${title.poster ? `<img src="${esc(title.poster)}" alt="" onerror="this.remove()">` : ''}</div>`;

  if (type === 'movie') {
    const p = prog(id);
    const done = p && isFinished(p);
    view.innerHTML = `
      <header class="page-top">${homeBtn()}</header>
      <div class="movie-body">${poster.replace('big-poster', `big-poster ${done ? 'checked' : ''}`)}
        <div class="movie-side"><h1 class="movie-name">${esc(title.name)}</h1>
          <div class="movie-actions"><button class="play-big tapable" data-cat="${cat}" data-act="play" data-index="0" aria-label="play">${done ? ICONS.again : ICONS.play}</button>${heart}</div></div></div>`;
  } else {
    let season = null;
    const tiles = videos.map((v, i) => {
      let div = '';
      if (type === 'series' && v.season !== season) { season = v.season; div = `<div class="season-div" aria-hidden="true">${season === 0 ? '★' : season}</div>`; }
      const p = prog(v.id);
      const done = p && isFinished(p);
      const bar = p && !done && p.position > 0 ? `<span class="pbar"><span style="width:${Math.round(Math.min(1, p.position / (p.duration || 1)) * 100)}%"></span></span>` : '';
      const isEnded = ended && v.id === ended;
      return `${div}<button class="ep tapable ${isEnded ? 'just-ended' : ''}" data-act="play" data-index="${i}" data-cat="${cat}" aria-label="${esc(v.title)}">
        <span class="fallback">${CHIP_ART[cat]}</span>${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}
        ${type === 'series' ? `<span class="ep-num">${v.episode}</span>` : ''}${done ? `<span class="ep-check">${ICONS.check}</span>` : ''}${bar}
        ${isEnded ? `<span class="again-btn" data-cat="${cat}">${ICONS.again}</span>` : ''}</button>`;
    }).join('');
    view.innerHTML = `
      <header class="page-top">${homeBtn()}<h1 class="page-name small">${esc(title.name)}</h1><div class="pager">${pagerHtml()}</div></header>
      <aside class="show-side">${poster}${heart}</aside>
      <div class="shelf ep-shelf">${tiles}</div>`;
    const { shelf, update } = wireShelf(view, app);
    const target = view.querySelector('.just-ended') || resumeTile(view, videos, prog);
    if (target) { shelf.scrollLeft = Math.max(0, target.offsetLeft - 24); update(); }
    prefetchStreams(app, type, videos, view);
    // Warm the episode she'll most likely tap (spec 4.3, P §5): invisible.
    const likely = target ? videos[+target.dataset.index] : videos[0];
    if (likely && kindOf(type) === 'torbox') { try { app.player.prefetch(app.playui.itemFor(data, likely)); } catch { /* optional */ } }
  }
  if (type === 'movie') { try { app.player.prefetch(app.playui.itemFor(data, data.videos[0])); } catch { /* optional */ } }
  if (!ended) app.speak('title.' + id);

  view.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'home') { app.effect('button'); app.go('#/'); }
    else if (act === 'heart') {
      const on = await app.store.toggleFav({ id, type, name: title.name, poster: title.poster, posterShape: square ? 'square' : 'poster' });
      app.favs = await app.store.allFavs();
      app.effect(on ? 'heartOn' : 'heartOff');
      b.classList.toggle('on', on); b.innerHTML = on ? ICONS.heartFull : ICONS.heart;
      b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
    } else if (act === 'play') {
      app.effect('poster');
      app.playui.start({ data, videos: type === 'movie' ? data.videos : videos, index: +b.dataset.index, from: b });
    }
  };
}

function resumeTile(view, videos, prog) {
  let best = null, bestAt = 0;
  videos.forEach((v, i) => { const p = prog(v.id); if (p && p.updatedAt > bestAt) { bestAt = p.updatedAt; best = i; } });
  return best == null ? null : view.querySelector(`.ep[data-index="${best}"]`);
}

// Audio stories need their stream URL before her tap; YouTube ids come from the thumbnail where possible.
function prefetchStreams(app, type, videos, view) {
  if (type !== 'Audio' && type !== 'YouTube') return;
  const need = type === 'Audio' ? videos : videos.filter(v => !/\/vi\/[^/]+\//.test(v.thumbnail || ''));
  const shelf = view.querySelector('.shelf');
  const warm = () => {
    const left = shelf.scrollLeft, right = left + shelf.clientWidth * 2;
    for (const el of view.querySelectorAll('.ep')) {
      if (el.offsetLeft + el.offsetWidth < left || el.offsetLeft > right) continue;
      const v = videos[+el.dataset.index];
      if (need.includes(v)) app.stream(type, v.id).catch(() => {});
    }
  };
  warm();
  shelf.addEventListener('scroll', () => { clearTimeout(shelf._w); shelf._w = setTimeout(warm, 200); }, { passive: true });
}

// ---------- rest, good night, how many ----------
export function renderRest(view, app) {
  view.className = 'screen rest';
  view.innerHTML = `${lockHtml()}<div class="sleep-scene"><div class="sleeper">${pom('sleep')}${CUSHION}</div></div>`;
  view.onclick = null;
}

export function renderGoodnight(view, app) {
  view.className = 'screen goodnight';
  view.innerHTML = `${lockHtml()}<div class="night-sky">
    <div class="moon-asleep"></div>${[[12, 18], [82, 14], [22, 70], [76, 62], [8, 46], [90, 40]].map(([x, y]) => `<span class="star" style="left:${x}%;top:${y}%"></span>`).join('')}
    <div class="sleeper">${pom('sleep')}${CUSHION}</div></div>`;
  view.onclick = null;
  if (!app._saidGoodnight) { app._saidGoodnight = true; app.speak('ui.goodnight'); }
}

export function renderHowMany(app) {
  const layer = document.getElementById('overlay');
  layer.innerHTML = `<div class="howmany" role="dialog">
    ${[1, 2, 3].map(n => `<button class="howmany-btn tapable" data-n="${n}" aria-label="${n}">${'<span></span>'.repeat(n)}</button>`).join('')}</div>`;
  layer.classList.add('open');
  app.speak('ui.howmany');
  layer.onclick = async (e) => {
    const b = e.target.closest('[data-n]');
    if (!b) return;
    app.effect('chip');
    app.usage = { ...app.today(), chosenShows: +b.dataset.n };
    await app.saveUsage();
    layer.classList.remove('open'); layer.innerHTML = ''; layer.onclick = null;
    app.render();
  };
}
