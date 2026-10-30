const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createIgdbProvider, platformFamilies } = require('../src/games/igdb');

const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const IGDB_IMG = 'https://images.igdb.com/igdb/image/upload';

// Lookup tables deliberately use IDs that differ from IGDB's old fixed numbers,
// so the tests prove the provider looks them up by name.
const LOOKUPS = {
  game_types: [{ id: 100, type: 'Main Game' }, { id: 101, type: 'DLC' }, { id: 108, type: 'Remake' }],
  external_game_sources: [{ id: 7, name: 'Steam' }, { id: 8, name: 'GOG' }],
  website_types: [{ id: 41, type: 'Official Website' }, { id: 43, type: 'Steam' }, { id: 46, type: 'Epic Games' }],
  popularity_types: [{ id: 3, name: 'Visits' }, { id: 4, name: 'Want to Play' }],
  genres: [{ id: 12, name: 'Role-playing (RPG)' }, { id: 31, name: 'Adventure' }, { id: 8, name: 'Platform' }],
  themes: [{ id: 1, name: 'Action' }, { id: 35, name: 'Kids' }],
};

const ELDEN = {
  id: 1,
  name: 'Elden Ring',
  slug: 'elden-ring',
  first_release_date: 1645747200,
  total_rating_count: 900,
  summary: 'Rise, Tarnished.',
  cover: { image_id: 'co1' },
  artworks: [{ image_id: 'ar1' }],
  genres: [{ name: 'Role-playing (RPG)' }],
  themes: [{ name: 'Action' }],
  platforms: [{ name: 'PC (Microsoft Windows)' }, { name: 'PlayStation 5' }, { name: 'PlayStation 4' }, { name: 'Xbox Series X|S' }],
  external_games: [{ uid: '1245620', external_game_source: 7 }],
};
const ZELDA = {
  id: 2,
  name: 'The Legend of Zelda: Tears of the Kingdom',
  slug: 'the-legend-of-zelda-tears-of-the-kingdom',
  first_release_date: 1683849600,
  total_rating_count: 700,
  cover: { image_id: 'co2' },
  screenshots: [{ image_id: 'sc2' }],
  genres: [{ name: 'Adventure' }],
  themes: [{ name: 'Action' }],
  platforms: [{ name: 'Nintendo Switch' }],
};

function fakeIgdb({ failLookups = false } = {}) {
  const calls = [];
  let tokens = 0;
  let expireNext = false;
  const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'id.twitch.tv') {
      assert.equal(u.searchParams.get('grant_type'), 'client_credentials');
      tokens++;
      return respond(200, { access_token: `token-${tokens}`, expires_in: 5000000, token_type: 'bearer' });
    }
    const endpoint = u.pathname.replace('/v4/', '');
    const body = init.body;
    calls.push({ endpoint, body, headers: init.headers });
    assert.equal(init.headers['Client-ID'], 'client');
    if (expireNext) {
      expireNext = false;
      return respond(401, {});
    }
    if (LOOKUPS[endpoint]) return failLookups ? respond(500, {}) : respond(200, LOOKUPS[endpoint]);
    if (endpoint === 'popularity_primitives') return respond(200, [{ game_id: 2, value: 9 }, { game_id: 1, value: 5 }]);
    if (endpoint === 'external_games') return respond(200, [{ uid: '1245620', game: 1 }]);
    if (endpoint === 'games') {
      if (body.includes('where slug = "elden-ring"')) {
        return respond(200, [{
          ...ELDEN,
          similar_games: [2],
          involved_companies: [
            { developer: true, publisher: false, company: { name: 'FromSoftware' } },
            { developer: false, publisher: true, company: { name: 'Bandai Namco' } },
          ],
          websites: [{ type: 41, url: 'https://en.bandainamcoent.eu/elden-ring' }, { type: 46, url: 'https://store.epicgames.com/elden-ring' }],
        }]);
      }
      if (body.includes('where slug =')) return respond(200, []);
      if (/where id = \(2,1\)/.test(body) || /where id = \(1,2\)/.test(body)) return respond(200, [ELDEN, ZELDA]);
      if (/where id = \(1\)/.test(body)) return respond(200, [ELDEN]);
      if (/where id = \(2\)/.test(body)) return respond(200, [ZELDA]);
      return respond(200, [ZELDA, ELDEN]);
    }
    return respond(404, {});
  };
  return { fetchImpl, calls, tokenCount: () => tokens, expireToken: () => { expireNext = true; } };
}

const provider = (fake) => createIgdbProvider('client', 'secret', { fetchImpl: fake.fetchImpl, minIntervalMs: 0 });

