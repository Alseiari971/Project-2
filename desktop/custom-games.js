// Games people add themselves by picking the game's program file. Saved as
// JSON in the app's data folder, alongside the database.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_NAME = 100;
// The parts of a GameShelf game summary kept for the Home row and the game page match.
const SUMMARY_FIELDS = ['id', 'name', 'released', 'image', 'poster', 'backdrop', 'logo', 'artHasTitle', 'fallbackImage', 'genres'];

function cleanSummary(game) {
  if (!game || typeof game.id !== 'string' || !game.id || typeof game.name !== 'string') return null;
  const out = {};
  for (const key of SUMMARY_FIELDS) {
    const value = game[key];
    if (key === 'genres') out.genres = Array.isArray(value) ? value.filter((g) => typeof g === 'string').slice(0, 6) : [];
    else if (key === 'artHasTitle') out.artHasTitle = Boolean(value);
    else if (typeof value === 'string') out[key] = value.slice(0, 2000);
    else out[key] = null;
  }
  // Pictures only ever come from the web, never from files on this computer.
  for (const key of ['image', 'poster', 'backdrop', 'logo', 'fallbackImage']) {
    if (out[key] && !/^https:\/\//.test(out[key])) out[key] = null;
  }
  return out;
}

function createCustomGames(file) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8')).filter((g) => g && g.key && g.exe && g.name);
  } catch {}

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 2));
  };

  return {
    /** Entries in the same shape as scanned games (see installed.js), plus the linked GameShelf game. */
    all: () => list.map((g) => ({ ...g, launcher: 'custom', cwd: path.dirname(g.exe), dir: path.dirname(g.exe) })),

    add({ exe, name, game }) {
      const cleanName = String(name || '').trim().slice(0, MAX_NAME);
      if (!cleanName) throw new Error('Give the game a name.');
      const summary = cleanSummary(game);
      const existing = list.find((g) => g.exe === exe);
      const entry = { key: existing?.key || `custom:${crypto.randomUUID()}`, name: summary?.name || cleanName, exe, game: summary };
      list = [...list.filter((g) => g.exe !== exe), entry];
      save();
      return entry;
    },

    remove(key) {
      list = list.filter((g) => g.key !== key);
      save();
    },
  };
}

/** A starting name for a picked program: its folder's name, unless that's a generic folder like "bin". */
function suggestName(exe) {
  const generic = /^(bin|bin32|bin64|x64|x86|win64|win32|binaries|game|games|release|retail|shipping)$/i;
  let dir = path.dirname(exe);
  while (generic.test(path.basename(dir)) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const folder = path.basename(dir);
  const base = folder && !/^[a-z]:\\?$/i.test(folder) && folder !== path.sep ? folder : path.basename(exe, path.extname(exe));
  return base.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { createCustomGames, suggestName, cleanSummary };
