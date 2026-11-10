// Games GameShelf doesn't carry: an admin's blocks and Steam's adult content
// descriptors, enforced in the catalog, on game pages and on the translation
// endpoints, with the admin's block and unblock.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createTranslationMemory, sha256 } = require('../src/translation-memory');
const { createGameBlocks, BlockError } = require('../src/game-blocks');

function client(base) {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

async function start() {
  const db = openDatabase(':memory:');
  const games = createLocalProvider();
  // The stand-in catalog, with Steam app ids and Steam's content descriptors for two of its games.
  const all = (await games.search({ pageSize: 50 })).results;
  const [first, second, third] = all;
  const appids = new Map([[first.id, 111], [second.id, 222], [third.id, 333]]);
  const withApp = (g) => (g && appids.has(g.id) ? { ...g, steamAppId: appids.get(g.id) } : g);
  const search = games.search.bind(games);
  const getGame = games.getGame.bind(games);
  games.search = async (...args) => {
    const data = await search(...args);
    return { ...data, results: data.results.map(withApp) };
  };
  games.getGame = async (id) => withApp(await getGame(id));
  games.contentDescriptors = async (ids) => new Map(ids.map((id) => [id, id === 222 ? [1, 3] : id === 333 ? [2, 5] : []]));
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push(url);
    const lines = JSON.parse(JSON.parse(init.body).messages[1].content);
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations: lines.map(({ id, text }) => ({ id, arabic: `عربي ${text}` })) }) } }] }) };
  };
  const translations = createTranslationMemory({ db, env: { OPENAI_API_KEY: 'k' }, fetch: fakeFetch });
  const server = createApp({ db, games, translations }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { db, server, base: `http://127.0.0.1:${server.address().port}`, first, second, third, calls };
}

async function signedIn(base, username) {
  const call = client(base);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { username, password: 'correct horse', email: `${username}@test.example`, nationality: 'AE' } })).status, 201);
  return call;
}

const line = (english) => ({ hash: sha256(english), english });

test('an adult-only game on Steam is left out of the catalog, its page and translation; others stay', async (t) => {
  const { server, base, first, second, third, calls } = await start();
  t.after(() => server.close());
  const anyone = client(base);
  const listed = (await anyone('/api/games')).body.results.map((g) => g.id);
  assert.ok(listed.includes(first.id));
  assert.ok(!listed.includes(second.id)); // descriptor 3: adult only sexual content
  assert.ok(listed.includes(third.id)); // violence and mature themes aren't what's filtered
  const page = await anyone(`/api/games/${second.id}`);
  assert.equal(page.status, 404);
  assert.equal(page.body.blocked, true);
  assert.equal((await anyone(`/api/games/${first.id}`)).status, 200);
  const home = JSON.stringify((await anyone('/api/home')).body);
  assert.ok(!home.includes(`"id":"${second.id}"`));

  const alice = await signedIn(base, 'alice');
  const refused = await alice('/api/translations/translate', { method: 'POST', body: { game: 'steam:222', lines: [line('Start')] } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.blocked, true);
  assert.equal((await alice('/api/translations/lookup', { method: 'POST', body: { game: 'steam:222', hashes: [sha256('Start')] } })).status, 403);
  assert.equal(calls.length, 0); // nothing was sent to the translator
  assert.equal((await alice('/api/translations/translate', { method: 'POST', body: { game: 'steam:111', lines: [line('Start')] } })).status, 200);
});

test('an admin blocks and unblocks a game; a block shows everywhere at once', async (t) => {
  const { server, base, db, first } = await start();
  t.after(() => server.close());
  const alice = await signedIn(base, 'alice');
  assert.equal((await alice('/api/admin/blocked-games')).status, 403);
  db.prepare("UPDATE users SET role = 'admin' WHERE username = 'alice'").run();

  const made = await alice('/api/admin/blocked-games', { method: 'POST', body: { steamAppId: 111, gameId: first.id, title: first.name, reason: 'gambling' } });
  assert.equal(made.status, 200);
  assert.equal(made.body.blocked.reason, 'gambling');
  assert.equal(made.body.blocked.blockedBy, 'alice');
  assert.equal((await alice('/api/admin/blocked-games', { method: 'POST', body: { steamAppId: 111, title: 'Again' } })).status, 400);
  assert.equal((await alice('/api/admin/blocked-games', { method: 'POST', body: { title: 'No id' } })).status, 400);

  assert.equal((await alice(`/api/games/${first.id}`)).status, 404);
  assert.ok(!(await alice('/api/games')).body.results.some((g) => g.id === first.id));
  assert.equal((await alice('/api/translations/translate', { method: 'POST', body: { game: 'steam:111', lines: [line('Start')] } })).status, 403);
  assert.equal((await alice('/api/translations/translate', { method: 'POST', body: { game: `game:${first.id}`, lines: [line('Start')] } })).status, 403);

  const list = (await alice('/api/admin/blocked-games')).body;
  assert.equal(list.blocked.length, 1);
  assert.ok(list.reasons.includes('adult_content'));
  assert.equal((await alice(`/api/admin/blocked-games/${list.blocked[0].id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await alice(`/api/games/${first.id}`)).status, 200);
  assert.equal((await alice(`/api/admin/blocked-games/${list.blocked[0].id}`, { method: 'DELETE' })).status, 400);
});

test('which descriptors are filtered is a setting, and Steam not answering blocks nothing', async () => {
  const db = openDatabase(':memory:');
  const games = { contentDescriptors: async (ids) => new Map(ids.map((id) => [id, [4]])) };
  assert.equal((await createGameBlocks({ db, games, env: {} }).refusal({ steamAppId: 5 })).reason, 'adult_content');
  assert.equal(await createGameBlocks({ db, games, env: { BLOCKED_CONTENT_DESCRIPTORS: '' } }).refusal({ steamAppId: 5 }), null);
  assert.equal(await createGameBlocks({ db, games, env: { BLOCKED_CONTENT_DESCRIPTORS: '3' } }).refusal({ steamAppId: 5 }), null);
  const down = { contentDescriptors: async () => { throw new Error('Steam is down'); } };
  assert.equal(await createGameBlocks({ db, games: down, env: {} }).refusal({ steamAppId: 5 }), null);
  assert.deepEqual(await createGameBlocks({ db, games: null, env: {} }).filter([{ id: 'a' }]), [{ id: 'a' }]);
  assert.throws(() => createGameBlocks({ db }).block({ gameId: 'Not A Slug!', title: 'x' }), BlockError);
});
