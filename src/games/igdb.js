// IGDB (https://www.igdb.com), run by Twitch: a staff-edited database of games
// on every platform, with official cover art. Needs a free Twitch developer
// app: set IGDB_CLIENT_ID and IGDB_CLIENT_SECRET.
//
// Field names follow IGDB's API v4 definitions (https://api.igdb.com/v4/igdbapi.proto).
const { buildBuyLinks } = require('./stores');
const { GENRES, findGenre } = require('./genres');
const { normalizeTitle } = require('../text');
const { steamArt } = require('./steam-art');

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const API_URL = 'https://api.igdb.com/v4';
const IMAGE_URL = 'https://images.igdb.com/igdb/image/upload';
const CACHE_TTL_MS = 10 * 60 * 1000;
const LOOKUP_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
// IGDB allows 4 requests a second; leave a little room.
const MIN_INTERVAL_MS = 260;
const SEARCH_LIMIT = 30;

const image = (id, size) => (id ? `${IMAGE_URL}/t_${size}/${id}.jpg` : null);
const isoDate = (seconds) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : null);
// Search terms go inside double quotes in IGDB's query language.
const quote = (text) => `"${String(text).replace(/["\\]/g, ' ')}"`;

// IGDB moved these codes from fixed numbers into lookup tables in 2025. They are
// looked up by name at startup; these are the old fixed numbers, used if that fails.
const FALLBACK = {
  // Main game, standalone expansion, remake, remaster, expanded game, port.
  gameTypes: [0, 4, 8, 9, 10, 11],
  steamSource: 1,
  websites: { official: 1, iphone: 10, ipad: 11, android: 12, steam: 13, itch: 15, epic: 16, gog: 17 },
};
const PLAYABLE_GAME_TYPES = ['main game', 'standalone expansion', 'remake', 'remaster', 'expanded game', 'port'];

// IGDB platform names are specific ("PlayStation 5"); the site shows families.
const PLATFORM_FAMILIES = [
  [/PC|Windows|DOS/i, 'PC'],
  [/PlayStation|PS Vita|PSP/i, 'PlayStation'],
  [/Xbox/i, 'Xbox'],
  [/Nintendo|Switch|Wii|Game ?Boy|GameCube|^NES|^SNES/i, 'Nintendo'],
  [/Mac/i, 'macOS'],
  [/Linux/i, 'Linux'],
  [/iOS/i, 'iOS'],
  [/Android/i, 'Android'],
];
function platformFamilies(platforms = []) {
  const out = [];
  for (const p of platforms) {
    const family = PLATFORM_FAMILIES.find(([re]) => re.test(p.name))?.[1] || p.name;
    if (!out.includes(family)) out.push(family);
  }
  return out;
}

// IGDB has its own genres and themes ("Role-playing (RPG)", theme "Action").
// Show the site's genre names so the chips, rows and stats all match.
function friendlyGenres(game) {
  const names = [...(game.genres || []), ...(game.themes || [])].map((g) => g.name.toLowerCase());
  const matched = GENRES.filter((g) => matchesGenre(g, names)).map((g) => g.name);
  if (matched.length) return matched;
  return (game.genres || []).map((g) => g.name.replace(/\s*\(.*\)$/, ''));
}
const matchesGenre = (genre, lowerNames) =>
  [...(genre.igdb.genres || []), ...(genre.igdb.themes || [])].some((token) => lowerNames.some((n) => n.includes(token)));

