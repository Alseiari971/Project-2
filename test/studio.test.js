// The Pack Studio: an admin builds a pack from a game's text with the real pack
// builder (live log lines and progress), it's signed with GameShelf's key,
// published to the cloud catalog, and a player's app downloads it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createTranslationMemory } = require('../src/translation-memory');
const { createPackRegistry } = require('../src/pack-registry');
const { createStudio, buildArgs, StudioError } = require('../desktop/localization/studio');
const { findBuilder } = require('../desktop/localization/builder');
const { createCloudClient } = require('../desktop/cloud');
const { createArabicOnline } = require('../desktop/localization/online');
const { createArabicService } = require('../desktop/localization/service');

const REPO = path.join(__dirname, '..');
const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import arabic_reshaper, bidi'], { stdio: 'ignore' }).status === 0);
const keys = crypto.generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' });
const cloudAs = (base, value) => createCloudClient({ server: () => base, session: async () => value });
const paths = { script: 'build.py', msgTool: 'remsg.py' };

test('the Studio\'s choices become the pack builder\'s command line, and mistakes are caught first', () => {
  const base = { source: 'D:\\Games\\RE3DEMO', engine: 'reengine', id: 're3-demo-ar', version: '1.2.0', steamAppId: '1173690', title: 'RE3 Demo' };
  const where = { ...paths, keyFile: 'k.key', outDir: 'out', server: 'https://gs.example' };
  assert.deepEqual(buildArgs({ ...base, translate: 'shared', pakList: 'RE3.list' }, where), [
    'build.py', 'D:\\Games\\RE3DEMO', '--id', 're3-demo-ar', '--version', '1.2.0', '--key', 'k.key', '--out', path.join('out', 're3-demo-ar'),
    '--title', 'RE3 Demo', '--steam-app-id', '1173690', '--engine', 'reengine', '--shared', 'https://gs.example', '--msg-tool', 'remsg.py', '--pak-list', 'RE3.list',
  ]);
  const own = buildArgs({ ...base, engine: 'auto', translate: 'provider', provider: 'gemini', model: 'gemini-2.5-flash' }, where);
  assert.ok(!own.includes('--engine'));
  assert.deepEqual(own.slice(own.indexOf('--provider'), own.indexOf('--provider') + 4), ['--provider', 'gemini', '--model', 'gemini-2.5-flash']);
  assert.ok(buildArgs({ ...base, translate: 'none', reviewed: 'translations.csv' }, where).join(' ').includes('--no-translate --msg-tool remsg.py --translations translations.csv'));

  for (const [change, message] of [
    [{ source: '' }, /game folder/], [{ id: 'bad id!' }, /pack ID/], [{ version: '' }, /version/],
    [{ steamAppId: '', gameId: '' }, /Steam app ID/], [{ steamAppId: 'abc' }, /is a number/], [{ translate: 'provider', provider: 'x' }, /OpenAI or Gemini/],
  ]) assert.throws(() => buildArgs({ ...base, ...change }, where), message);
  assert.throws(() => buildArgs(base, { ...where, keyFile: null }), StudioError);
});

test('Studio settings: the signing key is checked against the app\'s, and API keys are only stored encrypted', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-studio-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const keyFile = path.join(dataDir, 'pack-signing.key');
  await fs.writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const vault = { available: () => true, encrypt: (text) => Buffer.from(`sealed:${text}`), decrypt: (buf) => buf.toString().replace(/^sealed:/, '') };
  const studio = createStudio({ paths: { ...paths, python: 'python' }, dataDir, cloud: cloudAs('http://x', null), appKeys: [PUBLIC], secure: vault });

  assert.equal(studio.settings().keyMatchesApp, false);
  assert.throws(() => studio.saveSettings({ keyFile: path.join(dataDir, 'nope.key') }), /isn't a signing key/);
  let s = studio.saveSettings({ keyFile, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'sk-secret' });
  assert.deepEqual([s.keyOk, s.keyMatchesApp, s.hasKey.openai, s.hasKey.gemini, s.keysStoredSafely], [true, true, true, false, true]);
  const stored = await fs.readFile(path.join(dataDir, 'studio', 'settings.json'), 'utf8');
  assert.doesNotMatch(stored, /sk-secret/); // only the sealed form is written

  // Without the operating system's protection, a key lasts for the session only.
  const plain = createStudio({ paths: { ...paths, python: 'python' }, dataDir: path.join(dataDir, 'other'), cloud: cloudAs('http://x', null), appKeys: [PUBLIC] });
  s = plain.saveSettings({ provider: 'gemini', apiKey: 'AIza-secret' });
  assert.deepEqual([s.hasKey.gemini, s.keysStoredSafely], [true, false]);
  assert.doesNotMatch(await fs.readFile(path.join(dataDir, 'other', 'studio', 'settings.json'), 'utf8'), /AIza/);

  // A new key pair, never over an old one.
  const made = studio.makeKeys(path.join(dataDir, 'keys'));
  assert.match(made.publicKey, /BEGIN PUBLIC KEY/);
  assert.equal(studio.settings().keyFile, made.keyFile);
  assert.throws(() => studio.makeKeys(path.join(dataDir, 'keys')), /already has/);
});

