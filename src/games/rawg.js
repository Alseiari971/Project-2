// RAWG (https://rawg.io/apidocs) lists 500,000+ games across every platform.
// It needs a free API key, set as RAWG_API_KEY.
const { RAWG_STORE_KEYS, buildBuyLinks } = require('./stores');
const { findGenre } = require('./genres');
const { normalizeTitle } = require('../text');
const { steamArt } = require('./steam-art');

const MATCH_CONCURRENCY = 5;
const STEAM_STORE_ID = 1;

// RAWG lets anyone submit games, so searches turn up fan-made entries and
// cash-in mobile apps. "added" is how many RAWG users have the game on a list.
// RAWG store ids: Steam, Xbox Store, PlayStation Store, GOG, Nintendo, Xbox 360, Epic.
const MAJOR_STORE_IDS = new Set([1, 2, 3, 5, 6, 7, 11]);
// App Store and Google Play carry lots of knock-off apps, so they need more proof.
const MOBILE_STORE_IDS = new Set([4, 8]);
const MIN_ADDED = 30;
const MOBILE_MIN_ADDED = 150;

const storeIds = (g) => (g.stores || []).map((s) => s.store.id);
const onMajorStore = (g) => storeIds(g).some((id) => MAJOR_STORE_IDS.has(id));

function isRealGame(g) {
  if (onMajorStore(g)) return true;
  const added = g.added || 0;
  if (storeIds(g).some((id) => MOBILE_STORE_IDS.has(id))) return added >= MOBILE_MIN_ADDED;
  return added >= MIN_ADDED;
}

// When a search matches a big game, results with under 1% of its popularity are
// almost always knock-offs ("Chest Sim for Fortnite"), unless a major store sells
// them. Phone-only apps are where most knock-offs live, so they need 5%.
const RELATIVE_CUTOFF = 0.01;
const MOBILE_RELATIVE_CUTOFF = 0.05;
const BIG_GAME_ADDED = 2000;
const mobileOnly = (g) => !onMajorStore(g) && storeIds(g).some((id) => MOBILE_STORE_IDS.has(id));

const steamAppIdFromUrl = (url) => Number(/store\.steampowered\.com\/app\/(\d+)/.exec(url || '')?.[1]) || null;

const BASE_URL = 'https://api.rawg.io/api';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

const isoDate = (d) => d.toISOString().slice(0, 10);