test('logs in once and sends the Twitch token with every request', async () => {
  const fake = fakeIgdb();
  const igdb = provider(fake);
  await igdb.search({ query: 'elden ring' });
  await igdb.search({ query: 'zelda' });
  assert.equal(fake.tokenCount(), 1);
  assert.ok(fake.calls.every((c) => c.headers.Authorization === 'Bearer token-1'));
});

test('gets a new token when IGDB says the old one expired', async () => {
  const fake = fakeIgdb();
  const igdb = provider(fake);
  await igdb.search({ query: 'elden ring' });
  fake.expireToken();
  await igdb.search({ query: 'something else' });
  assert.equal(fake.tokenCount(), 2);
});

test('search uses looked-up game types and maps art, genres and platforms', async () => {
  const fake = fakeIgdb();
  const igdb = provider(fake);
  const { results } = await igdb.search({ query: 'elden ring' });

  const search = fake.calls.find((c) => c.endpoint === 'games' && c.body.startsWith('search'));
  assert.match(search.body, /^search "elden ring";/);
  assert.match(search.body, /game_type = \(100,108\)/);

  // Exact title match comes first.
  const [elden, zelda] = results;
  assert.equal(elden.name, 'Elden Ring');
  assert.equal(elden.id, 'elden-ring');
  assert.equal(elden.released, '2022-02-25');
  // On Steam: Steam's store banner and logo, IGDB's art as the fallback.
  assert.equal(elden.image, `${STEAM_CDN}/1245620/capsule_616x353.jpg`);
  assert.equal(elden.logo, null);
  assert.equal(elden.fallbackImage, `${IGDB_IMG}/t_screenshot_big/ar1.jpg`);
  assert.equal(elden.artHasTitle, true);
  assert.equal(elden.poster, `${IGDB_IMG}/t_cover_big_2x/co1.jpg`);
  assert.equal(elden.backdrop, `${IGDB_IMG}/t_1080p/ar1.jpg`);
  assert.deepEqual(elden.genres, ['Action', 'RPG']);
  assert.deepEqual(elden.platforms, ['PC', 'PlayStation', 'Xbox']);

  // Not on Steam: IGDB's own screenshot and official cover.
  assert.equal(zelda.image, `${IGDB_IMG}/t_screenshot_big/sc2.jpg`);
  assert.equal(zelda.artHasTitle, false);
  assert.equal(zelda.poster, `${IGDB_IMG}/t_cover_big_2x/co2.jpg`);
  assert.deepEqual(zelda.platforms, ['Nintendo']);
});

test('trending follows IGDB popularity, in order', async () => {
  const fake = fakeIgdb();
  const igdb = provider(fake);
  const { results } = await igdb.search({});
  const prim = fake.calls.find((c) => c.endpoint === 'popularity_primitives');
  assert.match(prim.body, /popularity_type = 3/);
  assert.deepEqual(results.map((g) => g.name), ['The Legend of Zelda: Tears of the Kingdom', 'Elden Ring']);
});

test('genres become IGDB genre and theme filters', async () => {
  const fake = fakeIgdb();
  const igdb = provider(fake);
  await igdb.search({ genre: 'Action' });
  await igdb.search({ genre: 'RPG', sort: 'new' });
  const bodies = fake.calls.filter((c) => c.endpoint === 'games').map((c) => c.body);
  assert.ok(bodies.some((b) => b.includes('(themes = (1))')));
  assert.ok(bodies.some((b) => b.includes('(genres = (12))') && b.includes('sort hypes desc')));
  // A genre IGDB has nothing for returns no results instead of everything.
  assert.deepEqual((await igdb.search({ genre: 'Racing' })).results, []);
});

test('game page: stores, companies, website and similar games', async () => {
  const fake = fakeIgdb();
  const igdb = provider(fake);
  const game = await igdb.getGame('elden-ring');
  assert.deepEqual(game.developers, ['FromSoftware']);
  assert.deepEqual(game.publishers, ['Bandai Namco']);
  assert.equal(game.website, 'https://en.bandainamcoent.eu/elden-ring');
  assert.equal(game.steamAppId, 1245620);
  const links = Object.fromEntries(game.buy.links.map((l) => [l.store, l]));
  assert.equal(links.steam.url, 'https://store.steampowered.com/app/1245620/');
  assert.equal(links.epic.url, 'https://store.epicgames.com/elden-ring');
  assert.equal(links.playstation.direct, false);
  assert.ok(links.xbox);
  assert.equal(links.nintendo, undefined);
  assert.deepEqual(game.similar.map((g) => g.name), ['The Legend of Zelda: Tears of the Kingdom']);
  assert.equal(await igdb.getGame('no-such-game'), null);
});

