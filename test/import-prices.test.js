const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createSteamService } = require('../src/steam');
const { createPriceService } = require('../src/prices');

// Simulated responses, keyed by URL path (plus query where it matters).
function fakeFetch(routes) {
  return async (url) => {
    const u = new URL(url);
    const body = routes[u.pathname + u.search] ?? routes[u.pathname];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    return {
      ok: true,
      status: 200,
      json: async () => (typeof body === 'function' ? body(u) : body),
      text: async () => String(body),
    };
  };
}

const OWNED = {
  response: {
    game_count: 3,
    games: [
      { appid: 367520, name: 'Hollow Knight', playtime_forever: 3000 },
      { appid: 1145360, name: 'Hades', playtime_forever: 600, playtime_2weeks: 45 },
      { appid: 999999, name: 'Some Obscure Game', playtime_forever: 5 },
      { appid: 504230, name: 'Celeste', playtime_forever: 0 },
    ],
  },
};

let server;
let baseUrl;
let db;
// A Steam account proved with Steam's sign-in (that flow is tested in steam-link.test.js).
const linkSteam = (username, steamId) => db.prepare('UPDATE users SET steam_id = ? WHERE username = ?').run(steamId, username);

before(async () => {
  const steam = createSteamService('test-key', {
    fetchImpl: fakeFetch({
      '/id/hamad': '<profile><steamID64>76561198000000001</steamID64></profile>',
      '/id/nobody': '<response><error>The specified profile could not be found.</error></response>',
      '/IPlayerService/GetOwnedGames/v1/': (u) => (u.searchParams.get('steamid') === '76561198000000002' ? { response: {} } : OWNED),
    }),
  });
  db = openDatabase(':memory:');
  const app = createApp({ db, games: createLocalProvider(), steam });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

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

test('a Steam library is only imported from the account linked with Steam\'s sign-in, never a typed-in profile', async () => {
  const me = client();
  await me('/api/auth/register', { method: 'POST', body: { username: 'typist', password: 'shelf-pass-42', email: 'typist@test.example', nationality: 'SA' } });
  // Someone else's public profile, typed in: refused, whatever form it takes.
  for (const profile of ['76561198000000001', 'https://steamcommunity.com/profiles/76561198000000001/', 'hamad']) {
    const tried = await me('/api/me/import/steam/preview', { method: 'POST', body: { profile } });
    assert.equal(tried.status, 403);
    assert.equal(tried.body.code, 'link_required');
  }
  // The service itself takes only a SteamID64, never a custom name.
  await assert.rejects(createSteamService('k', { fetchImpl: fakeFetch({}) }).ownedGames('hamad'), { code: 'link_required' });
});

test('imports a Steam library without overwriting existing entries', async () => {
  const me = client();
  await me('/api/auth/register', { method: 'POST', body: { username: 'steamer', password: 'shelf-pass-42', email: 'steamer@test.example', nationality: 'AE' } });
  linkSteam('steamer', '76561198000000001');
  // Already on the list, rated by hand.
  await me('/api/me/library/hollow-knight', { method: 'PUT', body: { status: 'completed', rating: 10 } });

  // A profile in the body is ignored: the linked account is what's read.
  const { status, body: preview } = await me('/api/me/import/steam/preview', { method: 'POST', body: { profile: '76561198000000002' } });
  assert.equal(status, 200);
  assert.equal(preview.total, 4);
  const byName = Object.fromEntries(preview.items.map((i) => [i.name, i]));
  assert.equal(byName['Hollow Knight'].existingStatus, 'completed');
  assert.equal(byName.Hades.suggestedStatus, 'playing');
  assert.equal(byName.Celeste.suggestedStatus, 'want');
  assert.equal(byName['Some Obscure Game'].match, null);
  // Sorted by hours played.
  assert.equal(preview.items[0].name, 'Hollow Knight');

  const commit = await me('/api/me/import/steam/commit', {
    method: 'POST',
    body: {
      previewId: preview.previewId,
      items: [
        { appid: 367520, status: 'dropped' },
        { appid: 1145360, status: 'playing' },
        { appid: 999999, status: 'played' },
      ],
    },
  });
  assert.deepEqual(commit.body, { added: 1, updated: 1 });

  const profile = await client()('/api/users/steamer');
  const entries = Object.fromEntries(profile.body.library.map((e) => [e.gameId, e]));
  assert.equal(entries['hollow-knight'].status, 'completed');
  assert.equal(entries['hollow-knight'].rating, 10);
  assert.equal(entries['hollow-knight'].playtime, 3000);
  assert.equal(entries.hades.status, 'playing');
  assert.equal(entries.hades.playtime, 600);
  assert.equal(entries.celeste, undefined);
  assert.equal(profile.body.stats.hours, 60);

  // A preview can only be used once, and only by its owner.
  assert.equal((await me('/api/me/import/steam/commit', { method: 'POST', body: { previewId: preview.previewId, items: [] } })).status, 410);
});

test('explains private profiles', async () => {
  const me = client();
  await me('/api/auth/register', { method: 'POST', body: { username: 'private_p', password: 'shelf-pass-42', email: 'private_p@test.example', nationality: 'AE' } });
  linkSteam('private_p', '76561198000000002');
  const priv = await me('/api/me/import/steam/preview', { method: 'POST' });
  assert.equal(priv.status, 400);
  assert.equal(priv.body.code, 'private');
  assert.equal((await client()('/api/me/import/steam/preview', { method: 'POST' })).status, 401);
});

test('Steam import reports when no API key is configured', async () => {
  await assert.rejects(createSteamService('').ownedGames('76561198000000001'), { code: 'no_key' });
});

test('prices come back cheapest first from active stores only', async () => {
  const prices = createPriceService({
    fetchImpl: fakeFetch({
      '/api/1.0/games?steamAppID=367520': [{ gameID: '165363', external: 'Hollow Knight' }],
      '/api/1.0/games?id=165363': {
        cheapestPriceEver: { price: '2.99', date: 1712840581 },
        deals: [
          { storeID: '1', dealID: 'abc%3D', price: '14.99', retailPrice: '14.99', savings: '0' },
          { storeID: '7', dealID: 'def', price: '7.49', retailPrice: '14.99', savings: '50.03' },
          { storeID: '4', dealID: 'old', price: '1.00', retailPrice: '14.99', savings: '93' },
        ],
      },
      '/api/1.0/stores': [
        { storeID: '1', storeName: 'Steam', isActive: 1 },
        { storeID: '7', storeName: 'GOG', isActive: 1 },
        { storeID: '4', storeName: 'Amazon', isActive: 0 },
      ],
      '/api/1.0/games?title=Elden%20Ring&limit=10': [{ gameID: '1', external: 'Elden Ring Nightreign' }],
    }),
  });

  const result = await prices.pricesFor({ steamAppId: 367520, name: 'Hollow Knight' });
  assert.deepEqual(result.deals.map((d) => [d.store, d.price]), [['GOG', 7.49], ['Steam', 14.99]]);
  assert.equal(result.deals[1].url, 'https://www.cheapshark.com/redirect?dealID=abc%3D');
  assert.equal(result.lowestEver.price, 2.99);

  // Title search only accepts an exact match, never a "close enough" different game.
  assert.equal(await prices.pricesFor({ name: 'Elden Ring' }), null);
});
