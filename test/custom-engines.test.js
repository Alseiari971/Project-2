// Engines beyond the big five, in the app: Bethesda's Creation Engine, games
// whose text is in readable files (replaced, with the originals kept and put
// back), and packed engines built with an admin-signed engine recipe; the game
// folder fingerprint sent with requests; the server keeping signed recipes; and
// the whole recipe flow, from a request the player's PC can't make to the
// Arabic built natively after an admin attaches the game's recipe.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writePack } = require('../desktop/localization/pack');
const { fingerprint } = require('../desktop/localization/engine');
const { preflight, createLocalization } = require('../desktop/localization/index');
const { checkRecipe, recipeTemplate, createRecipes } = require('../desktop/localization/recipes');
const { directoryFingerprint } = require('../desktop/localization/dirprint');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createTranslationMemory } = require('../src/translation-memory');
const { createArabicGames, cleanFingerprint } = require('../src/arabic-games');
const { createSubmissions } = require('../src/submissions');
const { createEngineRecipes } = require('../src/engine-recipes');
const { createCloudClient } = require('../desktop/cloud');
const { createArabicOnline } = require('../desktop/localization/online');
const { createArabicService } = require('../desktop/localization/service');
const { createPackBuilder, findBuilder, localPackKey } = require('../desktop/localization/builder');
const { createArabicRequests, NEEDS_RECIPE } = require('../desktop/localization/requests');
const { createStudio } = require('../desktop/localization/studio');

const REPO = path.join(__dirname, '..');
const keys = crypto.generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' });
const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import arabic_reshaper, bidi'], { stdio: 'ignore' }).status === 0);
const sign = (text) => crypto.sign(null, Buffer.from(text, 'utf8'), keys.privateKey).toString('base64');

async function tree(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-engines-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, ...name.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content ?? 'x');
  }
  return root;
}

async function makePack(engine, files, details = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-pack-'));
  for (const [target, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, 'payload', target)), { recursive: true });
    await fs.writeFile(path.join(dir, 'payload', target), content);
  }
  const list = Object.keys(files).map((target) => ({ source: `payload/${target}`, target }));
  await writePack(dir, { id: `test-${engine}`, version: '1.0.0', engine, files: list, privateKey: keys.privateKey, ...details });
  return dir;
}

// ---- Pack rules ----------------------------------------------------------------

