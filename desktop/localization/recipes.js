// Engine recipes in the app: for games whose text is packed in archives
// GameShelf has no reader of its own for (God of War's .wad, REDengine...).
//
// An admin writes a game's recipe in the Admin Panel; their desktop app checks
// it (checkRecipe, the same rules as the pack builder's recipes.py) and signs
// it with GameShelf's pack key (studio.js); GameShelf's server keeps it per game.
// Each player's app fetches it, checks the signature against GameShelf's key
// (never this PC's own key), and hands it to the pack builder, which runs the
// recipe's allowlisted tool from the app's own tools folder.
//
// The recipe format is described in localization/arabic_compiler/recipes.py.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const registry = require('../../localization/custom_engines.json');
const { EXECUTABLE } = require('./pack');

const MAX_RECIPE_BYTES = 256 * 1024;
const MAX_STEPS = 16;
const MAX_ARGS = 64;
const PLACEHOLDER = /\{(game|work|script|extracted|edited|out|font_bold|font)\}/g;
const FONT_PLACES = new Set(['font', 'font_bold']);
const ALLOWED = {
  extract: new Set(['game', 'work', 'script', 'extracted', 'out']),
  repack: new Set(['work', 'script', 'extracted', 'edited', 'out', 'font', 'font_bold']),
  'copy.from': new Set(['game', 'work', 'extracted', 'edited', 'out', 'font', 'font_bold']),
  'copy.to': new Set(['work', 'out']),
  'stage.from': new Set(['work', 'extracted', 'edited', 'out', 'font', 'font_bold']),
};
const TEXT_FORMATS = new Set(['json', 'csv', 'tsv', 'xml', 'po', 'mo', 'lines', 'txt', 'ini', 'bethesda-strings']);

class RecipeError extends Error {
  constructor(message) {
    super(message);
    this.code = 'recipe';
  }
}

function safeRelative(value, what) {
  if (typeof value !== 'string' || !value || value.length > 260 || /^[\\/]/.test(value) || /^[a-z]:/i.test(value)) {
    throw new RecipeError(`${what} "${value}" must be a path inside the game's folder.`);
  }
  const parts = value.split(/[\\/]/);
  if (parts.some((p) => !p || p === '.' || p === '..' || /[:*?"<>|\x00-\x1f]/.test(p) || /[ .]$/.test(p))) {
    throw new RecipeError(`${what} "${value}" isn't a plain path.`);
  }
  return parts;
}

function checkArg(arg, phase) {
  if (typeof arg !== 'string' || arg.length > 1024 || /[\x00\n]/.test(arg)) throw new RecipeError('A recipe step has an argument that isn\'t a short line of text.');
  const used = [...arg.matchAll(PLACEHOLDER)].map((m) => m[1]);
  if (used.length) {
    if (used.length > 1 || !arg.startsWith('{')) throw new RecipeError(`"${arg}": a path starts with one placeholder.`);
    if (!ALLOWED[phase].has(used[0])) throw new RecipeError(`"${arg}": {${used[0]}} can't be used in ${phase.split('.')[0]}.`);
    const rest = arg.replace(PLACEHOLDER, '');
    if (rest && FONT_PLACES.has(used[0])) throw new RecipeError(`"${arg}": {${used[0]}} is a file, with nothing after it.`);
    if (rest && !/^[\\/]/.test(rest)) throw new RecipeError(`"${arg}": a path goes on from its placeholder with a slash.`);
    if (rest) safeRelative(rest.replace(/^[\\/]+/, ''), 'A path');
  } else if (/[\\/:]|\.\.|^[@<>|&]|\{/.test(arg)) {
    throw new RecipeError(`"${arg}": paths in recipes start with a placeholder ({game}, {work}...).`);
  }
}

/**
 * Checks a recipe (an object) for the game `key` ("steam:<id>" or "game:<id>"),
 * with the same rules as the pack builder (recipes.py, check_recipe). Returns it.
 */
function checkRecipe(recipe, key) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe) || recipe.format !== 1) throw new RecipeError('That isn\'t a GameShelf engine recipe ("format": 1).');
  if (JSON.stringify(recipe).length > MAX_RECIPE_BYTES) throw new RecipeError('The recipe is too big.');
  const { game } = recipe;
  if (!game || typeof game !== 'object' || !(Number.isInteger(game.steamAppId) || typeof game.gameId === 'string')) {
    throw new RecipeError('The recipe must say which game it\'s for ("game": {"steamAppId": ...}).');
  }
  if (key) {
    const [kind, id] = String(key).split(':');
    const same = kind === 'steam' ? game.steamAppId === Number(id) : game.gameId === id;
    if (!same) throw new RecipeError('The recipe is for another game.');
  }
  if (typeof recipe.engine !== 'string' || !/^[\w-]{1,60}$/.test(recipe.engine)) throw new RecipeError('The recipe must name its engine ("engine").');
  if ((recipe.extract?.length || recipe.repack?.length) && !registry.tools[recipe.tool]) {
    throw new RecipeError(`The recipe's tool "${recipe.tool}" isn't one GameShelf allows (${Object.keys(registry.tools).sort().join(', ')}).`);
  }
  if (recipe.script !== undefined && (typeof recipe.script !== 'string' || recipe.script.length > 200000)) throw new RecipeError('The recipe\'s script must be text.');
  for (const phase of ['extract', 'repack']) {
    const steps = recipe[phase] ?? [];
    if (!Array.isArray(steps) || steps.length > MAX_STEPS) throw new RecipeError(`"${phase}" must be a list of up to ${MAX_STEPS} steps.`);
    for (const step of steps) {
      if (!Array.isArray(step) || !step.length || step.length > MAX_ARGS) throw new RecipeError(`Each ${phase} step is a list of the tool's arguments.`);
      for (const arg of step) checkArg(arg, phase);
    }
  }
  if (!Array.isArray(recipe.text) || !recipe.text.length || recipe.text.length > 64) throw new RecipeError('The recipe must say which files hold the text ("text").');
  for (const item of recipe.text) {
    if (!item || !TEXT_FORMATS.has(item.format) || typeof item.glob !== 'string') throw new RecipeError(`Each "text" entry has a glob and a format (${[...TEXT_FORMATS].join(', ')}).`);
    if (item.glob.includes('..') || /^[\\/]/.test(item.glob) || item.glob.includes(':')) throw new RecipeError(`"${item.glob}" must stay inside the extracted files.`);
  }
  for (const item of recipe.copy ?? []) {
    if (!item || typeof item !== 'object') throw new RecipeError('Each "copy" entry has "from" and "to".');
    checkArg(item.from, 'copy.from');
    checkArg(item.to, 'copy.to');
    if (!String(item.from).startsWith('{') || !String(item.to).startsWith('{')) throw new RecipeError('"copy" paths start with a placeholder.');
  }
  if (!Array.isArray(recipe.stage) || !recipe.stage.length || recipe.stage.length > 64) throw new RecipeError('The recipe must say what goes into the game ("stage").');
  for (const item of recipe.stage) {
    if (!item || typeof item !== 'object') throw new RecipeError('Each "stage" entry has "from" and "to".');
    checkArg(item.from, 'stage.from');
    if (!String(item.from).startsWith('{')) throw new RecipeError('"stage" sources start with a placeholder.');
    const parts = safeRelative(item.to, 'A stage target');
    if (EXECUTABLE.test(parts[parts.length - 1])) throw new RecipeError(`"${item.to}": recipes can't put programs or scripts into a game.`);
  }
  if (recipe.maxLine !== undefined && !(Number.isInteger(recipe.maxLine) && recipe.maxLine >= 8 && recipe.maxLine <= 10000)) {
    throw new RecipeError('maxLine must be a number from 8 to 10000.');
  }
  return recipe;
}

