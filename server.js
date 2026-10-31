const fs = require('node:fs');
const path = require('node:path');

// Read settings such as IGDB_CLIENT_ID from a .env file when there is one.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {}

const express = require('express');
const { openDatabase } = require('./src/db');
const { loadUser } = require('./src/auth');
const { createGameProvider } = require('./src/games');
const { createApi } = require('./src/api');
const { createPriceService } = require('./src/prices');
const { createSteamService } = require('./src/steam');
const { createSteamStore } = require('./src/steam-store');
const { createTranslationMemory } = require('./src/translation-memory');
const { createArabicGames } = require('./src/arabic-games');
const { createPackRegistry } = require('./src/pack-registry');

// Where uploaded Arabic packs and the Windows installer are kept: beside the database.
const defaultDataDir = () => process.env.DATA_DIR || path.dirname(path.resolve(process.env.DB_FILE || path.join(__dirname, 'data', 'gameshelf.db')));

// Every response: no sniffing, no outside scripts or styles, no framing.
function securityHeaders(_req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; " +
      // Trailers play in YouTube's privacy-friendly player; Steam's short clips stream from its servers.
      "frame-src https://www.youtube-nocookie.com; media-src https://*.steamstatic.com",
  });
  next();
}

function createApp({
  db = openDatabase(),
  games = createGameProvider(process.env, { db }),
  prices = createPriceService(),
  steam = createSteamService(),
  steamStore = createSteamStore(),
  translations = createTranslationMemory({ db }),
  arabicGames = createArabicGames({ db, translations }),
  dataDir = defaultDataDir(),
  packs = createPackRegistry({ db, dir: path.join(dataDir, 'packs') }),
} = {}) {
  const downloadsDir = path.join(dataDir, 'downloads');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use(securityHeaders);

  // Large enough for a resized avatar image.
  app.use(express.json({ limit: '500kb' }));
  app.use(loadUser(db));
  app.use('/api', createApi({ db, games, prices, steam, steamStore, translations, arabicGames, packs, downloadsDir }));
  // The website's "Download GameShelf for Windows" button: the installer an admin
  // uploaded in the Admin Panel, or else DOWNLOAD_URL (a GitHub release, say).
  app.get('/download/windows', (_req, res) => {
    const file = path.join(downloadsDir, 'GameShelf-Setup.exe');
    if (fs.existsSync(file)) return res.download(file, 'GameShelf-Setup.exe');
    if (process.env.DOWNLOAD_URL) return res.redirect(302, process.env.DOWNLOAD_URL);
    res.status(404).type('text').send('The Windows app isn\'t available to download yet.');
  });
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
  const db = openDatabase();
  const games = createGameProvider(process.env, { db });
  createApp({ db, games }).listen(port, () => {
    console.log(`GameShelf running at http://localhost:${port}`);
    const source = { igdb: 'IGDB', rawg: 'RAWG', local: 'the built-in 35-game sample catalog' }[games.name];
    console.log(`Game data: ${source}.`);
    if (games.name === 'local') {
      console.log('Set IGDB_CLIENT_ID and IGDB_CLIENT_SECRET to search every game (see README).');
    }
    if (!process.env.STEAM_API_KEY) {
      console.log('Steam import is off. Set STEAM_API_KEY to turn it on (see README).');
    }
    if (!process.env.OPENAI_API_KEY) {
      console.log('Shared Arabic translation is off. Set OPENAI_API_KEY to turn it on (see README).');
    }
  });
}

module.exports = { createApp, securityHeaders };
