// "Check connection" (review S3): the stored Torrentio link and the Worker token, checked step by step on this
// iPad, with OK or exactly what's wrong in plain words. Never shows a secret and never starts a download: the
// token is checked with an empty request (the Worker answers 400 once the token passes), and only a cached
// [TB+] stream is ever resolved (the Worker refuses anything uncached anyway).
const TORRENTIO = 'https://torrentio.strem.fun';
const TEST_EPISODE = 'series/tt7678620:1:1';   // Bluey S1E1: in the catalog, widely cached

function base(config) {
  let c = String(config || '').trim().replace(/^stremio:\/\//, 'https://');
  if (/^https?:\/\//.test(c)) c = new URL(c).pathname;
  return `${TORRENTIO}/${c.replace(/\/manifest\.json$/, '').replace(/^\/+|\/+$/g, '')}`;
}

async function timed(fetchFn, url, opts = {}, ms = 10000) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl && setTimeout(() => ctl.abort(), ms);
  try { return await fetchFn(url, { ...opts, ...(ctl ? { signal: ctl.signal } : {}) }); } finally { if (t) clearTimeout(t); }
}

export async function checkConnection({ secrets, workerUrl, fetchFn = (...a) => fetch(...a) }) {
  const steps = [];
  const fail = (message) => ({ ok: false, message, steps: [...steps, { ok: false, text: message }] });
  const pass = (text) => steps.push({ ok: true, text });
  const { torrentioConfig, appToken } = secrets || {};
  if (!torrentioConfig) return fail("The Torrentio link isn't set. Tap Set beside it and paste the link.");
  if (!appToken) return fail("The app token isn't set. Tap Set beside it and paste the token from the Mac.");

  // 1. Torrentio accepts the link.
  let r;
  try { r = await timed(fetchFn, `${base(torrentioConfig)}/manifest.json`); } catch { return fail("Couldn't reach Torrentio. Check the iPad's internet connection and try again."); }
  if (!r.ok) return fail(`Torrentio didn't accept the link (it answered ${r.status}). Copy the link again from torrentio.strem.fun/configure.`);
  pass('Torrentio accepts the link.');

  // 2. Torrentio lists TorBox streams for a test episode.
  let streams = [];
  try { r = await timed(fetchFn, `${base(torrentioConfig)}/stream/${TEST_EPISODE}.json`); streams = r.ok ? ((await r.json()).streams || []) : []; }
  catch { return fail("Torrentio didn't answer for a test episode. Try again in a minute."); }
  if (!streams.length) return fail("Torrentio returned nothing for a test episode (Bluey). Try again in a minute; if it keeps happening, make the link again.");
  const viaTorbox = streams.filter(s => /^\[TB/.test(s.name || ''));
  if (!viaTorbox.length) return fail("Torrentio isn't using TorBox. Make the link again on torrentio.strem.fun/configure with your TorBox key filled in.");
  const cached = viaTorbox.filter(s => /^\[TB\+\]/.test(s.name || '') && /^https:\/\/torrentio\.strem\.fun\/resolve\//.test(s.url || ''));
  pass(`Torrentio lists TorBox streams (${cached.length} ready to play for the test episode).`);

  // 3. The Worker accepts the app token and this address (an empty request: 400 means the token passed).
  const endpoint = String(workerUrl || '').replace(/\/+$/, '') + '/resolve';
  try { r = await timed(fetchFn, endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': appToken }, body: '{}' }); }
  catch { return fail("Couldn't reach the resolver. Check the iPad's internet connection and the Resolver address."); }
  if (r.status === 401) return fail('The app token was rejected. Copy it again from the Mac and paste it with Set.');
  if (r.status === 403) return fail('The resolver refused this address. Open the app from its Home Screen icon (it must be the danieldanilov.github.io app).');
  if (r.status === 500) return fail("The resolver isn't set up (it has no app token of its own). Ask for the Worker to be fixed.");
  if (r.status !== 400) return fail(`The resolver answered something unexpected (${r.status}). Try again in a minute.`);
  pass('The resolver accepts the app token.');

  // 4. One cached stream resolves to a TorBox download address (nothing new is started).
  if (!cached.length) return { ok: true, message: 'Connected. The test episode has no stream ready to play right now, so playback itself was not tried.', steps };
  let j = {};
  try { r = await timed(fetchFn, endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': appToken }, body: JSON.stringify({ url: cached[0].url }) }); j = await r.json().catch(() => ({})); }
  catch { return fail("The resolver didn't answer for the test episode. Try again in a minute."); }
  if (j.status === 'ok' && typeof j.url === 'string') {
    pass('TorBox hands out the test episode.');
    try {
      const g = await timed(fetchFn, j.url, { headers: { Range: 'bytes=0-1' } });
      if (g.status === 206 || g.status === 200) pass('The video server answers this iPad.');
      else return fail(`TorBox's video server answered ${g.status}. Try again in a minute.`);
    } catch { return fail("TorBox's video server didn't answer this iPad. Try again in a minute."); }
    return { ok: true, message: 'Connected. Everything works.', steps };
  }
  const reason = String(j.reason || j.status || r.status);
  if (/torbox_auth/.test(reason)) return fail('TorBox rejected the key inside the Torrentio link. Check the key on torbox.app and make the link again.');
  if (/not_cached|downloading/.test(reason)) return { ok: true, message: 'Connected. The test episode is not ready on TorBox right now, so playback itself was not tried.', steps };
  return fail(`The test episode didn't resolve (${reason.replace(/[^\w-]/g, '').slice(0, 40)}). Try again in a minute.`);
}
