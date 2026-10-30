// The shared Arabic translation memory: each line is translated once, by the
// server, and then served to everyone, within spending limits.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createTranslationMemory, sha256, problemWith } = require('../src/translation-memory');

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
  const server = createApp({ db, games: createLocalProvider(), translations }).listen(0);
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
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { username, password: 'correct horse' } })).status, 201);
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
  assert.match(openai.calls[1].body.messages[1].content, /unusable because it changed <TIME 4.4, 8.44>/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM translation_memory').get().n, 1);

  assert.equal(problemWith('Hello, {0}!', 'مرحبًا!'), 'it changed {0}');
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
