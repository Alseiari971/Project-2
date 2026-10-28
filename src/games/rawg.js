// RAWG (https://rawg.io/apidocs) lists 500,000+ games across every platform.
// It needs a free API key, set as RAWG_API_KEY.
const { RAWG_STORE_KEYS, buildBuyLinks } = require('./stores');
const { findGenre } = require('./genres');
const { normalizeTitle } = require('../text');
const { steamArt } = require('./steam-art');

const MATCH_CONCURRENCY = 5;
const STEAM_STORE_ID = 1;

const steamAppIdFromUrl = (url) => Number(/store\.steampowered\.com\/app\/(\d+)/.exec(url || '')?.[1]) || null;

const BASE_URL = 'https://api.rawg.io/api';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

const isoDate = (d) => d.toISOString().slice(0, 10);

function createRawgProvider(apiKey, { fetchImpl = fetch } = {}) {
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
      // RAWG has no logo or poster art. addSteamArt fills these in for games sold on Steam.
      logo: null,
      poster: null,
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
        // Searches are ordered by relevance; browsing uses the chosen sort.
        ...(q ? {} : sortParams(sort)),
        page,
        page_size: pageSize,
      });
      return {
        count: data.count,
        hasMore: Boolean(data.next),
        results: data.results.map(toSummary),
      };
    },

    /**
     * Swaps in official Steam artwork (poster, logo) for games that are sold on
     * Steam. Costs one cached request per game, so only use it on short lists
     * like the home page banner and Top 10.
     */
    async addSteamArt(games) {
      await Promise.all(games.map(async (game) => {
        const info = seen.get(game.id);
        if (!info?.onSteam || game.poster) return;
        try {
          const stores = await request(`/games/${info.rawgId}/stores`);
          const steam = stores?.results.find((s) => s.store_id === STEAM_STORE_ID);
          const appId = steamAppIdFromUrl(steam?.url);
          if (appId) Object.assign(game, { ...steamArt(appId), image: game.image, backdrop: game.backdrop });
        } catch (err) {
          console.error(`Could not load Steam art for ${game.id}:`, err.message);
        }
      }));
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
            const data = await request('/games', { search: steamGames[i].name, search_precise: true, page_size: 5 });
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
      const art = steamAppId ? steamArt(steamAppId) : {};

      return {
        ...toSummary(game),
        logo: art.logo || null,
        poster: art.poster || null,
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
