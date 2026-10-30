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
  // Main game, standalone expansion, remake, remaster, expanded game. Ports are
  // left out: they are the same game on another platform, listed separately.
  gameTypes: [0, 4, 8, 9, 10],
  steamSource: 1,
  websites: { official: 1, iphone: 10, ipad: 11, android: 12, steam: 13, itch: 15, epic: 16, gog: 17 },
};
const PLAYABLE_GAME_TYPES = ['main game', 'standalone expansion', 'remake', 'remaster', 'expanded game'];

// Old fixed website type numbers, used to name links when the lookup table fails.
const LEGACY_WEBSITE_NAMES = {
  1: 'Official site', 2: 'Fandom wiki', 3: 'Wikipedia', 4: 'Facebook', 5: 'X', 6: 'Twitch', 8: 'Instagram',
  9: 'YouTube', 14: 'Reddit', 18: 'Discord', 19: 'Bluesky',
};
// Store links are shown under "Where to buy", not with the official links.
const STORE_SITE = /steam|epic|gog|itch|iphone|ipad|android|app ?store|google play/i;

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
  'name', 'slug', 'first_release_date', 'total_rating_count', 'hypes', 'summary',
  'cover.image_id', 'artworks.image_id', 'artworks.alpha_channel', 'screenshots.image_id',
  'genres.name', 'themes.name', 'platforms.name',
  'external_games.uid', 'external_games.external_game_source',
].join(',');
const DETAIL_FIELDS = [
  SUMMARY_FIELDS, 'storyline', 'similar_games',
  'videos.video_id', 'videos.name',
  'aggregated_rating', 'aggregated_rating_count', 'rating', 'rating_count',
  'game_modes.name', 'player_perspectives.name',
  'language_supports.language.name', 'language_supports.language_support_type.name',
  'dlcs.name', 'dlcs.slug', 'dlcs.cover.image_id',
  'expansions.name', 'expansions.slug', 'expansions.cover.image_id',
  'standalone_expansions.name', 'standalone_expansions.slug', 'standalone_expansions.cover.image_id',
  'involved_companies.company.name', 'involved_companies.developer', 'involved_companies.publisher',
  'websites.url', 'websites.type',
].join(',');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ratings for released games plus "hypes" (follows before release), so an
// upcoming game like a new sequel isn't ranked as if nobody cared about it.
const popularity = (g) => (g.total_rating_count || 0) + (g.hypes || 0);

// Special editions ("Collector's Edition") are versions of another game.
const NOT_AN_EDITION = 'version_parent = null';

// Hidden everywhere except a direct link: adult games (IGDB's "Erotic" theme)
// and test builds.
const NOT_A_RELEASE = /\b(beta|demo|playtest|test server|alpha)\s*$/i;
const listable = (g) =>
  !(g.themes || []).some((t) => /erotic/i.test(t.name)) && !NOT_A_RELEASE.test(g.name);

const yearOf = (g) => (g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null);

/**
 * IGDB sometimes lists one game several times (once per platform). Keeps the
 * first entry for each name; a later one with the same name stays only if it's
 * from a different year and has real interest of its own (God of War 2005 and
 * the 2018 reboot both stay; a barely-known duplicate goes). Order is kept.
 */
