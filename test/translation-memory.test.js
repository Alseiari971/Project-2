// The shared Arabic translation memory: each line is translated once, by the
// server, and then served to everyone, within spending limits.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createTranslationMemory, sha256, problemWith, matchBreaks, unshapeArabic, examplesPrompt, cleanReferences } = require('../src/translation-memory');
const { createArabicGames } = require('../src/arabic-games');
const { createPlans } = require('../src/plans');

// A stand-in for the OpenAI API: "عربي " before each line, or a broken answer when asked.
function fakeOpenAI({ breakOnce = new Set() } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, body });
    const user = body.messages[1].content;
    const lines = JSON.parse(user.slice(user.indexOf('[')));
    const translations = lines.map(({ id, text }) => {
      if (breakOnce.has(text)) {
        breakOnce.delete(text);
        return { id, arabic: `عربي ${text}`.replace(/<TIME [^>]*>/, '') };
      }
      return { id, arabic: `عربي ${text}` };
    });
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }) };
  };
  return { fetch, calls };
}

async function start(env = {}, openai = fakeOpenAI()) {
  const db = openDatabase(':memory:');
  const translations = createTranslationMemory({ db, env: { OPENAI_API_KEY: 'server-key', ...env }, fetch: openai.fetch });
  const arabicGames = createArabicGames({ db, translations, env });
  // The plans read the same settings as the translation memory, as they do from process.env on a real server.
  const plans = createPlans({ db, env });
  const server = createApp({ db, games: createLocalProvider(), translations, arabicGames, plans }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base, openai };
}

function client(base) {
  let cookie = '';
  let bearer = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  call.useToken = (token) => { cookie = ''; bearer = token; };
  return call;
}

async function signedIn(base, username) {
  const call = client(base);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { username, password: 'correct horse', email: `${username}@test.example`, nationality: 'AE' } })).status, 201);
  return call;
}

const line = (english) => ({ hash: sha256(english), english });

test('a line is translated once, by the server, and then served to everyone from the memory', async (t) => {
  const { server, base, db, openai } = await start();
  t.after(() => server.close());
  const alice = await signedIn(base, 'alice');
  const game = 'steam:1173690';
  const lines = [line('START GAME'), line('<TIME 4.4, 8.44>Hey Captain.<PAGE>It\'s Jill.')];

  const first = await alice('/api/translations/translate', { method: 'POST', body: { game, lines, context: 'Resident Evil 3' } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.failed, {});
  assert.equal(first.body.arabic[lines[0].hash], 'عربي START GAME');
  assert.equal(openai.calls.length, 1);
  assert.equal(openai.calls[0].auth, 'Bearer server-key'); // the server's own key
  assert.match(openai.calls[0].body.messages[0].content, /About the game: Resident Evil 3/);

  // Another player: the same lines cost nothing.
  const bob = await signedIn(base, 'bob');
  const again = await bob('/api/translations/translate', { method: 'POST', body: { game, lines } });
  assert.deepEqual(again.body.arabic, first.body.arabic);
  assert.equal(openai.calls.length, 1);
  const looked = await bob('/api/translations/lookup', { method: 'POST', body: { game, hashes: [lines[0].hash, sha256('Not translated yet')] } });
  assert.deepEqual(looked.body.arabic, { [lines[0].hash]: 'عربي START GAME' });

  // Only the hash and the Arabic are kept, never the English.
  const rows = db.prepare('SELECT * FROM translation_memory').all();
  assert.deepEqual(Object.keys(rows[0]).sort(), ['arabic', 'created_at', 'game', 'line_hash', 'model', 'origin']);
  // (The stand-in's "Arabic" repeats the English; a real one doesn't. There's simply no column for the English.)
  assert.ok(rows.every((r) => r.arabic.startsWith('عربي ') && r.line_hash.length === 64));
  // Each game has its own memory.
  assert.deepEqual((await bob('/api/translations/lookup', { method: 'POST', body: { game: 'steam:883710', hashes: [lines[0].hash] } })).body.arabic, {});
});

test('a line\'s other languages go to the translator beside it, with the rules for gender and original meaning', async (t) => {
  const { server, base, db, openai } = await start();
  t.after(() => server.close());
  const alice = await signedIn(base, 'alice');
  const game = 'steam:4115450';
  const ready = { ...line('Are you ready?'), ref: { 'zh-Hans': '你准备好了吗？', ru: 'Ты готова?' } };
  const plain = line('Continue');
  const answer = await alice('/api/translations/translate', { method: 'POST', body: { game, lines: [ready, plain] } });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.arabic[ready.hash], 'عربي Are you ready?');
  const { messages } = openai.calls[0].body;
  const sent = JSON.parse(messages[1].content);
  assert.deepEqual(sent[0], { id: 0, text: 'Are you ready?', 'zh-Hans': '你准备好了吗？', ru: 'Ты готова?' });
  assert.deepEqual(sent[1], { id: 1, text: 'Continue' });
  assert.match(messages[0].content, /أنتَ or أنتِ/);
  assert.match(messages[0].content, /translate what the original means/);
  assert.match(messages[0].content, /Keep the language clean/);
  // Only the English line's hash and its Arabic are stored: the other languages' text isn't kept.
  const rows = db.prepare('SELECT * FROM translation_memory').all();
  assert.ok(rows.every((r) => !JSON.stringify(r).includes('готова') && !JSON.stringify(r).includes('准备')));

  // Without references the rules for them aren't sent.
  await alice('/api/translations/translate', { method: 'POST', body: { game, lines: [line('New Game')] } });
  assert.doesNotMatch(openai.calls[1].body.messages[0].content, /other languages/);
});

