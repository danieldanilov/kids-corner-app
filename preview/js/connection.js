// "Check connection" (reviews app-v1 S3, app-v2 S1): the stored Torrentio link and the Worker token, checked
// step by step on this iPad, in plain words, never showing a secret and never starting a download. The token is
// checked with an empty request (the Worker answers 400 once the token passes), and only a cached [TB+] stream
// is ever resolved. It never says "Connected" without proving the TorBox key: a cached stream has to resolve
// and TorBox's video server has to answer. Levels: 'ok' (green, proven), 'amber' (couldn't confirm yet), 'fail'.
const TORRENTIO = 'https://torrentio.strem.fun';
// Known-popular titles in the catalog, tried in order until one has a stream ready on TorBox.
export const TEST_TITLES = [
  { path: 'series/tt7678620:1:1', name: 'Bluey' },
  { path: 'series/tt0426769:1:1', name: 'Peppa Pig' },
  { path: 'movie/tt3521164', name: 'Moana' },
];
const AMBER = "Couldn't confirm the TorBox key yet: play something and check the Playback report.";

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
  const fail = (message) => ({ ok: false, level: 'fail', message, steps: [...steps, { ok: false, text: message }] });
  const amber = (why) => ({ ok: false, level: 'amber', message: AMBER, steps: [...steps, { ok: false, text: why }] });
  const pass = (text) => steps.push({ ok: true, text });
  const { torrentioConfig, appToken } = secrets || {};
  if (!torrentioConfig) return fail("The Torrentio link isn't set. Tap Set beside it and paste the link.");
  if (!appToken) return fail("The app token isn't set. Tap Set beside it and paste the token from the Mac.");

  // 1. Torrentio accepts the link.
  let r;
  try { r = await timed(fetchFn, `${base(torrentioConfig)}/manifest.json`); } catch { return fail("Couldn't reach Torrentio. Check the iPad's internet connection and try again."); }
  if (!r.ok) return fail(`Torrentio didn't accept the link (it answered ${r.status}). Copy the link again from torrentio.strem.fun/configure.`);
  pass('Torrentio accepts the link.');

  // 2. Torrentio lists TorBox streams; find a test title with one ready on TorBox.
  let sawTorbox = false, sawAny = false, cached = [], found = null;
  for (const t of TEST_TITLES) {
    let streams = [];
    try { r = await timed(fetchFn, `${base(torrentioConfig)}/stream/${t.path}.json`); streams = r.ok ? ((await r.json()).streams || []) : []; } catch { continue; }
    if (streams.length) sawAny = true;
    const viaTorbox = streams.filter(s => /^\[TB/.test(s.name || ''));
    if (viaTorbox.length) sawTorbox = true;
    cached = viaTorbox.filter(s => /^\[TB\+\]/.test(s.name || '') && /^https:\/\/torrentio\.strem\.fun\/resolve\//.test(s.url || ''));
    if (cached.length) { found = t; break; }
  }
  if (!sawAny) return fail("Torrentio returned nothing for the test titles. Try again in a minute; if it keeps happening, make the link again.");
  if (!sawTorbox) return fail("Torrentio isn't using TorBox. Make the link again on torrentio.strem.fun/configure with your TorBox key filled in.");
  pass(found ? `Torrentio lists streams ready on TorBox (${found.name}).` : 'Torrentio lists TorBox streams, but none of the test titles is ready on TorBox right now.');

  // 3. The Worker accepts the app token and this address (an empty request: 400 means the token passed).
  const endpoint = String(workerUrl || '').replace(/\/+$/, '') + '/resolve';
  try { r = await timed(fetchFn, endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': appToken }, body: '{}' }); }
  catch { return fail("Couldn't reach the resolver. Check the iPad's internet connection and the Resolver address."); }
  if (r.status === 401) return fail('The app token was rejected. Copy it again from the Mac and paste it with Set.');
  if (r.status === 403) return fail('The resolver refused this address. Open the app from its Home Screen icon (it must be the danieldanilov.github.io app).');
  if (r.status === 500) return fail("The resolver isn't set up (it has no app token of its own). Ask for the Worker to be fixed.");
  if (r.status !== 400) return fail(`The resolver answered something unexpected (${r.status}). Try again in a minute.`);
  pass('The resolver accepts the app token.');

  // 4. Prove the TorBox key: a cached stream resolves and TorBox's video server answers this iPad.
  if (!found) return amber('No test title had a stream ready on TorBox, so the TorBox key could not be tried.');
  let j = {};
  try { r = await timed(fetchFn, endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': appToken }, body: JSON.stringify({ url: cached[0].url }) }); j = await r.json().catch(() => ({})); }
  catch { return amber("The resolver didn't answer for the test title, so the TorBox key could not be tried."); }
  if (j.status === 'ok' && typeof j.url === 'string') {
    try {
      const g = await timed(fetchFn, j.url, { headers: { Range: 'bytes=0-1' } });
      if (g.status !== 206 && g.status !== 200) return amber(`TorBox handed out the test title, but its video server answered ${g.status}.`);
    } catch { return amber("TorBox handed out the test title, but its video server didn't answer this iPad."); }
    pass(`TorBox hands out ${found.name}, and its video server answers this iPad.`);
    return { ok: true, level: 'ok', message: 'Connected. Everything works.', steps };
  }
  const reason = String(j.reason || j.status || r.status);
  if (/torbox_auth/.test(reason)) return fail('TorBox rejected the key inside the Torrentio link. Check the key on torbox.app and make the link again.');
  return amber(`The test title didn't resolve (${reason.replace(/[^\w-]/g, '').slice(0, 40)}), so the TorBox key could not be confirmed.`);
}