const SUMMARY_FIELDS = [
  'name', 'slug', 'first_release_date', 'total_rating_count', 'summary',
  'cover.image_id', 'artworks.image_id', 'screenshots.image_id',
  'genres.name', 'themes.name', 'platforms.name',
  'external_games.uid', 'external_games.external_game_source',
].join(',');
const DETAIL_FIELDS = [
  SUMMARY_FIELDS, 'storyline', 'similar_games',
  'involved_companies.company.name', 'involved_companies.developer', 'involved_companies.publisher',
  'websites.url', 'websites.type',
].join(',');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createIgdbProvider(clientId, clientSecret, { fetchImpl = fetch, minIntervalMs = MIN_INTERVAL_MS } = {}) {
  const cache = new Map();
  let token = null;
  let lookupsPromise = null;
  let lookupsExpire = 0;

  async function getToken(force = false) {
    if (!force && token && token.expires > Date.now()) return token.value;
    const url = new URL(TOKEN_URL);
    url.search = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' });
    const res = await fetchImpl(url, { method: 'POST' });
    if (!res.ok) throw new Error(`Twitch login failed with status ${res.status}. Check IGDB_CLIENT_ID and IGDB_CLIENT_SECRET.`);
    const data = await res.json();
    // Renew a minute early so a request never goes out with an expired token.
    token = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
    return token.value;
  }

  // Requests leave one at a time, spaced to stay under IGDB's rate limit.
  let queue = Promise.resolve();
  let lastStart = 0;
  function throttle() {
    const turn = queue.then(async () => {
      const wait = lastStart + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
    });
    queue = turn.catch(() => {});
    return turn;
  }

  async function query(endpoint, body, { retry = true } = {}) {
    const key = `${endpoint}\n${body}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    await throttle();
    const res = await fetchImpl(`${API_URL}/${endpoint}`, {
      method: 'POST',
      headers: { 'Client-ID': clientId, Authorization: `Bearer ${await getToken()}`, Accept: 'application/json' },
      body,
    });
    if (retry && res.status === 401) {
      await getToken(true);
      return query(endpoint, body, { retry: false });
    }
    if (retry && res.status === 429) {
      await sleep(1000);
      return query(endpoint, body, { retry: false });
    }
    if (!res.ok) throw new Error(`IGDB request failed with status ${res.status}`);
    const value = await res.json();
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }

  // Lookup tables: game types, the Steam source, website types, popularity
  // types, genres and themes. Loaded once a day.
  function lookups() {
    if (lookupsPromise && lookupsExpire > Date.now()) return lookupsPromise;
    lookupsExpire = Date.now() + LOOKUP_TTL_MS;
    const safe = (endpoint, fields) => query(endpoint, `fields ${fields}; limit 500;`).catch(() => []);
    lookupsPromise = Promise.all([
      safe('game_types', 'id,type'),
      safe('external_game_sources', 'id,name'),
      safe('website_types', 'id,type'),
      safe('popularity_types', 'id,name'),
      safe('genres', 'id,name'),
      safe('themes', 'id,name'),
    ]).then(([gameTypes, sources, websiteTypes, popularityTypes, genres, themes]) => {
      const byLabel = (rows, label, words) => rows.filter((r) => words.some((w) => String(r[label]).toLowerCase() === w)).map((r) => r.id);
      const playable = byLabel(gameTypes, 'type', PLAYABLE_GAME_TYPES);
      const steam = sources.find((s) => String(s.name).toLowerCase() === 'steam')?.id;
      const site = (word) => websiteTypes.find((w) => String(w.type).toLowerCase().includes(word))?.id;
      const visits = popularityTypes.find((p) => /visit/i.test(p.name))?.id ?? null;
      return {
        gameTypes: playable.length ? playable : FALLBACK.gameTypes,
        steamSource: steam ?? FALLBACK.steamSource,
        websites: Object.fromEntries(Object.entries(FALLBACK.websites).map(([k, id]) => [k, site(k) ?? id])),
        popularityType: visits,
        genres,
        themes,
      };
    });
    return lookupsPromise;
  }

  function toSummary(g, l) {
    const steam = (g.external_games || []).find((e) => e.external_game_source === l.steamSource && /^\d+$/.test(e.uid || ''));
    const steamAppId = steam ? Number(steam.uid) : null;
    const artworkId = g.artworks?.[0]?.image_id;
    const shotId = g.screenshots?.[0]?.image_id;
    const wide = image(artworkId || shotId, 'screenshot_big');
    const summary = {
      id: g.slug,
      name: g.name,
      released: isoDate(g.first_release_date),
      // Wide card art: Steam's store banner (title included) when the game is on
      // Steam, otherwise IGDB's artwork or a screenshot, which get a title overlay.
      image: wide,
      backdrop: image(artworkId || shotId, '1080p'),
      // Official box art, for posters.
      poster: image(g.cover?.image_id, 'cover_big_2x'),
      logo: null,
      artHasTitle: false,
      genres: friendlyGenres(g),
      platforms: platformFamilies(g.platforms),
      description: g.summary || null,
      steamAppId,
      popularity: g.total_rating_count || 0,
    };
    if (steamAppId) {
      const art = steamArt(steamAppId);
      Object.assign(summary, { image: art.image, fallbackImage: wide, logo: art.logo, artHasTitle: true });
      if (!summary.backdrop) summary.backdrop = art.backdrop;
    }
    return summary;
  }

  /** The `where` clause for a genre, or null when IGDB has no match for it. */
  function genreClause(genreName, l) {
    const genre = findGenre(genreName);
    if (!genre) return null;
    const ids = (rows, tokens = []) => rows.filter((r) => tokens.some((t) => r.name.toLowerCase().includes(t))).map((r) => r.id);
    const parts = [];
    const g = ids(l.genres, genre.igdb.genres);
    const t = ids(l.themes, genre.igdb.themes);
    if (g.length) parts.push(`genres = (${g.join(',')})`);
    if (t.length) parts.push(`themes = (${t.join(',')})`);
    return parts.length ? `(${parts.join(' | ')})` : null;
  }

  /** Raw IGDB rows for these game IDs, keyed by ID. */
  async function rowsByIds(ids) {
    const byId = new Map();
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = await query('games', `fields ${SUMMARY_FIELDS}; where id = (${chunk.join(',')}); limit ${chunk.length};`);
      for (const r of rows) byId.set(r.id, r);
    }
    return byId;
  }

  /** Summaries for these game IDs, in the same order. */
  async function gamesByIds(ids, l) {
    const byId = await rowsByIds(ids);
    return ids.map((id) => byId.get(id)).filter(Boolean).map((g) => toSummary(g, l));
  }

  return {
    name: 'igdb',

    async search({ query: text = '', genre = '', sort = 'popular', page = 1, pageSize = 24 }) {
      const l = await lookups();
      const q = text.trim();
      const playable = `game_type = (${l.gameTypes.join(',')})`;
      const offset = (page - 1) * pageSize;
      let genreWhere = '';
      if (genre) {
        const clause = genreClause(genre, l);
        if (!clause) return { count: 0, hasMore: false, results: [] };
        genreWhere = ` & ${clause}`;
      }

      if (q) {
        const rows = await query('games', `search ${quote(q)}; fields ${SUMMARY_FIELDS}; where ${playable}${genreWhere}; limit ${SEARCH_LIMIT}; offset ${(page - 1) * SEARCH_LIMIT};`);
        // An exact title match first, then the games the most people have rated.
        const target = normalizeTitle(q);
        const exact = (g) => (normalizeTitle(g.name) === target ? 1 : 0);
        const results = rows
          .map((g, i) => ({ g, i }))
          .sort((a, b) => exact(b.g) - exact(a.g) || (b.g.total_rating_count || 0) - (a.g.total_rating_count || 0) || a.i - b.i)
          .map(({ g }) => toSummary(g, l));
        return { count: results.length, hasMore: rows.length === SEARCH_LIMIT, results };
      }

      // "Trending": what people are looking at on IGDB right now.
      if (sort === 'popular' && !genre && l.popularityType !== null) {
        try {
          const prims = await query('popularity_primitives',
            `fields game_id,value; where popularity_type = ${l.popularityType}; sort value desc; limit ${pageSize}; offset ${offset};`);
          const results = await gamesByIds(prims.map((p) => p.game_id), l);
          if (results.length) return { count: results.length, hasMore: prims.length === pageSize, results };
        } catch (err) {
          console.error('IGDB popularity lookup failed, using ratings instead:', err.message);
        }
      }

      const now = Math.floor(Date.now() / 1000);
      const yearAgo = now - 365 * 24 * 60 * 60;
      const bySort = {
        // Released in the last year, most anticipated first.
        new: { where: ` & first_release_date >= ${yearAgo} & first_release_date <= ${now}`, order: 'hypes desc' },
        top: { where: ' & total_rating >= 85 & total_rating_count >= 50', order: 'total_rating_count desc' },
        popular: { where: ' & total_rating_count >= 5', order: 'total_rating_count desc' },
      }[sort] || { where: ' & total_rating_count >= 5', order: 'total_rating_count desc' };
      const rows = await query('games',
        `fields ${SUMMARY_FIELDS}; where ${playable}${genreWhere}${bySort.where}; sort ${bySort.order}; limit ${pageSize}; offset ${offset};`);
      return { count: rows.length, hasMore: rows.length === pageSize, results: rows.map((g) => toSummary(g, l)) };
    },

    // Art comes with every IGDB result already (including Steam's when the game is on Steam).
    async addSteamArt(games) {
      return games;
    },

    // Steam app IDs map straight to IGDB games, so every match is exact.
    async matchSteamGames(steamGames) {
      const l = await lookups();
      const gameIdByApp = new Map();
      const appIds = [...new Set(steamGames.map((s) => String(s.appid)))];
      for (let i = 0; i < appIds.length; i += 400) {
        const chunk = appIds.slice(i, i + 400);
        const rows = await query('external_games',
          `fields uid,game; where external_game_source = ${l.steamSource} & uid = (${chunk.map(quote).join(',')}); limit 500;`);
        for (const r of rows) if (r.game) gameIdByApp.set(r.uid, r.game);
      }
      const rows = await rowsByIds([...new Set(gameIdByApp.values())]);
      return steamGames.map((s) => {
        const row = rows.get(gameIdByApp.get(String(s.appid)));
        return row ? toSummary(row, l) : null;
      });
    },

    async getGame(id) {
      const l = await lookups();
      const rows = await query('games', `fields ${DETAIL_FIELDS}; where slug = ${quote(id)}; limit 1;`);
      const g = rows[0];
      if (!g) return null;
      const summary = toSummary(g, l);

      const site = (type) => (g.websites || []).find((w) => w.type === type)?.url;
      const families = summary.platforms;
      const stores = [
        { key: 'steam', url: site(l.websites.steam) || (summary.steamAppId ? `https://store.steampowered.com/app/${summary.steamAppId}/` : undefined), when: summary.steamAppId || site(l.websites.steam) },
        { key: 'epic', url: site(l.websites.epic), when: site(l.websites.epic) },
        { key: 'gog', url: site(l.websites.gog), when: site(l.websites.gog) },
        // Console stores aren't linked from IGDB, so these open a search on the store.
        { key: 'playstation', when: families.includes('PlayStation') },
        { key: 'xbox', when: families.includes('Xbox') },
        { key: 'nintendo', when: families.includes('Nintendo') },
        { key: 'itch', url: site(l.websites.itch), when: site(l.websites.itch) },
        { key: 'apple', url: site(l.websites.iphone) || site(l.websites.ipad), when: site(l.websites.iphone) || site(l.websites.ipad) },
        { key: 'googleplay', url: site(l.websites.android), when: site(l.websites.android) },
      ].filter((s) => s.when).map(({ key, url }) => ({ key, url }));

      const companies = g.involved_companies || [];
      let similar = [];
      try {
        similar = await gamesByIds((g.similar_games || []).slice(0, 12), l);
      } catch (err) {
        console.error('Could not load similar games:', err.message);
      }

      return {
        ...summary,
        description: g.summary || g.storyline || null,
        developers: companies.filter((c) => c.developer && c.company).map((c) => c.company.name),
        publishers: companies.filter((c) => c.publisher && c.company).map((c) => c.company.name),
        website: site(l.websites.official) || null,
        buy: buildBuyLinks(g.name, stores),
        similar,
      };
    },
  };
}

module.exports = { createIgdbProvider, platformFamilies };
