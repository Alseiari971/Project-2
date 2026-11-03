// "Request Arabic subtitles" on a UE5 game whose text is in encrypted IoStore
// containers (.utoc/.ucas), end to end: the app's own pack builder, with
// stand-ins for retoc and repak that behave like them (a container's header
// says it's encrypted; listing and reading it needs the right --aes-key).
//
// - Without a key, nothing is read: the request goes to the admins, who hear why.
// - An admin attaches the game's key in a signed key recipe; GameShelf never
//   looks for one. The same button then reads Game.locres out of the container,
//   has the server translate it, and builds pakchunk99-ArabicLocalization_P
//   .pak, .utoc and .ucas (retoc to-zen, for the engine version in the game's
//   program), which go into Content/Paks/~mods at Play.
// - The English goes to the Admin Panel's queue; the key appears in no log,
//   command line or file the build leaves.
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
const { createArabicGames } = require('../src/arabic-games');
const { createSubmissions } = require('../src/submissions');
const { createEngineRecipes } = require('../src/engine-recipes');
const { createCloudClient } = require('../desktop/cloud');
const { createArabicOnline } = require('../desktop/localization/online');
const { createArabicService } = require('../desktop/localization/service');
const { createArabicRequests } = require('../desktop/localization/requests');
const { createRecipes, checkRecipe, aesKeyOf } = require('../desktop/localization/recipes');
const { createPackBuilder, findBuilder, localPackKey } = require('../desktop/localization/builder');

const REPO = path.join(__dirname, '..');
const keys = crypto.generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' });
const KEY = `0x${'ab'.repeat(32)}`;
const python = process.platform !== 'win32' && ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import arabic_reshaper, bidi'], { stdio: 'ignore' }).status === 0);

// retoc and repak stand-ins: a .utoc is a real header (encrypted flag at byte 80) and a JSON list of chunks.
const FAKE_RETOC = String.raw`
import json, sys
from pathlib import Path
args = sys.argv[1:]
key = None
if args[:1] == ['--aes-key']:
    key, args = args[1], args[2:]
log = Path(__file__).with_name('calls.log')
with log.open('a') as f: f.write('retoc ' + ' '.join('<key>' if a == key else a for a in args) + '\n')
def chunks(utoc):
    data = Path(utoc).read_bytes()
    if data[80] & 2 and key != '${KEY}':
        sys.exit(Path(utoc).name + ' is encrypted')
    return json.loads(data[144:])
cmd = args[0]
if cmd == 'list':
    utoc = [a for a in args[1:] if not a.startswith('--')][0]
    for c in chunks(utoc):
        print(f"{Path(utoc).stem:30} {c['id']} {c['type']:20} {c['path']}")
elif cmd == 'get':
    utoc, chunk_id, out = args[1:4]
    Path(out).write_bytes(bytes.fromhex([c for c in chunks(utoc) if c['id'] == chunk_id][0]['hex']))
elif cmd == 'to-zen':
    if key: sys.exit('our own container is never encrypted')
    folder, out = Path(args[1]), Path(args[2])
    version = args[args.index('--version') + 1]
    out.write_bytes(b'-==--==--==--==-' + json.dumps({'version': version}).encode())
    out.with_suffix('.ucas').write_bytes(b'ucas')
    if not out.with_suffix('.pak').exists(): out.with_suffix('.pak').write_bytes(b'empty pak')
`;
const FAKE_REPAK = String.raw`
import json, sys
from pathlib import Path
argv = sys.argv[1:]
key = None
if argv[:1] == ['--aes-key']:
    key, argv = argv[1], argv[2:]
cmd, args = argv[0], argv[1:]
if cmd == 'pack':
    Path(args[-1]).write_bytes(b'the Arabic pak: ' + b' '.join(p.relative_to(args[-2]).as_posix().encode() for p in Path(args[-2]).rglob('*') if p.is_file())); sys.exit(0)
pak = json.loads(Path(args[0]).read_text())
if pak.get('encrypted') and key != '${KEY}': sys.exit('the pak is AES encrypted')
if cmd == 'list': print('\n'.join(pak['files']))
elif cmd == 'info': print('version: V11')
elif cmd == 'get': sys.stdout.buffer.write(bytes.fromhex(pak['files'][args[1]]))
`;

async function tool(dir, name, script) {
  await fs.writeFile(path.join(dir, `${name}.py`), script);
  const file = path.join(dir, name);
  await fs.writeFile(file, `#!/bin/sh\nexec "${python}" "${path.join(dir, `${name}.py`)}" "$@"\n`, { mode: 0o755 });
  return file;
}

function header(encrypted, entries) {
  const head = Buffer.alloc(144);
  head.write('-==--==--==--==-', 0, 'latin1');
  head[16] = 8;
  head.writeUInt32LE(144, 20);
  head.writeUInt32LE(entries, 24);
  head[80] = 8 | (encrypted ? 2 : 0);
  return head;
}

