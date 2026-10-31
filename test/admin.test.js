// Roles, the Admin Panel's API, and the cloud catalog of Arabic packs: admins
// publish signed packs, signed-in players download them, and nobody else can
// do either.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createPackRegistry } = require('../src/pack-registry');
const { readZip, writeZip, packFiles } = require('../src/zip');
const { writePack, readPack } = require('../desktop/localization/pack');
const { KIND } = require('../desktop/localization/fingerprint');

const keys = crypto.generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' });

async function start(t, { env = {} } = {}) {
  const saved = { ADMIN_USERS: process.env.ADMIN_USERS, ARABIC_ADMINS: process.env.ARABIC_ADMINS };
  Object.assign(process.env, { ADMIN_USERS: '', ARABIC_ADMINS: '' }, env);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-admin-'));
  const db = openDatabase(':memory:');
  const packs = createPackRegistry({ db, dir: path.join(dataDir, 'packs'), publicKeys: [PUBLIC] });
  const server = createApp({ db, games: createLocalProvider(), dataDir, packs }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.close();
    Object.assign(process.env, saved);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { db, base: `http://127.0.0.1:${server.address().port}`, dataDir };
}

function client(base) {
  let cookie = '';
  const call = async (route, { method = 'GET', body, raw, type } = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': type || 'application/zip' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: raw || (body ? JSON.stringify(body) : undefined),
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: text, headers: res.headers };
  };
  return call;
}

async function signedUp(base, username) {
  const call = client(base);
  assert.equal((await call('/api/auth/register', { method: 'POST', body: { username, password: 'correct horse' } })).status, 201);
  return call;
}

