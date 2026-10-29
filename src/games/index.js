const { createLocalProvider } = require('./local');
const { createRawgProvider } = require('./rawg');
const { createIgdbProvider } = require('./igdb');
const { steamIdStore } = require('../db');

/**
 * Picks the game database: IGDB when its Twitch codes are set, otherwise RAWG
 * when its key is set, otherwise the built-in sample catalog.
 */
function createGameProvider(env = process.env, { db } = {}) {
  if (env.IGDB_CLIENT_ID && env.IGDB_CLIENT_SECRET) return createIgdbProvider(env.IGDB_CLIENT_ID, env.IGDB_CLIENT_SECRET);
  if (env.RAWG_API_KEY) return createRawgProvider(env.RAWG_API_KEY, { steamIds: db ? steamIdStore(db) : undefined });
  return createLocalProvider();
}

module.exports = { createGameProvider };
