// Fills the `games` table for every game GameShelf already refers to, so pages
// that existed under IGDB keep their ids and gain Steam + Wikidata details:
//
//   cd /opt/gameshelf && node scripts/backfill-games.js
//
// It reads DB_FILE from the environment or /etc/gameshelf.env, goes slowly
// (the catalog's own rate limits), and can be run again at any time: games
// already filled in are skipped. Nothing else in the database changes.
const fs = require('node:fs');

const ENV_FILE = process.env.GAMESHELF_ENV || '/etc/gameshelf.env';
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && ['DB_FILE', 'METADATA_TTL_DAYS'].includes(m[1]) && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const { openDatabase } = require('../src/db');
const { createSteamWikidataProvider } = require('../src/games/steam-wikidata');

(async () => {
  const db = openDatabase();
  const games = createSteamWikidataProvider({ db });
  const ids = new Set();
  const add = (rows, key) => rows.forEach((r) => r[key] && ids.add(String(r[key])));
  add(db.prepare('SELECT DISTINCT game_id FROM library').all(), 'game_id');
  add(db.prepare('SELECT DISTINCT game_id FROM localization_packs WHERE game_id IS NOT NULL').all(), 'game_id');
  for (const table of ['arabic_requests', 'arabic_games']) {
    for (const { game } of db.prepare(`SELECT DISTINCT game FROM ${table}`).all()) if (/^game:/.test(game)) ids.add(game.slice(5));
  }
  // Packs that name their Steam app link it to their game id right away.
  const link = db.prepare('UPDATE games SET steam_appid = ? WHERE id = ? AND steam_appid IS NULL');
  for (const { game_id: id, steam_app_id: appid, title } of db.prepare('SELECT DISTINCT game_id, steam_app_id, title FROM localization_packs WHERE game_id IS NOT NULL AND steam_app_id IS NOT NULL').all()) {
    if (db.prepare('SELECT 1 FROM games WHERE steam_appid = ?').get(appid)) continue;
    db.prepare('INSERT OR IGNORE INTO games (id, name) VALUES (?, ?)').run(id, title || id);
    link.run(appid, id);
  }
  const todo = [...ids].filter((id) => !db.prepare('SELECT details_at FROM games WHERE id = ?').get(id)?.details_at);
  console.log(`${ids.size} games referred to; ${todo.length} to fill in.`);
  let done = 0;
  let missing = 0;
  for (const id of todo) {
    try {
      const game = await games.getGame(id);
      if (game) done += 1;
      else {
        missing += 1;
        console.log(`  not found on Steam or Wikidata: ${id}`);
      }
    } catch (err) {
      missing += 1;
      console.log(`  ${id}: ${err.message}`);
    }
  }
  await games.settled();
  console.log(`Done: ${done} filled in, ${missing} not found (they keep working as before, with the name players saved).`);
})();
