// Live PC game prices from CheapShark (https://apidocs.cheapshark.com), a free
// price comparison service. No API key needed. Prices are in US dollars.
const { normalizeTitle: normalize } = require('./text');

const BASE_URL = 'https://www.cheapshark.com/api/1.0';
const USER_AGENT = 'GameShelf/0.3 (+https://github.com/Alseiari971/Project-2)';
const PRICE_TTL_MS = 60 * 60 * 1000;
const STORES_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 1000;

function createPriceService({ fetchImpl = fetch } = {}) {
  const cache = new Map();

  async function request(path, ttl) {
    const key = path;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const res = await fetchImpl(BASE_URL + path, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`CheapShark request failed with status ${res.status}`);
    const value = await res.json();
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + ttl });
    return value;
  }

  async function storeNames() {
    const stores = await request('/stores', STORES_TTL_MS);
    return new Map(stores.filter((s) => s.isActive).map((s) => [s.storeID, s.storeName]));
  }

  // Steam app IDs give an exact match; otherwise we only accept an exact title match.
  async function findGameId({ steamAppId, name }) {
    if (steamAppId) {
      const found = await request(`/games?steamAppID=${encodeURIComponent(steamAppId)}`, PRICE_TTL_MS);
      if (found.length) return found[0].gameID;
    }
    if (!name) return null;
    const found = await request(`/games?title=${encodeURIComponent(name)}&limit=10`, PRICE_TTL_MS);
    return found.find((g) => normalize(g.external) === normalize(name))?.gameID ?? null;
  }

  return {
    /** Returns current deals (cheapest first) and the all-time low, or null if the game isn't found. */
    async pricesFor({ steamAppId, name }) {
      const gameId = await findGameId({ steamAppId, name });
      if (!gameId) return null;
      const [details, stores] = await Promise.all([
        request(`/games?id=${encodeURIComponent(gameId)}`, PRICE_TTL_MS),
        storeNames(),
      ]);
      const deals = (details.deals || [])
        .filter((d) => stores.has(d.storeID))
        .map((d) => ({
          store: stores.get(d.storeID),
          price: Number(d.price),
          retailPrice: Number(d.retailPrice),
          savings: Number(d.savings),
          // CheapShark's redirect link sends the buyer to the store's own page for the deal.
          url: `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(decodeURIComponent(d.dealID))}`,
        }))
        .sort((a, b) => a.price - b.price);
      const low = details.cheapestPriceEver;
      return {
        currency: 'USD',
        deals,
        lowestEver: low ? { price: Number(low.price), date: new Date(low.date * 1000).toISOString() } : null,
      };
    },
  };
}

module.exports = { createPriceService };
