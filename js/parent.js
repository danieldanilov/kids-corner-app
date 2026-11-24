// Grown-up gate (hold the corner lock 3 s, then a PIN) and the parent screen (spec 6).
import { HOLD_MS, validPinFormat, makePinRecord, checkPin, registerAttempt, attemptState } from './gate.js';
import { normaliseTorrentioConfig } from './secrets.js';
import { setSecretList } from './main.js';
import { CATEGORIES } from './data.js';
import { todayKey } from './rules.js';
import { ICONS } from './art.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- gate ----------
export function openGate(app, lockEl) {
  if (lockEl._holding) return;
  lockEl._holding = true;
  lockEl.classList.add('holding');
  const t0 = performance.now();
  const timer = setTimeout(() => { cleanup(); lockEl.classList.add('held'); setTimeout(() => lockEl.classList.remove('held'), 400); showPin(app); }, HOLD_MS);
  function cleanup() {
    clearTimeout(timer);
    lockEl._holding = false;
    lockEl.classList.remove('holding');
    window.removeEventListener('pointerup', early); window.removeEventListener('pointercancel', early);
  }
  function early() { if (performance.now() - t0 < HOLD_MS) cleanup(); }   // let go early: the ring drains, nothing happens
  window.addEventListener('pointerup', early); window.addEventListener('pointercancel', early);
}

async function showPin(app) {
  const layer = document.getElementById('overlay');
  const rec = await app.store.getPin();
  const setting = !rec;
  let first = null, entry = '';
  layer.innerHTML = `<div class="gate">
    <button class="round-btn gate-home tapable" aria-label="back">${ICONS.back}</button>
    <div class="pin-card"><p class="pin-title">${setting ? 'Choose a 4-digit grown-up PIN' : 'Grown-ups'}</p>
      <div class="pin-dots">${'<span></span>'.repeat(4)}</div><p class="pin-msg" aria-live="polite"></p>
      <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map(k => k === '' ? '<span></span>' : `<button class="key" data-k="${k}">${k}</button>`).join('')}</div></div></div>`;
  layer.classList.add('open');
  const dots = layer.querySelectorAll('.pin-dots span'), msg = layer.querySelector('.pin-msg'), card = layer.querySelector('.pin-card');
  const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < entry.length));
  const close = () => { layer.classList.remove('open'); layer.innerHTML = ''; layer.onclick = null; };
  const shake = () => { card.classList.remove('sway'); void card.offsetWidth; card.classList.add('sway'); };

  const gateState = await app.store.getGateState();
  const lockedMsg = (s) => { const w = attemptState(s, Date.now()); if (w.locked) { msg.textContent = `Too many tries. Wait ${Math.ceil(w.waitMs / 1000)} s.`; return true; } return false; };
  let state = gateState;
  lockedMsg(state);

  layer.onclick = async (e) => {
    if (e.target.closest('.gate-home')) { close(); return; }
    const k = e.target.closest('.key')?.dataset.k;
    if (k == null) return;
    if (!setting && lockedMsg(state)) return;
    if (k === '⌫') { entry = entry.slice(0, -1); paint(); return; }
    if (entry.length >= 4) return;
    entry += k; paint();
    if (entry.length < 4) return;
    const pin = entry;
    if (setting) {
      if (!first) { first = pin; entry = ''; paint(); msg.textContent = 'Once more to confirm'; return; }
      if (first !== pin || !validPinFormat(pin)) { first = null; entry = ''; paint(); shake(); msg.textContent = "They didn't match. Choose again."; return; }
      await app.store.savePin(await makePinRecord(pin));
      close(); app.parentOpen = true; app.go('#/grownups'); return;
    }
    const ok = await checkPin(pin, rec);
    state = registerAttempt(state, ok, Date.now());
    await app.store.saveGateState(state);
    if (ok) { close(); app.parentOpen = true; app.go('#/grownups'); return; }
    entry = ''; paint(); shake();
    if (!lockedMsg(state)) msg.textContent = '';
  };
}

