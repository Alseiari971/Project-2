// RAWG (https://rawg.io/apidocs) lists 500,000+ games across every platform.
// It needs a free API key, set as RAWG_API_KEY.
const { RAWG_STORE_KEYS, buildBuyLinks } = require('./stores');

const BASE_URL = 'https://api.rawg.io/api';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

function createRawgProvider(apiKey, { fetchImpl = fetch } = {}) {
  const cache = new Map();

  async function request(path, params = {}) {
    const url = new URL(BASE_URL + path);
    url.searchParams.set('key', apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const cacheKey = url.toString();
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.value;

    const res = await fetchImpl(url, { headers: { 'User-Agent': 'GameShelf/0.1' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`RAWG request failed with status ${res.status}`);
    const value = await res.json();

    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }

  function toSummary(g) {
    return {
      // Slugs are stable and readable, and RAWG accepts them anywhere an id is expected.
      id: g.slug,
      name: g.name,
      released: g.released || null,
      image: g.background_image || null,
      genres: (g.genres || []).map((x) => x.name),
      platforms: (g.parent_platforms || g.platforms || []).map((p) => p.platform.name),
    };
  }

  return {
    name: 'rawg',

    async search({ query = '', page = 1, pageSize = 24 }) {
      const data = await request('/games', {
        search: query.trim() || undefined,
        search_precise: query.trim() ? true : undefined,
        // Without a search term, show the most-added games so the home page isn't random.
        ordering: query.trim() ? undefined : '-added',
        page,
        page_size: pageSize,
      });
      return {
        count: data.count,
        hasMore: Boolean(data.next),
        results: data.results.map(toSummary),
      };
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

      return {
        ...toSummary(game),
        description: game.description_raw || '',
        developers: (game.developers || []).map((d) => d.name),
        publishers: (game.publishers || []).map((p) => p.name),
        website: game.website || null,
        buy: buildBuyLinks(game.name, stores),
      };
    },
  };
}

module.exports = { createRawgProvider };