function dedupeByName(rows) {
  const kept = new Map();
  return rows.filter((g) => {
    const key = normalizeTitle(g.name);
    const same = kept.get(key);
    if (!same) {
      kept.set(key, [g]);
      return true;
    }
    const distinctYear = same.every((s) => yearOf(s) !== yearOf(g));
    if (distinctYear && popularity(g) > 0 && popularity(g) >= popularity(same[0]) * 0.1) {
      same.push(g);
      return true;
    }
    return false;
  });
}

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
  // types, genres, themes and game modes. Loaded once a day.
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
      safe('game_modes', 'id,name'),
    ]).then(([gameTypes, sources, websiteTypes, popularityTypes, genres, themes, gameModes]) => {
      const byLabel = (rows, label, words) => rows.filter((r) => words.some((w) => String(r[label]).toLowerCase() === w)).map((r) => r.id);
      const playable = byLabel(gameTypes, 'type', PLAYABLE_GAME_TYPES);
      const steam = sources.find((s) => String(s.name).toLowerCase() === 'steam')?.id;
      // Whole words only: "itch" must not match "Twitch".
      const site = (word) => websiteTypes.find((w) => new RegExp(`\\b${word}\\b`, 'i').test(String(w.type)))?.id;
      const visits = popularityTypes.find((p) => /visit/i.test(p.name))?.id ?? null;
      return {
        gameTypes: playable.length ? playable : FALLBACK.gameTypes,
        steamSource: steam ?? FALLBACK.steamSource,
        websites: Object.fromEntries(Object.entries(FALLBACK.websites).map(([k, id]) => [k, site(k) ?? id])),
        websiteNames: new Map(websiteTypes.map((w) => [w.id, String(w.type)])),
        popularityType: visits,
        genres,
        themes,
        gameModes,
      };
    });
    return lookupsPromise;
  }

  function toSummary(g, l) {
    const steam = (g.external_games || []).find((e) => e.external_game_source === l.steamSource && /^\d+$/.test(e.uid || ''));
    const steamAppId = steam ? Number(steam.uid) : null;
    // Artworks with transparency are logos, which make poor backgrounds.
    const artworkId = (g.artworks || []).find((a) => !a.alpha_channel)?.image_id;
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
      popularity: popularity(g),
    };
    if (steamAppId) {
      const art = steamArt(steamAppId);
      Object.assign(summary, { image: art.image, fallbackImage: wide, artHasTitle: true });
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
    return dedupeByName(ids.map((id) => byId.get(id)).filter(Boolean).filter(listable)).map((g) => toSummary(g, l));
  }

  return {
    name: 'igdb',

    async search({ query: text = '', genre = '', sort = 'popular', page = 1, pageSize = 24 }) {
      const l = await lookups();
      const q = text.trim();
      const playable = `game_type = (${l.gameTypes.join(',')})`;
      const browseWhere = `${playable} & ${NOT_AN_EDITION}`;
      const offset = (page - 1) * pageSize;
      let genreWhere = '';
      if (genre) {
        const clause = genreClause(genre, l);
        if (!clause) return { count: 0, hasMore: false, results: [] };
        genreWhere = ` & ${clause}`;
      }

      if (q) {
        const where = `${playable} & ${NOT_AN_EDITION}${genreWhere}`;
        // IGDB's own search favours short names and can miss the big games
        // entirely (its top 30 for "zelda" has no Breath of the Wild), so also
        // ask for the most popular games whose name contains the words.
        const [byName, bySearch] = await Promise.all([
          query('games', `fields ${SUMMARY_FIELDS}; where ${where} & name ~ *${quote(q)}*; sort total_rating_count desc; limit ${SEARCH_LIMIT}; offset ${(page - 1) * SEARCH_LIMIT};`),
          page === 1 ? query('games', `search ${quote(q)}; fields ${SUMMARY_FIELDS}; where ${where}; limit ${SEARCH_LIMIT};`) : [],
        ]);
        const seen = new Set();
        const rows = [...byName, ...bySearch].filter((g) => !seen.has(g.id) && seen.add(g.id)).filter(listable)
          // Entries with no date, no cover and no interest are placeholders.
          .filter((g) => g.first_release_date || g.cover || popularity(g));
        const target = normalizeTitle(q);
        const top = Math.max(0, ...rows.map(popularity));
        // An exact title match comes first, but only if people actually play it
        // (an obscure 1989 game called "Zelda" shouldn't beat the series).
        const exact = (g) => (normalizeTitle(g.name) === target && popularity(g) >= top * 0.05 ? 1 : 0);
        const ranked = rows
          .map((g, i) => ({ g, i }))
          .sort((a, b) => exact(b.g) - exact(a.g) || popularity(b.g) - popularity(a.g) ||
            Boolean(b.g.screenshots || b.g.artworks) - Boolean(a.g.screenshots || a.g.artworks) || a.i - b.i)
          .map(({ g }) => g);
        const results = dedupeByName(ranked).map((g) => toSummary(g, l));
        return { count: results.length, hasMore: byName.length === SEARCH_LIMIT, results };
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
        `fields ${SUMMARY_FIELDS}; where ${browseWhere}${genreWhere}${bySort.where}; sort ${bySort.order}; limit ${pageSize}; offset ${offset};`);
      return { count: rows.length, hasMore: rows.length === pageSize, results: dedupeByName(rows.filter(listable)).map((g) => toSummary(g, l)) };
    },

    /**
     * Games for a seasonal home page section (see src/seasons.js): every group
     * in `all` must match (any genre, theme or mode named in it), and no theme
     * or genre named in `not`. Empty when IGDB has none of a group's names.
     */
    async collection({ all = [], not = {}, sort = 'popular', year = new Date().getFullYear(), pageSize = 24 }) {
      const l = await lookups();
      // "role-playing" matches "Role-playing (RPG)"; "co-operative" matches exactly.
      const named = (rows, words = []) => rows
        .filter((r) => words.some((w) => String(r.name).toLowerCase().startsWith(w)))
        .map((r) => r.id);
      const clauses = [];
      for (const group of all) {
        const parts = [
          ['genres', named(l.genres, group.genres)],
          ['themes', named(l.themes, group.themes)],
          ['game_modes', named(l.gameModes, group.modes)],
        ].filter(([, ids]) => ids.length).map(([field, ids]) => `${field} = (${ids.join(',')})`);
        if (!parts.length) return [];
        clauses.push(`(${parts.join(' | ')})`);
      }

      const now = Math.floor(Date.now() / 1000);
      const day = 24 * 60 * 60;
      const yearStart = Date.UTC(year, 0, 1) / 1000;
      const yearEnd = Math.min(now, Date.UTC(year + 1, 0, 1) / 1000);
      const bySort = {
        popular: { where: 'total_rating_count >= 5', order: 'total_rating_count desc' },
        top: { where: 'total_rating >= 80 & total_rating_count >= 20', order: 'total_rating_count desc' },
        new: { where: `first_release_date >= ${now - 365 * day} & first_release_date <= ${now}`, order: 'hypes desc' },
        year: { where: `first_release_date >= ${yearStart} & first_release_date < ${yearEnd} & total_rating >= 75 & total_rating_count >= 3`, order: 'total_rating_count desc' },
        upcoming: { where: `first_release_date > ${now} & first_release_date <= ${now + 90 * day} & hypes >= 1`, order: 'hypes desc' },
      }[sort] || { where: 'total_rating_count >= 5', order: 'total_rating_count desc' };
      const where = [`game_type = (${l.gameTypes.join(',')})`, NOT_AN_EDITION, ...clauses, bySort.where].join(' & ');
      // Extra rows make up for the ones `not` removes.
      const rows = await query('games', `fields ${SUMMARY_FIELDS}; where ${where}; sort ${bySort.order}; limit ${pageSize * 2};`);

      const excluded = [...(not.themes || []), ...(not.genres || [])];
      const keep = (g) => ![...(g.themes || []), ...(g.genres || [])]
        .some((t) => excluded.some((w) => String(t.name).toLowerCase().startsWith(w)));
      return dedupeByName(rows.filter(listable).filter(keep)).slice(0, pageSize).map((g) => toSummary(g, l));
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
        similar = (await gamesByIds((g.similar_games || []).slice(0, 16), l))
          .filter((s) => s.id !== g.slug && normalizeTitle(s.name) !== normalizeTitle(g.name))
          .slice(0, 12);
      } catch (err) {
        console.error('Could not load similar games:', err.message);
      }

      // Media: trailers first, then screenshots and artwork.
      const media = [
        ...(g.videos || []).filter((v) => /^[\w-]{6,20}$/.test(v.video_id || '')).slice(0, 4).map((v) => ({
          type: 'video',
          youtubeId: v.video_id,
          name: v.name || 'Trailer',
          thumb: `https://i.ytimg.com/vi/${v.video_id}/hqdefault.jpg`,
        })),
        ...[...(g.screenshots || []), ...(g.artworks || []).filter((a) => !a.alpha_channel)].slice(0, 14).map((im) => ({
          type: 'image',
          thumb: image(im.image_id, 'screenshot_med'),
          full: image(im.image_id, '1080p'),
        })),
      ];

      const score = (value, count) => (value && count ? { score: Math.round(value), count } : null);

      // "English: Interface, Audio, Subtitles" rows from IGDB's language support list.
      const languages = new Map();
      for (const ls of g.language_supports || []) {
        const name = ls.language?.name;
        const kind = String(ls.language_support_type?.name || '').toLowerCase();
        if (!name) continue;
        const row = languages.get(name) || { name, interface: false, audio: false, subtitles: false };
        if (kind.includes('interface')) row.interface = true;
        if (kind.includes('audio')) row.audio = true;
        if (kind.includes('subtitle')) row.subtitles = true;
        languages.set(name, row);
      }

      const linkName = (w) => l.websiteNames?.get(w.type) || LEGACY_WEBSITE_NAMES[w.type] || null;
      const links = (g.websites || [])
        .map((w) => ({ label: linkName(w), url: w.url }))
        .filter((w) => w.label && !STORE_SITE.test(w.label) && /^https?:\/\//.test(w.url))
        .map((w) => ({ ...w, label: /official/i.test(w.label) ? 'Official website' : w.label }));

      const addon = (kind) => (a) => ({ id: a.slug, name: a.name, kind, image: image(a.cover?.image_id, 'cover_big') });
      const addons = [
        ...(g.expansions || []).map(addon('Expansion')),
        ...(g.standalone_expansions || []).map(addon('Standalone')),
        ...(g.dlcs || []).map(addon('DLC')),
      ].filter((a) => a.id).slice(0, 12);

      // Special editions are separate IGDB entries that point back at this game.
      let editions = [];
      try {
        editions = (await query('games', `fields name,slug,cover.image_id; where version_parent = ${g.id}; limit 8;`))
          .map(addon('Edition'));
      } catch (err) {
        console.error('Could not load editions:', err.message);
      }

      return {
        ...summary,
        description: g.summary || g.storyline || null,
        developers: companies.filter((c) => c.developer && c.company).map((c) => c.company.name),
        publishers: companies.filter((c) => c.publisher && c.company).map((c) => c.company.name),
        website: site(l.websites.official) || null,
        buy: buildBuyLinks(g.name, stores),
        similar,
        media,
        scores: {
          critics: score(g.aggregated_rating, g.aggregated_rating_count),
          players: score(g.rating, g.rating_count),
        },
        features: [...(g.game_modes || []), ...(g.player_perspectives || [])].map((m) => m.name),
        languages: [...languages.values()],
        links,
        editions,
        addons,
      };
    },
  };
}

module.exports = { createIgdbProvider, platformFamilies };