function englishLocres() {
  const script = 'import sys; sys.path.insert(0, sys.argv[1]); from arabic_compiler import locres as l; '
    + 'sys.stdout.buffer.write(l.write(l.LocRes(3, [l.Namespace("UI", [l.Entry("Start", "Start the journey", 1), l.Entry("Quit", "Leave the blade behind", 2), '
    + 'l.Entry("Gate", "The gate opens at dawn.", 3)])])))';
  return spawnSync(python, ['-c', script, path.join(REPO, 'localization')]).stdout;
}

async function ue5Game(dir) {
  const paks = path.join(dir, 'Blade', 'Content', 'Paks');
  await fs.mkdir(paks, { recursive: true });
  await fs.mkdir(path.join(dir, 'Engine', 'Binaries'), { recursive: true });
  const chunks = [
    { id: '0a'.repeat(12), type: 'ExportBundleData', path: '../../../Blade/Content/Maps/Town.umap', hex: '00' },
    { id: '0c'.repeat(12), type: 'ExternalFile', path: '../../../Blade/Content/Localization/Game/en/Game.locres', hex: englishLocres().toString('hex') },
  ];
  await fs.writeFile(path.join(paks, 'pakchunk0-Windows.utoc'), Buffer.concat([header(true, chunks.length), Buffer.from(JSON.stringify(chunks))]));
  await fs.writeFile(path.join(paks, 'pakchunk0-Windows.ucas'), 'ucas');
  await fs.writeFile(path.join(paks, 'pakchunk0-Windows.pak'), JSON.stringify({ files: { 'Blade/Content/Movies/intro.bk2': '00' }, encrypted: true }));
  const binaries = path.join(dir, 'Blade', 'Binaries', 'Win64');
  await fs.mkdir(binaries, { recursive: true });
  const pe = Buffer.alloc(512);
  pe.write('MZ', 0, 'latin1');
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write('PE\0\0', 0x80, 'latin1');
  pe.writeUInt16LE(0x8664, 0x84);
  await fs.writeFile(path.join(binaries, 'Blade-Win64-Shipping.exe'), Buffer.concat([pe, Buffer.from('++UE5+Release-5.4-CL-0', 'utf16le'), Buffer.alloc(64)]));
  return paks;
}

