const fs = require('node:fs');
const path = require('node:path');

// Read settings such as STEAM_API_KEY from a .env file when there is one.
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
const { createPackRegistry, packKeys } = require('./src/pack-registry');
const { createSubmissions } = require('./src/submissions');
const { createEngineRecipes } = require('./src/engine-recipes');
const { createCommunity } = require('./src/community');
const { createMailer } = require('./src/mailer');

// Where uploaded Arabic packs and the Windows installer are kept: beside the database.
const defaultDataDir = () => process.env.DATA_DIR || path.dirname(path.resolve(process.env.DB_FILE || path.join(__dirname, 'data', 'gameshelf.db')));

// Every response: no sniffing, no outside scripts or styles, no framing.
// The same headers Helmet sets, written out: no inline scripts or plugins,
// no framing, no MIME sniffing, HTTPS remembered, powerful browser features off.
function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Origin-Agent-Cluster': '?1',
    'X-DNS-Prefetch-Control': 'off',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; " +
      "img-src 'self' https: data:; style-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; " +
      // Trailers play in YouTube's privacy-friendly player; Steam's short clips stream from its servers.
      "frame-src https://www.youtube-nocookie.com; media-src https://*.steamstatic.com",
  });
  // HTTPS only from now on, once the site was reached over HTTPS (behind Caddy, req.secure follows X-Forwarded-Proto).
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/**
 * Requests that change something must come from GameShelf's own pages: a
 * browser names the page's origin in Origin, and another site's origin is
 * refused (with SameSite=Lax cookies and JSON bodies, this closes CSRF).
 * Tools without a browser send no Origin and are let through; they still
 * need a session or token.
 */
function sameOriginWrites(allowed = () => []) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      return res.status(403).json({ error: 'This request came from another site.' });
    }
    if (host === req.headers.host || allowed().includes(origin)) return next();
    res.status(403).json({ error: 'This request came from another site.' });
  };
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
  submissions = createSubmissions({ db, translations, publicKeys: packKeys() }),
  recipes = createEngineRecipes({ db, publicKeys: packKeys() }),
  community = createCommunity({ db, translations, arabicGames, submissions }),
  // Email for Guard codes (src/mailer.js), and Steam's sign-in check (fetch); tests pass stand-ins.
  mailer = createMailer(),
  fetchImpl = fetch,
  now = () => Date.now(),
  // GameShelf Supporter (src/plans.js) and payment webhooks (src/billing.js); made from process.env when left out.
  plans,
  billing,
} = {}) {
  const downloadsDir = path.join(dataDir, 'downloads');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use(securityHeaders);
  app.use('/api', sameOriginWrites(() => [process.env.PUBLIC_URL].filter(Boolean).map((u) => new URL(u).origin)));

  // Large enough for a resized avatar image.
  // The raw bytes are kept for payment webhooks, whose signatures cover them exactly.
  app.use(express.json({ limit: '500kb', verify: (req, _res, buf) => { if (req.originalUrl === '/api/billing/webhook') req.rawBody = buf.toString('utf8'); } }));
  app.use(loadUser(db));
  app.use('/api', createApi({ db, games, prices, steam, steamStore, translations, arabicGames, packs, submissions, recipes, community, downloadsDir, mailer, fetchImpl, now, plans, billing }));
  // The website's "Download GameShelf for Windows" button: the installer an admin
  // uploaded in the Admin Panel, or else DOWNLOAD_URL (a GitHub release, say).
  app.get('/download/windows', (_req, res) => {
    const file = path.join(downloadsDir, 'GameShelf-Setup.exe');
    if (fs.existsSync(file)) return res.download(file, 'GameShelf-Setup.exe');
    if (process.env.DOWNLOAD_URL) return res.redirect(302, process.env.DOWNLOAD_URL);
    res.status(404).type('text').send('The Windows app isn\'t available to download yet.');
  });
  app.use(express.static(path.join(__dirname, 'public')));

  // Errors never show their stack or file paths: those go to the server log only.
  app.use((err, _req, res, _next) => {
    // Client mistakes such as malformed JSON or a too-big body carry a 4xx status from Express.
    if (err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: err.status === 413 ? 'That request is too big.' : 'Invalid request.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const db = openDatabase();
  const games = createGameProvider(process.env, { db });
  createApp({ db, games }).listen(port, () => {
    console.log(`GameShelf running at http://localhost:${port}`);
    const source = { steam: 'Steam and Wikidata (no keys needed)', rawg: 'RAWG', local: 'the built-in 35-game sample catalog (GAME_DATA=local)' }[games.name];
    console.log(`Game data: ${source}.`);
    // Twitch/IGDB keys are no longer used; say so instead of silently ignoring them.
    if (process.env.IGDB_CLIENT_ID || process.env.TWITCH_CLIENT_ID) {
      console.log('IGDB_CLIENT_ID / TWITCH_CLIENT_ID are set but no longer used: game data now comes from Steam and Wikidata. You can remove them.');
    }
    if (!process.env.STEAM_API_KEY) {
      console.log('Steam import is off. Set STEAM_API_KEY to turn it on (see README).');
    }
    if (!process.env.OPENAI_API_KEY) {
      console.log('Shared Arabic translation is off. Set OPENAI_API_KEY to turn it on (see README).');
    }
    if (!process.env.SMTP_URL && process.env.MAIL_DEV_LOG !== '1') {
      console.log('Email is off: no email checks or Email Guard codes. Set SMTP_URL to turn it on (see README).');
    } else if (process.env.SMTP_URL) {
      console.log(`Email goes out through ${new URL(process.env.SMTP_URL).host}. Test it with: node scripts/send-test-email.js you@example.com`);
    }
  });
}

module.exports = { createApp, securityHeaders, sameOriginWrites };
