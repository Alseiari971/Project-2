// Built-in sample catalog, used when no RAWG_API_KEY is configured so the
// app works out of the box. Add a RAWG key to unlock every game in the world.
const path = require('node:path');
const { buildBuyLinks } = require('./stores');

const catalog = require(path.join(__dirname, '..', '..', 'data', 'games.json'));

const steamImage = (appId) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

function toSummary(game) {
  return {
    id: game.id,
    name: game.name,
    released: game.released,
    image: game.steamAppId ? steamImage(game.steamAppId) : null,
    genres: game.genres,
    platforms: game.platforms,
  };
}

function createLocalProvider() {
  return {
    name: 'local',

    async search({ query = '', page = 1, pageSize = 24 }) {
      const q = query.trim().toLowerCase();
      const matches = catalog
        .filter((g) => !q || g.name.toLowerCase().includes(q) || g.genres.some((x) => x.toLowerCase() === q))
        .sort((a, b) => b.released.localeCompare(a.released));
      const start = (page - 1) * pageSize;
      return {
        count: matches.length,
        hasMore: start + pageSize < matches.length,
        results: matches.slice(start, start + pageSize).map(toSummary),
      };
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
        description: game.description,
        developers: game.developers || [],
        publishers: [],
        website: null,
        buy: buildBuyLinks(game.name, stores),
      };
    },
  };
}

module.exports = { createLocalProvider };