/** A signed overlay pack for a Steam game, zipped the way Explorer would (inside a folder). */
async function packZip({ id = 're3-demo-ar', version = '1.0.0', key = keys.privateKey, steamAppId = 1173690, folder = 'My pack/' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-pack-'));
  await fs.writeFile(path.join(dir, 'fingerprints.json'), JSON.stringify({ kind: KIND, format: 2, normalization: 1, entries: [] }));
  await writePack(dir, { id, version, engine: 'overlay', title: 'Resident Evil 3 Demo', game: { steamAppId }, files: [{ source: 'fingerprints.json', target: 'fingerprints.json' }], privateKey: key });
  const files = [];
  for (const name of ['pack.json', 'pack.json.sig', 'fingerprints.json']) files.push({ name: folder + name, data: await fs.readFile(path.join(dir, name)) });
  await fs.rm(dir, { recursive: true, force: true });
  return writeZip(files);
}

test('ADMIN_USERS accounts are admins; everyone else is a user and can\'t open the Admin Panel', async (t) => {
  const { base } = await start(t, { env: { ADMIN_USERS: 'Hamad' } });
  const hamad = await signedUp(base, 'hamad');
  const alice = await signedUp(base, 'alice');
  assert.equal((await hamad('/api/me')).body.user.role, 'admin');
  assert.equal((await alice('/api/me')).body.user.role, 'user');

  for (const [method, route] of [['GET', '/api/admin/stats'], ['GET', '/api/admin/users'], ['GET', '/api/admin/packs'], ['POST', '/api/admin/packs'], ['GET', '/api/admin/requests'], ['PUT', '/api/admin/installer']]) {
    assert.equal((await alice(route, { method })).status, 403, `${method} ${route} for a user`);
    assert.equal((await client(base)(route, { method })).status, 401, `${method} ${route} logged out`);
  }

  // Promote and demote; the last admin stays.
  const users = (await hamad('/api/admin/users')).body.users;
  assert.deepEqual(users.map((u) => [u.username, u.role]), [['hamad', 'admin'], ['alice', 'user']]);
  assert.equal((await hamad('/api/admin/users/alice', { method: 'PATCH', body: { role: 'admin' } })).body.user.role, 'admin');
  assert.equal((await alice('/api/admin/stats')).status, 200);
  assert.equal((await alice('/api/admin/users/hamad', { method: 'PATCH', body: { role: 'user' } })).status, 200);
  const last = await alice('/api/admin/users/alice', { method: 'PATCH', body: { role: 'user' } });
  assert.equal(last.status, 400);
  assert.match(last.body.error, /at least one admin/);
  assert.equal((await alice('/api/admin/users/alice', { method: 'PATCH', body: { role: 'owner' } })).status, 400);

  const stats = (await alice('/api/admin/stats')).body;
  assert.deepEqual([stats.users, stats.admins, stats.packKey], [2, 1, true]);
});

test('admins publish signed packs; signed-in players download them; the catalog lists the newest version', async (t) => {
  const { base, dataDir } = await start(t, { env: { ADMIN_USERS: 'hamad' } });
  const hamad = await signedUp(base, 'hamad');
  const alice = await signedUp(base, 'alice');

  // Players and strangers can't publish.
  assert.equal((await alice('/api/admin/packs', { method: 'POST', raw: await packZip() })).status, 403);

  const first = await hamad('/api/admin/packs', { method: 'POST', raw: await packZip() });
  assert.equal(first.status, 201);
  assert.deepEqual([first.body.pack.id, first.body.pack.mode, first.body.pack.steamAppId], ['re3-demo-ar', 'overlay', 1173690]);
  // The same version twice is refused; a new version replaces it in the catalog.
  assert.equal((await hamad('/api/admin/packs', { method: 'POST', raw: await packZip() })).status, 409);
  assert.equal((await hamad('/api/admin/packs', { method: 'POST', raw: await packZip({ version: '1.1.0', folder: '' }) })).status, 201);

  const catalog = (await client(base)('/api/localization/packs')).body.packs;
  assert.equal(catalog.length, 1);
  const [entry] = catalog;
  assert.deepEqual([entry.id, entry.version, entry.engine, entry.mode, entry.gameSlug], ['re3-demo-ar', '1.1.0', 'overlay', 'overlay', null]);
  assert.equal(entry.downloadUrl, '/api/localization/packs/re3-demo-ar/download');

  // Downloads: signed-in only, and the bytes match the catalog's SHA-256.
  assert.equal((await client(base)(entry.downloadUrl)).status, 401);
  const got = await alice(entry.downloadUrl);
  assert.equal(got.status, 200);
  assert.equal(crypto.createHash('sha256').update(got.body).digest('hex'), entry.sha256);
  assert.equal(got.headers.get('x-pack-version'), '1.1.0');
  // ...and it unpacks to a pack that checks out.
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-got-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  for (const f of packFiles(readZip(got.body))) await fs.writeFile(path.join(out, f.name), f.data);
  assert.equal((await readPack(out, { publicKey: PUBLIC })).manifest.version, '1.1.0');

  // Unpublishing the newest version brings back the one before; download counts show in the panel.
  assert.equal((await hamad('/api/admin/packs/re3-demo-ar/1.1.0', { method: 'PATCH', body: { published: false } })).status, 200);
  assert.equal((await alice('/api/localization/packs')).body.packs[0].version, '1.0.0');
  const all = (await hamad('/api/admin/packs')).body.packs;
  assert.deepEqual(all.map((p) => [p.version, p.published, p.downloads, p.uploader]), [['1.1.0', false, 1, 'hamad'], ['1.0.0', true, 0, 'hamad']]);
  assert.equal((await hamad('/api/admin/stats')).body.packs.downloads, 1);

  assert.equal((await hamad('/api/admin/packs/re3-demo-ar/1.0.0', { method: 'DELETE' })).status, 204);
  assert.deepEqual((await alice('/api/localization/packs')).body.packs, []);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'packs')), ['re3-demo-ar-1.1.0.zip']);
});

