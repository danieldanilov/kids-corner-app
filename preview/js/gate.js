// Grown-up door: hold the corner lock, then a 4-digit PIN (salted PBKDF2, never stored in clear).
export const HOLD_MS = 3000;
export const MAX_FAILS = 5;
export const LOCK_MS = 60000;
const ITER = 150000;

export const holdDone = (start, now) => start != null && now - start >= HOLD_MS;
export const validPinFormat = (pin) => typeof pin === 'string' && /^\d{4}$/.test(pin);

const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16)));

async function derive(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function makePinRecord(pin) {
  if (!validPinFormat(pin)) throw new Error('bad pin');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: hex(salt), iterations: ITER, hash: await derive(pin, salt, ITER) };
}

export async function checkPin(pin, rec) {
  if (!rec || !validPinFormat(pin)) return false;
  const h = await derive(pin, unhex(rec.salt), rec.iterations);
  let diff = h.length ^ rec.hash.length;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ (rec.hash.charCodeAt(i) || 0);
  return diff === 0;
}

export function registerAttempt(s, ok, now) {
  if (ok) return { fails: 0, lockedUntil: 0 };
  const fails = s.fails + 1;
  return fails >= MAX_FAILS ? { fails: 0, lockedUntil: now + LOCK_MS } : { fails, lockedUntil: s.lockedUntil };
}

export const attemptState = (s, now) => ({ locked: now < s.lockedUntil, waitMs: Math.max(0, s.lockedUntil - now) });
