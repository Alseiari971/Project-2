const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gameFolder, processesOf } = require('../desktop/processes');
const { createCustomGames, suggestName } = require('../desktop/custom-games');

const games = path.join(os.tmpdir(), 'Games');

test('a game runs when a program from its folder runs', () => {
  const hades = { dir: path.join(games, 'Hades') };
  const processes = [
    { pid: 10, path: path.join(games, 'Hades', 'x64', 'Hades.exe') },
    { pid: 11, path: path.join(games, 'Hades II', 'Hades2.exe') },
    { pid: 12, path: path.join(games, 'Hades') },
    { pid: process.pid, path: path.join(games, 'Hades', 'GameShelf.exe') },
  ];
  assert.deepStrictEqual(processesOf(hades, processes).map((p) => p.pid), [10]);
});

test('broad folders only match the exact program', () => {
  const home = os.homedir();
  assert.strictEqual(gameFolder({ dir: path.join(home, 'Desktop') }), null);
  assert.strictEqual(gameFolder({ dir: path.parse(home).root }), null);
  const onDesktop = { dir: path.join(home, 'Desktop'), exe: path.join(home, 'Desktop', 'game.exe') };
  const processes = [
    { pid: 20, path: path.join(home, 'Desktop', 'game.exe') },
    { pid: 21, path: path.join(home, 'Desktop', 'notes.exe') },
  ];
  assert.deepStrictEqual(processesOf(onDesktop, processes).map((p) => p.pid), [20]);
});

test('suggests a name from the game folder, skipping folders like bin', () => {
  assert.strictEqual(suggestName(path.join(games, 'Hollow Knight', 'hollow_knight.exe')), 'Hollow Knight');
  assert.strictEqual(suggestName(path.join(games, 'The_Witcher_3', 'bin', 'x64', 'witcher3.exe')), 'The Witcher 3');
});

test('added games are saved, linked to a GameShelf game, and removable', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'custom-')), 'custom-games.json');
  const store = createCustomGames(file);
  const exe = path.join(games, 'Hollow Knight', 'hollow_knight.exe');
  const entry = store.add({
    exe,
    name: 'hollow knight',
    game: { id: 'hollow-knight', name: 'Hollow Knight', image: 'https://images.igdb.com/a.jpg', poster: 'file:///C:/x.png', genres: ['Indie'], extra: 'dropped' },
  });
  assert.match(entry.key, /^custom:/);
  assert.strictEqual(entry.name, 'Hollow Knight');
  assert.strictEqual(entry.game.poster, null);
  assert.strictEqual('extra' in entry.game, false);

  // Saved to disk; adding the same program again replaces it instead of duplicating.
  const reopened = createCustomGames(file);
  reopened.add({ exe, name: 'HK', game: null });
  const all = createCustomGames(file).all();
  assert.strictEqual(all.length, 1);
  assert.deepStrictEqual({ key: all[0].key, name: all[0].name, launcher: all[0].launcher, dir: all[0].dir },
    { key: entry.key, name: 'HK', launcher: 'custom', dir: path.dirname(exe) });

  assert.throws(() => reopened.add({ exe, name: '  ' }), /name/);
  reopened.remove(entry.key);
  assert.deepStrictEqual(createCustomGames(file).all(), []);
});

const { parseGpuPreference, withGpuPreference, pickMainProgram, createProgramStore } = require('../desktop/game-options');

test('graphics card choice keeps the other Windows settings for the game', () => {
  assert.strictEqual(parseGpuPreference('SwapEffectUpgradeEnable=1;GpuPreference=2;'), 2);
  assert.strictEqual(parseGpuPreference(''), 0);
  assert.strictEqual(withGpuPreference('SwapEffectUpgradeEnable=1;GpuPreference=1;', 2), 'SwapEffectUpgradeEnable=1;GpuPreference=2;');
  assert.strictEqual(withGpuPreference('', 1), 'GpuPreference=1;');
  // "Let Windows decide" removes the choice, and the whole value when nothing else is left.
  assert.strictEqual(withGpuPreference('SwapEffectUpgradeEnable=1;GpuPreference=2;', 0), 'SwapEffectUpgradeEnable=1;');
  assert.strictEqual(withGpuPreference('GpuPreference=2;', 0), '');
});

test('the game program is picked over crash reporters and anti-cheat helpers', () => {
  const dir = path.join(games, 'ELDEN RING', 'Game');
  assert.strictEqual(pickMainProgram([path.join(dir, 'start_protected_game.exe'), path.join(dir, 'eldenring.exe')]), path.join(dir, 'eldenring.exe'));
  assert.strictEqual(pickMainProgram([path.join(dir, 'CrashReportClient.exe'), path.join(dir, 'eldenring.exe')]), path.join(dir, 'eldenring.exe'));
  assert.strictEqual(pickMainProgram([path.join(dir, 'EasyAntiCheat_launcher.exe')]), path.join(dir, 'EasyAntiCheat_launcher.exe'));
  assert.strictEqual(pickMainProgram([]), null);
});

test('learned programs are remembered between launches', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'programs-')), 'game-programs.json');
  createProgramStore(file).remember('steam:1245620', '/games/eldenring.exe');
  assert.strictEqual(createProgramStore(file).get('steam:1245620'), '/games/eldenring.exe');
  assert.strictEqual(createProgramStore(file).get('steam:1'), null);
});