test('the catalog refuses packs that aren\'t GameShelf\'s, or that try to reach outside their folder', async (t) => {
  const { base } = await start(t, { env: { ADMIN_USERS: 'hamad' } });
  const hamad = await signedUp(base, 'hamad');
  const stranger = crypto.generateKeyPairSync('ed25519').privateKey;
  const wrongKey = await hamad('/api/admin/packs', { method: 'POST', raw: await packZip({ key: stranger }) });
  assert.equal(wrongKey.status, 400);
  assert.match(wrongKey.body.error, /signature/);

  // A changed file after signing.
  const zip = readZip(await packZip({ folder: '' }));
  zip.find((f) => f.name === 'fingerprints.json').data = Buffer.from('{"changed":true}');
  assert.match((await hamad('/api/admin/packs', { method: 'POST', raw: writeZip(zip) })).body.error, /doesn't match pack.json/);

  // Zip slip: an entry that climbs out of its folder (written by hand; writeZip won't).
  const evil = Buffer.from(writeZip([{ name: 'aa/pack.json', data: Buffer.from('{}') }]).toString('latin1').replaceAll('aa/pack.json', '../pack.json'), 'latin1');
  assert.match((await hamad('/api/admin/packs', { method: 'POST', raw: evil })).body.error, /isn't allowed/);
  assert.match((await hamad('/api/admin/packs', { method: 'POST', raw: Buffer.from('not a zip') })).body.error, /isn't a \.zip/);
});

test('the Windows installer: admins upload it, the website hands it out', async (t) => {
  const { base } = await start(t, { env: { ADMIN_USERS: 'hamad' } });
  const hamad = await signedUp(base, 'hamad');
  assert.equal((await client(base)('/api/download/info')).body.available, false);
  assert.equal((await client(base)('/download/windows')).status, 404);
  assert.match((await hamad('/api/admin/installer', { method: 'PUT', raw: Buffer.from('not a program'), type: 'application/octet-stream' })).body.error, /Windows program/);
  const exe = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(5000)]);
  assert.equal((await hamad('/api/admin/installer', { method: 'PUT', raw: exe, type: 'application/octet-stream' })).body.size, exe.length);
  const info = (await client(base)('/api/download/info')).body;
  assert.deepEqual([info.available, info.size, info.url], [true, exe.length, '/download/windows']);
  const got = await client(base)('/download/windows');
  assert.equal(got.status, 200);
  assert.ok(Buffer.compare(got.body, exe) === 0);
  assert.match(got.headers.get('content-disposition'), /GameShelf-Setup\.exe/);
});

test('the desktop app matches a PC\'s games and can add the ones not on My games yet', async (t) => {
  const { base } = await start(t);
  const alice = await signedUp(base, 'alice');
  const catalog = (await client(base)('/api/games?pageSize=3')).body.results || (await client(base)('/api/games/popular')).body.results;
  assert.ok(catalog?.length, 'the sample catalog has games');
  const [one, two] = catalog;
  const list = [{ name: one.name }, { name: 'A game nobody has heard of' }, { name: two.name, status: 'playing' }];
  const matched = (await client(base)('/api/games/match', { method: 'POST', body: { games: list } })).body.matches;
  assert.deepEqual(matched.map((m) => m?.id ?? null), [one.id, null, two.id]);

  assert.equal((await client(base)('/api/me/library/installed', { method: 'POST', body: { games: list } })).status, 401);
  await alice(`/api/me/library/${one.id}`, { method: 'PUT', body: { status: 'completed' } });
  const added = (await alice('/api/me/library/installed', { method: 'POST', body: { games: list } })).body;
  assert.deepEqual(added, { added: 1, matched: 2 });
  const { library } = (await alice('/api/users/alice')).body;
  const status = Object.fromEntries(library.map((e) => [e.gameId, e.status]));
  assert.deepEqual([status[one.id], status[two.id]], ['completed', 'playing']); // a game already there keeps its status
});
