// Shared Arabic translations of game text, so each line is machine-translated
// once and every later player (or pack builder) gets it for free.
//
// - Lines are found by a SHA-256 of their English, per game ("steam:1173690",
//   "game:hades"). The English is never stored: only the hash and the Arabic.
// - Only this server writes machine translations, with its own API key, after
//   checking that each line's hash really is its English (so nobody can plant
//   Arabic under another line's hash) and that every tag and placeholder came
//   back unchanged (the same rules as localization/arabic_compiler/translate.py).
// - Spending is capped: each user may have so many new lines translated a day,
//   and the server so many characters a month. Lines already stored are free.
//
// Settings (environment): OPENAI_API_KEY, TRANSLATE_MODEL (default
// gpt-4.1-mini), TRANSLATE_API_BASE (any OpenAI-compatible API),
// TRANSLATE_DAILY_LINES (per user, default 2000), TRANSLATE_MONTHLY_CHARS
// (whole server, default 3,000,000).
const crypto = require('node:crypto');

const GAME_RE = /^(steam:\d{1,10}|game:[a-z0-9][a-z0-9-]{0,149})$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_LINE_CHARS = 2000;
const BATCH = 40;
const WORKERS = 3;

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// Tags and placeholders that must come back exactly (see translate.py's tokens()).
const ATTR = String.raw`(?:"[^"]*"|'[^']*'|[^\s>"']+)`;
const TOKENS = new RegExp([
  String.raw`<br\s*/?>|\r\n|\r|\n|\\n`,
  String.raw`<\/>|<\/?[A-Za-z][\w.\-]*(?:\s*=\s*${ATTR})?(?:\s+[A-Za-z][\w\-]*(?:\s*=\s*${ATTR})?)*\s*\/?>`,
  String.raw`\{[A-Za-z0-9_.:,#\- ]{0,40}\}|\$\{[A-Za-z0-9_.]{1,40}\}`,
  String.raw`%(?:\d+\$)?[-+#0]*(?:\d+|\*)?(?:\.\d+)?(?:hh|ll|[hlLqjzt])?[diouxXeEfFgGaAcspn@%]|%[A-Z_][A-Z0-9_]*%`,
  String.raw`\[[\x20-\x5A\x5C\x5E-\x7E]{1,40}\]`,
].join('|'), 'g');
const EXTRA_TOKENS = [
  /\{\/[A-Za-z_]{1,20}\}|\{[A-Za-z_]{1,20}=[^{}\n]{1,80}\}/g, // Ren'Py
  /<\/?[A-Z][A-Z_]*(?: [^<>\n]{1,80})?>/g, // RE Engine: <TIME 4.4, 8.44>, <PAGE>, <COLOR FF0000>
];

function tokens(text) {
  const counts = new Map();
  for (const pattern of [TOKENS, ...EXTRA_TOKENS]) {
    for (const [match] of text.matchAll(pattern)) counts.set(match, (counts.get(match) || 0) + 1);
  }
  return counts;
}

/** Why a translation can't be used, or null. */
function problemWith(english, arabic) {
  if (typeof arabic !== 'string' || !arabic.trim()) return 'it came back empty';
  const want = tokens(english);
  const got = tokens(arabic);
  const keys = new Set([...want.keys(), ...got.keys()]);
  for (const key of keys) if ((want.get(key) || 0) !== (got.get(key) || 0)) return `it changed ${key}`;
  if (/[A-Za-z]/.test(english.replace(TOKENS, '')) && !/[؀-ۿ]/.test(arabic)) return 'it isn\'t Arabic';
  return null;
}

const SYSTEM_PROMPT = `You translate video game text from English into natural Modern Standard Arabic for players in the Middle East and North Africa.
Rules:
- Keep every tag, placeholder and key prompt exactly as written, character for character: {0}, {name}, %s, %d, %1$s, %PLAYER%, \${name}, <color=#ff0000>...</color>, <b>, </>, {i}...{/i}, {w=0.5}, <TIME 4.4, 8.44>, <PAGE>, <COLOR FF0000>, [E], [Press E], [player], <br>, and \\n line breaks. Move them only where Arabic word order needs it.
- Keep proper names of people and places in their usual Arabic spelling; keep brand and product names in Latin letters.
- Match the tone: menus short and plain, dialogue natural.
- Use Western digits (0-9) as written.
Answer with JSON only: {"translations": [{"id": <id>, "arabic": "<translation>"}, ...]}, one item per input line, same ids.`;

