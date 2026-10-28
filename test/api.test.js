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

test('home screen has a featured carousel and rows', async () => {
  const { status, body } = await client()('/api/home');
  assert.equal(status, 200);
  assert.ok(body.featured.length > 0);
  assert.ok(body.featured.every((g) => g.backdrop));
  assert.ok(body.rows.some((r) => r.id === 'trending'));
  assert.ok(body.rows.some((r) => r.genre === 'RPG'));
  assert.ok(body.genres.find((g) => g.name === 'RPG').image);

  const rpg = await client()('/api/games?genre=rpg');
  assert.ok(rpg.body.results.length > 0);
  assert.ok(rpg.body.results.every((g) => g.genres.includes('RPG')));
  assert.equal((await client()('/api/games?genre=nonsense')).status, 400);

  const game = await client()('/api/games/hollow-knight');
  assert.ok(game.body.similar.length > 0);
  assert.ok(!game.body.similar.some((g) => g.id === 'hollow-knight'));
});

test('customize a profile with showcases, background, frame and accent', async () => {
  const dana = client();
  await dana('/api/auth/register', { method: 'POST', body: { username: 'dana', password: 'password123' } });
  await dana('/api/me/library/elden-ring', { method: 'PUT', body: { status: 'completed', rating: 10 } });
  await dana('/api/me/library/celeste', { method: 'PUT', body: { status: 'played', rating: 8 } });

  const saved = await dana('/api/me', {
    method: 'PATCH',
    body: {
      headline: 'Souls-like addict',
      country: 'Dubai, UAE',
      avatarFrame: 'fire',
      background: 'game:elden-ring',
      accent: '#ef4444',
      showcases: [
        { type: 'favorite', gameId: 'elden-ring' },
        { type: 'collection', title: 'Hard but fair', gameIds: ['celeste', 'elden-ring'] },
        { type: 'toprated' },
        { type: 'info', title: 'Setup', text: 'PC + Steam Deck' },
      ],
    },
  });
  assert.equal(saved.status, 200);

  const { body } = await client()('/api/users/dana');
  assert.equal(body.user.headline, 'Souls-like addict');
  assert.equal(body.user.avatarFrame, 'fire');
  assert.equal(body.background.image, 'https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/library_hero.jpg');
  assert.deepEqual(body.showcases.map((s) => s.type), ['favorite', 'collection', 'toprated', 'info']);
  assert.equal(body.showcases[0].game.name, 'Elden Ring');
  assert.deepEqual(body.showcases[1].games.map((g) => g.gameId), ['celeste', 'elden-ring']);
  assert.deepEqual(body.showcases[2].games.map((g) => g.rating), [10, 8]);
  assert.equal(body.stats.averageRating, 9);
  assert.ok(body.progression.level >= 2);
  assert.ok(body.progression.badges.find((b) => b.id === 'curator').earned);

  const bad = async (patch) => (await dana('/api/me', { method: 'PATCH', body: patch })).status;
  assert.equal(await bad({ accent: '#123456' }), 400);
  assert.equal(await bad({ avatarFrame: 'sparkles' }), 400);
  assert.equal(await bad({ background: 'javascript:alert(1)' }), 400);
  assert.equal(await bad({ showcases: [{ type: 'stats' }, { type: 'stats' }, { type: 'stats' }, { type: 'stats' }, { type: 'stats' }] }), 400);
  assert.equal(await bad({ showcases: [{ type: 'evil' }] }), 400);
});

test('avatar upload checks the image bytes', async () => {
  const erin = client();
  await erin('/api/auth/register', { method: 'POST', body: { username: 'erin', password: 'password123' } });
  // Smallest valid PNG: 1×1 transparent pixel.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const ok = await erin('/api/me/avatar', { method: 'PUT', body: { image: `data:image/png;base64,${png}` } });
  assert.equal(ok.status, 200);
  assert.match(ok.body.user.avatarUrl, /^\/api\/users\/erin\/avatar\?v=1$/);

  const res = await fetch(baseUrl + ok.body.user.avatarUrl);
  assert.equal(res.headers.get('content-type'), 'image/png');

  const fake = Buffer.from('<script>alert(1)</script>').toString('base64');
  assert.equal((await erin('/api/me/avatar', { method: 'PUT', body: { image: `data:image/png;base64,${fake}` } })).status, 400);
});

test('profile comments can be deleted by the author or the profile owner', async () => {
  const frank = client();
  const gina = client();
  await frank('/api/auth/register', { method: 'POST', body: { username: 'frank', password: 'password123' } });
  await gina('/api/auth/register', { method: 'POST', body: { username: 'gina', password: 'password123' } });

  const posted = await gina('/api/users/frank/comments', { method: 'POST', body: { body: 'Nice list!' } });
  assert.equal(posted.status, 201);
  const second = await gina('/api/users/frank/comments', { method: 'POST', body: { body: 'Play Hades!' } });

  const profile = await client()('/api/users/frank');
  assert.deepEqual(profile.body.comments.map((c) => c.body), ['Play Hades!', 'Nice list!']);
  assert.equal(profile.body.comments[0].author.username, 'gina');
  assert.equal(profile.body.comments[0].id, second.body.comment.id);

  const stranger = client();
  await stranger('/api/auth/register', { method: 'POST', body: { username: 'harry', password: 'password123' } });
  assert.equal((await stranger(`/api/comments/${posted.body.comment.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await frank(`/api/comments/${posted.body.comment.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await gina(`/api/comments/${second.body.comment.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await client()('/api/users/frank')).body.comments.length, 0);
  assert.equal((await client()('/api/users/frank/comments', { method: 'POST', body: { body: 'hi' } })).status, 401);
});

test('RAWG games sold on Steam get official poster and logo art', async () => {
  const responses = {
    '/api/games': {
      count: 2,
      next: null,
      results: [
        { id: 4200, slug: 'portal-2', name: 'Portal 2', background_image: 'https://media.rawg.io/p2.jpg', stores: [{ store: { id: 1, slug: 'steam' } }] },
        { id: 99, slug: 'zelda', name: 'Zelda', background_image: 'https://media.rawg.io/z.jpg', stores: [{ store: { id: 6, slug: 'nintendo' } }] },
      ],
    },
    '/api/games/4200/stores': { results: [{ store_id: 1, url: 'https://store.steampowered.com/app/620/' }] },
  };
  const requested = [];
  const fakeFetch = async (url) => {
    requested.push(url.pathname);
    const body = responses[url.pathname];
    return { ok: Boolean(body), status: body ? 200 : 404, json: async () => body };
  };
  const rawg = createRawgProvider('test-key', { fetchImpl: fakeFetch });
  const { results } = await rawg.search({});
  await rawg.addSteamArt(results);

  const [portal, zelda] = results;
  assert.equal(portal.poster, 'https://cdn.cloudflare.steamstatic.com/steam/apps/620/library_600x900.jpg');
  assert.equal(portal.logo, 'https://cdn.cloudflare.steamstatic.com/steam/apps/620/logo.png');
  assert.equal(portal.image, 'https://media.rawg.io/p2.jpg');
  // Not on Steam: no poster, and no wasted request to look one up.
  assert.equal(zelda.poster, null);
  assert.ok(!requested.includes('/api/games/99/stores'));
});
