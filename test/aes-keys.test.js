// Admin Panel → AES Keys & Recipes: the in-browser signer (public/js/admin-signer.js)
// signs Unreal key recipes with GameShelf's pack key without the key ever leaving
// the page, and the server keeps only recipes that verify against the public key.
// Attaching a key answers the requests players' apps made when they found the game
// encrypted, and tells those players.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createTranslationMemory } = require('../src/translation-memory');
const { createArabicGames } = require('../src/arabic-games');
const { createEngineRecipes } = require('../src/engine-recipes');
const { checkRecipe, aesKeyOf } = require('../desktop/localization/recipes');

const signerModule = () => import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin-signer.js'), 'utf8'))}`);
const packKeys = crypto.generateKeyPairSync('ed25519');
const PUBLIC = packKeys.publicKey.export({ type: 'spki', format: 'pem' });
const PRIVATE_PEM = packKeys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const KEY = `0x${'4BC8'.repeat(15)}E01D`;

test('the in-browser signer: Ed25519 exactly as Node signs, from a PEM or a raw key, and nothing extractable', async () => {
  const s = await signerModule();
  // The fallback (browsers without WebCrypto Ed25519) gives Node's signatures, byte for byte.
  for (let i = 0; i < 12; i += 1) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const seed = s.readPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const message = crypto.randomBytes(i * 11);
    assert.deepEqual(Buffer.from(await s.signWithSeed(seed, message)), crypto.sign(null, message, privateKey));
    assert.deepEqual(Buffer.from(await s.publicKeyOf(seed)), publicKey.export({ type: 'spki', format: 'der' }).subarray(12));
  }
  // The same key, however it's given.
  const der = packKeys.privateKey.export({ type: 'pkcs8', format: 'der' });
  const seed = der.subarray(16);
  const forms = [PRIVATE_PEM, PRIVATE_PEM.replace(/\n/g, ''), seed.toString('hex'), `0x${seed.toString('hex')}`, seed.toString('base64'), der.toString('base64'), new Uint8Array(der), new TextEncoder().encode(PRIVATE_PEM)];
  for (const form of forms) assert.deepEqual(Buffer.from(s.readPrivateKey(form)), seed);
  assert.throws(() => s.readPrivateKey(PUBLIC), /public key/);
  assert.throws(() => s.readPrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'), /OpenSSH/);
  assert.throws(() => s.readPrivateKey('not a key'), /doesn't look like/);

  // WebCrypto signs with a non-extractable key; the seed handed over is wiped.
  const given = s.readPrivateKey(PRIVATE_PEM);
  const signer = await s.createSigner(given);
  assert.equal(signer.method, 'webcrypto');
  assert.ok(given.every((b) => b === 0));
  assert.equal(signer.publicKey, packKeys.publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64'));
  const text = s.keyRecipeText('steam:2358720', KEY, 'UE5 IoStore (.utoc/.ucas) · Content/Paks/~mods');
  assert.ok(crypto.verify(null, Buffer.from(text), packKeys.publicKey, Buffer.from(await signer.sign(text), 'base64')));
  signer.lock();
  await assert.rejects(signer.sign(text), /locked/);

  // What's signed is a key recipe players' apps accept as it is.
  assert.equal(text, '{"format":1,"game":{"steamAppId":2358720},"engine":"unreal","aesKey":"0x4BC84BC84BC84BC84BC84BC84BC84BC84BC84BC84BC84BC84BC84BC84BC8E01D","note":"UE5 IoStore (.utoc/.ucas) · Content/Paks/~mods"}');
  assert.equal(aesKeyOf(checkRecipe(JSON.parse(text), 'steam:2358720')), KEY);
  // AES keys: 0x and 64 hex digits, the digits alone, or 44 characters of base64.
  assert.equal(s.normalizeAesKey(KEY.toLowerCase()), `0x${KEY.slice(2).toLowerCase()}`);
  assert.equal(s.normalizeAesKey(`0X${KEY.slice(2)}`), KEY);
  assert.equal(s.normalizeAesKey(KEY.slice(2)), KEY);
  assert.equal(s.normalizeAesKey(Buffer.from(KEY.slice(2), 'hex').toString('base64')), KEY);
  for (const bad of ['0x1234', `${KEY}00`, `${KEY} --x`, 'zz'.repeat(32), '']) assert.equal(s.normalizeAesKey(bad), null, bad);
  assert.equal(s.maskAesKey(KEY), '0x4BC8…E01D');
});

async function start(t, { recipesKeys = [PUBLIC] } = {}) {
  const saved = process.env.ADMIN_USERS;
  process.env.ADMIN_USERS = 'hamad';
  t.after(() => { if (saved === undefined) delete process.env.ADMIN_USERS; else process.env.ADMIN_USERS = saved; });
  const db = openDatabase(':memory:');
  const translations = createTranslationMemory({ db, env: {} });
  const sent = [];
  const server = createApp({
    db, games: createLocalProvider(), translations, arabicGames: createArabicGames({ db, translations }),
    recipes: createEngineRecipes({ db, publicKeys: recipesKeys }),
    mailer: { enabled: true, send: async (mail) => sent.push(mail) },
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = async (username, email) => {
    const res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, email, password: 'violet-harbor-lantern-92', nationality: 'AE' }) });
    assert.equal(res.status, 201, await res.clone().text());
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (url, { method = 'GET', body, headers = {} } = {}) => {
      const r = await fetch(base + url, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
  };
  return { db, base, as, sent };
}

test('an admin pre-attaches a signed AES key to a game nobody has asked for yet; tampered or unsigned ones are refused', async (t) => {
  const s = await signerModule();
  const { as, db } = await start(t);
  const admin = await as('hamad', 'hamad@test.example');
  const player = await as('layla', 'layla@test.example');
  const signer = await s.createSigner(s.readPrivateKey(PRIVATE_PEM));
  const game = 'steam:2358720';
  const recipe = s.keyRecipeText(game, KEY, 'UE5 IoStore (.utoc/.ucas)');
  const signature = await signer.sign(recipe);

  // The browser checks its key against the server's public keys first.
  const listed = await admin('/api/admin/recipes');
  assert.deepEqual(listed.body.publicKeys, [signer.publicKey]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM arabic_requests').get().n, 0);

  // Refused: players, other sites, no signature, a changed recipe, another key, more than a key, a bad key.
  assert.equal((await player('/api/admin/recipes', { method: 'POST', body: { game, recipe, signature } })).status, 403);
  assert.equal((await admin('/api/admin/recipes', { method: 'POST', body: { game, recipe, signature }, headers: { Origin: 'https://evil.example' } })).status, 403);
  const refused = async (body, pattern) => {
    const r = await admin('/api/admin/recipes', { method: 'POST', body: { game, ...body } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, pattern);
  };
  await refused({ recipe }, /isn't signed with GameShelf's pack key/);
  await refused({ recipe: recipe.replace('E01D', 'E01E'), signature }, /isn't signed with GameShelf's pack key/);
  const other = crypto.generateKeyPairSync('ed25519');
  await refused({ recipe, signature: crypto.sign(null, Buffer.from(recipe), other.privateKey).toString('base64') }, /isn't signed/);
  const sneaky = JSON.stringify({ ...JSON.parse(recipe), tool: 'quickbms', extract: [['{game}']] });
  await refused({ recipe: sneaky, signature: await signer.sign(sneaky) }, /holds only the game's key/);
  const short = s.keyRecipeText(game, '0x1234');
  await refused({ recipe: short, signature: await signer.sign(short) }, /64 hex digits/);
  const elsewhere = s.keyRecipeText('steam:1', KEY);
  await refused({ recipe: elsewhere, signature: await signer.sign(elsewhere) }, /another game/);
  await refused({ recipe, signature, container: 'zip' }, /container/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM engine_recipes').get().n, 0);

  // Signed in the browser with GameShelf's key: kept, before anyone asked.
  const saved = await admin('/api/admin/recipes', { method: 'POST', body: { game, recipe, signature, title: 'Lies of P', container: 'iostore' } });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.answered, 0);
  const [row] = (await admin('/api/admin/recipes')).body.recipes;
  assert.deepEqual(
    [row.game, row.title, row.engine, row.container, row.maskedKey, row.verified, row.attachedBy],
    [game, 'Lies of P', 'unreal', 'iostore', '0x4BC8…E01D', true, 'hamad'],
  );
  assert.ok(!JSON.stringify((await admin('/api/admin/recipes')).body).includes(KEY), 'the list shows only the masked key');
  // Players' apps get exactly what was signed.
  const got = await player(`/api/arabic/recipes/${game}`);
  assert.equal(got.body.recipe, recipe);
  assert.ok(crypto.verify(null, Buffer.from(got.body.recipe), packKeys.publicKey, Buffer.from(got.body.signature, 'base64')));

  // A batch: each line checked on its own.
  const good = s.keyRecipeText('steam:1817230', KEY);
  const batch = await admin('/api/admin/recipes/batch', { method: 'POST', body: { items: [
    { game: 'steam:1817230', recipe: good, signature: await signer.sign(good), title: 'Hogwarts Legacy', container: 'pak' },
    { game: 'steam:1888930', recipe: s.keyRecipeText('steam:1888930', KEY), signature },
  ] } });
  assert.deepEqual(batch.body.results.map((r) => [r.game, r.ok]), [['steam:1817230', true], ['steam:1888930', false]]);
  assert.match(batch.body.results[1].error, /isn't signed/);

  // Revoked: gone for players too.
  assert.equal((await admin(`/api/admin/recipes/${game}`, { method: 'DELETE' })).body.removed, true);
  assert.equal((await player(`/api/arabic/recipes/${game}`)).status, 404);
});

test('attaching a key answers the "encrypted" requests waiting for it, and tells those players', async (t) => {
  const s = await signerModule();
  const { as, db, sent } = await start(t);
  const admin = await as('hamad', 'hamad@test.example');
  const layla = await as('layla', 'layla@test.example');
  const omar = await as('omar', 'omar@test.example');
  db.prepare("UPDATE users SET email_verified = 1 WHERE username = 'layla'").run();
  const game = 'steam:2109880';
  const encrypted = 'This Unreal game\'s files are encrypted, and GameShelf never looks for keys.';
  await layla('/api/arabic/requests', { method: 'POST', body: { game, name: 'Phantom Blade Zero', reason: encrypted } });
  await omar('/api/arabic/requests', { method: 'POST', body: { game, name: 'Phantom Blade Zero', reason: encrypted } });
  assert.equal((await layla('/api/arabic/status', { method: 'POST', body: { games: [game] } })).body.games[game].answered, null);

  const signer = await s.createSigner(s.readPrivateKey(PRIVATE_PEM));
  const recipe = s.keyRecipeText(game, KEY);
  const saved = await admin('/api/admin/recipes', { method: 'POST', body: { game, recipe, signature: await signer.sign(recipe), title: 'Phantom Blade Zero', container: 'iostore' } });
  assert.equal(saved.body.answered, 2);
  // Ready for both players; Admin Panel → Requests shows it.
  assert.equal((await layla('/api/arabic/status', { method: 'POST', body: { games: [game] } })).body.games[game].answered, 'key');
  const [request] = (await admin('/api/admin/requests')).body.requests;
  assert.deepEqual([request.game, request.answered, request.recipe], [game, 'key', true]);
  // An email to the player whose address is confirmed (only them).
  await new Promise((resolve) => setImmediate(resolve));
  const ready = () => sent.filter((m) => /can be made now/.test(m.subject));
  assert.equal(ready().length, 1);
  assert.equal(ready()[0].to, 'layla@test.example');
  assert.match(ready()[0].subject, /Arabic for Phantom Blade Zero can be made now/);
  // Signing it again (a new key) doesn't tell them twice.
  await admin('/api/admin/recipes', { method: 'POST', body: { game, recipe, signature: await signer.sign(recipe) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready().length, 1);
  // Revoked: the requests are waiting again.
  await admin(`/api/admin/recipes/${game}`, { method: 'DELETE' });
  assert.equal((await layla('/api/arabic/status', { method: 'POST', body: { games: [game] } })).body.games[game].answered, null);
});

test('without a pack public key on the server, nothing can be attached', async (t) => {
  const s = await signerModule();
  const { as } = await start(t, { recipesKeys: [] });
  const admin = await as('hamad', 'hamad@test.example');
  const signer = await s.createSigner(s.readPrivateKey(PRIVATE_PEM));
  const recipe = s.keyRecipeText('steam:7', KEY);
  const r = await admin('/api/admin/recipes', { method: 'POST', body: { game: 'steam:7', recipe, signature: await signer.sign(recipe) } });
  assert.equal(r.status, 503);
});