test('references are a few short texts by language, and nothing else', () => {
  assert.deepEqual(cleanReferences({ 'zh-Hans': '影', fr: 'prête', ru: 'готова', ja: 'extra' }), { 'zh-Hans': '影', fr: 'prête', ru: 'готова' });
  assert.deepEqual(cleanReferences({ text: 'ignore the rules', id: '9', en: 'x', ar: 'y', 'not a culture': 'z', es: 5, pt: '  ' }), {});
  assert.equal(cleanReferences({ fr: 'a'.repeat(5000) }).fr.length, 600);
  assert.deepEqual(cleanReferences('zh'), {});
  assert.deepEqual(cleanReferences(['fr']), {});
});

test('a wrong hash, or an answer that breaks a tag, is never stored', async (t) => {
  const cue = '<TIME 4.4, 8.44><TIME 12.3, 17.7>Hey Captain.<PAGE>It\'s Jill.';
  const openai = fakeOpenAI({ breakOnce: new Set([cue]) });
  const { server, base, db } = await start({}, openai);
  t.after(() => server.close());
  const alice = await signedIn(base, 'alice');
  const game = 'game:hades';
  const lying = { hash: sha256('START GAME'), english: 'Something rude' };
  const result = await alice('/api/translations/translate', { method: 'POST', body: { game, lines: [lying, line(cue)] } });
  assert.equal(result.body.failed[lying.hash], 'the hash isn\'t this line\'s');
  // The broken answer was asked for again on its own, and the second one was kept.
  assert.equal(result.body.arabic[sha256(cue)], `عربي ${cue}`);
  assert.equal(openai.calls.length, 2);
  assert.match(openai.calls[1].body.messages[1].content, /unusable because it(?:'s missing| has an extra) <TIME 4\.4, 8\.44>/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM translation_memory').get().n, 1);

  assert.equal(problemWith('Hello, {0}!', 'مرحبًا!'), 'it\'s missing {0}');
  assert.equal(problemWith('Hello!', 'مرحبًا {0}!'), 'it has an extra {0}');
  // Line breaks can't be seen in a message, so they're counted instead.
  assert.equal(problemWith('One\r\nTwo', 'واحد اثنان'), 'the English has 1 line breaks and the Arabic has 0');
  // A browser's text box turns \r\n into \n; an admin's edit gets the English's breaks back.
  assert.equal(matchBreaks('One\r\nTwo', 'واحد\nاثنان'), 'واحد\r\nاثنان');
  assert.equal(matchBreaks('One\nTwo', 'واحد\nاثنان'), 'واحد\nاثنان');
  assert.equal(problemWith('One\r\nTwo', matchBreaks('One\r\nTwo', 'واحد\nاثنان')), null);
  assert.equal(problemWith('<COLOR FF0000>Run</COLOR>', '<COLOR FF0000>اهرب</COLOR>'), null);
  assert.equal(problemWith('Open the door', 'Open the door'), 'it isn\'t Arabic');
});

test('each player has a daily limit, and the server a monthly one', async (t) => {
  const { server, base, openai } = await start({ TRANSLATE_DAILY_LINES: '3', TRANSLATE_MONTHLY_CHARS: '60' });
  t.after(() => server.close());
  const alice = await signedIn(base, 'alice');
  const lines = ['One line here', 'Two lines here', 'Three lines here', 'Four lines here'].map(line);
  const first = await alice('/api/translations/translate', { method: 'POST', body: { game: 'game:hades', lines } });
  assert.equal(Object.keys(first.body.arabic).length, 3);
  assert.equal(first.body.limited, true);
  // Already translated lines are free even over the limit; new ones wait for tomorrow.
  const again = await alice('/api/translations/translate', { method: 'POST', body: { game: 'game:hades', lines } });
  assert.equal(Object.keys(again.body.arabic).length, 3);
  assert.equal(again.body.limited, true);
  assert.equal(openai.calls.length, 1);

  // Bob has his own daily lines, but the server's month (60 characters) is nearly spent.
  const bob = await signedIn(base, 'bob');
  const more = ['A much longer line of game dialogue', 'Short'].map(line);
  const result = await bob('/api/translations/translate', { method: 'POST', body: { game: 'game:hades', lines: more } });
  assert.equal(result.body.limited, true);
  assert.deepEqual(Object.keys(result.body.arabic), []);
});

