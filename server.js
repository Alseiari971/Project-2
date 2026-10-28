const path = require('node:path');

// Read settings such as RAWG_API_KEY from a .env file when there is one.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {}

const express = require('express');
const { openDatabase } = require('./src/db');
const { loadUser } = require('./src/auth');
const { createGameProvider } = require('./src/games');
const { createApi } = require('./src/api');

function createApp({ db = openDatabase(), games = createGameProvider() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    next();
  });

  // Large enough for a resized avatar image.
  app.use(express.json({ limit: '500kb' }));
  app.use(loadUser(db));
  app.use('/api', createApi({ db, games }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use((err, _req, res, _next) => {
    // Client mistakes such as malformed JSON carry a 4xx status from Express.
    if (err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: 'Invalid request.' });
    }
    console.error(err);
    res.status(502).json({ error: 'Something went wrong talking to the game database. Please try again.' });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const games = createGameProvider();
  createApp({ games }).listen(port, () => {
    console.log(`GameShelf running at http://localhost:${port}`);
    if (games.name === 'local') {
      console.log('Using the built-in sample catalog. Set RAWG_API_KEY to search every game (see README).');
    }
  });
}

module.exports = { createApp };
