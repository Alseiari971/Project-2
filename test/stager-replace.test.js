// Replacing a game's own localization file: the original is kept outside the
// game, and comes back exactly as it was when Arabic is turned off, when an
// add fails halfway, or after a crash.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStager } = require('../desktop/localization/stager');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-replace-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const game = path.join(dir, 'Game');
  await fs.mkdir(path.join(game, 'data', 'lang'), { recursive: true });
  await fs.writeFile(path.join(game, 'data', 'lang', 'en.json'), '{"start":"Start game"}');
  const stateDir = path.join(dir, 'state');
  return { dir, game, stateDir, stager: createStager({ stateDir }) };
}

const arabic = '{"start":"ابدأ اللعبة"}';
const pack = { id: 'test-ar', version: '1.0.0' };

test('a replaced file comes back exactly when Arabic is turned off', async (t) => {
  const { game, stateDir, stager } = await setup(t);
  const file = path.join(game, 'data', 'lang', 'en.json');
  const added = await stager.enable({ root: game, anchor: game, pack, files: [
    { target: 'data/lang/en.json', content: arabic, sha256: sha(arabic), replace: true },
    { target: 'data/fonts/arabic.ttf', content: 'font', sha256: sha('font') },
  ] });
  assert.equal(added.files, 2);
  assert.equal(await fs.readFile(file, 'utf8'), arabic);
  // The original sits outside the game folder.
  const backups = await fs.readdir(path.join(stateDir, 'backups'), { recursive: true });
  assert.ok(backups.some((name) => name.endsWith('en.json')));

  const off = await stager.disable(game);
  assert.deepEqual(off.kept, []);
  assert.equal(await fs.readFile(file, 'utf8'), '{"start":"Start game"}');
  assert.equal(await fs.lstat(path.join(game, 'data', 'fonts')).catch(() => null), null);
  assert.deepEqual((await fs.readdir(path.join(stateDir, 'backups'), { recursive: true })).filter((n) => n.endsWith('.json')), []);
});

test('a file that has to be replaced must be there; an add that fails halfway puts the original back', async (t) => {
  const { game, stager } = await setup(t);
  await assert.rejects(stager.enable({ root: game, anchor: game, pack, files: [
    { target: 'data/lang/fr.json', content: arabic, sha256: sha(arabic), replace: true },
  ] }), /isn't in the game/);

  // The second file's hash is wrong, so the add stops after the first file was already replaced.
  await assert.rejects(stager.enable({ root: game, anchor: game, pack, files: [
    { target: 'data/lang/en.json', content: arabic, sha256: sha(arabic), replace: true },
    { target: 'data/extra.txt', content: 'x', sha256: sha('something else') },
  ] }), /changed while it was being copied/);
  assert.equal(await fs.readFile(path.join(game, 'data', 'lang', 'en.json'), 'utf8'), '{"start":"Start game"}');
  assert.equal(await stager.status(game), null);
});

test('after a crash, the next start puts the original back', async (t) => {
  const { game, stateDir, stager } = await setup(t);
  await stager.enable({ root: game, anchor: game, pack, files: [{ target: 'data/lang/en.json', content: arabic, sha256: sha(arabic), replace: true }] });
  // As if GameShelf stopped before it could mark the add finished.
  const [record] = (await fs.readdir(stateDir)).filter((n) => n.endsWith('.json'));
  const state = JSON.parse(await fs.readFile(path.join(stateDir, record), 'utf8'));
  await fs.writeFile(path.join(stateDir, record), JSON.stringify({ ...state, status: 'staging' }));
  assert.equal(await createStager({ stateDir }).recover(), 1);
  assert.equal(await fs.readFile(path.join(game, 'data', 'lang', 'en.json'), 'utf8'), '{"start":"Start game"}');
});

test('a file the game changed since (an update) is left as it is, and the original copy is kept', async (t) => {
  const { game, stager } = await setup(t);
  const file = path.join(game, 'data', 'lang', 'en.json');
  await stager.enable({ root: game, anchor: game, pack, files: [{ target: 'data/lang/en.json', content: arabic, sha256: sha(arabic), replace: true }] });
  await fs.writeFile(file, '{"start":"Start game","new":"New line"}');
  const off = await stager.disable(game);
  assert.equal(off.kept.length, 1);
  assert.match(off.kept[0].why, /changed since GameShelf replaced it; GameShelf's copy of the original is at /);
  const backup = off.kept[0].why.split(' is at ')[1];
  assert.equal(await fs.readFile(backup, 'utf8'), '{"start":"Start game"}');
  assert.equal(await fs.readFile(file, 'utf8'), '{"start":"Start game","new":"New line"}');
});
