// One AudioContext, three gain nodes (master, names, effects), resumed on her first tap (spec 2.5, 11).
// Spoken names: English clip, 250 ms gap, Russian clip; a new clip stops the one playing. Effects: soft sine/triangle tones.

export const LEVELS = { off: 0, quiet: 1, normal: 2 };
const NAME_GAIN = { off: 0, quiet: 0.35, normal: 0.7 };
const EFFECT_GAIN = { off: 0, quiet: 0.18, normal: 0.36 };

// Fixed sound per element (same tap, same sound). [frequency Hz, ...] played in sequence, wave, note length s.
export const EFFECTS = {
  chip: [[440], 'sine', 0.22],
  poster: [[330], 'sine', 0.22],
  sign: [[392], 'triangle', 0.2],
  heartOn: [[392, 523], 'sine', 0.16],
  heartOff: [[523, 392], 'sine', 0.16],
  button: [[349], 'triangle', 0.16],
  tick: [[494], 'sine', 0.1],
  arrow: [[294], 'triangle', 0.18],
};

export function createSound({ fetchImpl = (...a) => fetch(...a), base = 'voice/' } = {}) {
  let ctx = null, master, names, effects, current = [];
  let settings = { all: true, names: 'quiet', effects: 'quiet', namesLang: 'en-ru' };
  let bedtime = false;
  let index = { en: new Set(), ru: new Set() };
  const buffers = new Map();
  const lastEffect = {};

  function applyGains() {
    if (!ctx) return;
    const all = settings.all !== false;
    master.gain.value = all ? 1 : 0;
    names.gain.value = bedtime ? Math.min(0.25, NAME_GAIN[settings.names] ?? 0.35) : (NAME_GAIN[settings.names] ?? 0.35);
    effects.gain.value = bedtime ? 0 : (EFFECT_GAIN[settings.effects] ?? 0.18);
  }

  async function loadIndex() {
    try {
      const r = await fetchImpl(base + 'index.json');
      const j = await r.json();
      index = { en: new Set(j.en || []), ru: new Set(j.ru || []) };
    } catch { /* no clips: silence */ }
  }

  async function buffer(lang, key) {
    const id = lang + '/' + key;
    if (!buffers.has(id)) {
      buffers.set(id, (async () => {
        const r = await fetchImpl(`${base}${lang}/${encodeURIComponent(key)}.m4a`);
        return ctx.decodeAudioData(await r.arrayBuffer());
      })().catch(() => null));
    }
    return buffers.get(id);
  }

  const has = (lang, key) => index[lang]?.has(key);

  return {
    loadIndex,
    has,
    langsFor(key) {
      // A title is spoken once, as written in the catalog (only that language's clip exists).
      if (key.startsWith('title.')) { const l = ['en', 'ru'].find(x => has(x, key)); return l ? [l] : []; }
      const order = settings.namesLang === 'en' ? ['en'] : settings.namesLang === 'ru' ? ['ru'] : ['en', 'ru'];
      return order.filter(l => has(l, key));
    },
    configure(s, isBedtime) { settings = { ...settings, ...s }; bedtime = !!isBedtime; applyGains(); },
    unlock() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain(); master.connect(ctx.destination);
        names = ctx.createGain(); names.connect(master);
        effects = ctx.createGain(); effects.connect(master);
        applyGains();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    },
    stopVoice() { for (const s of current) { try { s.stop(); } catch { /* done */ } } current = []; },
    // Speak a phrase key in the parent's language order. Resolves when finished (or at once if silent).
    async say(key) {
      this.stopVoice();
      if (!ctx || settings.all === false || settings.names === 'off') return;
      const langs = this.langsFor(key);
      if (!langs.length) return;
      const token = {};
      this._token = token;
      const bufs = await Promise.all(langs.map(l => buffer(l, key)));
      if (this._token !== token) return;
      let t = ctx.currentTime + 0.02;
      const started = [];
      for (const b of bufs) {
        if (!b) continue;
        const src = ctx.createBufferSource();
        src.buffer = b; src.connect(names); src.start(t);
        started.push(src);
        t += b.duration + 0.25;
      }
      current = started;
      await new Promise(r => setTimeout(r, Math.max(0, (t - ctx.currentTime) * 1000)));
    },
    effect(name) {
      if (!ctx || settings.all === false || settings.effects === 'off' || bedtime) return;
      const now = performance.now();
      if (lastEffect[name] && now - lastEffect[name] < 250) return;
      lastEffect[name] = now;
      const e = EFFECTS[name];
      if (!e) return;
      const [freqs, wave, len] = e;
      let t = ctx.currentTime + 0.005;
      for (const f of freqs) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = wave; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.9, t + 0.03);           // 30 ms attack
        g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.25);  // soft release
        o.connect(g); g.connect(effects);
        o.start(t); o.stop(t + len + 0.3);
        t += len * 0.8;
      }
    },
    tone(freq, wave = 'sine', len = 0.25) {     // toys use fixed pitches per element
      if (!ctx || settings.all === false || settings.effects === 'off' || bedtime) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      const t = ctx.currentTime + 0.005;
      o.type = wave; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.8, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.25);
      o.connect(g); g.connect(effects); o.start(t); o.stop(t + len + 0.3);
      return { fade() { try { const n = ctx.currentTime; g.gain.cancelScheduledValues(n); g.gain.setTargetAtTime(0.0001, n, 0.02); o.stop(n + 0.12); } catch { /* ended */ } } };
    },
  };
}
