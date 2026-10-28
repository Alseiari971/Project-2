const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createRawgProvider } = require('../src/games/rawg');

let server;
let baseUrl;

before(async () => {
  const app = createApp({ db: openDatabase(':memory:'), games: createLocalProvider() });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// Minimal client that keeps a session cookie, like a browser would.
function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

test('lists and searches games', async () => {
  const call = client();
  const all = await call('/api/games');
  assert.equal(all.status, 200);
  assert.ok(all.body.results.length > 0);

  const found = await call('/api/games?search=hollow');
  assert.deepEqual(found.body.results.map((g) => g.name), ['Hollow Knight']);
});

test('game page has outbound store links only', async () => {
  const { status, body } = await client()('/api/games/elden-ring');
  assert.equal(status, 200);
  const steam = body.buy.links.find((l) => l.store === 'steam');
  assert.equal(steam.url, 'https://store.steampowered.com/app/1245620/');
  assert.equal(steam.direct, true);
  for (const link of body.buy.links) assert.match(link.url, /^https:\/\//);
  assert.equal((await client()('/api/games/not-a-real-game')).status, 404);
});

test('register, add games to a list and view the public profile', async () => {
  const alice = client();
  const reg = await alice('/api/auth/register', { method: 'POST', body: { username: 'alice', password: 'correct horse' } });
  assert.equal(reg.status, 201);

  assert.equal((await alice('/api/me/library/hades', { method: 'PUT', body: { status: 'completed', rating: 9 } })).status, 200);
  assert.equal((await alice('/api/me/library/celeste', { method: 'PUT', body: { status: 'want' } })).status, 200);
  await alice('/api/me', { method: 'PATCH', body: { displayName: 'Alice', bio: 'Roguelikes forever' } });

  // Anyone, logged in or not, can see Alice's list.
  const profile = await client()('/api/users/ALICE');
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.displayName, 'Alice');
  assert.equal(profile.body.stats.completed, 1);
  assert.equal(profile.body.stats.want, 1);
  const hades = profile.body.library.find((e) => e.gameId === 'hades');
  assert.equal(hades.name, 'Hades');
  assert.equal(hades.rating, 9);

  const game = await client()('/api/games/hades');
  assert.equal(game.body.community.count, 1);
  assert.equal(game.body.community.players[0].username, 'alice');

  const mine = await alice('/api/games/hades');
  assert.equal(mine.body.myEntry.status, 'completed');

  await alice('/api/me/library/celeste', { method: 'DELETE' });
  assert.equal((await client()('/api/users/alice')).body.library.length, 1);
});

test('validates input and requires login', async () => {
  const anon = client();
  assert.equal((await anon('/api/me/library/hades', { method: 'PUT', body: { status: 'played' } })).status, 401);

  const bob = client();
  assert.equal((await bob('/api/auth/register', { method: 'POST', body: { username: 'b', password: 'longenough' } })).status, 400);
  assert.equal((await bob('/api/auth/register', { method: 'POST', body: { username: 'bob', password: 'short' } })).status, 400);
  assert.equal((await bob('/api/auth/register', { method: 'POST', body: { username: 'bob', password: 'longenough' } })).status, 201);
  assert.equal((await client()('/api/auth/register', { method: 'POST', body: { username: 'BOB', password: 'longenough' } })).status, 409);

  assert.equal((await bob('/api/me/library/hades', { method: 'PUT', body: { status: 'owned' } })).status, 400);
  assert.equal((await bob('/api/me/library/hades', { method: 'PUT', body: { status: 'played', rating: 11 } })).status, 400);
  assert.equal((await bob('/api/me/library/nope-nope', { method: 'PUT', body: { status: 'played' } })).status, 404);
});

test('login and logout', async () => {
  const carol = client();
  await carol('/api/auth/register', { method: 'POST', body: { username: 'carol', password: 'password123' } });
  await carol('/api/auth/logout', { method: 'POST' });
  assert.equal((await carol('/api/me')).body.user, null);

  assert.equal((await carol('/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'wrong-password' } })).status, 401);
  const ok = await carol('/api/auth/login', { method: 'POST', body: { username: 'carol', password: 'password123' } });
  assert.equal(ok.status, 200);
  assert.equal((await carol('/api/me')).body.user.username, 'carol');
});

test('RAWG provider maps games and store links', async () => {
  const responses = {
    '/api/games/portal-2': {
      id: 4200, slug: 'portal-2', name: 'Portal 2', released: '2011-04-18', background_image: 'https://media.rawg.io/p2.jpg',
      description_raw: 'Puzzles.', genres: [{ name: 'Puzzle' }], parent_platforms: [{ platform: { name: 'PC' } }],
      developers: [{ name: 'Valve' }], publishers: [], website: 'https://www.thinkwithportals.com/',
      stores: [{ store: { id: 1, slug: 'steam' } }, { store: { id: 3, slug: 'playstation-store' } }],
    },
    '/api/games/4200/stores': { results: [{ store_id: 1, url: 'https://store.steampowered.com/app/620/' }] },
  };
  const fakeFetch = async (url) => {
    const body = responses[url.pathname];
    return { ok: Boolean(body), status: body ? 200 : 404, json: async () => body };
  };
  const rawg = createRawgProvider('test-key', { fetchImpl: fakeFetch });
  const game = await rawg.getGame('portal-2');
  assert.equal(game.id, 'portal-2');
  assert.deepEqual(game.platforms, ['PC']);
  assert.deepEqual(game.buy.links.map((l) => [l.store, l.direct]), [['steam', true], ['playstation', false]]);
  assert.equal(await rawg.getGame('missing'), null);
});
