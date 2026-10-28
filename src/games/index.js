const { createLocalProvider } = require('./local');
const { createRawgProvider } = require('./rawg');

function createGameProvider(apiKey = process.env.RAWG_API_KEY) {
  return apiKey ? createRawgProvider(apiKey) : createLocalProvider();
}

module.exports = { createGameProvider };
