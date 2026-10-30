// Built-in sample catalog, used when no RAWG_API_KEY is configured so the
// app works out of the box. Add a RAWG key to unlock every game in the world.
const path = require('node:path');
const { buildBuyLinks } = require('./stores');
const { steamArt } = require('./steam-art');

const catalog = require(path.join(__dirname, '..', '..', 'data', 'games.json'));

function toSummary(game) {
  return {
    id: game.id,
    name: game.name,
    released: game.released,
    image: null,
    backdrop: null,
    logo: null,
    poster: null,
    artHasTitle: false,
    ...(game.steamAppId ? steamArt(game.steamAppId) : {}),
    steamAppId: game.steamAppId || null,
    genres: game.genres,
    platforms: game.platforms,
    description: game.description,
  };
}

function createLocalProvider() {
  return {
    name: 'local',

    // sort: 'popular' (catalog order), 'new' (newest first) or 'top' (no
    // ratings in the sample catalog, so the same as popular).
    async search({ query = '', genre = '', sort = 'popular', page = 1, pageSize = 24 }) {
      const q = query.trim().toLowerCase();
      const g = genre.toLowerCase();
      let matches = catalog.filter((x) =>
        (!q || x.name.toLowerCase().includes(q)) &&
        (!g || x.genres.some((name) => name.toLowerCase() === g)));
      if (sort === 'new') matches = [...matches].sort((a, b) => b.released.localeCompare(a.released));
      const start = (page - 1) * pageSize;
      return {
        count: matches.length,
        hasMore: start + pageSize < matches.length,
        results: matches.slice(start, start + pageSize).map(toSummary),
      };
    },

    // The catalog already uses official Steam artwork.
    async addSteamArt(games) {
      return games;
    },

    // Matches Steam games to the catalog by Steam app ID. Returns a summary or null for each.
    async matchSteamGames(steamGames) {
      const byAppId = new Map(catalog.filter((g) => g.steamAppId).map((g) => [g.steamAppId, g]));
      return steamGames.map((s) => (byAppId.has(s.appid) ? toSummary(byAppId.get(s.appid)) : null));
    },

    async getGame(id) {
      const game = catalog.find((g) => g.id === id);
      if (!game) return null;
      const stores = game.stores.map((key) => ({
        key,
        url: key === 'steam' && game.steamAppId ? `https://store.steampowered.com/app/${game.steamAppId}/` : undefined,
      }));
      return {
        ...toSummary(game),
        steamAppId: game.steamAppId || null,
        developers: game.developers || [],
        publishers: [],
        website: null,
        buy: buildBuyLinks(game.name, stores),
      };
    },
  };
}

module.exports = { createLocalProvider };
