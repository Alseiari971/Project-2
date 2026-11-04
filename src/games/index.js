const { createLocalProvider } = require('./local');
const { createRawgProvider } = require('./rawg');
const { createSteamWikidataProvider } = require('./steam-wikidata');
const { steamIdStore } = require('../db');

/**
 * Picks the game data: Steam's store and Wikidata (no keys needed) by default.
 * GAME_DATA=local uses the built-in sample catalog (offline, for development),
 * GAME_DATA=rawg the older RAWG database (with RAWG_API_KEY).
 */
function createGameProvider(env = process.env, { db, fetchImpl } = {}) {
  if (env.GAME_DATA === 'local' || !db) return createLocalProvider();
  if (env.GAME_DATA === 'rawg' && env.RAWG_API_KEY) return createRawgProvider(env.RAWG_API_KEY, { steamIds: steamIdStore(db) });
  return createSteamWikidataProvider({ db, env, ...(fetchImpl ? { fetchImpl } : {}) });
}

module.exports = { createGameProvider };
