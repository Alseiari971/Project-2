// Built-in sample catalog, used when no RAWG_API_KEY is configured so the
// app works out of the box. Add a RAWG key to unlock every game in the world.
const path = require('node:path');
const { buildBuyLinks } = require('./stores');

const catalog = require(path.join(__dirname, '..', '..', 'data', 'games.json'));

const steamAsset = (appId, file) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/${file}`;

function toSummary(game) {
  return {
    id: game.id,
    name: game.name,
    released: game.released,
    image: game.steamAppId ? steamAsset(game.steamAppId, 'capsule_616x353.jpg') : null,
    backdrop: game.steamAppId ? steamAsset(game.steamAppId, 'library_hero.jpg') : null,
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

    async getGame(id) {
      const game = catalog.find((g) => g.id === id);
      if (!game) return null;
      const stores = game.stores.map((key) => ({
        key,
        url: key === 'steam' && game.steamAppId ? `https://store.steampowered.com/app/${game.steamAppId}/` : undefined,
      }));
      return {
        ...toSummary(game),
        developers: game.developers || [],
        publishers: [],
        website: null,
        buy: buildBuyLinks(game.name, stores),
      };
    },
  };
}

module.exports = { createLocalProvider };
