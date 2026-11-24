// Secret hygiene. The Torrentio config holds the TorBox key; with the app token it lives only in IndexedDB.
// Nothing here ever writes a secret to a URL the app controls, a console line or the play report.

const TORRENTIO_HOST = 'torrentio.strem.fun';

// Accept a pasted manifest URL (https:// or stremio://) or the bare config segment; return the config or null.
export function normaliseTorrentioConfig(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (/^[a-z]+:\/\//i.test(s)) {
    const m = /^[a-z]+:\/\/([^/]+)\/(.+?)(?:\/manifest\.json)?\/?$/i.exec(s);
    if (!m || m[1].toLowerCase() !== TORRENTIO_HOST) return null;
    s = m[2];
  }
  try { if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s); } catch { return null; }
  if (s.includes('/')) return null;
  return torboxKeyOf(s) ? s : null;
}

export function torboxKeyOf(config) {
  const m = /(?:^|\|)torbox=([^|]+)/.exec(config || '');
  return m ? m[1] : null;
}

// Every string form a secret could appear in, longest first so the config is replaced before its key.
export function secretValues({ torrentioConfig = '', appToken = '' } = {}) {
  const vals = new Set();
  const add = (v) => { if (v && v.length >= 6) { vals.add(v); vals.add(encodeURIComponent(v)); } };
  add(torrentioConfig); add(torboxKeyOf(torrentioConfig)); add(appToken);
  return [...vals].sort((a, b) => b.length - a.length);
}

export function redact(text, secrets) {
  let s = String(text);
  for (const v of secrets) if (v) s = s.split(v).join('[redacted]');
  return s;
}

function stringify(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try { return JSON.stringify(a); } catch { return String(a); }
}

// Wrap console methods so every argument is redacted before it reaches the console.
export function guardConsole(con, getSecrets) {
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = con[m]?.bind(con);
    if (!orig) continue;
    con[m] = (...args) => {
      const secrets = getSecrets() || [];
      if (!secrets.length) return orig(...args);
      orig(...args.map(a => redact(stringify(a), secrets)));
    };
  }
  return con;
}

export function urlCarriesSecret(url, secrets) {
  return secrets.some(v => v && String(url).includes(v));
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi;
const DROP_KEYS = /url|href|link|token|config|key|secret|auth/i;

// Keep the numbers and names a parent needs; drop URL-ish fields, then scrub URLs and secrets from strings.
export function sanitizeReport(report, secrets) {
  const clean = (v, depth = 0) => {
    if (depth > 5) return undefined;
    if (typeof v === 'string') return redact(v, secrets).replace(URL_RE, '[link]');
    if (typeof v === 'number' || typeof v === 'boolean' || v == null) return v;
    if (Array.isArray(v)) return v.slice(0, 50).map(x => clean(x, depth + 1));
    if (typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) if (!DROP_KEYS.test(k)) o[k] = clean(x, depth + 1);
      return o;
    }
    return undefined;
  };
  return clean(report || {});
}