// The glossary pass (the pack builder sends a game's candidate names, terms and sample lines; see
// localization/arabic_compiler/glossary.py, which has the same prompt for --provider builds).
const GLOSSARY_PROMPT = `You prepare a translation glossary for a video game being translated from English into Modern Standard Arabic.
For each term, give the Arabic to use everywhere in the game: names of people, places, factions and creatures in their usual Arabic spelling (transliterated when they have none); items, skills, menus and other game terms translated, short and natural; brand and product names in Latin letters.
From the sample lines, decide how the game speaks to the player character: "masculine", "feminine", or "unknown" (the player picks, or the lines don't say), and the player character's name if the lines show it.
Answer with JSON only: {"terms": {"<English>": "<Arabic>", ...}, "player": {"gender": "masculine" | "feminine" | "unknown", "name": "<name, or empty>"}}`;
const GENDERS = ['masculine', 'feminine', 'unknown'];
const MAX_GLOSSARY_TERMS = 300;
const MAX_GLOSSARY_SAMPLES = 40;
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A glossary kept to its shape: { terms: { English: Arabic }, player: { gender, name } }. */
function cleanGlossary(data) {
  const out = { terms: {}, player: { gender: 'unknown', name: '' } };
  const terms = data && typeof data.terms === 'object' && !Array.isArray(data.terms) ? data.terms : {};
  for (const [english, arabic] of Object.entries(terms)) {
    if (typeof arabic !== 'string' || !english.trim() || english.length > 80 || !arabic.trim() || arabic.length > 120) continue;
    // Brand names may stay in Latin letters; anything else must be Arabic.
    if (/[\u0600-\u06FF]/.test(arabic) || arabic === english) out.terms[english.trim()] = arabic.trim();
  }
  const player = data && typeof data.player === 'object' ? data.player : {};
  if (GENDERS.includes(player.gender)) out.player.gender = player.gender;
  if (typeof player.name === 'string') out.player.name = player.name.trim().slice(0, 60);
  return out;
}

/** What a batch of English lines is told: the Arabic for the terms in them, and how to speak to the player. */
function glossaryPrompt(glossary, lines) {
  // No terms and nothing known of the player: the same as no glossary.
  if (!glossary || (!Object.keys(glossary.terms || {}).length && (glossary.player?.gender || 'unknown') === 'unknown')) return '';
  const text = lines.join('\n');
  const terms = Object.entries(glossary.terms || {})
    .filter(([english]) => text.includes(english) && lines.some((line) => new RegExp(`(?<![\\w])${escapeRe(english)}(?![\\w])`).test(line)))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(0, 80);
  let out = terms.length ? `\nUse these Arabic renderings for names and terms, always the same way:\n${terms.map(([en, ar]) => `- ${en} -> ${ar}`).join('\n')}` : '';
  const { gender, name } = glossary.player || {};
  const who = name ? ` (${name})` : '';
  if (gender === 'feminine') out += `\nThe player character is female${who}: when a line speaks to the player ("you"), use feminine Arabic forms (أنتِ، تستطيعين، اذهبي).`;
  else if (gender === 'masculine') out += `\nThe player character is male${who}: when a line speaks to the player ("you"), use masculine Arabic forms (أنتَ، تستطيع، اذهب).`;
  else out += '\nThe player character\'s gender isn\'t known: when a line speaks to the player ("you"), use masculine Arabic forms, the usual default, consistently.';
  return out;
}

class TranslationLimit extends Error {}