// ---------- parent screen ----------
const seg = (name, value, opts) => `<div class="seg" data-name="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${esc(v)}" class="${String(v) === String(value) ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
const sw = (name, on) => `<button type="button" class="switch ${on ? 'on' : ''}" data-switch="${name}" aria-pressed="${on}"><span></span></button>`;
const fmtMB = (b) => b ? (b / 1e6).toFixed(0) + ' MB' : '–';
const fmtS = (ms) => ms != null ? (ms / 1000).toFixed(1) + ' s' : '–';
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export async function renderParent(view, app) {
  const s = app.settings;
  const secrets = await app.store.getSecrets();
  const plays = await app.store.allPlays();
  const u = app.today();
  const today = plays.filter(p => p.date === todayKey());
  const hid = app.hidden();
  const allTitles = [...new Map(Object.values(app.catalogs).flat().map(m => [m.id, m])).values()];
  const name = (id) => allTitles.find(t => t.id === id)?.name || id;

  // Playback report summary (BR: is TorBox Essential enough?)
  const tb = plays.filter(p => p.kind === 'torbox');
  const started = tb.filter(p => p.ttffMs != null && p.endReason !== 'failed');
  const ttffs = started.map(p => p.ttffMs).sort((a, b) => a - b);
  const median = ttffs.length ? ttffs[Math.floor(ttffs.length / 2)] : null;
  const failedPlays = tb.filter(p => p.endReason === 'failed').length;

  const byTitle = {};
  for (const p of today) { const k = p.titleName || p.titleId; byTitle[k] = (byTitle[k] || 0) + (p.watchedSec || 0); }
  const ends = {};
  for (const p of today) ends[p.endReason || 'unknown'] = (ends[p.endReason || 'unknown'] || 0) + 1;

  const voiceMissing = allTitles.filter(t => !app.sound.hasTitle(t.id));
  const failedIds = [...hid.failedTitles];

  view.className = 'screen parent';
  view.innerHTML = `<div class="parent-wrap">
    <header class="parent-top"><h1>Grown-ups</h1><button class="btn primary" data-a="done">Done</button></header>
    ${app.setupHint ? `<p class="notice">Playback needs attention: ${esc(app.setupHint === 'torbox_auth' ? 'TorBox rejected the key inside the Torrentio config' : app.setupHint === 'app_token' || app.setupHint === 'origin' ? 'the resolver rejected the app token' : app.setupHint === 'no_secrets' || app.setupHint === 'not-configured' ? 'the Torrentio config or the app token is not set' : /network|fetch|load failed|time|offline|abort/i.test(app.setupHint) ? 'the last play hit a network problem' : app.setupHint === 'no-player' ? 'the player module is not installed yet (YouTube and stories still play)' : 'the TorBox connection is not set up')}. Check Connection below.</p>` : ''}

    <section><h2>Sounds</h2>
      <div class="field"><span>All sounds</span>${sw('sounds.all', s.sounds.all !== false)}</div>
      <div class="field"><span>Spoken names</span>${seg('sounds.names', s.sounds.names, [['off', 'Off'], ['quiet', 'Quiet'], ['normal', 'Normal']])}<button class="btn" data-a="sample-name">Play a sample</button></div>
      <div class="field"><span>Tap and toy sounds</span>${seg('sounds.effects', s.sounds.effects, [['off', 'Off'], ['quiet', 'Quiet'], ['normal', 'Normal']])}<button class="btn" data-a="sample-effect">Play a sample</button></div>
      <div class="field"><span>Interface phrases</span>${seg('sounds.namesLang', s.sounds.namesLang, [['en-ru', 'English then Russian'], ['en', 'English'], ['ru', 'Russian']])}</div>
    </section>

    <section><h2>Bedtime</h2>
      <div class="field"><span>Bedtime now</span>${sw('bedtime.manual', s.bedtime.manual)}</div>
      <div class="field"><span>Every day from</span><input type="time" data-input="bedtime.start" value="${esc(s.bedtime.start)}"> <span>to</span> <input type="time" data-input="bedtime.end" value="${esc(s.bedtime.end)}">${s.bedtime.start || s.bedtime.end ? '<button class="btn small" data-a="clear-window">No window</button>' : ''}</div>
      <div class="field"><span>One story, then good night</span>${sw('bedtime.oneStory', s.bedtime.oneStory)}</div>
      ${u.goodnight ? '<div class="field"><span>She is on the good night screen</span><button class="btn" data-a="wake">Wake the app</button></div>' : ''}
      <p class="hint">Bedtime switches only between videos, never in the middle of one.</p>
    </section>

    <section><h2>Motion</h2><div class="field">${seg('motion', s.motion, [['auto', 'Follow iPad'], ['reduced', 'Reduced'], ['normal', 'Normal']])}</div></section>

    <section><h2>Titles</h2>
      <div class="field"><input type="search" class="wide" placeholder="Find a title to hide, pin or add to New" data-filter autocomplete="off"></div>
      <div class="title-list" data-list></div>
      ${s.hidden.length ? `<h3>Hidden by you</h3><ul class="plain">${s.hidden.map(id => `<li>${esc(name(id))} <button class="btn small" data-a="unhide" data-id="${esc(id)}">Unhide</button></li>`).join('')}</ul>` : ''}
      ${failedIds.length ? `<h3>Hidden because no stream played</h3><ul class="plain">${failedIds.map(id => `<li>${esc(name(id))} <button class="btn small" data-a="unfail" data-id="${esc(id)}">Try again</button></li>`).join('')}</ul>` : ''}
      ${s.pinned.length ? `<h3>Pinned to My shows</h3><ul class="plain">${s.pinned.map(id => `<li>${esc(name(id))} <button class="btn small" data-a="unpin" data-id="${esc(id)}">Unpin</button></li>`).join('')}</ul>` : ''}
      ${s.newRow.length ? `<h3>In the New row</h3><ul class="plain">${s.newRow.map(t => `<li>${esc(t.name)} <button class="btn small" data-a="unnew" data-id="${esc(t.id)}">Remove</button></li>`).join('')}</ul>` : ''}
    </section>

    <section><h2>Today</h2>
      ${Object.keys(byTitle).length ? `<table class="report"><tr><th>Title</th><th>Minutes</th></tr>${Object.entries(byTitle).map(([t, sec]) => `<tr><td>${esc(t)}</td><td>${Math.round(sec / 60)}</td></tr>`).join('')}</table>
        <p class="hint">How plays ended: ${Object.entries(ends).map(([k, n]) => `${esc(k)} ${n}`).join(', ')}</p>` : '<p class="hint">Nothing watched yet today.</p>'}
    </section>

    <section><h2>Playback report</h2>
      <p class="summary">TorBox plays: ${tb.length}. Started: ${started.length}. Median time to first picture: ${fmtS(median)}. All streams failed: ${failedPlays}. Plays that needed a fallback: ${tb.filter(p => (p.fallbacks || []).length).length}.</p>
      <div class="table-wrap"><table class="report"><tr><th>When</th><th>Title</th><th>Start</th><th>Size</th><th>Picked</th><th>Fallbacks</th><th>Path</th><th>End</th></tr>
      ${plays.slice(0, 200).map(p => `<tr class="${p.endReason === 'failed' ? 'bad' : ''}"><td>${when(p.at)}</td><td>${esc(p.titleName)} ${esc(p.episodeLabel || '')}</td><td>${fmtS(p.ttffMs)}</td><td>${p.sizeMB ? esc(p.sizeMB) + ' MB' : fmtMB(p.fileSize)}</td>
        <td>${esc(p.candidate ? [p.candidate.filename, p.candidate.res, p.candidate.container].filter(Boolean).join(' · ') : '–')}</td>
        <td>${(p.fallbacks || []).length ? esc((p.fallbacks || []).map(f => f.reason || f).join(', ')) : '0'}</td><td>${esc(p.path || p.kind)}</td>
        <td>${esc(p.endReason || '')}${(p.failures || []).length ? ': ' + esc(p.failures.join(', ')) : ''}</td></tr>`).join('') || '<tr><td colspan="8">No plays yet.</td></tr>'}</table></div>
      <div class="field"><button class="btn" data-a="copy-report">Copy report as text</button><button class="btn" data-a="clear-report">Clear report</button></div>
    </section>

    <section><h2>Connection</h2>
      <div class="field"><span>Torrentio config (holds the TorBox key)</span><b class="${secrets.torrentioConfig ? 'ok' : 'warn'}">${secrets.torrentioConfig ? 'Set' : 'Not set'}</b><button class="btn" data-a="set-config">Set</button>${secrets.torrentioConfig ? '<button class="btn" data-a="clear-config">Clear</button>' : ''}</div>
      <div class="field"><span>App token</span><b class="${secrets.appToken ? 'ok' : 'warn'}">${secrets.appToken ? 'Set' : 'Not set'}</b><button class="btn" data-a="set-token">Set</button>${secrets.appToken ? '<button class="btn" data-a="clear-token">Clear</button>' : ''}</div>
      <div class="secret-entry" hidden><input type="password" autocomplete="off" autocapitalize="off" spellcheck="false" class="wide" data-secret><button class="btn primary" data-a="save-secret">Save</button><button class="btn" data-a="cancel-secret">Cancel</button><p class="pin-msg" data-secret-msg></p></div>
      <div class="field"><span>Resolver address</span><input type="url" class="wide" data-input="workerUrl" value="${esc(s.workerUrl)}"></div>
      <p class="hint">Player: ${esc(app.player.source)}. These stay on this iPad only, in this Home Screen app's storage. Paste the Torrentio manifest link from torrentio.strem.fun/configure.</p>
    </section>

    <section><h2>Missing voice clips</h2>
      <p class="hint">${voiceMissing.length} titles have no spoken name. Titles are always spoken once, in their own language; this setting is for interface phrases only.</p>
      ${voiceMissing.length ? `<details><summary>Show them</summary><ul class="plain">${voiceMissing.slice(0, 300).map(t => `<li>${esc(t.name)}</li>`).join('')}</ul></details>` : ''}
    </section>

    <section><h2>PIN and storage</h2>
      <div class="field"><button class="btn" data-a="change-pin">Change PIN</button><span class="hint">Storage kept safe by the iPad: ${app.persisted ? 'yes' : 'not confirmed'}</span></div>
      <div class="field"><button class="btn" data-a="lock">Lock now</button></div>
    </section>
  </div>`;

  const set = async (path, value) => {
    const next = structuredClone(app.settings);
    const [a, b] = path.split('.');
    if (b) next[a][b] = value; else next[a] = value;
    await app.saveSettings(next);
  };
  const rerender = () => renderParent(view, app);

  // Titles list (filter for the grown-up; there is no search for her).
  const list = view.querySelector('[data-list]');
  const filter = view.querySelector('[data-filter]');
  const paintList = () => {
    const q = filter.value.trim().toLowerCase();
    if (q.length < 2) { list.innerHTML = ''; return; }
    const hits = allTitles.filter(t => (t.name || '').toLowerCase().includes(q)).slice(0, 30);
    list.innerHTML = hits.map(t => {
      const h = app.settings.hidden.includes(t.id), p = app.settings.pinned.includes(t.id), n = app.settings.newRow.some(x => x.id === t.id);
      return `<div class="title-row"><span>${esc(t.name)} <small>${esc(t.type)}</small></span>
        <button class="btn small" data-a="${h ? 'unhide' : 'hide'}" data-id="${esc(t.id)}">${h ? 'Unhide' : 'Hide'}</button>
        <button class="btn small" data-a="${p ? 'unpin' : 'pin'}" data-id="${esc(t.id)}">${p ? 'Unpin' : 'Pin'}</button>
        <button class="btn small" data-a="${n ? 'unnew' : 'new'}" data-id="${esc(t.id)}">${n ? 'Out of New' : 'Add to New'}</button></div>`;
    }).join('') || '<p class="hint">No match.</p>';
  };
  filter.addEventListener('input', paintList);

  let secretTarget = null;
  const entry = view.querySelector('.secret-entry'), secretInput = view.querySelector('[data-secret]'), secretMsg = view.querySelector('[data-secret-msg]');

  view.onchange = async (e) => {
    const inp = e.target.closest('[data-input]');
    if (!inp) return;
    const path = inp.dataset.input;
    let v = inp.value;
    if (path === 'limits.showsPerDay') v = Math.max(1, Math.min(10, +v || 1));
    if (path === 'workerUrl' && !/^https:\/\/[a-z0-9.-]+\.workers\.dev\/?$/i.test(v)) { inp.value = app.settings.workerUrl; return; }
    await set(path, v);
  };

  view.onclick = async (e) => {
    const segBtn = e.target.closest('.seg button');
    if (segBtn) {
      const path = segBtn.parentElement.dataset.name;
      let v = segBtn.dataset.v;
      if (path === 'limits.dailyMinutes') v = +v;
      await set(path, v);
      if (path === 'limits.showsMode' && v === 'fixed' && !app.settings.limits.showsPerDay) await set('limits.showsPerDay', 2);
      return rerender();
    }
    const swBtn = e.target.closest('[data-switch]');
    if (swBtn) {
      const path = swBtn.dataset.switch, [a, b] = path.split('.');
      await set(path, !app.settings[a][b]);
      return rerender();
    }
    const btn = e.target.closest('[data-a]');
    if (!btn) return;
    const a = btn.dataset.a, id = btn.dataset.id;
    const meta = allTitles.find(t => t.id === id);
    switch (a) {
      case 'done': app.parentOpen = false; app.go('#/'); return;
      case 'lock': app.parentOpen = false; app.go('#/'); return;
      case 'sample-name': app.sound.unlock(); app.speak('ui.hi'); return;
      case 'sample-effect': app.sound.unlock(); app.effect('chip'); return;
      case 'clear-window': { const n = structuredClone(app.settings); n.bedtime.start = ''; n.bedtime.end = ''; await app.saveSettings(n); return rerender(); }
      case 'wake': app.usage = { ...app.today(), goodnight: false }; await app.saveUsage(); app._saidGoodnight = false; return rerender();
      case 'more-show': app.usage = { ...app.today(), extraShows: (app.today().extraShows || 0) + 1 }; await app.saveUsage(); return rerender();
      case 'more-time': app.usage = { ...app.today(), extraMinutes: (app.today().extraMinutes || 0) + 15 }; await app.saveUsage(); return rerender();
      case 'hide': await set('hidden', [...app.settings.hidden, id]); paintList(); return;
      case 'unhide': await set('hidden', app.settings.hidden.filter(x => x !== id)); return rerender();
      case 'pin': await set('pinned', [...app.settings.pinned, id]); paintList(); return;
      case 'unpin': await set('pinned', app.settings.pinned.filter(x => x !== id)); return rerender();
      case 'new': if (meta) await set('newRow', [...app.settings.newRow, { id, type: meta.type, name: meta.name, poster: meta.poster, posterShape: meta.posterShape }]); paintList(); return;
      case 'unnew': await set('newRow', app.settings.newRow.filter(x => x.id !== id)); return rerender();
      case 'unfail': { const f = { ...app.failed }; delete f[id]; app.failed = f; await app.store.saveFailed(f); return rerender(); }
      case 'copy-report': {
        const text = plays.map(p => [when(p.at), p.titleName, p.episodeLabel, fmtS(p.ttffMs), p.sizeMB ? p.sizeMB + ' MB' : fmtMB(p.fileSize), p.path || p.kind, `fallbacks ${(p.fallbacks || []).length}`, p.endReason, (p.failures || []).join(' ')].join(' | ')).join('\n');
        try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Copy failed'; }
        return;
      }
      case 'clear-report': if (confirm('Clear the playback report on this iPad?')) { await app.store.clearPlays(); rerender(); } return;
      case 'set-config': case 'set-token':
        secretTarget = a === 'set-config' ? 'torrentioConfig' : 'appToken';
        entry.hidden = false; secretInput.value = ''; secretMsg.textContent = '';
        secretInput.placeholder = secretTarget === 'torrentioConfig' ? 'https://torrentio.strem.fun/…/manifest.json' : 'App token';
        secretInput.focus();
        return;
      case 'cancel-secret': entry.hidden = true; secretInput.value = ''; return;
      case 'save-secret': {
        const cur = await app.store.getSecrets();
        let v = secretInput.value.trim();
        if (secretTarget === 'torrentioConfig') { v = normaliseTorrentioConfig(v); if (!v) { secretMsg.textContent = 'That is not a Torrentio link with a TorBox key.'; return; } }
        else if (v.length < 16) { secretMsg.textContent = 'The app token is at least 16 characters.'; return; }
        const next = { ...cur, [secretTarget]: v };
        await app.store.saveSecrets(next);
        setSecretList(next);
        secretInput.value = '';
        app.setupHint = null;
        return rerender();
      }
      case 'clear-config': case 'clear-token': {
        const cur = await app.store.getSecrets();
        const next = { ...cur, [a === 'clear-config' ? 'torrentioConfig' : 'appToken']: '' };
        await app.store.saveSecrets(next); setSecretList(next); return rerender();
      }
      case 'change-pin': await app.store.savePin(null); app.parentOpen = false; app.go('#/'); setTimeout(() => showPin(app), 50); return;
    }
  };
}

export { CATEGORIES };
