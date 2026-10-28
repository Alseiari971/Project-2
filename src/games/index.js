const { createLocalProvider } = require('./local');
const { createRawgProvider } = require('./rawg');
const { steamIdStore } = require('../db');

/** Uses RAWG (every game) when a key is set, otherwise the built-in sample catalog. */
function createGameProvider(apiKey = process.env.RAWG_API_KEY, { db } = {}) {
  return apiKey ? createRawgProvider(apiKey, { steamIds: db ? steamIdStore(db) : undefined }) : createLocalProvider();
}

module.exports = { createGameProvider };
