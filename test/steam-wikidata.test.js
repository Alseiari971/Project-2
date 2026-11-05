// The Steam + Wikidata game catalog, against stand-ins for both (no network):
// search, browse lists, game pages, Wikidata's Arabic titles and engines,
// games that aren't on Steam, old ids, caching with a TTL, backoff, Wikidata
// being down, and that nothing asks Twitch/IGDB for anything.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createSteamWikidataProvider, mapEngine, slugify, titleScore, USER_AGENT } = require('../src/games/steam-wikidata');
const { createGameProvider } = require('../src/games');

const searchRow = (appid, name, date, percent, count) => `<a href="https://store.steampowered.com/app/${appid}/x/" data-ds-appid="${appid}" data-ds-tagids="[19,21]" class="search_result_row">
  <div class="search_capsule"><img src="https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/abc123/capsule_231x87.jpg?t=1" ></div>
  <div class="search_name ellipsis"> <span class="title">${name}</span> </div>
  <div class="search_released responsive_secondrow"> ${date} </div>
  <span class="search_review_summary positive" data-tooltip-html="Very Positive&lt;br&gt;${percent}% of the ${count} user reviews for this game are positive."></span></a>`;

function fakeWeb({ wikidataDown = false, steamStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ host: u.host, path: u.pathname, url: String(url), headers: init.headers || {} });
    const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (u.host === 'store.steampowered.com') {
      if (steamStatus !== 200) return reply({}, steamStatus);
      if (u.pathname === '/api/storesearch/') {
        return reply({ total: 3, items: [
          { type: 'app', id: 367520, name: 'Hollow Knight', tiny_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/367520/fba7/capsule_231x87.jpg?t=1' },
          { type: 'app', id: 598190, name: 'Hollow Knight - Official Soundtrack', tiny_image: 'x' },
          { type: 'app', id: 1030300, name: 'Hollow Knight: Silksong', tiny_image: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1030300/b73e/capsule_231x87.jpg' },
        ] });
      }
      if (u.pathname === '/search/results/') {
        return reply({ success: 1, total_count: 2, results_html: searchRow(1174180, 'Red Dead Redemption 2', 'Dec 5, 2019', 91, '650,000') + searchRow(489830, 'The Elder Scrolls V: Skyrim Special Edition', 'Oct 27, 2016', 94, '300,000') });
      }
      if (u.pathname === '/api/appdetails') {
        const appid = u.searchParams.get('appids');
        return reply({ [appid]: { success: true, data: {
          name: { 367520: 'Hollow Knight', 1174180: 'Red Dead Redemption 2', 489830: 'The Elder Scrolls V: Skyrim Special Edition' }[appid] || 'Some Game',
          short_description: 'Forge your own path in <b>Hollow Knight</b>!', developers: ['Team Cherry'], publishers: ['Team Cherry'],
          genres: [{ description: 'Action' }, { description: 'Adventure' }, { description: 'Indie' }], release_date: { coming_soon: false, date: 'Feb 24, 2017' },
          header_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/hdr/header.jpg?t=2`,
          platforms: { windows: true, mac: true, linux: false }, website: 'http://hollowknight.com',
          screenshots: [{ path_thumbnail: 'https://x/t.jpg', path_full: 'https://x/f.jpg?t=3' }],
          supported_languages: 'English<strong>*</strong>, Arabic, French<br><strong>*</strong>languages with full audio support',
          metacritic: { score: 87 }, categories: [{ description: 'Single-player' }],
        } } });
      }
    }
    if (u.host === 'api.steampowered.com' && u.pathname === '/IStoreBrowseService/GetItems/v1/') {
      if (steamStatus !== 200) return reply({}, steamStatus);
      const { ids } = JSON.parse(u.searchParams.get('input_json'));
      const item = ({ appid }) => (appid === 598190 ? { appid, type: 4, name: 'Hollow Knight - Official Soundtrack', assets: {} } : {
        appid, type: 0, name: 'x',
        assets: {
          asset_url_format: `steam/apps/${appid}/\${FILENAME}?t=1`, main_capsule: 'aa11/capsule_616x353.jpg', header: 'bb22/header.jpg',
          library_capsule_2x: 'cc33/library_600x900_2x.jpg', library_hero: 'dd44/library_hero.jpg', ...(appid === 367520 ? { library_logo: 'ee55/logo.png' } : {}),
        },
        trailers: appid === 367520 ? { highlights: [{
          trailer_name: 'Release Trailer', trailer_url_format: 'steam/apps/${FILENAME}?t=2', screenshot_full: '256679401/movie.jpg',
          microtrailer: [{ filename: '367520/1/abc/microtrailer.mp4', type: 'video/mp4' }],
          adaptive_trailers: [{ cdn_path: '367520/1/abc/dash_h264.mpd', encoding: 'dash_h264' }, { cdn_path: '367520/1/abc/hls_264_master.m3u8', encoding: 'hls_h264' }],
        }] } : {},
      });
      return reply({ response: { store_items: ids.map(item) } });
    }
    if (u.host === 'en.wikipedia.org' || u.host === 'ar.wikipedia.org') {
      const title = decodeURIComponent(u.pathname.split('/').pop()).replace(/_/g, ' ');
      const pages = { 'en:Bloodborne': 'Bloodborne is a 2015 action role-playing game developed by FromSoftware.', 'ar:بلود بورن': 'بلود بورن لعبة تقمص أدوار وحركة صدرت سنة 2015.' };
      const text = pages[`${u.host.slice(0, 2)}:${title}`];
      return text ? reply({ type: 'standard', extract: text, content_urls: { desktop: { page: `https://${u.host}/wiki/${encodeURIComponent(title)}` } } }) : reply({}, 404);
    }
    if (u.host === 'www.wikidata.org' && u.pathname === '/w/api.php') {
      // Wikidata's search: Bloodborne for "bloodborne", else two games that aren't on Steam.
      if (wikidataDown) return reply({}, 503);
      const ids = /bloodborne/i.test(u.searchParams.get('search')) ? ['Q17154554'] : ['Q64577191', 'Q999'];
      return reply({ search: [...ids.map((id) => ({ id, description: '2023 video game' })), { id: 'Q12393', description: 'video game series' }] });
    }
    if (u.host === 'query.wikidata.org') {
      if (wikidataDown) return reply({}, 503);
      const query = u.searchParams.get('query');
      const b = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));
      if (query.includes('wd:Q17154554')) {
        return reply({ results: { bindings: [
          b({ item: 'http://www.wikidata.org/entity/Q17154554', label: 'Bloodborne', ar: 'بلود بورن', platform: 'http://www.wikidata.org/entity/Q5014725', enwiki: 'Bloodborne', arwiki: 'بلود بورن' }),
        ] } });
      }
      if (query.includes('wd:Q64577191')) {
        return reply({ results: { bindings: [
          b({ item: 'http://www.wikidata.org/entity/Q64577191', label: 'The Legend of Zelda: Tears of the Kingdom', ar: 'أسطورة زيلدا: دموع المملكة', date: '2023-05-12T00:00:00Z' }),
          b({ item: 'http://www.wikidata.org/entity/Q999', label: 'Alan Wake 2', epic: 'alan-wake-2', engineLabel: 'Northlight Engine' }),
        ] } });
      }
      return reply({ results: { bindings: [
        b({ item: 'http://www.wikidata.org/entity/Q29300592', steam: '367520', label: 'Hollow Knight', ar: 'هولو نايت', arDesc: 'لعبة فيديو صدرت سنة 2017', engineLabel: 'Unity', gog: 'game/hollow_knight', site: 'https://hollowknight.com' }),
        b({ item: 'http://www.wikidata.org/entity/Q27438121', steam: '1174180', label: 'Red Dead Redemption 2', ar: 'ريد ديد ريدمبشن 2', engineLabel: 'Rockstar Advanced Game Engine', epic: 'red-dead-redemption-2' }),
        b({ item: 'http://www.wikidata.org/entity/Q31602948', steam: '489830', label: 'Skyrim SE', engineLabel: 'Creation Engine' }),
      ].filter((row) => query.includes(`"${row.steam.value}"`)) } });
    }
    throw new Error(`unexpected request to ${u.host}`);
  };
  return { fetchImpl, calls };
}

const provider = (web, extra = {}) => createSteamWikidataProvider({
  db: openDatabase(':memory:'), fetchImpl: web.fetchImpl, sleep: async () => {}, steamGapMs: 0, steamListGapMs: 0, wikidataGapMs: 0, ...extra,
});

test('engines from Wikidata map to the engines GameShelf patches', () => {
  assert.equal(mapEngine('Unreal Engine 5'), 'unreal');
  assert.equal(mapEngine('Unreal Engine 4'), 'unreal');
  assert.equal(mapEngine('Unity'), 'unity');
  assert.equal(mapEngine('RE Engine'), 'reengine');
  assert.equal(mapEngine('Creation Engine'), 'bethesda');
  assert.equal(mapEngine('Gamebryo'), 'bethesda');
  assert.equal(mapEngine("Ren'Py"), 'renpy');
  assert.equal(mapEngine('Godot'), 'godot');
  assert.equal(mapEngine('MT Framework'), 'mtframework');
  assert.equal(mapEngine('Rockstar Advanced Game Engine'), 'rage');
  assert.equal(mapEngine('Northlight Engine'), null);
  assert.equal(mapEngine(null), null);
  assert.equal(slugify('The Elder Scrolls V: Skyrim® Special Edition'), 'the-elder-scrolls-v-skyrim-special-edition');
  assert.equal(slugify("Assassin's Creed & Co."), 'assassins-creed-and-co');
});

test('search: Steam\'s results with Wikidata\'s Arabic titles; soundtracks left out', async () => {
  const web = fakeWeb();
  const p = provider(web);
  const { results } = await p.search({ query: 'hollow knight' });
  assert.deepEqual(results.slice(0, 2).map((g) => [g.id, g.name, g.steamAppId]), [['hollow-knight', 'Hollow Knight', 367520], ['hollow-knight-silksong', 'Hollow Knight: Silksong', 1030300]]);
  assert.ok(!results.some((g) => /Soundtrack/.test(g.name)));
  // Steam's exact artwork (newer games keep it at hashed addresses), from one store-items request.
  assert.equal(results[0].image, 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/367520/aa11/capsule_616x353.jpg?t=1');
  assert.equal(results[0].poster, 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/367520/cc33/library_600x900_2x.jpg?t=1');
  assert.equal(results[0].logo, 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/367520/ee55/logo.png?t=1');
  assert.equal(results[1].logo, null, 'no logo rather than a broken one');
  assert.equal(web.calls.filter((c) => c.host === 'api.steampowered.com').length, 1);
  // Arabic titles and engines come from Wikidata in the background, so search answers at once.
  await p.settled();
  const again = (await p.search({ query: 'hollow knight' })).results;
  assert.equal(again[0].nameAr, 'هولو نايت');
  assert.equal(again[0].engine, 'unity');
  // Wikidata was asked with GameShelf's User-Agent, and Twitch/IGDB never.
  const wd = web.calls.find((c) => c.host === 'query.wikidata.org');
  assert.equal(wd.headers['User-Agent'], USER_AGENT);
  assert.equal(USER_AGENT, 'GameShelf/1.0 (https://gameshelf.ae)');
  assert.ok(web.calls.every((c) => !/twitch|igdb/i.test(c.host)));
});

test('browse lists: names, dates and review counts from one Steam request; engines added', async () => {
  const web = fakeWeb();
  const p = provider(web);
  const { results } = await p.search({ genre: 'Action', pageSize: 10 });
  assert.deepEqual(results.map((g) => [g.id, g.released, g.popularity]), [['red-dead-redemption-2', '2019-12-05', 650000], ['the-elder-scrolls-v-skyrim-special-edition', '2016-10-27', 300000]]);
  const listUrl = new URL(web.calls.find((c) => c.path === '/search/results/').url);
  assert.equal(listUrl.searchParams.get('tags'), '19');
  assert.equal(listUrl.searchParams.get('untags'), '12095', 'adult-only games left out');
  await p.settled();
  assert.deepEqual((await p.search({ genre: 'Action', pageSize: 10 })).results.map((g) => g.engine), ['rage', 'bethesda']);
  assert.deepEqual(await p.search({ genre: 'Not a genre' }), { count: 0, hasMore: false, results: [] });
  // Seasonal sections and moods: each group's word is a Steam tag.
  await p.collection({ all: [{ themes: ['horror'] }, { modes: ['co-operative'] }], not: { themes: ['warfare'] }, sort: 'top' });
  const col = new URL(web.calls.filter((c) => c.path === '/search/results/').at(-1).url);
  assert.deepEqual([col.searchParams.get('tags'), col.searchParams.get('sort_by')], ['1667,1685', 'Reviews_DESC']);
  assert.ok(col.searchParams.get('untags').split(',').includes('1678'));
});

test('a game page: Steam\'s details, Wikidata\'s Arabic and stores, kept for the TTL', async () => {
  const web = fakeWeb();
  let clock = Date.parse('2026-11-04T12:00:00Z');
  const p = provider(web, { now: () => clock });
  await p.search({ query: 'hollow knight' });
  const g = await p.getGame('hollow-knight');
  assert.equal(g.description, 'Forge your own path in Hollow Knight!');
  assert.deepEqual([g.developers, g.publishers, g.released, g.genres], [['Team Cherry'], ['Team Cherry'], '2017-02-24', ['Action', 'Adventure', 'Indie']]);
  assert.deepEqual([g.nameAr, g.descriptionAr, g.engine, g.engineLabel, g.wikidataId], ['هولو نايت', 'لعبة فيديو صدرت سنة 2017', 'unity', 'Unity', 'Q29300592']);
  assert.deepEqual(g.buy.links.map((l) => [l.store, l.url]), [['steam', 'https://store.steampowered.com/app/367520/'], ['gog', 'https://www.gog.com/en/game/hollow_knight']]);
  assert.deepEqual(g.languages.map((l) => [l.name, l.audio]), [['English', true], ['Arabic', false], ['French', false]]);
  assert.equal(g.scores.critics.score, 87);
  assert.ok(g.links.some((l) => l.url === 'https://www.wikidata.org/wiki/Q29300592'));
  // Trailers first (Steam's HLS stream, with its short clip as the preview), then screenshots.
  assert.deepEqual(g.media[0], {
    type: 'video', name: 'Release Trailer', thumb: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/256679401/movie.jpg?t=2',
    hls: 'https://video.akamai.steamstatic.com/store_trailers/367520/1/abc/hls_264_master.m3u8',
    preview: 'https://video.akamai.steamstatic.com/store_trailers/367520/1/abc/microtrailer.mp4',
  });
  assert.equal(g.media[1].full, 'https://x/f.jpg?t=3');

  // Within the TTL: nothing is asked again.
  const before = web.calls.length;
  await p.getGame('hollow-knight');
  assert.equal(web.calls.filter((c, i) => i >= before && c.path !== '/search/results/').length, 0);
  // After it (7 days by default), Steam is asked again.
  clock += 8 * 24 * 60 * 60 * 1000;
  await p.getGame('hollow-knight');
  assert.ok(web.calls.slice(before).some((c) => c.path === '/api/appdetails'));
});

test('old ids (like IGDB slugs) keep working: found by name once, then kept', async () => {
  const web = fakeWeb();
  const db = openDatabase(':memory:');
  const p = createSteamWikidataProvider({ db, fetchImpl: web.fetchImpl, sleep: async () => {}, steamGapMs: 0, steamListGapMs: 0, wikidataGapMs: 0 });
  const g = await p.getGame('hollow-knight');
  assert.deepEqual([g.id, g.steamAppId], ['hollow-knight', 367520]);
  assert.equal(db.prepare('SELECT steam_appid FROM games WHERE id = ?').get('hollow-knight').steam_appid, 367520);
  assert.equal(await p.getGame('no-such-game-at-all'), null);
  assert.equal(await p.getGame('../../etc'), null);
  // Steam libraries match by app id, with no requests at all.
  const before = web.calls.length;
  const [hk, unknown] = await p.matchSteamGames([{ appid: 367520, name: 'Hollow Knight' }, { appid: 4242, name: 'Brand New Indie' }]);
  assert.equal(hk.id, 'hollow-knight');
  assert.deepEqual([unknown.id, unknown.steamAppId], ['brand-new-indie', 4242]);
  assert.equal(web.calls.length, before);
});

test('games that aren\'t on Steam come from Wikidata, with their Epic or GOG store', async () => {
  const web = fakeWeb();
  const p = provider(web);
  const { results } = await p.search({ query: 'zelda tears' });
  const zelda = results.find((g) => g.wikidataId === 'Q64577191');
  assert.deepEqual([zelda.id, zelda.steamAppId, zelda.nameAr, zelda.released], ['the-legend-of-zelda-tears-of-the-kingdom', null, 'أسطورة زيلدا: دموع المملكة', '2023-05-12']);
  const alan = await p.getGame('alan-wake-2');
  assert.deepEqual(alan.buy.links.map((l) => [l.store, l.url]), [['epic', 'https://store.epicgames.com/p/alan-wake-2']]);
  assert.equal(alan.engine, null, 'engines GameShelf can\'t patch stay unmapped');
  assert.equal(alan.engineLabel, 'Northlight Engine');
  // Arabic searches go to Wikidata.
  await p.search({ query: 'زيلدا' });
  const find = new URL(web.calls.filter((c) => c.host === 'www.wikidata.org').at(-1).url);
  assert.deepEqual([find.searchParams.get('action'), find.searchParams.get('search'), find.searchParams.get('language')], ['wbsearchentities', 'زيلدا', 'ar']);
});

test('Wikidata down: Steam stands alone. Steam refusing: back off and use what\'s saved', async () => {
  const down = fakeWeb({ wikidataDown: true });
  const p = provider(down);
  const g = await p.getGame('hollow-knight');
  assert.deepEqual([g.name, g.nameAr, g.developers], ['Hollow Knight', null, ['Team Cherry']]);

  // Steam answers once, then refuses with 429: the saved list is used, and
  // Steam isn't asked again while backing off.
  let clock = 1_000_000;
  let refuse = false;
  const web = fakeWeb();
  const fetchImpl = async (url, init) => (refuse && String(url).includes('steampowered') ? { ok: false, status: 429, json: async () => ({}) } : web.fetchImpl(url, init));
  const q = createSteamWikidataProvider({ db: openDatabase(':memory:'), fetchImpl, now: () => clock, sleep: async () => {}, steamGapMs: 0, steamListGapMs: 0, wikidataGapMs: 0 });
  const first = await q.search({ genre: 'Action' });
  clock += 7 * 60 * 60 * 1000; // the list's 6 hours are up
  refuse = true;
  const steamCalls = () => web.calls.filter((c) => c.host === 'store.steampowered.com').length;
  const again = await q.search({ genre: 'Action' });
  assert.deepEqual(again.results.map((x) => x.id), first.results.map((x) => x.id), 'old list served');
  const n = steamCalls();
  await q.search({ genre: 'Action' });
  assert.equal(steamCalls(), n, 'no request while backing off');
});

test('no Twitch or IGDB keys needed: the default catalog is Steam + Wikidata', () => {
  const db = openDatabase(':memory:');
  assert.equal(createGameProvider({}, { db }).name, 'steam');
  assert.equal(createGameProvider({ IGDB_CLIENT_ID: 'x', IGDB_CLIENT_SECRET: 'y', TWITCH_CLIENT_ID: 'z' }, { db }).name, 'steam');
  assert.equal(createGameProvider({ GAME_DATA: 'local' }, { db }).name, 'local');
  const fs = require('node:fs');
  const path = require('node:path');
  for (const dir of ['src', 'src/games']) {
    for (const file of fs.readdirSync(path.join(__dirname, '..', dir)).filter((f) => f.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(__dirname, '..', dir, file), 'utf8');
      assert.ok(!/api\.igdb\.com|id\.twitch\.tv|TWITCH_CLIENT_SECRET/.test(text), `${dir}/${file} still talks to IGDB`);
    }
  }
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src/games/igdb.js')));
});

test('old ids match the store name a game actually has, and never its add-ons or bundles', () => {
  const same = [
    ["Baldur's Gate 3", 'baldurs gate iii'],
    ['Until Dawn™', 'until dawn'],
    ['S.T.A.L.K.E.R. 2: Heart of Chornobyl', 'stalker 2 heart of chornobyl'],
    ['Warhammer 40,000: Space Marine 2', 'warhammer 40000 space marine ii'],
    ['METAL GEAR SOLID Δ: SNAKE EATER', 'metal gear solid delta snake eater'],
    ['ARK: The Survival Of The Fittest', 'ark survival of the fittest'],
    ['God of War Ragnarök', 'god of war ragnarok'],
    ['Ratchet & Clank: Rift Apart', 'ratchet and clank rift apart'],
    ['MOUSE: P.I. For Hire', 'mouse pi for hire'],
  ];
  for (const [name, words] of same) assert.equal(titleScore(name, words), 100, name);
  // An edition of the game, or a brand in front, still is the game; the exact name wins over both.
  assert.equal(titleScore('Disco Elysium - The Final Cut', 'disco elysium'), 80);
  assert.equal(titleScore('CONTROL Ultimate Edition', 'control'), 80);
  assert.equal(titleScore('Just Cause™ 4: Reloaded', 'just cause 4'), 80);
  assert.equal(titleScore("Tom Clancy's Rainbow Six Siege", 'rainbow six siege'), 60);
  // Not the game: another game, an add-on, a bundle.
  for (const [name, words] of [
    ['CONTROL Resonant', 'control'],
    ['Mind Control Delete', 'control'],
    ["Baldur's Gate 3 - Digital Deluxe Edition DLC", 'baldurs gate 3'],
    ["Marvel's Spider-Man 2 - Digital Deluxe Upgrade", 'marvels spider man 2'],
    ['Ghost Master: Resurrection | Until Dawn', 'until dawn'],
    ['Kairos: Until the Dawn Breaks', 'until dawn'],
    ['Dead Space 2', 'dead space'],
  ]) assert.equal(titleScore(name, words), 0, name);
});

test('an old id with a suffix ("hollow-knight--1") becomes another name for the game, kept without asking again', async () => {
  const web = fakeWeb();
  const db = openDatabase(':memory:');
  const p = createSteamWikidataProvider({ db, fetchImpl: web.fetchImpl, sleep: async () => {}, steamGapMs: 0, steamListGapMs: 0, wikidataGapMs: 0 });
  assert.equal((await p.getGame('hollow-knight')).id, 'hollow-knight');
  const g = await p.getGame('hollow-knight--1');
  assert.deepEqual([g.id, g.steamAppId], ['hollow-knight', 367520]);
  assert.equal(db.prepare('SELECT game_id FROM game_aliases WHERE alias = ?').get('hollow-knight--1').game_id, 'hollow-knight');
  const searches = () => web.calls.filter((c) => c.path === '/api/storesearch/').length;
  const before = searches();
  assert.equal((await p.getGame('hollow-knight--1')).id, 'hollow-knight');
  assert.equal(searches(), before);
});

test('search finds the game, not its DLC, season passes or games that merely share a word', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });
    const row = (appid, name) => `<a href="https://store.steampowered.com/app/${appid}/x/" data-ds-appid="${appid}" class="search_result_row"><div class="search_name"><span class="title">${name}</span></div></a>`;
    if (u.pathname === '/search/results/') {
      return reply({ total_count: 6, results_html: [
        row(3606480, 'Call of Duty®: Black Ops 7'), row(4200780, 'Call of Duty®: Black Ops 7 - BlackCell (Season 06)'),
        row(2170970, 'Call of Duty®: Black Ops 7 or Call of Duty®: Warzone™ Points'), row(311210, 'Call of Duty®: Black Ops III'),
        row(1, 'Seven Nights of the Black Tide'), row(4098660, 'Call of Duty®: Black Ops 7 - Arachnid\'s Mark: Starter Pack'),
      ].join('') });
    }
    if (u.host === 'api.steampowered.com') {
      const { ids } = JSON.parse(u.searchParams.get('input_json'));
      return reply({ response: { store_items: ids.map(({ appid }) => ({ appid, type: appid === 4200780 ? 4 : 0, name: 'x', assets: {} })) } });
    }
    if (u.host === 'query.wikidata.org') return reply({ results: { bindings: [] } });
    throw new Error(`unexpected ${u}`);
  };
  const p = createSteamWikidataProvider({ db: openDatabase(':memory:'), fetchImpl, sleep: async () => {}, steamGapMs: 0, steamListGapMs: 0, wikidataGapMs: 0, steamApiGapMs: 0 });
  const { results } = await p.search({ query: 'black ops 7' });
  assert.deepEqual(results.map((g) => g.name), ['Call of Duty®: Black Ops 7']);
  const list = calls.find((u) => u.pathname === '/search/results/');
  assert.deepEqual([list.searchParams.get('term'), list.searchParams.get('category1')], ['black ops 7', '998'], 'games only');
  // Asked for by name, an add-on is found.
  assert.ok((await p.search({ query: 'warzone points' })).results.some((g) => /Points/.test(g.name)));
  // "Newest" is Steam's popular new releases.
  await p.search({ sort: 'new' });
  assert.equal(calls.filter((u) => u.pathname === '/search/results/').at(-1).searchParams.get('filter'), 'popularnew');
});

test('a game that isn\'t on Steam: Wikipedia\'s summary (credited), its platforms and their stores', async () => {
  const web = fakeWeb();
  const p = provider(web);
  const { results } = await p.search({ query: 'bloodborne' });
  assert.deepEqual(results.map((g) => [g.id, g.steamAppId]), [['bloodborne', null]]);
  const g = await p.getGame('bloodborne');
  assert.equal(g.description, 'Bloodborne is a 2015 action role-playing game developed by FromSoftware.');
  assert.deepEqual(g.descriptionSource, { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Bloodborne', license: 'CC BY-SA 4.0' });
  assert.equal(g.descriptionAr, 'بلود بورن لعبة تقمص أدوار وحركة صدرت سنة 2015.');
  assert.equal(g.descriptionArSource.license, 'CC BY-SA 4.0');
  assert.deepEqual(g.platforms, ['PlayStation 4']);
  assert.deepEqual(g.buy.links.map((l) => [l.store, l.direct]), [['playstation', false]]);
  assert.equal(g.nameAr, 'بلود بورن');
  // Wikipedia was asked with GameShelf's User-Agent.
  assert.ok(web.calls.filter((c) => /wikipedia/.test(c.host)).every((c) => c.headers['User-Agent'] === USER_AGENT));
});

test('"New & notable" is what sells now and came out in the last six months, not Steam\'s obscure newest', async () => {
  const calls = [];
  const row = (appid, name, date) => `<a href="https://store.steampowered.com/app/${appid}/x/" data-ds-appid="${appid}" class="search_result_row"><div class="search_name"><span class="title">${name}</span></div><div class="search_released responsive_secondrow">${date}</div></a>`;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const reply = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.pathname === '/search/results/' && u.searchParams.get('filter') === 'topsellers') {
      return reply({ results_html: [row(1, 'Counter-Strike 2', 'Aug 21, 2012'), row(2, 'Call of Duty®: Modern Warfare® 4', 'Oct 22, 2026'), row(3, 'Phantom Blade Zero', 'Oct 28, 2026'), row(4, 'Next Year Game', 'Mar 4, 2027')].join('') });
    }
    if (u.pathname === '/search/results/') return reply({ results_html: row(5, 'Some New Indie', 'Nov 4, 2026') });
    if (u.host === 'api.steampowered.com') return reply({ response: { store_items: [] } });
    if (u.host === 'query.wikidata.org') return reply({ results: { bindings: [] } });
    throw new Error(`unexpected ${u}`);
  };
  const p = createSteamWikidataProvider({ db: openDatabase(':memory:'), fetchImpl, now: () => Date.parse('2026-11-05T12:00:00Z'), sleep: async () => {}, steamGapMs: 0, steamListGapMs: 0, wikidataGapMs: 0, steamApiGapMs: 0 });
  const { results } = await p.search({ sort: 'new', pageSize: 3 });
  assert.deepEqual(results.map((g) => g.name), ['Call of Duty®: Modern Warfare® 4', 'Phantom Blade Zero', 'Some New Indie']);
});