test('build in the Studio, publish to the catalog, and a player gets it', { skip: !python && 'the pack builder needs Python with its requirements' }, async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-studio-'));
  const saved = process.env.ADMIN_USERS;
  process.env.ADMIN_USERS = 'hamad';
  t.after(async () => {
    if (saved === undefined) delete process.env.ADMIN_USERS;
    else process.env.ADMIN_USERS = saved;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // GameShelf's server, translating with a stand-in for OpenAI.
  const db = openDatabase(':memory:');
  const fetch = async (_url, init) => {
    const user = JSON.parse(init.body).messages[1].content;
    const translations = JSON.parse(user.slice(user.indexOf('['))).map(({ id, text }) => ({ id, arabic: `عربي ${text}` }));
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }) };
  };
  const translations = createTranslationMemory({ db, env: { OPENAI_API_KEY: 'server-key' }, fetch });
  const server = createApp({ db, games: createLocalProvider(), translations, dataDir: tmp, packs: createPackRegistry({ db, dir: path.join(tmp, 'catalog'), publicKeys: [PUBLIC] }) }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const signUp = async (username) => {
    const res = await globalThis.fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'correct horse' }) });
    return /gs_session=([^;]+)/.exec(res.headers.get('set-cookie'))[1];
  };

  // The game's text, and the admin's Studio with GameShelf's key.
  const source = path.join(tmp, 'lines.csv');
  await fs.writeFile(source, 'source\nWe must reach the castle before nightfall.\nHey Captain.\n', 'utf8');
  const keyFile = path.join(tmp, 'pack-signing.key');
  await fs.writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const studio = createStudio({
    paths: { ...findBuilder({ packaged: false, repoDir: REPO, env: { GAMESHELF_PYTHON: python } }), msgTool: null },
    dataDir: path.join(tmp, 'admin'),
    cloud: cloudAs(base, await signUp('hamad')),
    appKeys: [PUBLIC],
    nodePath: process.execPath,
  });
  studio.saveSettings({ keyFile });

  const lines = [];
  const phases = new Set();
  const options = { source, engine: 'overlay', id: 'test-game-ar', version: '1.0.0', steamAppId: '7654321', title: 'Test Game', translate: 'shared' };
  const built = await studio.build(options, { onLog: (l) => lines.push(l.line), onProgress: (p) => phases.add(p.phase) });
  assert.ok(lines.some((l) => /Shared memory had 0 of 2 lines/.test(l)), lines.join('\n'));
  assert.ok(phases.has('translating') && phases.has('done'));
  assert.match(await fs.readFile(built.review, 'utf8'), /عربي Hey Captain/);
  // One build at a time.
  const again = studio.build(options);
  await assert.rejects(studio.build(options), /already being built/);
  await again;

  const pack = await studio.publish(built.packDir);
  assert.deepEqual([pack.id, pack.version, pack.mode, pack.steamAppId], ['test-game-ar', '1.0.0', 'overlay', 7654321]);
  // Players can't publish.
  const player = await signUp('alice');
  const intruder = createStudio({ paths: { ...paths, python }, dataDir: path.join(tmp, 'alice'), cloud: cloudAs(base, player) });
  await assert.rejects(intruder.publish(built.packDir), /Only admins/);

  // The player's app finds it in the catalog and installs it with one switch.
  const gameDir = path.join(tmp, 'TestGame');
  await fs.mkdir(gameDir);
  await fs.writeFile(path.join(gameDir, 'game.exe'), 'MZ');
  const online = createArabicOnline({ cloud: cloudAs(base, player), cacheDir: path.join(tmp, 'downloads') });
  const arabic = createArabicService({ dataDir: path.join(tmp, 'player'), publicKey: PUBLIC, overlayAvailable: true, catalog: online.catalog });
  const game = { key: 'steam:7654321', dir: gameDir, steamAppId: 7654321, gameId: null };
  const { info, error } = await arabic.set(game, true);
  assert.equal(error, null);
  assert.deepEqual([info.mode, info.enabled, info.pack.id], ['overlay', true, 'test-game-ar']);
});