test('Steam games match IGDB exactly by Steam app ID', async () => {
  const fake = fakeIgdb();
  const igdb = provider(fake);
  const matches = await igdb.matchSteamGames([
    { appid: 1245620, name: 'ELDEN RING' },
    { appid: 999, name: 'Unknown' },
  ]);
  const ext = fake.calls.find((c) => c.endpoint === 'external_games');
  assert.match(ext.body, /external_game_source = 7/);
  assert.match(ext.body, /uid = \("1245620","999"\)/);
  assert.equal(matches[0].name, 'Elden Ring');
  assert.equal(matches[1], null);
});

test('falls back to IGDB\'s old fixed numbers if the lookup tables fail', async () => {
  const fake = fakeIgdb({ failLookups: true });
  const igdb = provider(fake);
  const { results } = await igdb.search({ query: 'elden ring' });
  const search = fake.calls.find((c) => c.endpoint === 'games' && c.body.startsWith('search'));
  assert.match(search.body, /game_type = \(0,4,8,9,10\)/);
  // Steam source 1 doesn't match the fake's 7, so no Steam art, but the page still works.
  assert.equal(results[0].name, 'Elden Ring');
});

test('groups platforms into families', () => {
  assert.deepEqual(
    platformFamilies([{ name: 'PlayStation 5' }, { name: 'PlayStation 4' }, { name: 'Nintendo Switch 2' }, { name: 'Mac' }, { name: 'Stadia' }]),
    ['PlayStation', 'Nintendo', 'macOS', 'Stadia'],
  );
});

test('one entry per game: platform duplicates and placeholders are dropped', async () => {
  // Real IGDB numbers for "god of war" (total_rating_count).
  const rows = [
    { id: 10, name: 'God of War', slug: 'god-of-war--1', first_release_date: 1111449600, total_rating_count: 1069, cover: {} },
    { id: 11, name: 'God of War', slug: 'god-of-war', first_release_date: 1524182400, total_rating_count: 3640, cover: {} },
    { id: 12, name: 'God of War', slug: 'god-of-war--2', first_release_date: 1258416000, total_rating_count: 98, cover: {} },
    { id: 13, name: 'God of War Ragnarök', slug: 'god-of-war-ragnarok', first_release_date: 1667952000, total_rating_count: 1197, cover: {} },
    { id: 14, name: 'God Wars 2', slug: 'god-wars-2' },
  ];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'id.twitch.tv') return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 99999 }) };
    return { ok: true, status: 200, json: async () => (u.pathname.endsWith('/games') ? rows : []) };
  };
  const igdb = createIgdbProvider('client', 'secret', { fetchImpl, minIntervalMs: 0 });
  const { results } = await igdb.search({ query: 'god of war' });
  // Exact name matches first (both real God of War games), then by popularity.
  assert.deepEqual(results.map((g) => `${g.name} ${g.released.slice(0, 4)}`), [
    'God of War 2018',
    'God of War 2005',
    'God of War Ragnarök 2022',
  ]);
});

test('adult games and test builds are hidden from lists', async () => {
  const rows = [
    { id: 1, name: 'Hollow Knight', slug: 'hollow-knight', total_rating_count: 900, cover: {}, themes: [{ name: 'Action' }] },
    { id: 2, name: 'Some Adult Game', slug: 'adult', total_rating_count: 50, cover: {}, themes: [{ name: 'Erotic' }] },
    { id: 3, name: 'Shooter Beta', slug: 'shooter-beta', total_rating_count: 40, cover: {} },
  ];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'id.twitch.tv') return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 99999 }) };
    return { ok: true, status: 200, json: async () => (u.pathname.endsWith('/games') ? rows : []) };
  };
  const igdb = createIgdbProvider('client', 'secret', { fetchImpl, minIntervalMs: 0 });
  assert.deepEqual((await igdb.search({ sort: 'top' })).results.map((g) => g.name), ['Hollow Knight']);
});

test('seasonal collections ask IGDB by theme and mode names, and leave out unwanted themes', async () => {
  const fake = fakeIgdb();
  const igdb = provider(fake);
  const kids = await igdb.collection({ all: [{ themes: ['kids'], genres: ['platform'] }], not: { themes: ['action'] }, sort: 'top' });
  const call = fake.calls.find((c) => c.endpoint === 'games');
  assert.match(call.body, /\(genres = \(8\) \| themes = \(35\)\)/);
  assert.match(call.body, /total_rating >= 80/);
  // Both fake games have the Action theme, so `not` removes them.
  assert.deepEqual(kids, []);
  // A theme IGDB doesn't have means an empty section, without asking for games.
  const before = fake.calls.length;
  assert.deepEqual(await igdb.collection({ all: [{ themes: ['horror'] }] }), []);
  assert.equal(fake.calls.filter((c, i) => i >= before && c.endpoint === 'games').length, 0);
  const all = await igdb.collection({ sort: 'popular' });
  assert.deepEqual(all.map((g) => g.id), ['the-legend-of-zelda-tears-of-the-kingdom', 'elden-ring']);
});