function createTranslationMemory({ db, env = process.env, fetch = globalThis.fetch, now = () => new Date() }) {
  const apiKey = env.OPENAI_API_KEY || '';
  const model = env.TRANSLATE_MODEL || 'gpt-4.1-mini';
  const base = (env.TRANSLATE_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const dailyLines = Number(env.TRANSLATE_DAILY_LINES) || 2000;
  const monthlyChars = Number(env.TRANSLATE_MONTHLY_CHARS) || 3000000;

  const select = db.prepare('SELECT line_hash, arabic FROM translation_memory WHERE game = ? AND line_hash = ?');
  const insert = db.prepare(`INSERT INTO translation_memory (game, line_hash, arabic, origin, model) VALUES (?, ?, ?, 'machine', ?)
    ON CONFLICT (game, line_hash) DO NOTHING`);
  const usageToday = db.prepare('SELECT lines FROM translation_usage WHERE user_id = ? AND day = ?');
  const usageMonth = db.prepare('SELECT COALESCE(SUM(chars), 0) AS chars FROM translation_usage WHERE day LIKE ?');
  const addUsage = db.prepare(`INSERT INTO translation_usage (user_id, day, lines, chars) VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, day) DO UPDATE SET lines = lines + excluded.lines, chars = chars + excluded.chars`);
  // One game translated at a time, so two players asking at once don't pay twice.
  const busy = new Map();

  function checkGame(game) {
    if (!GAME_RE.test(String(game))) throw new TypeError('The game should be "steam:<app id>" or "game:<GameShelf id>".');
  }

  /** The Arabic already stored for these line hashes: { hash: arabic }. */
  function lookup(game, hashes) {
    checkGame(game);
    const found = {};
    for (const hash of hashes) {
      if (!HASH_RE.test(hash)) continue;
      const row = select.get(game, hash);
      if (row) found[hash] = row.arabic;
    }
    return found;
  }

  async function ask(lines, context, note = '', extra = '') {
    const system = SYSTEM_PROMPT + (context ? `\nAbout the game: ${context}` : '') + extra;
    const user = (note ? `${note}\n` : '') + JSON.stringify(lines.map(([id, text]) => ({ id, text })));
    const data = await complete(system, user);
    if (!data) return {};
    const items = Array.isArray(data) ? data : data?.translations;
    return Object.fromEntries((Array.isArray(items) ? items : []).filter((i) => i && 'id' in i).map((i) => [i.id, i.arabic]));
  }

  /** One request to the translation service: the answer's JSON, or null when it wasn't JSON. */
  async function complete(system, user) {
    let delay = 1000;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (res.ok) {
        const payload = await res.json();
        const text = String(payload?.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      }
      if (![408, 409, 425, 429, 500, 502, 503, 504].includes(res.status) || attempt >= 4) {
        throw new Error(`The translation service answered ${res.status}.`);
      }
      const wait = Number(res.headers.get('retry-after'));
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(wait) && wait > 0 ? wait * 1000 : delay));
      delay = Math.min(delay * 2, 30000);
    }
  }

  // One batch: asked together, then any line that broke a tag once more on its own.
  async function batch(lines, context, extra = '') {
    const answers = await ask(lines, context, '', extra);
    const good = {};
    const failed = {};
    for (const [id, english] of lines) {
      let arabic = answers[id];
      let problem = problemWith(english, arabic);
      if (problem) {
        arabic = (await ask([[id, english]], context, `Your last translation of this line was unusable because ${problem}. Keep every tag and placeholder exactly.`, extra))[id];
        problem = problemWith(english, arabic);
      }
      if (problem) failed[id] = problem;
      else good[id] = arabic;
    }
    return { good, failed };
  }

  /**
   * Translates the lines not stored yet, for `user`, within the limits.
   * `lines` is [{ hash, english }]; returns { arabic: { hash: text }, failed:
   * { hash: why }, limited: true when some weren't translated because of a limit }.
   */
  async function translate(user, game, lines, { context = '' } = {}) {
    checkGame(game);
    if (!apiKey) throw new TranslationLimit('Shared translation isn\'t set up on this server.');
    const arabic = {};
    const failed = {};
    const todo = [];
    for (const { hash, english } of lines) {
      if (typeof english !== 'string' || !english.trim() || english.length > MAX_LINE_CHARS) {
        failed[hash] = 'the line is empty or too long';
      } else if (sha256(english) !== hash) {
        failed[hash] = 'the hash isn\'t this line\'s';
      } else {
        const row = select.get(game, hash);
        if (row) arabic[hash] = row.arabic;
        else if (!todo.some((t) => t.hash === hash)) todo.push({ hash, english });
      }
    }
    if (!todo.length) return { arabic, failed, limited: false };

    while (busy.has(game)) await busy.get(game).catch(() => {});
    let release;
    busy.set(game, new Promise((resolve) => { release = resolve; }));
    try {
      // Someone may have translated some of these while this waited.
      const fresh = todo.filter((t) => {
        const row = select.get(game, t.hash);
        if (row) arabic[t.hash] = row.arabic;
        return !row;
      });
      const day = now().toISOString().slice(0, 10);
      const leftToday = Math.max(0, dailyLines - (usageToday.get(user.id, day)?.lines || 0));
      let leftMonth = Math.max(0, monthlyChars - usageMonth.get(`${day.slice(0, 7)}%`).chars);
      const allowed = [];
      for (const t of fresh) {
        if (allowed.length >= leftToday || t.english.length > leftMonth) break;
        leftMonth -= t.english.length;
        allowed.push(t);
      }
      const limited = allowed.length < fresh.length;
      const batches = [];
      for (let i = 0; i < allowed.length; i += BATCH) batches.push(allowed.slice(i, i + BATCH));
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const lines = batches[next++].map((t, i) => [i, t.english, t.hash]);
          const known = glossary(game);
          const { good, failed: bad } = await batch(lines.map(([i, english]) => [i, english]), String(context).slice(0, 300),
            known ? glossaryPrompt(known, lines.map(([, english]) => english)) : '');
          const chars = lines.reduce((sum, [, english]) => sum + english.length, 0);
          addUsage.run(user.id, day, lines.length, chars);
          for (const [i, , hash] of lines) {
            if (i in good) {
              insert.run(game, hash, good[i], model);
              arabic[hash] = good[i];
            } else {
              failed[hash] = bad[i];
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(WORKERS, batches.length) }, worker));
      return { arabic, failed, limited };
    } finally {
      busy.delete(game);
      release();
    }
  }

  /**
   * An admin's own Arabic for a line (from reviewing a submission): kept as
   * 'reviewed', replacing the machine translation. Throws TypeError when it
   * breaks a tag or placeholder of the English.
   */
  const saveReviewed = db.prepare(`INSERT INTO translation_memory (game, line_hash, arabic, origin, model) VALUES (?, ?, ?, 'reviewed', NULL)
    ON CONFLICT (game, line_hash) DO UPDATE SET arabic = excluded.arabic, origin = 'reviewed', model = NULL`);
  function review(game, english, arabic) {
    checkGame(game);
    const problem = problemWith(english, arabic);
    if (problem) throw new TypeError(`That Arabic can't be used: ${problem}.`);
    saveReviewed.run(game, sha256(english), arabic);
  }

  // ---- The game's glossary ----------------------------------------------------------

  const getGlossary = db.prepare('SELECT * FROM game_glossaries WHERE game = ?');
  const saveGlossary = db.prepare(`INSERT INTO game_glossaries (game, terms, player, locked, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (game) DO UPDATE SET terms = excluded.terms, player = excluded.player, locked = excluded.locked, updated_at = excluded.updated_at`);

  /** A game's glossary: { terms, player: { gender, name, checked }, locked, updatedAt }, or null. */
  function glossary(game) {
    checkGame(game);
    const row = getGlossary.get(game);
    return row ? { terms: JSON.parse(row.terms), player: JSON.parse(row.player), locked: Boolean(row.locked), updatedAt: row.updated_at } : null;
  }

  /**
   * Before a game's lines are translated: makes its glossary, or adds the new
   * candidate terms to it, in one request (counted like that many lines, for
   * `user`). Terms already there, and an admin's edits, are never changed.
   * Returns the glossary.
   */
  async function ensureGlossary(user, game, { terms = [], samples = [], context = '' } = {}) {
    checkGame(game);
    if (!apiKey) throw new TranslationLimit('Shared translation isn\'t set up on this server.');
    const current = glossary(game) || { terms: {}, player: { gender: 'unknown', name: '' }, locked: false };
    const wanted = [...new Set((Array.isArray(terms) ? terms : []).filter((t) => typeof t === 'string' && t.trim() && t.length <= 80).map((t) => t.trim()))]
      .filter((t) => !(t in current.terms)).slice(0, MAX_GLOSSARY_TERMS);
    const lines = (Array.isArray(samples) ? samples : []).filter((l) => typeof l === 'string' && l.trim()).map((l) => l.slice(0, 300)).slice(0, MAX_GLOSSARY_SAMPLES);
    const askPlayer = !current.player.checked && !current.locked && lines.length > 0;
    if (!wanted.length && !askPlayer) return current;
    const day = now().toISOString().slice(0, 10);
    const cost = wanted.length + lines.length;
    if ((usageToday.get(user.id, day)?.lines || 0) + cost > dailyLines) return current; // the day's limit: no glossary this time
    const answer = cleanGlossary(await complete(GLOSSARY_PROMPT, JSON.stringify({ context: String(context).slice(0, 300), terms: wanted, samples: askPlayer ? lines : [] })));
    const added = Object.fromEntries(Object.entries(answer.terms).filter(([english]) => wanted.includes(english)));
    const player = askPlayer ? { ...answer.player, checked: true } : current.player;
    saveGlossary.run(game, JSON.stringify({ ...added, ...current.terms }), JSON.stringify(player), current.locked ? 1 : 0);
    addUsage.run(user.id, day, cost, JSON.stringify(wanted).length + lines.join('').length);
    return glossary(game);
  }

  /** An admin's glossary for a game (replacing it): kept, and only added to by the automatic pass. */
  function setGlossary(game, data) {
    checkGame(game);
    const cleaned = cleanGlossary(data);
    saveGlossary.run(game, JSON.stringify(cleaned.terms), JSON.stringify({ ...cleaned.player, checked: true }), 1);
    return glossary(game);
  }

  /** How many lines are stored for a game. */
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM translation_memory WHERE game = ?');
  const stored = (game) => countStmt.get(game).n;

  return { configured: Boolean(apiKey), lookup, translate, review, stored, model, glossary, ensureGlossary, setGlossary };
}

module.exports = { createTranslationMemory, problemWith, sha256, TranslationLimit, GAME_RE, cleanGlossary, glossaryPrompt, GLOSSARY_PROMPT };