test('Bethesda, loose-file and recipe packs hold only what their engine allows', async () => {
  await makePack('bethesda', {
    'Data/Strings/skyrim_english.strings': 'a', 'Data/Strings/Update_English.DLSTRINGS': 'b', 'Data/Interface/fontconfig.txt': 'c',
    'Data/Interface/gameshelf_arabic.swf': 'd', 'Data/Interface/GameShelf/FONT-LICENSE-OFL.txt': 'e',
  });
  const bad = (engine, target) => makePack(engine, { [target]: 'x' });
  await assert.rejects(bad('bethesda', 'Data/Skyrim.esm'), /Bethesda packs may only add/);
  await assert.rejects(bad('bethesda', 'Data/Interface/fonts_en.swf'), /Bethesda packs may only add/);
  await assert.rejects(bad('bethesda', 'SkyrimSE.exe'), /Bethesda packs may only add/);

  await makePack('loose', { 'data/lang/en.json': '{}', 'Localization/English.xml': '<a/>', 'fonts/Body.ttf': 'f', 'gameshelf_arabic/FONT-LICENSE-OFL.txt': 'l' });
  await assert.rejects(bad('loose', 'Game.exe'), /can't put programs/);
  await assert.rejects(bad('loose', 'plugins/x.dll'), /can't put programs/);
  await assert.rejects(bad('loose', 'textures/menu.png'), /only hold text, data and font files/);
  await assert.rejects(bad('loose', '../outside.json'), /plain path/);

  await makePack('custom', { 'exec/wad/pc_le/r_english.wad': 'w', 'archive/pc/mod/arabic.archive': 'a' });
  for (const target of ['bin/x64/Game.exe', 'scripts/run.bat', 'boot.ps1', 'mods/loader.py', 'lib/engine.so']) {
    await assert.rejects(bad('custom', target), /can't put programs/, target);
  }
});

// ---- Finding the engine -----------------------------------------------------------

test('Bethesda games are found by their Data folder; older editions and packed engines get a recipe tier', async () => {
  const skyrim = await tree({ 'SkyrimSE.exe': 'MZ', 'Data/Skyrim.esm': 'TES4', 'Data/Skyrim - Interface.bsa': 'BSA', 'Data/Strings/x_english.strings': 's' });
  const found = await fingerprint(skyrim);
  assert.equal(found.engine, 'bethesda');
  assert.equal(found.bethesda.game, 'Skyrim Special Edition');
  assert.equal(found.bethesda.looseStrings, true);
  assert.equal((await preflight(skyrim)).tier, 'bethesda-strings');
  const starfield = await tree({ 'Starfield.exe': 'MZ', 'Data/Starfield.esm': 'x', 'Data/Starfield - Localization.ba2': 'x' });
  assert.equal((await fingerprint(starfield)).engine, 'bethesda');

  // Skyrim 2011 can't show UTF-8 text: no string tables tier, but an admin can still write it a recipe.
  const legacy = await fingerprint(await tree({ 'TESV.exe': 'MZ', 'Data/Skyrim.esm': 'x', 'Data/Skyrim - Interface.bsa': 'x' }));
  assert.equal(legacy.engine, 'custom');
  assert.equal(legacy.custom.family.id, 'bethesda-creation');

  const gow = await tree({ 'GoW.exe': 'MZ', 'exec/wad/pc_le/r_english.wad': 'w', 'exec/wad/pc_le/r_ui.wad': 'w', 'localization/readme_en.txt': 'Hello there' });
  const gowCheck = await preflight(gow);
  assert.equal(gowCheck.engine.custom.family.id, 'santa-monica');
  // Known to pack its text: the recipe tier, even with a stray text file around.
  assert.equal(gowCheck.tier, 'recipe');
  assert.equal(gowCheck.fileChanges, true);
  assert.equal((await fingerprint(await tree({ 'Game.exe': 'MZ', 'archive/pc/content/basegame_4_gamedata.archive': 'a' }))).custom.family.id, 'redengine4');
  assert.equal((await fingerprint(await tree({ 'Game.exe': 'MZ', 'data/game.psarc': 'a' }))).custom.family.id, 'psarc');
});

test('custom engines with readable text files get the loose-file tier', async () => {
  const game = await tree({ 'Game.exe': 'MZ', 'data/lang/en.json': '{}', 'data/lang/fr.json': '{}', 'Localization/subtitles_en.csv': 'a', 'saves/en.json': '{}' });
  const found = await fingerprint(game);
  assert.equal(found.engine, 'custom');
  assert.equal(found.custom.family, null);
  assert.deepEqual(found.custom.looseText.sort(), ['Localization/subtitles_en.csv', 'data/lang/en.json', 'data/lang/fr.json']);
  assert.equal((await preflight(game)).tier, 'loose-files');
});

// ---- Replacing a game's own files ---------------------------------------------------------

test('a loose-file pack replaces the game\'s text and fonts, and turning it off puts the originals back', async (t) => {
  const game = await tree({ 'Game.exe': 'MZ', 'data/lang/en.json': '{"start":"Start"}', 'fonts/Body.ttf': 'game font' });
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-state-'));
  t.after(() => Promise.all([game, data].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const pack = await makePack('loose', { 'data/lang/en.json': '{"start":"ابدأ"}', 'fonts/Body.ttf': 'arabic font', 'gameshelf_arabic/FONT-LICENSE-OFL.txt': 'OFL' });
  const localization = createLocalization({ dataDir: data });
  const on = await localization.enable({ root: game, packDir: pack, publicKey: PUBLIC });
  assert.equal(on.tier, 'loose-files');
  assert.equal(await fs.readFile(path.join(game, 'data/lang/en.json'), 'utf8'), '{"start":"ابدأ"}');
  assert.equal(await fs.readFile(path.join(game, 'fonts/Body.ttf'), 'utf8'), 'arabic font');
  assert.equal(await fs.readFile(path.join(game, 'gameshelf_arabic/FONT-LICENSE-OFL.txt'), 'utf8'), 'OFL');
  const off = await localization.disable({ root: game });
  assert.deepEqual(off.kept, []);
  assert.equal(await fs.readFile(path.join(game, 'data/lang/en.json'), 'utf8'), '{"start":"Start"}');
  assert.equal(await fs.readFile(path.join(game, 'fonts/Body.ttf'), 'utf8'), 'game font');
  assert.equal(await fs.stat(path.join(game, 'gameshelf_arabic')).catch(() => null), null);
});

test('a Bethesda pack adds string tables over the archives and keeps a loose table or fontconfig that was there', async (t) => {
  const game = await tree({ 'SkyrimSE.exe': 'MZ', 'Data/Skyrim.esm': 'x', 'Data/Skyrim - Interface.bsa': 'x', 'Data/Interface/fontconfig.txt': 'a mod\'s fonts' });
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-state-'));
  t.after(() => Promise.all([game, data].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const pack = await makePack('bethesda', {
    'Data/Strings/skyrim_english.strings': 'arabic table', 'Data/Interface/fontconfig.txt': 'arabic fonts', 'Data/Interface/gameshelf_arabic.swf': 'swf',
  });
  const localization = createLocalization({ dataDir: data });
  assert.equal((await localization.enable({ root: game, packDir: pack, publicKey: PUBLIC })).tier, 'bethesda-strings');
  assert.equal(await fs.readFile(path.join(game, 'Data/Strings/skyrim_english.strings'), 'utf8'), 'arabic table');
  assert.equal(await fs.readFile(path.join(game, 'Data/Interface/fontconfig.txt'), 'utf8'), 'arabic fonts');
  await localization.disable({ root: game });
  assert.equal(await fs.stat(path.join(game, 'Data/Strings')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(game, 'Data/Interface/gameshelf_arabic.swf')).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(game, 'Data/Interface/fontconfig.txt'), 'utf8'), 'a mod\'s fonts');
});

test('a pack for another kind of engine is refused', async (t) => {
  const game = await tree({ 'Game.exe': 'MZ', 'data/lang/en.json': '{}' });
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-state-'));
  t.after(() => Promise.all([game, data].map((d) => fs.rm(d, { recursive: true, force: true }))));
  const pack = await makePack('custom', { 'data/lang/en.json': '{}' });
  await assert.rejects(createLocalization({ dataDir: data }).enable({ root: game, packDir: pack, publicKey: PUBLIC }), /custom-engine games, and this game uses loose-file/);
});

// ---- Recipes ----------------------------------------------------------------------

test('recipes are checked like the pack builder checks them', () => {
  const recipe = recipeTemplate('steam:1593500', 'santa-monica');
  assert.equal(checkRecipe(recipe, 'steam:1593500'), recipe);
  assert.match(recipe.extract[0].join(' '), /\{game\}\/path\/to\/text\.wad/);
  const bad = (change, message) => assert.throws(() => checkRecipe({ ...recipeTemplate('steam:1'), ...change }, 'steam:1'), message);
  assert.throws(() => checkRecipe(recipe, 'steam:2'), /another game/);
  bad({ tool: 'cmd' }, /isn't one GameShelf allows/);
  bad({ extract: [['-o', 'C:/Windows/notepad.exe']] }, /start with a placeholder/);
  bad({ extract: [['{extracted}/../../x']] }, /plain path/);
  bad({ repack: [['{game}/x.wad']] }, /can't be used in repack/);
  bad({ copy: [{ from: '{game}/a', to: '{game}/b' }] }, /can't be used in copy/);
  bad({ stage: [{ from: '{work}/x', to: 'bin/Game.exe' }] }, /programs or scripts/);
  bad({ stage: [{ from: '{work}/x', to: '../escape.wad' }] }, /plain path/);
  bad({ text: [{ glob: '../**/*.json', format: 'json' }] }, /inside the extracted files/);
  bad({ text: [{ glob: '**/*', format: 'exe' }] }, /glob and a format/);
  bad({ format: 2 }, /format/);
});

test('the app uses a recipe only when GameShelf\'s key signed it, for that game', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-recipes-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const text = JSON.stringify(recipeTemplate('steam:42'));
  let answer;
  const cloud = { json: async (route) => answer(route) };
  const recipes = createRecipes({ cloud, cacheDir: dir, publicKeys: [PUBLIC] });
  answer = () => {
    throw Object.assign(new Error('none'), { status: 404 });
  };
  assert.equal(await recipes.forGame('steam:42'), null);
  answer = (route) => {
    assert.equal(route, '/api/arabic/recipes/steam%3A42');
    return { recipe: text, signature: sign(text) };
  };
  const got = await recipes.forGame('steam:42');
  assert.deepEqual(got.recipe, JSON.parse(text));
  assert.deepEqual(JSON.parse(await fs.readFile(got.file, 'utf8')), { recipe: text, signature: sign(text) });
  const other = crypto.generateKeyPairSync('ed25519');
  answer = () => ({ recipe: text, signature: crypto.sign(null, Buffer.from(text), other.privateKey).toString('base64') });
  await assert.rejects(recipes.forGame('steam:42'), /isn't signed with GameShelf's key/);
  answer = () => ({ recipe: text, signature: sign(text) });
  await assert.rejects(recipes.forGame('steam:43'), /another game/);
});

test('a game folder\'s fingerprint holds names, kinds and sizes, and nothing of this PC', async (t) => {
  const game = await tree({ 'GoW.exe': 'MZMZ', 'exec/wad/pc_le/r_english.wad': '0123456789', 'exec/wad/pc_le/r_ui.wad': '01234', 'exec/settings.ini': 'a=1' });
  t.after(() => fs.rm(game, { recursive: true, force: true }));
  const print = await directoryFingerprint(game, { engine: { id: 'santa-monica', name: 'God of War' } });
  assert.deepEqual(print.top, { folders: ['exec'], files: ['GoW.exe'] });
  assert.deepEqual(print.folders, ['exec/', 'exec/wad/', 'exec/wad/pc_le/']);
  assert.deepEqual(print.extensions[0], { ext: '.wad', count: 2, bytes: 15 });
  assert.equal(print.files, 4);
  assert.equal(print.engine.id, 'santa-monica');
  assert.ok(!JSON.stringify(print).includes(path.basename(game)), 'no path of this PC');
  // The server keeps only the known fields, at their sizes.
  const cleaned = cleanFingerprint({ ...print, extra: 'dropped', top: { folders: ['x'.repeat(500)], files: [] }, extensions: [{ ext: '.wad', count: -3, bytes: 'a lot' }] });
  assert.equal(cleaned.extra, undefined);
  assert.equal(cleaned.top.folders[0].length, 160);
  assert.deepEqual(cleaned.extensions, [{ ext: '.wad', count: 0, bytes: 0 }]);
  assert.equal(cleanFingerprint('nope'), null);
});

// ---- The server -------------------------------------------------------------------

async function startServer(t, tmp, { memory = (db) => createTranslationMemory({ db, env: {} }) } = {}) {
  const saved = process.env.ADMIN_USERS;
  process.env.ADMIN_USERS = 'hamad';
  t.after(() => {
    if (saved === undefined) delete process.env.ADMIN_USERS;
    else process.env.ADMIN_USERS = saved;
  });
  const db = openDatabase(':memory:');
  const translations = memory(db);
  const server = createApp({
    db, games: createLocalProvider(), translations, dataDir: tmp, arabicGames: createArabicGames({ db, translations }),
    submissions: createSubmissions({ db, translations, publicKeys: [PUBLIC] }), recipes: createEngineRecipes({ db, publicKeys: [PUBLIC] }),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const signUp = async (username) => {
    const res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'correct horse', email: `${username}@test.example`, nationality: 'AE' }) });
    return createCloudClient({ server: () => base, session: async () => /gs_session=([^;]+)/.exec(res.headers.get('set-cookie'))[1] });
  };
  return { base, db, signUp };
}

test('the server keeps signed recipes per game, for admins to attach and players to fetch', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-recipes-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const { signUp } = await startServer(t, tmp);
  const admin = await signUp('hamad');
  const player = await signUp('alice');
  const text = JSON.stringify(recipeTemplate('steam:1593500', 'santa-monica'));
  const put = (cloud, game, body) => cloud.json(`/api/admin/recipes/${encodeURIComponent(game)}`, { method: 'PUT', body });

  await assert.rejects(player.json('/api/arabic/recipes/steam%3A1593500'), (err) => err.status === 404);
  await assert.rejects(put(player, 'steam:1593500', { recipe: text, signature: sign(text) }), (err) => err.status === 403);
  await assert.rejects(put(admin, 'steam:1593500', { recipe: text, signature: sign('something else') }), /isn't signed with GameShelf's pack key/);
  await assert.rejects(put(admin, 'steam:7', { recipe: text, signature: sign(text) }), /for another game/);
  const attached = await put(admin, 'steam:1593500', { recipe: text, signature: sign(text) });
  assert.deepEqual([attached.recipe.game, attached.recipe.engine, attached.recipe.tool, attached.recipe.attachedBy], ['steam:1593500', 'santa-monica', 'quickbms', 'hamad']);
  assert.deepEqual(await player.json('/api/arabic/recipes/steam%3A1593500').then(({ recipe, signature }) => ({ recipe, signature })), { recipe: text, signature: sign(text) });
  const status = await player.json('/api/arabic/status', { method: 'POST', body: { games: ['steam:1593500'] } });
  assert.equal(status.games['steam:1593500'].recipe, true);
  assert.deepEqual((await admin.json('/api/admin/recipes')).recipes.map((r) => r.game), ['steam:1593500']);
  assert.ok((await admin.json('/api/admin/engines')).recipes.some((r) => r.id === 'santa-monica'));
  assert.deepEqual(await admin.json('/api/admin/recipes/steam%3A1593500', { method: 'DELETE' }), { removed: true });
  await assert.rejects(player.json('/api/arabic/recipes/steam%3A1593500'), (err) => err.status === 404);
});

// ---- The whole recipe flow ------------------------------------------------------------

// A stand-in for QuickBMS (named as the allowlist names it): "x <archive> <folder>"
// takes a zip apart, "r <archive> <folder>" puts a folder's files back in.
const FAKE_QUICKBMS = `#!/usr/bin/env python3
import os, sys, zipfile
command, archive, folder = sys.argv[1:4]
if command == 'x':
    zipfile.ZipFile(archive).extractall(folder)
elif command == 'r':
    with zipfile.ZipFile(archive) as z:
        items = {name: z.read(name) for name in z.namelist()}
    for root, _, files in os.walk(folder):
        for name in files:
            full = os.path.join(root, name)
            items[os.path.relpath(full, folder).replace(os.sep, '/')] = open(full, 'rb').read()
    with zipfile.ZipFile(archive, 'w') as z:
        for name, data in items.items():
            z.writestr(name, data)
`;

function zipOf(files) {
  const result = spawnSync(python, ['-c', `
import io, json, sys, zipfile
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w') as z:
    for name, text in json.load(sys.stdin).items():
        z.writestr(name, text)
sys.stdout.buffer.write(buffer.getvalue())`], { input: JSON.stringify(files) });
  return result.stdout;
}

function unzip(file, name) {
  return spawnSync(python, ['-c', 'import sys, zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())', file, name], { encoding: 'utf8' }).stdout;
}

test('a packed game: request with its folder\'s fingerprint, admin attaches a signed recipe, the player\'s app makes it natively',
  { skip: (!python && 'the pack builder needs Python with its requirements') || (process.platform === 'win32' && 'the stand-in tool is a script') }, async (t) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-recipe-flow-'));
    t.after(() => fs.rm(tmp, { recursive: true, force: true }));
    const fetchAi = async (_url, init) => {
      const user = JSON.parse(init.body).messages[1].content;
      const translations = JSON.parse(user.slice(user.indexOf('['))).map(({ id, text }) => ({ id, arabic: `عربي ${text}` }));
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }) };
    };
    const { base, signUp } = await startServer(t, tmp, { memory: (db) => createTranslationMemory({ db, env: { OPENAI_API_KEY: 'server-key' }, fetch: fetchAi }) });

    // The game: God of War's layout, its English packed in a .wad (a zip, for the stand-in tool).
    const gameDir = path.join(tmp, 'God of War');
    const wad = path.join(gameDir, 'exec', 'wad', 'pc_le', 'r_english.wad');
    await fs.mkdir(path.dirname(wad), { recursive: true });
    await fs.writeFile(path.join(gameDir, 'GoW.exe'), 'MZ');
    const original = zipOf({ 'text/en/subtitles.json': JSON.stringify({ s1: 'Do not be sorry. Be better.', s2: 'We go together, boy.', s3: 'Close your heart to it.' }) });
    await fs.writeFile(wad, original);
    const tools = path.join(tmp, 'tools');
    await fs.mkdir(path.join(tools, 'quickbms'), { recursive: true });
    await fs.writeFile(path.join(tools, 'quickbms', 'quickbms.exe'), FAKE_QUICKBMS, { mode: 0o755 });

    // The player's app.
    const player = await signUp('alice');
    const online = createArabicOnline({ cloud: player, cacheDir: path.join(tmp, 'dl'), publicKeys: [PUBLIC] });
    const localKey = localPackKey(path.join(tmp, 'player'));
    const packBuilder = createPackBuilder({
      paths: { ...findBuilder({ packaged: false, repoDir: REPO, env: { GAMESHELF_PYTHON: python, GAMESHELF_TOOLS: tools } }), msgTool: null },
      outDir: path.join(tmp, 'builds'), keyFile: localKey.keyFile,
    });
    const recipes = createRecipes({ cloud: player, cacheDir: path.join(tmp, 'recipes'), publicKeys: [PUBLIC] });
    const arabic = createArabicService({
      dataDir: path.join(tmp, 'player'), publicKey: [PUBLIC, localKey.publicKey], overlayAvailable: false, catalog: online.catalog,
      builder: { canBuild: (tier, engine) => packBuilder.canBuild(tier, engine), fromSet: async () => null },
    });
    const requests = createArabicRequests({
      arabic, packBuilder, online, recipes, server: () => base, overlayAvailable: false,
      fingerprint: (game, info) => directoryFingerprint(game.dir, { engine: info?.engineInfo || null }),
    });
    const game = { key: 'steam:1593500', dir: gameDir, steamAppId: 1593500, gameId: null, title: 'God of War' };

    // 1. No recipe yet: the request goes to the admins, with why and what's in the folder.
    const first = await requests.run(game, { consent: true });
    assert.equal(first.requested, true);
    assert.equal(first.reason, NEEDS_RECIPE);
    const admin = await signUp('hamad');
    const [request] = (await admin.json('/api/admin/requests')).requests;
    assert.equal(request.reason, NEEDS_RECIPE);
    assert.equal(request.fingerprint.engine.id, 'santa-monica');
    assert.ok(request.fingerprint.folders.includes('exec/wad/pc_le/'));
    assert.equal(request.fingerprint.extensions[0].ext, '.wad');

    // 2. The admin writes the recipe in the Admin Panel; their app checks and signs it.
    const keyFile = path.join(tmp, 'admin', 'pack-signing.key');
    await fs.mkdir(path.dirname(keyFile), { recursive: true });
    await fs.writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const studio = createStudio({ paths: findBuilder({ packaged: false, repoDir: REPO, env: {} }), dataDir: path.join(tmp, 'admin'), cloud: admin, appKeys: [PUBLIC] });
    studio.saveSettings({ keyFile });
    const recipe = {
      format: 1, game: { steamAppId: 1593500 }, engine: 'santa-monica', tool: 'quickbms',
      extract: [['x', '{game}/exec/wad/pc_le/r_english.wad', '{extracted}']],
      text: [{ glob: 'text/en/*.json', format: 'json' }],
      copy: [{ from: '{game}/exec/wad/pc_le/r_english.wad', to: '{work}/repack/r_english.wad' }],
      repack: [['r', '{work}/repack/r_english.wad', '{edited}']],
      stage: [{ from: '{work}/repack/r_english.wad', to: 'exec/wad/pc_le/r_english.wad' }],
    };
    await assert.rejects(studio.attachRecipe('steam:1593500', JSON.stringify({ ...recipe, tool: 'cmd' })), /isn't one GameShelf allows/);
    await studio.attachRecipe('steam:1593500', JSON.stringify(recipe, null, 2));
    assert.equal((await online.status('steam:1593500')).recipe, true);

    // 3. The same button now makes it on the player's PC, with the recipe, natively.
    const second = await requests.run(game, { consent: true });
    assert.equal(second.done, true, JSON.stringify(second.error || second));
    assert.equal((await fs.readFile(wad)).equals(original), true, 'the game is changed only when it starts');
    const launch = await arabic.prepareLaunch(game);
    assert.deepEqual([launch.mode, launch.ok], ['native', true], JSON.stringify(launch.error));
    const subtitles = JSON.parse(unzip(wad, 'text/en/subtitles.json'));
    assert.ok(Object.values(subtitles).every((line) => /[\uFE70-\uFEFF]/.test(line)), JSON.stringify(subtitles));
    // Sent for review like any other game's Arabic.
    assert.equal(second.submitted?.total, 3);

    // 4. Turning Arabic off puts the game's own archive back, byte for byte.
    const off = await arabic.set(game, false);
    assert.equal(off.error, null);
    assert.equal((await fs.readFile(wad)).equals(original), true);
  });