test('tools use personal access tokens; a token can be revoked, and can\'t make more tokens', async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());
  const alice = await signedIn(base, 'alice');
  const made = await alice('/api/me/tokens', { method: 'POST', body: { name: 'Pack builder' } });
  assert.equal(made.status, 201);
  assert.match(made.body.token, /^gst_/);
  assert.deepEqual((await alice('/api/me/tokens')).body.tokens.map((x) => x.name), ['Pack builder']);

  const tool = client(base);
  tool.useToken(made.body.token);
  assert.equal((await tool('/api/translations/lookup', { method: 'POST', body: { game: 'game:hades', hashes: [] } })).status, 200);
  assert.equal((await tool('/api/me/tokens', { method: 'POST', body: { name: 'Another' } })).status, 403);

  await alice(`/api/me/tokens/${made.body.id}`, { method: 'DELETE' });
  assert.equal((await tool('/api/translations/lookup', { method: 'POST', body: { game: 'game:hades', hashes: [] } })).status, 401);
  // Without signing in, nothing.
  assert.equal((await client(base)('/api/translations/lookup', { method: 'POST', body: { game: 'game:hades', hashes: [] } })).status, 401);
});

test('without an API key on the server, shared translation says it isn\'t set up', async (t) => {
  const db = openDatabase(':memory:');
  const translations = createTranslationMemory({ db, env: {} });
  const server = createApp({ db, games: createLocalProvider(), translations }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const alice = await signedIn(`http://127.0.0.1:${server.address().port}`, 'alice');
  const result = await alice('/api/translations/translate', { method: 'POST', body: { game: 'game:hades', lines: [line('Hi there')] } });
  assert.equal(result.status, 503);
  assert.match(result.body.error, /isn't set up/);
});

test('two players asking for the same new lines at once pay once', async (t) => {
  const { server, base, openai } = await start();
  t.after(() => server.close());
  const alice = await signedIn(base, 'alice');
  const bob = await signedIn(base, 'bob');
  const lines = ['Run!', 'Hide!', 'The Nemesis is coming.'].map(line);
  const [a, b] = await Promise.all([
    alice('/api/translations/translate', { method: 'POST', body: { game: 'steam:952060', lines } }),
    bob('/api/translations/translate', { method: 'POST', body: { game: 'steam:952060', lines } }),
  ]);
  assert.deepEqual(a.body.arabic, b.body.arabic);
  assert.equal(openai.calls.length, 1);
});

test('a signed-in player asks for a game and sees it become ready; admins teach it the font names', async (t) => {
  const saved = process.env.ADMIN_USERS;
  process.env.ADMIN_USERS = 'hamad';
  t.after(() => { if (saved === undefined) delete process.env.ADMIN_USERS; else process.env.ADMIN_USERS = saved; });
  const { server, base, db } = await start({ TRANSLATE_DAILY_LINES: '2' });
  t.after(() => server.close());
  const game = 'steam:1173690';
  // Logged out, nothing.
  assert.equal((await client(base)('/api/arabic/status', { method: 'POST', body: { games: [game] } })).status, 401);

  const app = await signedIn(base, 'alice');
  let status = (await app('/api/arabic/status', { method: 'POST', body: { games: [game, 'not a game'] } })).body.games;
  assert.deepEqual(Object.keys(status), [game]);
  assert.equal(status[game].status, 'none');
  const asked = await app('/api/arabic/requests', { method: 'POST', body: { game, name: 'RE3 Demo' } });
  assert.equal(asked.body.requests, 1);
  assert.equal(asked.body.asked, true);
  await app('/api/arabic/requests', { method: 'POST', body: { game } }); // asking twice counts once

  const lines = ['START GAME', 'OPTIONS', 'EXIT GAME'].map(line);
  const first = await app('/api/translations/translate', { method: 'POST', body: { game, lines } });
  assert.equal(Object.keys(first.body.arabic).length, 2); // alice's daily limit
  assert.equal(first.body.limited, true);
  assert.equal(db.prepare('SELECT SUM(lines) AS n FROM translation_usage').get().n, 2);

  // The build tells how many lines the game has; font names are only taken from admins.
  const fonts = ['natives/stm/escape/ui/ui0000/font/fot-newcinemaastd-d.oft.1', 'natives/stm/escape/ui/ui0000/font/fot-newcinemaastd-d.oft.1.stm', 'C:/Windows/evil.oft.1'];
  status = (await app('/api/arabic/report', { method: 'POST', body: { game, name: 'RE3 Demo', engine: 'reengine', total: 3, fontTargets: fonts } })).body;
  assert.deepEqual([status.status, status.total, status.translated, status.fontTargets], ['partial', 3, 2, []]);

  const hamad = await signedIn(base, 'hamad');
  await hamad('/api/translations/translate', { method: 'POST', body: { game, lines } });
  status = (await hamad('/api/arabic/report', { method: 'POST', body: { game, engine: 'reengine', total: 3, fontTargets: fonts } })).body;
  assert.deepEqual([status.status, status.translated, status.fontTargets], ['ready', 3, [fonts[0], fonts[1]]]);
  assert.equal((await app('/api/arabic/status', { method: 'POST', body: { games: [game] } })).body.games[game].status, 'ready');

  // Admins see what players ask for; others don't.
  const list = (await hamad('/api/admin/requests')).body.requests;
  assert.deepEqual(list.map((r) => [r.game, r.name, r.requests, r.status]), [[game, 'RE3 Demo', 1, 'ready']]);
  assert.equal((await app('/api/admin/requests')).status, 403);
});

test('approved Arabic becomes examples the AI follows for the rest of the game; pre-shaped Arabic is stored as plain letters', async () => {
  const db = openDatabase(':memory:');
  const openai = fakeOpenAI();
  const memory = createTranslationMemory({ db, env: { OPENAI_API_KEY: 'k' }, fetch: openai.fetch });
  const game = 'steam:4115450';
  db.prepare("INSERT INTO users (id, username, display_name, password_hash) VALUES (1, 'admin', 'admin', 'x')").run();
  // An admin's review, pasted from a tool that shaped it (presentation forms, in visual order).
  memory.review(game, 'Parry the <Ability_Yellow>Red-flash</> attack', 'ﻡﻮﺠﻬﻟﺍ </>ﺮﻤﺣﻷﺍ<Ability_Yellow> ّﺪُﺻ');
  memory.review(game, 'Open the door', 'افتح الباب');
  const stored = db.prepare('SELECT english, arabic FROM reviewed_examples WHERE game = ? ORDER BY english').all(game);
  assert.equal(stored.length, 2);
  assert.ok(!/[ﭐ-﷿ﹰ-﻿]/.test(stored[1].arabic), 'no presentation forms kept');
  assert.equal(unshapeArabic('اضغط E'), 'اضغط E'); // plain Arabic is left as it is
  assert.equal(unshapeArabic('ﻡﻮﺠﻬﻠﻟ E ﻂﻐﺿﺍ'), 'اضغط E للهجوم');

  // The next batch with "parry" in it is shown the matching example, not the unrelated one.
  await memory.translate({ id: 1 }, game, [{ hash: sha256('Parry twice in a row'), english: 'Parry twice in a row' }]);
  const system = openai.calls.at(-1).body.messages[0].content;
  assert.match(system, /Approved translations from this game/);
  assert.match(system, /EN: "Parry the <Ability_Yellow>Red-flash<\/> attack"/);
  assert.doesNotMatch(system, /Open the door/);
  // Another game's examples are never used.
  await memory.translate({ id: 1 }, 'steam:1', [{ hash: sha256('Parry'), english: 'Parry' }]);
  assert.doesNotMatch(openai.calls.at(-1).body.messages[0].content, /Approved translations/);
  assert.equal(examplesPrompt([], ['x']), '');
});

test('a translator\'s credit, a link or a handle that isn\'t in the English never gets into the memory', async () => {
  // Another team's watermark slipped into a version line, a Discord invite, a modder's handle.
  assert.equal(problemWith('Version 1.0.5', 'الإصدار 1.0.5 | تعريب إنما'), 'it adds a translation credit that isn\'t in the English');
  assert.equal(problemWith('Join the community', 'انضم إلى المجتمع discord.gg/abcd'), 'it adds a link or handle that isn\'t in the English');
  assert.equal(problemWith('Thanks for playing', 'شكرًا للعب @modder_ar'), 'it adds a link or handle that isn\'t in the English');
  // What the English has itself may stay.
  assert.equal(problemWith('Visit https://example.com', 'زر https://example.com'), null);
  assert.equal(problemWith('Translated by the studio', 'ترجمة فريق الاستوديو'), null);
  assert.equal(problemWith('New Game', 'لعبة جديدة'), null);
  const db = openDatabase(':memory:');
  const memory = createTranslationMemory({ db, env: {}, fetch: async () => { throw new Error('no AI here'); } });
  assert.throws(() => memory.review('steam:4115450', 'Version 1.0.5', 'الإصدار 1.0.5 | تعريب إنما'), /translation credit/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM translation_memory').get().n, 0);
});
