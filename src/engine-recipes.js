// Engine recipes, per game: how players' apps read the text of a game whose
// engine packs it in archives GameShelf has no reader for (God of War's .wad,
// REDengine .archive...), and put the Arabic back. An admin writes one in the
// Admin Panel; their desktop app checks it and signs it with GameShelf's pack
// key; this keeps it, after checking the signature again. Players' apps check
// the signature a third time before the pack builder runs it, and the builder
// only ever runs the allowlisted tools in localization/custom_engines.json.
// The format is described in localization/arabic_compiler/recipes.py.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { GAME_RE } = require('./translation-memory');

const MAX_RECIPE_BYTES = 256 * 1024;
const REGISTRY_FILE = path.join(__dirname, '..', 'localization', 'custom_engines.json');

class RecipeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function readRegistry(file = REGISTRY_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { format: 1, tools: {}, recipes: [] };
  }
}

function createEngineRecipes({ db, publicKeys = [], registryFile = REGISTRY_FILE }) {
  const q = {
    get: db.prepare('SELECT * FROM engine_recipes WHERE game = ?'),
    put: db.prepare(`INSERT INTO engine_recipes (game, recipe, signature, engine, tool, attached_by)
      VALUES (@game, @recipe, @signature, @engine, @tool, @user)
      ON CONFLICT (game) DO UPDATE SET recipe = excluded.recipe, signature = excluded.signature, engine = excluded.engine,
        tool = excluded.tool, attached_by = excluded.attached_by, updated_at = datetime('now')`),
    remove: db.prepare('DELETE FROM engine_recipes WHERE game = ?'),
    list: db.prepare(`SELECT r.game, r.engine, r.tool, r.updated_at, u.username AS attached_by
      FROM engine_recipes r LEFT JOIN users u ON u.id = r.attached_by ORDER BY r.updated_at DESC`),
    one: db.prepare(`SELECT r.game, r.engine, r.tool, r.updated_at, u.username AS attached_by
      FROM engine_recipes r LEFT JOIN users u ON u.id = r.attached_by WHERE r.game = ?`),
  };
  const registry = readRegistry(registryFile);

  function checkGame(game) {
    if (!GAME_RE.test(String(game))) throw new RecipeError('The game should be "steam:<app id>" or "game:<GameShelf id>".');
  }

  const summary = (row) => ({ game: row.game, engine: row.engine, tool: row.tool, updatedAt: row.updated_at, attachedBy: row.attached_by ?? null });

  /** Keeps a signed recipe for a game (admins). Returns its summary. */
  function attach(game, { recipe, signature } = {}, user = null) {
    checkGame(game);
    const text = String(recipe || '');
    if (!text || Buffer.byteLength(text) > MAX_RECIPE_BYTES) throw new RecipeError('Send the recipe (up to 256 KB) and its signature.');
    if (!publicKeys.length) throw new RecipeError('No pack signing key is set up on the server.', 503);
    const body = Buffer.from(text, 'utf8');
    const signed = publicKeys.some((key) => {
      try {
        return crypto.verify(null, body, key, Buffer.from(String(signature || ''), 'base64'));
      } catch {
        return false;
      }
    });
    if (!signed) throw new RecipeError('The recipe isn\'t signed with GameShelf\'s pack key. Pick GameShelf\'s pack-signing.key in the Pack Studio.');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RecipeError('That isn\'t an engine recipe.');
    }
    const [kind, id] = String(game).split(':');
    const same = kind === 'steam' ? parsed?.game?.steamAppId === Number(id) : parsed?.game?.gameId === id;
    if (parsed?.format !== 1 || !same) throw new RecipeError('That recipe is for another game.');
    if (parsed.tool !== undefined && !registry.tools?.[parsed.tool]) throw new RecipeError(`"${parsed.tool}" isn't a tool GameShelf allows.`);
    q.put.run({
      game: String(game),
      recipe: text,
      signature: String(signature),
      engine: String(parsed.engine || '').slice(0, 60),
      tool: String(parsed.tool || '').slice(0, 40),
      user: user?.id ?? null,
    });
    return summary(q.one.get(String(game)));
  }

  /** The signed recipe for a game, as players' apps get it: { recipe, signature }, or null. */
  function get(game) {
    checkGame(game);
    const row = q.get.get(String(game));
    return row ? { recipe: row.recipe, signature: row.signature, updatedAt: row.updated_at } : null;
  }

  return {
    attach,
    get,
    has: (game) => Boolean(q.get.get(String(game))),
    remove: (game) => {
      checkGame(game);
      return q.remove.run(String(game)).changes > 0;
    },
    list: () => q.list.all().map(summary),
    /** The engines and tools GameShelf knows (custom_engines.json), for the Admin Panel. */
    registry: () => registry,
  };
}

module.exports = { createEngineRecipes, RecipeError, MAX_RECIPE_BYTES, readRegistry };
