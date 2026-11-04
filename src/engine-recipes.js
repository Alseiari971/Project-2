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
// An Unreal game's key recipe holds the game's AES-256 key and nothing else that
// runs (the same rules as desktop/localization/recipes.js and recipes.py).
const AES_KEY = /^0x[0-9a-fA-F]{64}$/;
const KEY_RECIPE_FIELDS = new Set(['format', 'game', 'engine', 'aesKey', 'note']);
const CONTAINERS = new Set(['', 'iostore', 'pak']);
// Requests a recipe answers: players' apps said the game is encrypted, or needs a recipe.
const ANSWERS = { key: '%encrypt%', recipe: '%recipe%' };
/** "0x4BC8…E01D": enough to tell keys apart, never the whole key. */
const maskKey = (key) => (AES_KEY.test(String(key || '')) ? `${key.slice(0, 6)}…${key.slice(-4)}` : null);
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
    put: db.prepare(`INSERT INTO engine_recipes (game, recipe, signature, engine, tool, attached_by, title, container)
      VALUES (@game, @recipe, @signature, @engine, @tool, @user, @title, @container)
      ON CONFLICT (game) DO UPDATE SET recipe = excluded.recipe, signature = excluded.signature, engine = excluded.engine,
        tool = excluded.tool, attached_by = excluded.attached_by, updated_at = datetime('now'),
        title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END, container = excluded.container`),
    remove: db.prepare('DELETE FROM engine_recipes WHERE game = ?'),
    list: db.prepare(`SELECT r.*, u.username AS attached_by_name,
        (SELECT MAX(q.name) FROM arabic_requests q WHERE q.game = r.game) AS asked_name,
        (SELECT COUNT(*) FROM arabic_requests q WHERE q.game = r.game AND q.ready_kind <> '') AS answered
      FROM engine_recipes r LEFT JOIN users u ON u.id = r.attached_by ORDER BY r.updated_at DESC`),
    one: db.prepare(`SELECT r.*, u.username AS attached_by_name,
        (SELECT MAX(q.name) FROM arabic_requests q WHERE q.game = r.game) AS asked_name,
        (SELECT COUNT(*) FROM arabic_requests q WHERE q.game = r.game AND q.ready_kind <> '') AS answered
      FROM engine_recipes r LEFT JOIN users u ON u.id = r.attached_by WHERE r.game = ?`),
    waiting: db.prepare("SELECT asker FROM arabic_requests WHERE game = ? AND ready_kind = '' AND reason LIKE ?"),
    answer: db.prepare("UPDATE arabic_requests SET ready_kind = ?, ready_at = datetime('now') WHERE game = ? AND ready_kind = '' AND reason LIKE ?"),
    unanswer: db.prepare("UPDATE arabic_requests SET ready_kind = '', ready_at = '' WHERE game = ?"),
  };
  const registry = readRegistry(registryFile);

  function checkGame(game) {
    if (!GAME_RE.test(String(game))) throw new RecipeError('The game should be "steam:<app id>" or "game:<GameShelf id>".');
  }

  const signedWithOurKey = (text, signature) => publicKeys.some((key) => {
    try {
      return crypto.verify(null, Buffer.from(String(text), 'utf8'), key, Buffer.from(String(signature || ''), 'base64'));
    } catch {
      return false;
    }
  });

  const summary = (row) => {
    let recipe = null;
    try {
      recipe = JSON.parse(row.recipe);
    } catch {}
    return {
      game: row.game,
      title: row.title || row.asked_name || '',
      engine: row.engine,
      tool: row.tool,
      container: row.container || '',
      maskedKey: maskKey(recipe?.aesKey),
      note: typeof recipe?.note === 'string' ? recipe.note : '',
      // Checked again now, against the pack keys this server has today.
      verified: signedWithOurKey(row.recipe, row.signature),
      requestsAnswered: row.answered ?? 0,
      updatedAt: row.updated_at,
      attachedBy: row.attached_by_name ?? null,
    };
  };

  /** Checks an Unreal key recipe: the key in the right form, and nothing else. */
  function checkKeyRecipe(parsed) {
    const extra = Object.keys(parsed).filter((k) => !KEY_RECIPE_FIELDS.has(k));
    if (extra.length) throw new RecipeError(`An Unreal key recipe holds only the game's key ("aesKey"), not ${extra.map((k) => `"${k}"`).join(', ')}.`);
    if (typeof parsed.aesKey !== 'string' || !AES_KEY.test(parsed.aesKey)) throw new RecipeError('"aesKey" must be "0x" and 64 hex digits.');
    if (parsed.note !== undefined && (typeof parsed.note !== 'string' || parsed.note.length > 500)) throw new RecipeError('"note" must be short text.');
  }

  /** Keeps a signed recipe for a game (admins). Returns its summary. */
  function attach(game, { recipe, signature, title = '', container = '' } = {}, user = null) {
    checkGame(game);
    const text = String(recipe || '');
    if (!text || Buffer.byteLength(text) > MAX_RECIPE_BYTES) throw new RecipeError('Send the recipe (up to 256 KB) and its signature.');
    if (!publicKeys.length) throw new RecipeError('No pack signing key is set up on the server.', 503);
    if (!signedWithOurKey(text, signature)) throw new RecipeError('The recipe isn\'t signed with GameShelf\'s pack key. Pick GameShelf\'s pack-signing.key in the Pack Studio.');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RecipeError('That isn\'t an engine recipe.');
    }
    const [kind, id] = String(game).split(':');
    const same = kind === 'steam' ? parsed?.game?.steamAppId === Number(id) : parsed?.game?.gameId === id;
    if (parsed?.format !== 1 || !same) throw new RecipeError('That recipe is for another game.');
    if (typeof parsed.engine !== 'string' || !/^[\w-]{1,60}$/.test(parsed.engine)) throw new RecipeError('The recipe must name its engine ("engine").');
    if (parsed.engine === 'unreal') checkKeyRecipe(parsed);
    if (parsed.tool !== undefined && !registry.tools?.[parsed.tool]) throw new RecipeError(`"${parsed.tool}" isn't a tool GameShelf allows.`);
    if (!CONTAINERS.has(String(container))) throw new RecipeError('The container is "iostore" (UE5 .utoc/.ucas) or "pak" (UE4 .pak).');
    q.put.run({
      game: String(game),
      recipe: text,
      signature: String(signature),
      engine: String(parsed.engine || '').slice(0, 60),
      tool: String(parsed.tool || '').slice(0, 40),
      user: user?.id ?? null,
      title: String(title || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200),
      container: parsed.engine === 'unreal' ? String(container) : '',
    });
    return summary(q.one.get(String(game)));
  }

  /**
   * Requests the game's recipe answers become ready: an Unreal key answers the
   * players' apps that found the game encrypted, another recipe those that needed
   * one. Returns the askers ("user:<id>") who hadn't heard yet.
   */
  function answerRequests(game) {
    checkGame(game);
    const row = q.get.get(String(game));
    if (!row) return [];
    const kind = row.engine === 'unreal' ? 'key' : 'recipe';
    const askers = q.waiting.all(String(game), ANSWERS[kind]).map((r) => r.asker);
    q.answer.run(kind, String(game), ANSWERS[kind]);
    return askers;
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
    answerRequests,
    remove: (game) => {
      checkGame(game);
      const removed = q.remove.run(String(game)).changes > 0;
      // Revoked: the requests it answered are waiting again.
      if (removed) q.unanswer.run(String(game));
      return removed;
    },
    list: () => q.list.all().map(summary),
    one: (game) => {
      const row = q.one.get(String(game));
      return row ? summary(row) : null;
    },
    /** GameShelf's pack public keys, as raw Ed25519 keys in base64, for admins' browsers to check their signer against. */
    publicKeys: () => publicKeys.map((key) => {
      try {
        const der = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
        return der.subarray(der.length - 32).toString('base64');
      } catch {
        return null;
      }
    }).filter(Boolean),
    /** The engines and tools GameShelf knows (custom_engines.json), for the Admin Panel. */
    registry: () => registry,
  };
}

module.exports = { createEngineRecipes, RecipeError, MAX_RECIPE_BYTES, readRegistry, maskKey, AES_KEY };