test('key recipes hold only an Unreal game\'s key, in the right form', () => {
  const ok = { format: 1, game: { steamAppId: 7 }, engine: 'unreal', aesKey: KEY, note: 'From the publisher.' };
  assert.equal(checkRecipe(ok, 'steam:7'), ok);
  assert.equal(aesKeyOf(ok), KEY);
  assert.throws(() => checkRecipe({ ...ok, aesKey: '0x1234' }, 'steam:7'), /64 hex digits/);
  assert.throws(() => checkRecipe({ ...ok, aesKey: `${KEY} --other` }, 'steam:7'), /64 hex digits/);
  assert.throws(() => checkRecipe({ ...ok, tool: 'quickbms', extract: [['x']] }, 'steam:7'), /holds only the game's key/);
  assert.throws(() => checkRecipe(ok, 'steam:8'), /another game/);
  assert.equal(aesKeyOf({ ...ok, engine: 'santa-monica' }), null);
});

test('Request Arabic on an encrypted UE5 IoStore game: the admins are asked, then an admin\'s signed key makes it in one click',
  { skip: !python && 'needs Python with the builder\'s requirements (and a POSIX shell for the stand-in tools)' }, async (t) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-ue5-flow-'));
    t.after(() => fs.rm(tmp, { recursive: true, force: true }));
    const tools = path.join(tmp, 'tools');
    await fs.mkdir(tools);
    const retoc = await tool(tools, 'retoc', FAKE_RETOC);
    const repak = await tool(tools, 'repak', FAKE_REPAK);

    const fetchAi = async (_url, init) => {
      const user = JSON.parse(init.body).messages[1].content;
      const lines = JSON.parse(user.slice(user.indexOf('[')));
      const content = Array.isArray(lines)
        ? { translations: lines.map(({ id, text }) => ({ id, arabic: `عربي ${text}` })) }
        : { terms: {}, player: { gender: 'unknown' } };
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
    };
    const db = openDatabase(':memory:');
    const translations = createTranslationMemory({ db, env: { OPENAI_API_KEY: 'server-key' }, fetch: fetchAi });
    const submissions = createSubmissions({ db, translations, publicKeys: [PUBLIC] });
    const recipes = createEngineRecipes({ db, publicKeys: [PUBLIC] });
    const arabicGames = createArabicGames({ db, translations });
    const server = createApp({ db, games: createLocalProvider(), translations, dataDir: tmp, arabicGames, submissions, recipes,
      steamStore: { details: async () => ({ features: ['Single-player'] }) } }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'correct horse' }) });
    const cloud = createCloudClient({ server: () => base, session: async () => /gs_session=([^;]+)/.exec(res.headers.get('set-cookie'))[1] });

    const online = createArabicOnline({ cloud, cacheDir: path.join(tmp, 'dl'), publicKeys: [PUBLIC] });
    const localKey = localPackKey(path.join(tmp, 'player'));
    const paths = findBuilder({ packaged: false, repoDir: REPO, env: { GAMESHELF_PYTHON: python, GAMESHELF_REPAK: repak, GAMESHELF_RETOC: retoc } });
    const packBuilder = createPackBuilder({ paths: { ...paths, msgTool: null }, outDir: path.join(tmp, 'builds'), keyFile: localKey.keyFile });
    const arabic = createArabicService({
      dataDir: path.join(tmp, 'player'), publicKey: [PUBLIC, localKey.publicKey], overlayAvailable: false, catalog: online.catalog,
      builder: { canBuild: (tier, engine) => packBuilder.canBuild(tier, engine), fromSet: async () => null },
    });
    const requests = createArabicRequests({
      arabic, packBuilder, online, server: () => base, overlayAvailable: false,
      recipes: createRecipes({ cloud, cacheDir: path.join(tmp, 'recipes'), publicKeys: [PUBLIC] }),
    });

    const dir = path.join(tmp, 'Blade');
    const paks = await ue5Game(dir);
    const game = { key: 'steam:2109880', dir, steamAppId: 2109880, gameId: null, title: 'Phantom Blade' };
    const before = await arabic.info(game);
    assert.deepEqual([before.tier, before.missing], ['unreal-pak', true]);

    // No key: nothing is read, and the admins hear why.
    const asked = await requests.run(game, { consent: true });
    assert.equal(asked.requested, true, JSON.stringify(asked));
    assert.match(asked.reason, /encrypted.*never looks for keys/);
    const [request] = arabicGames.requests();
    assert.equal(request.game, 'steam:2109880');

    // An admin attaches the game's key, signed with GameShelf's pack key.
    const recipe = JSON.stringify({ format: 1, game: { steamAppId: 2109880 }, engine: 'unreal', aesKey: KEY });
    recipes.attach('steam:2109880', { recipe, signature: crypto.sign(null, Buffer.from(recipe), keys.privateKey).toString('base64') });

    const phases = [];
    const done = await requests.run(game, { consent: true, onProgress: (p) => phases.push(p.phase) });
    assert.equal(done.done, true, JSON.stringify(done.error || done));
    assert.ok(phases.includes('translating') && phases.includes('submitting'), phases.join());
    assert.equal(done.submitted?.total, 3);

    // At Play: the triplet, in Content/Paks/~mods.
    const launch = await arabic.prepareLaunch(game);
    assert.deepEqual([launch.mode, launch.ok], ['native', true], JSON.stringify(launch.error));
    assert.deepEqual((await fs.readdir(path.join(paks, '~mods'))).sort(),
      ['pakchunk99-ArabicLocalization_P.pak', 'pakchunk99-ArabicLocalization_P.ucas', 'pakchunk99-ArabicLocalization_P.utoc']);
    const pak = await fs.readFile(path.join(paks, '~mods', 'pakchunk99-ArabicLocalization_P.pak'), 'utf8');
    assert.match(pak, /Blade\/Content\/Localization\/Game\/en\/Game\.locres/);
    const utoc = await fs.readFile(path.join(paks, '~mods', 'pakchunk99-ArabicLocalization_P.utoc'));
    assert.deepEqual(JSON.parse(utoc.subarray(16)), { version: 'UE5_4' });

    // The tools were given the key; nothing the build left behind holds it.
    const calls = await fs.readFile(path.join(tools, 'calls.log'), 'utf8');
    assert.match(calls, /retoc list --path .*pakchunk0-Windows\.utoc/);
    for (const file of await fs.readdir(path.join(tmp, 'builds'), { recursive: true })) {
      const full = path.join(tmp, 'builds', file);
      if ((await fs.stat(full)).isFile()) assert.ok(!(await fs.readFile(full, 'latin1')).includes(KEY), `${file} holds the key`);
    }

    // The English is waiting in Admin Panel, Pending approvals.
    const [waiting] = submissions.list();
    assert.deepEqual([waiting.game, waiting.engine, waiting.status], ['steam:2109880', 'unreal', 'pending']);

    // Arabic off: Content/Paks is as it was.
    assert.equal((await arabic.set(game, false)).error, null);
    assert.deepEqual((await fs.readdir(paks)).sort(), ['pakchunk0-Windows.pak', 'pakchunk0-Windows.ucas', 'pakchunk0-Windows.utoc']);
  });