/** A starting point for an admin writing a game's recipe (Admin Panel), for the engine its folder looks like. */
function recipeTemplate(key, familyId = null) {
  const [kind, id] = String(key).split(':');
  const family = registry.recipes.find((r) => r.id === familyId);
  const archive = family?.archives?.[0] || '.pak';
  return {
    format: 1,
    game: kind === 'steam' ? { steamAppId: Number(id) } : { gameId: id },
    engine: family?.id || 'custom',
    tool: 'quickbms',
    script: '# The QuickBMS script for this game\'s archives (text, not a program).',
    extract: [['-o', '-f', '*.json', '{script}', `{game}/path/to/text${archive}`, '{extracted}']],
    text: [{ glob: '**/*.json', format: 'json' }],
    copy: [{ from: `{game}/path/to/text${archive}`, to: `{work}/repack/text${archive}` }],
    repack: [['-o', '-w', '-r', '{script}', `{work}/repack/text${archive}`, '{edited}']],
    stage: [{ from: `{work}/repack/text${archive}`, to: `path/to/text${archive}` }],
    shape: true,
  };
}

function verifies(text, signature, publicKeys) {
  const body = Buffer.from(String(text), 'utf8');
  return [].concat(publicKeys || []).filter(Boolean).some((key) => {
    try {
      return crypto.verify(null, body, key, Buffer.from(String(signature || ''), 'base64'));
    } catch {
      return false;
    }
  });
}

/**
 * The app's side: `cloud` is the GameShelf server client, `publicKeys` GameShelf's
 * pack keys (not this PC's own), `cacheDir` where checked recipes are kept for the builder.
 */
function createRecipes({ cloud, cacheDir, publicKeys = [] }) {
  return {
    /**
     * The signed recipe for a game (`key` as gameKey gives it), checked, as
     * { file, recipe } for the pack builder; null when GameShelf has none for it.
     */
    async forGame(key) {
      let got;
      try {
        got = await cloud.json(`/api/arabic/recipes/${encodeURIComponent(key)}`);
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
      if (!verifies(got?.recipe, got?.signature, publicKeys)) throw new RecipeError('The engine recipe from GameShelf isn\'t signed with GameShelf\'s key, so it wasn\'t used.');
      let recipe;
      try {
        recipe = JSON.parse(got.recipe);
      } catch {
        throw new RecipeError('The engine recipe from GameShelf isn\'t valid.');
      }
      checkRecipe(recipe, key);
      await fs.mkdir(cacheDir, { recursive: true });
      const file = path.join(cacheDir, `recipe-${key.replace(/[^\w.-]/g, '_')}.json`);
      await fs.writeFile(file, JSON.stringify({ recipe: got.recipe, signature: got.signature }));
      return { file, recipe };
    },
  };
}

module.exports = { createRecipes, checkRecipe, recipeTemplate, verifies, RecipeError, registry };