// Fallback when no database is passed in (tests): remembers Steam IDs in memory.
function memoryStore() {
  const map = new Map();
  return { get: (id) => map.get(id), set: (id, appId) => map.set(id, appId) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createRawgProvider(apiKey, { fetchImpl = fetch, steamIds = memoryStore() } = {}) {
  const cache = new Map();
  // RAWG's numeric id for each slug, and whether the game is sold on Steam, learned from search results.
  const seen = new Map();

  async function request(path, params = {}) {
    const url = new URL(BASE_URL + path);
    url.searchParams.set('key', apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const cacheKey = url.toString();
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.value;

    const res = await fetchImpl(url, { headers: { 'User-Agent': 'GameShelf/0.2' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`RAWG request failed with status ${res.status}`);
    const value = await res.json();

    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }

  function toSummary(g) {
    seen.set(g.slug, { rawgId: g.id, onSteam: (g.stores || []).some((s) => s.store.id === STEAM_STORE_ID) });
    return {
      // Slugs are stable and readable, and RAWG accepts them anywhere an id is expected.
      id: g.slug,
      name: g.name,
      released: g.released || null,
      image: g.background_image || null,
      backdrop: g.background_image_additional || g.background_image || null,
      // RAWG has no logo or poster art, and its images are screenshots without the
      // title. addSteamArt swaps in Steam's store art for games sold on Steam.
      logo: null,
      poster: null,
      artHasTitle: false,
      genres: (g.genres || []).map((x) => x.name),
      platforms: (g.parent_platforms || g.platforms || []).map((p) => p.platform.name),
      description: g.description_raw || null,
    };
  }

  function sortParams(sort) {
    if (sort === 'new') {
      // Popular games from the last year, rather than whatever is dated furthest in the future.
      const now = new Date();
      const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      return { dates: `${isoDate(yearAgo)},${isoDate(now)}`, ordering: '-added' };
    }
    if (sort === 'top') return { metacritic: '85,100', ordering: '-added' };
    return { ordering: '-added' };
  }

  return {
    name: 'rawg',

    async search({ query = '', genre = '', sort = 'popular', page = 1, pageSize = 24 }) {
      const q = query.trim();
      let genreSlug;
      if (genre) {
        genreSlug = findGenre(genre)?.rawg;
        if (!genreSlug) return { count: 0, hasMore: false, results: [] };
      }
      const data = await request('/games', {
        search: q || undefined,
        search_precise: q ? true : undefined,
        genres: genreSlug,
        // DLC, editions and add-on packs aren't separate games.
        exclude_additions: true,
        // Searches are ordered by relevance; browsing uses the chosen sort.
        ...(q ? {} : sortParams(sort)),
        page,
        // Searches ask for extra results, since fan-made entries get filtered out.
        page_size: q ? 40 : pageSize,
      });
      let results = data.results.filter(isRealGame);
      if (q) {
        // An exact title match comes first, then the games most people have added.
        const target = normalizeTitle(q);
        const rank = (g) => (normalizeTitle(g.name) === target ? 1 : 0);
        const top = Math.max(0, ...results.map((g) => g.added || 0));
        if (top >= BIG_GAME_ADDED) {
          results = results.filter((g) => rank(g) || onMajorStore(g) || g.metacritic ||
            (g.added || 0) >= top * (mobileOnly(g) ? MOBILE_RELATIVE_CUTOFF : RELATIVE_CUTOFF));
        }
        results = results
          .map((g, i) => ({ g, i }))
          .sort((a, b) => rank(b.g) - rank(a.g) || Boolean(b.g.background_image) - Boolean(a.g.background_image) ||
            (b.g.added || 0) - (a.g.added || 0) || a.i - b.i)
          .map(({ g }) => g);
      }
      return {
        count: data.count,
        hasMore: Boolean(data.next),
        results: results.map(toSummary),
      };
    },

    /**
     * Swaps in Steam's official store art (banner with the title, poster, logo)
     * for games sold on Steam. Each game's Steam ID is looked up once and saved
     * for good. Waits at most `budgetMs`; slower lookups finish in the background
     * and show up on the next page load.
     */
    async addSteamArt(games, { budgetMs = 1500 } = {}) {
      const apply = (game, appId) => {
        // Keep RAWG's wide background for banners, and its image as a fallback.
        const { backdrop } = game;
        Object.assign(game, steamArt(appId), { backdrop, fallbackImage: game.image, steamAppId: appId });
      };
      const unknown = [];
      for (const game of games) {
        const info = seen.get(game.id);
        if (!info?.onSteam || game.artHasTitle) continue;
        const known = steamIds.get(game.id);
        if (known === undefined) unknown.push({ game, rawgId: info.rawgId });
        else if (known) apply(game, known);
      }
      if (!unknown.length) return games;

      let next = 0;
      const worker = async () => {
        while (next < unknown.length) {
          const { game, rawgId } = unknown[next++];
          try {
            const stores = await request(`/games/${rawgId}/stores`);
            const steam = stores?.results.find((s) => s.store_id === STEAM_STORE_ID);
            const appId = steamAppIdFromUrl(steam?.url);
            steamIds.set(game.id, appId);
            if (appId) apply(game, appId);
          } catch (err) {
            console.error(`Could not look up Steam art for ${game.id}:`, err.message);
          }
        }
      };
      const all = Promise.all(Array.from({ length: MATCH_CONCURRENCY }, worker));
      await Promise.race([all, sleep(budgetMs)]);
      return games;
    },

    // Matches Steam games to RAWG by exact title, a few lookups at a time.
    // Returns a summary or null for each game, in the same order.
    async matchSteamGames(steamGames) {
      const results = new Array(steamGames.length).fill(null);
      let next = 0;
      const worker = async () => {
        while (next < steamGames.length) {
          const i = next++;
          try {
            const data = await request('/games', { search: steamGames[i].name, search_precise: true, exclude_additions: true, page_size: 5 });
            const target = normalizeTitle(steamGames[i].name);
            const hit = data.results.find((g) => normalizeTitle(g.name) === target);
            if (hit) results[i] = toSummary(hit);
          } catch (err) {
            console.error(`Could not match "${steamGames[i].name}":`, err.message);
          }
        }
      };
      await Promise.all(Array.from({ length: MATCH_CONCURRENCY }, worker));
      return results;
    },

    async getGame(id) {
      const game = await request(`/games/${encodeURIComponent(id)}`);
      if (!game || !game.id) return null;

      // The game detail lists which stores carry it; the /stores endpoint has the product URLs.
      const storeLinks = (await request(`/games/${game.id}/stores`)) || { results: [] };
      const urlByStoreId = new Map(storeLinks.results.map((s) => [s.store_id, s.url]));
      const stores = (game.stores || []).map((s) => ({
        key: RAWG_STORE_KEYS[s.store.slug],
        url: urlByStoreId.get(s.store.id),
      }));

      // RAWG doesn't expose Steam app IDs directly, but the Steam store link contains one.
      const steamStore = (game.stores || []).find((s) => s.store.slug === 'steam');
      const steamUrl = steamStore && urlByStoreId.get(steamStore.store.id);
      const steamAppId = steamAppIdFromUrl(steamUrl);
      if (steamAppId) steamIds.set(game.slug, steamAppId);
      const summary = toSummary(game);
      const art = steamAppId
        ? { ...steamArt(steamAppId), backdrop: summary.backdrop, fallbackImage: summary.image }
        : {};

      return {
        ...summary,
        ...art,
        steamAppId,
        developers: (game.developers || []).map((d) => d.name),
        publishers: (game.publishers || []).map((p) => p.name),
        website: game.website || null,
        buy: buildBuyLinks(game.name, stores),
      };
    },
  };
}

module.exports = { createRawgProvider };
