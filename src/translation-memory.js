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
// TRANSLATE_DAILY_LINES (per user or desktop app, default 2000), TRANSLATE_MONTHLY_CHARS
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
  // Users and desktop apps (devices) each have their own daily lines; the month counts both.
  const usage = Object.fromEntries([['user', 'translation_usage', 'user_id'], ['device', 'device_usage', 'device_id']].map(([kind, table, column]) => [kind, {
    today: db.prepare(`SELECT lines FROM ${table} WHERE ${column} = ? AND day = ?`),
    add: db.prepare(`INSERT INTO ${table} (${column}, day, lines, chars) VALUES (?, ?, ?, ?)
      ON CONFLICT (${column}, day) DO UPDATE SET lines = lines + excluded.lines, chars = chars + excluded.chars`),
  }]));
  const usageMonth = db.prepare(`SELECT (SELECT COALESCE(SUM(chars), 0) FROM translation_usage WHERE day LIKE ?1)
    + (SELECT COALESCE(SUM(chars), 0) FROM device_usage WHERE day LIKE ?1) AS chars`);
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

  async function ask(lines, context, note = '') {
    const system = SYSTEM_PROMPT + (context ? `\nAbout the game: ${context}` : '');
    const user = (note ? `${note}\n` : '') + JSON.stringify(lines.map(([id, text]) => ({ id, text })));
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
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return {};
        }
        const items = Array.isArray(data) ? data : data?.translations;
        return Object.fromEntries((Array.isArray(items) ? items : []).filter((i) => i && 'id' in i).map((i) => [i.id, i.arabic]));
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
  async function batch(lines, context) {
    const answers = await ask(lines, context);
    const good = {};
    const failed = {};
    for (const [id, english] of lines) {
      let arabic = answers[id];
      let problem = problemWith(english, arabic);
      if (problem) {
        arabic = (await ask([[id, english]], context, `Your last translation of this line was unusable because ${problem}. Keep every tag and placeholder exactly.`))[id];
        problem = problemWith(english, arabic);
      }
      if (problem) failed[id] = problem;
      else good[id] = arabic;
    }
    return { good, failed };
  }

  /**
   * Translates the lines not stored yet, for `asker` ({ kind: 'user' | 'device', id }), within the limits.
   * `lines` is [{ hash, english }]; returns { arabic: { hash: text }, failed:
   * { hash: why }, limited: true when some weren't translated because of a limit }.
   */
  async function translate(asker, game, lines, { context = '' } = {}) {
    const spend = usage[asker.kind];
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
      const leftToday = Math.max(0, dailyLines - (spend.today.get(asker.id, day)?.lines || 0));
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
          const { good, failed: bad } = await batch(lines.map(([i, english]) => [i, english]), String(context).slice(0, 300));
          const chars = lines.reduce((sum, [, english]) => sum + english.length, 0);
          spend.add.run(asker.id, day, lines.length, chars);
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

  /** How many lines are stored for a game. */
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM translation_memory WHERE game = ?');
  const stored = (game) => countStmt.get(game).n;

  return { configured: Boolean(apiKey), lookup, translate, stored, model };
}

module.exports = { createTranslationMemory, problemWith, sha256, TranslationLimit, GAME_RE };
