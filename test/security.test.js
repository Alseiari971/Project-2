// Security regression tests: each one tries an attack and checks it fails.
// Stored XSS, path traversal and zip-slip, shell injection, forged Steam
// sign-ins, IDOR on support tickets, unsigned or tampered packs and recipes,
// cross-site writes, response headers, error leaks, the server never holding
// a private key, and the desktop app's window and IPC rules.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createMemoryMailer } = require('../src/mailer');
const { readZip, writeZip } = require('../src/zip');
const { packKeys } = require('../src/pack-registry');
const { createEngineRecipes } = require('../src/engine-recipes');
const { writePack, readPack } = require('../desktop/localization/pack');
const { hashPassword, verifyPassword, needsRehash, clientMessage } = require('../src/auth');
const { externalUrl, createPickedPaths, trustedSender, permissionPolicy, SAFE_PREFERENCES } = require('../desktop/safety');
const { OP } = require('../src/steam-openid');

const ROOT = path.join(__dirname, '..');
const XSS = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "javascript:alert('x')", '<svg onload=alert(1)>', "'};alert(1);//"];

let server;
let base;
let db;
const valveSays = { valid: false };
const fakeFetch = async (url, init) => {
  // Valve's check_authentication: genuine only when the test says so.
  if (url === OP && init?.method === 'POST') return { ok: true, status: 200, text: async () => `ns:http://specs.openid.net/auth/2.0\nis_valid:${valveSays.valid}\n` };
  throw new Error(`unexpected fetch ${url}`);
};

before(async () => {
  process.env.ADMIN_USERS = 'boss';
  db = openDatabase(':memory:');
  server = createApp({ db, games: createLocalProvider(), mailer: createMemoryMailer(), fetchImpl: fakeFetch }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  delete process.env.ADMIN_USERS;
});

function client() {
  let cookie = '';
  return async (route, { method = 'GET', body, headers = {}, raw } = {}) => {
    const res = await fetch(base + route, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text, headers: res.headers, location: res.headers.get('location') };
  };
}
async function signedUp(username) {
  const c = client();
  const r = await c('/api/auth/register', { method: 'POST', body: { username, password: 'a long passphrase', email: `${username}@mail.example`, nationality: 'AE' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return c;
}

// ---- Stored XSS ----

test('stored XSS: hostile text is refused or stored as plain text, and the pages only insert escaped HTML', async () => {
  const me = await signedUp('xss_tester');
  // Usernames can't carry markup at all.
  for (const name of XSS) {
    const r = await client()('/api/auth/register', { method: 'POST', body: { username: name, password: 'a long passphrase', email: 'x@mail.example', nationality: 'AE' } });
    assert.equal(r.status, 400, name);
  }
  // Display names, ticket subjects, messages and presence titles are kept as text, byte for byte.
  await me('/api/me', { method: 'PATCH', body: { displayName: XSS[1] } });
  assert.equal((await client()('/api/users/xss_tester')).body.user.displayName, XSS[1]);
  const ticket = (await me('/api/support/tickets', { method: 'POST', body: { category: 'other', subject: XSS[0], message: `${XSS[3]} and more words` } })).body;
  assert.equal(ticket.ticket.subject, XSS[0]);
  assert.equal(ticket.messages[0].body, `${XSS[3]} and more words`);
  const beat = await me('/api/presence/heartbeat', { method: 'POST', body: { status: 'in_game', gameTitle: XSS[1] } });
  assert.equal(beat.body.presence.game.title, XSS[1]);
  assert.equal(beat.body.presence.game.id, null, 'a hostile game id is dropped');

  // The page's html`` template escapes every value it inserts.
  const source = fs.readFileSync(path.join(ROOT, 'public/js/lib.js'), 'utf8').replace("import { t, locale } from './i18n.js';", "const t = (s) => s; const locale = 'en';");
  const lib = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  for (const payload of XSS) {
    const out = lib.html`<p title="${payload}">${payload}</p>`.value;
    // Only the template's own tags remain: the value can't open a tag or leave the attribute.
    const inner = out.slice('<p title="'.length, -'</p>'.length).split('">');
    assert.equal(inner.length, 2, out);
    for (const part of inner) assert.ok(!/[<>"']/.test(part), out);
  }
  assert.equal(lib.html`${XSS[0]}`.value, '&lt;script&gt;alert(1)&lt;/script&gt;');

  // And raw HTML is only ever set from that template (or emptied).
  const files = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? e.name !== 'vendor' && e.name !== 'lang' && walk(path.join(dir, e.name)) : e.name.endsWith('.js') && files.push(path.join(dir, e.name))));
  walk(path.join(ROOT, 'public/js'));
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!/(innerHTML|outerHTML)\s*=|insertAdjacentHTML\(|document\.write/.test(line)) continue;
      assert.ok(/=\s*''|=\s*content\.value|\.value;|\.value\)/.test(line), `raw HTML from something other than html\`\`: ${path.relative(ROOT, file)}: ${line.trim()}`);
    }
  }

  // The server's own small pages escape what they show.
  const confirm = await client()(`/api/auth/steam/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, raw: `state=${encodeURIComponent(XSS[0])}&token=x` });
  assert.ok(!confirm.text.includes('<script>alert'), 'no markup echoed');
});

// ---- Path traversal and zip-slip ----

test('path traversal: zips, pack manifests and pack downloads can\'t put a file outside their folder', async () => {
  // A zip made elsewhere: the entry's name is swapped in after writing (writeZip itself refuses such names).
  for (const evil of ['../../evil.dll', '..\\..\\evil.dll', '/etc/passwd', 'C:/Windows/evil.dll', 'a/../../evil.dll', 'ok/./x']) {
    const stand = 'q'.repeat(evil.length);
    const zip = writeZip([{ name: 'pack.json', data: Buffer.from('{}') }, { name: stand, data: Buffer.from('x') }]);
    const hostile = Buffer.from(zip.toString('latin1').split(stand).join(evil), 'latin1');
    assert.throws(() => readZip(hostile), /isn't allowed|isn't a relative path/, evil);
    assert.throws(() => writeZip([{ name: evil, data: Buffer.from('x') }]), /isn't allowed|isn't a relative path/);
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gs-sec-'));
  const keys = crypto.generateKeyPairSync('ed25519');
  try {
    await fsp.writeFile(path.join(dir, 'x.pak'), 'data');
    for (const target of ['../../evil.dll', '..\\evil.dll', '/abs/evil.pak', 'C:\\evil_P.pak', 'Content/Paks/~mods/../../../evil_P.pak', 'CON.pak']) {
      await assert.rejects(
        writePack(dir, { id: 'evil', version: '1.0.0', engine: 'unreal', title: 'Evil', game: { steamAppId: 1 }, files: [{ source: 'x.pak', target }], privateKey: keys.privateKey }),
        /isn't a plain path|isn't allowed|not a plain|must be relative|can't use safely/i,
        target,
      );
    }
    // Programs and libraries can't go into a game through an ordinary pack.
    await assert.rejects(
      writePack(dir, { id: 'evil', version: '1.0.0', engine: 'loose', title: 'Evil', game: { steamAppId: 1 }, files: [{ source: 'x.pak', target: 'evil.dll' }], privateKey: keys.privateKey }),
      /isn't allowed/,
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---- Unsigned or tampered packs and recipes ----

test('unsigned, tampered or wrongly signed packs and recipes are refused', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const other = crypto.generateKeyPairSync('ed25519');
  const pub = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gs-sec-'));
  try {
    await fsp.writeFile(path.join(dir, 'fingerprints.json'), JSON.stringify({ kind: 'gameshelf-fingerprints', format: 2, normalization: 1, entries: [] }));
    const details = { id: 'demo', version: '1.0.0', engine: 'overlay', title: 'Demo', game: { steamAppId: 1 }, files: [{ source: 'fingerprints.json', target: 'fingerprints.json' }] };
    await writePack(dir, { ...details, privateKey: keys.privateKey });
    assert.equal((await readPack(dir, { publicKey: pub })).manifest.id, 'demo');
    // Tampered manifest.
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'pack.json'), 'utf8'));
    await fsp.writeFile(path.join(dir, 'pack.json'), JSON.stringify({ ...manifest, title: 'Evil' }, null, 2));
    await assert.rejects(readPack(dir, { publicKey: pub }), /signature|signed/i);
    // Signed with someone else's key.
    await writePack(dir, { ...details, privateKey: other.privateKey });
    await assert.rejects(readPack(dir, { publicKey: pub }), /signature|signed/i);
    // No signature at all.
    await fsp.rm(path.join(dir, 'pack.json.sig'));
    await assert.rejects(readPack(dir, { publicKey: pub }), /isn't signed/);
    // A payload file changed after signing.
    await writePack(dir, { ...details, privateKey: keys.privateKey });
    await fsp.writeFile(path.join(dir, 'fingerprints.json'), '{"evil":true}');
    await assert.rejects(readPack(dir, { publicKey: pub }), /SHA-256|changed|doesn't match|size/i);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }

  const recipes = createEngineRecipes({ db: openDatabase(':memory:'), publicKeys: [pub] });
  const recipe = JSON.stringify({ format: 1, engine: 'custom', family: 'test', match: {}, steps: [] });
  const good = crypto.sign(null, Buffer.from(recipe), keys.privateKey).toString('base64');
  assert.throws(() => recipes.attach('steam:1', { recipe, signature: '' }), /isn't signed/);
  assert.throws(() => recipes.attach('steam:1', { recipe, signature: crypto.sign(null, Buffer.from(recipe), other.privateKey).toString('base64') }), /isn't signed/);
  assert.throws(() => recipes.attach('steam:1', { recipe: recipe.replace('"test"', '"evil"'), signature: good }), /isn't signed/, 'tampered after signing');
});

// ---- Steam sign-in ----

test('forged Steam sign-ins are refused, and Valve is asked directly', async () => {
  const me = await signedUp('steam_victim');
  const go = await me('/api/auth/steam/link');
  const returnTo = new URL(go.location).searchParams.get('openid.return_to');
  const answer = (tweak = {}) => {
    const claimed = 'https://steamcommunity.com/openid/id/76561198000000099';
    const fields = {
      'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'id_res', 'openid.op_endpoint': OP,
      'openid.claimed_id': claimed, 'openid.identity': claimed, 'openid.return_to': returnTo,
      'openid.response_nonce': `${new Date().toISOString().slice(0, 19)}Zabc`, 'openid.assoc_handle': '1',
      'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle', 'openid.sig': 'x', ...tweak,
    };
    return `${returnTo}&${new URLSearchParams(fields)}`.replace(base, '');
  };
  valveSays.valid = true;
  for (const [tweak, why] of [
    [{ 'openid.op_endpoint': 'https://evil.example/openid/login' }, /didn't come from Steam/],
    [{ 'openid.op_endpoint': 'https://steamcommunity.com.evil.example/openid/login' }, /didn't come from Steam/],
    [{ 'openid.claimed_id': 'https://evil.example/openid/id/76561198000000099' }, /doesn't name a Steam account/],
    [{ 'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000001' }, /doesn't name a Steam account/],
    [{ 'openid.return_to': 'https://evil.example/api/auth/steam/return?state=x' }, /another address/],
  ]) {
    const r = await me(answer(tweak));
    assert.match(decodeURIComponent(r.location || ''), why, JSON.stringify(tweak));
  }
  // A perfect-looking answer Valve doesn't vouch for.
  valveSays.valid = false;
  assert.match(decodeURIComponent((await me(answer())).location), /didn't confirm/);
  assert.equal((await me('/api/me/steam')).body.linked, false);
  // The check goes to Steam's endpoint, POST, and never follows a redirect.
  const src = fs.readFileSync(path.join(ROOT, 'src/steam-openid.js'), 'utf8');
  assert.match(src, /fetchImpl\(OP, \{\s*method: 'POST'/);
  assert.match(src, /redirect: 'error'/);
  assert.equal(OP, 'https://steamcommunity.com/openid/login');
});

// ---- IDOR ----

test('IDOR: one player can\'t read, reply to or close another\'s ticket, or use admin routes', async () => {
  const alice = await signedUp('alice_idor');
  const mallory = await signedUp('mallory_idor');
  const { ticket } = (await alice('/api/support/tickets', { method: 'POST', body: { category: 'account', subject: 'My account', message: 'Private details about my account.' } })).body;
  assert.equal((await mallory(`/api/support/tickets/${ticket.id}`)).status, 404);
  assert.equal((await mallory(`/api/support/tickets/${ticket.id}/messages`, { method: 'POST', body: { body: 'hijack' } })).status, 404);
  assert.equal((await mallory(`/api/support/tickets/${ticket.id}/close`, { method: 'POST' })).status, 404);
  assert.ok(!(await mallory('/api/support/tickets')).body.tickets.some((t) => t.id === ticket.id));
  for (const [method, route] of [['GET', '/api/admin/support'], ['GET', `/api/admin/support/${ticket.id}`], ['POST', `/api/admin/support/${ticket.id}/messages`], ['PATCH', `/api/admin/support/${ticket.id}`]]) {
    assert.equal((await mallory(route, { method, ...(method === 'GET' ? {} : { body: { body: 'x', status: 'closed' } }) })).status, 403, route);
  }
  // Sessions belong to their owner too.
  const sessions = (await alice('/api/me/sessions')).body.sessions;
  await mallory(`/api/me/sessions/${sessions[0].id}`, { method: 'DELETE' });
  assert.equal((await alice('/api/me')).body.user.username, 'alice_idor');
  assert.equal((await alice(`/api/support/tickets/${ticket.id}`)).body.messages[0].body, 'Private details about my account.');
});

// ---- Cross-site writes, headers, errors ----

test('cross-site writes are refused; headers lock the page down; errors don\'t leak internals', async () => {
  const me = await signedUp('csrf_tester');
  const evil = await me('/api/me', { method: 'PATCH', body: { displayName: 'pwned' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.notEqual((await client()('/api/users/csrf_tester')).body.user.displayName, 'pwned');
  assert.equal((await me('/api/me', { method: 'PATCH', body: { displayName: 'Fine' }, headers: { Origin: base } })).status, 200, 'its own pages still work');

  const page = await client()('/');
  const csp = page.headers.get('content-security-policy');
  for (const part of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'"]) assert.ok(csp.includes(part), part);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-powered-by'), null);
  assert.equal(page.headers.get('access-control-allow-origin'), null, 'no CORS: other sites can\'t read the API');
  const https = await client()('/', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(https.headers.get('strict-transport-security') || '', /max-age=31536000/);

  const broken = await client()('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, raw: '{"username": ' });
  assert.equal(broken.status, 400);
  assert.deepEqual(broken.body, { error: 'Invalid request.' });
  const big = await client()('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, raw: JSON.stringify({ username: 'x'.repeat(600 * 1024) }) });
  assert.equal(big.status, 413);
  assert.ok(!/\bat \w|node_modules|\.js:\d/.test(big.text));
  assert.equal(clientMessage(new TypeError("Cannot read properties of undefined (reading 'x')")), 'Invalid request.');
  assert.equal(clientMessage(new Error('ENOENT: no such file, open /srv/secret/db.sqlite')), 'Invalid request.');
  assert.equal(clientMessage(new TypeError('The game should be "steam:<app id>".')), 'The game should be "steam:<app id>".');
});

// ---- Passwords, tokens and keys ----

test('passwords are scrypt-hashed and compared in constant time; tokens and codes are stored hashed', async () => {
  const stored = hashPassword('correct horse battery');
  assert.match(stored, /^scrypt2\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(verifyPassword('correct horse battery', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
  assert.equal(verifyPassword('x', 'scrypt2$2$1$1$00$00'), false, 'weak or malformed parameters are refused');
  assert.equal(needsRehash(stored), false);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/auth.js'), 'utf8'), /timingSafeEqual/);

  const me = await signedUp('hash_checker');
  const row = db.prepare("SELECT password_hash FROM users WHERE username = 'hash_checker'").get();
  assert.ok(!row.password_hash.includes('a long passphrase'));
  // Only SHA-256 hashes of session tokens are kept.
  const tokens = db.prepare('SELECT token_hash FROM sessions').all().map((r) => r.token_hash);
  assert.ok(tokens.every((t) => /^[0-9a-f]{64}$/.test(t)));
  const login = await client()('/api/auth/login', { method: 'POST', body: { username: 'hash_checker', password: 'a long passphrase' } });
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  const raw = /gs_session=([^;]+)/.exec(cookie)[1];
  assert.ok(!tokens.includes(raw) && !db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(decodeURIComponent(raw)));
  void me;
});

test('the server never holds the private signing key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => packKeys({ PACK_PUBLIC_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), /private key/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-key-'));
  try {
    fs.writeFileSync(path.join(dir, 'k.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    assert.throws(() => packKeys({ PACK_PUBLIC_KEY: path.join(dir, 'k.pem') }), /private key/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(packKeys({ PACK_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }) }).length >= 1);
  // Nothing on the server signs.
  for (const file of fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
    assert.ok(!/crypto\.sign\(|createPrivateKey/.test(text), `src/${file} signs or loads a private key`);
  }
});

// ---- Shell injection ----

test('no shell anywhere: no exec, no shell: true; tools run from argument lists', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'vendor', '.git', 'dist', 'build', 'build-tools', 'halai-outputs'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !p.includes(`${path.sep}test${path.sep}`)) files.push(p);
    }
  };
  walk(ROOT);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/child_process['"]\)\.exec\b|\bexecSync\(|[^.\w]exec\(\s*[`'"]|shell:\s*true/.test(text), `${path.relative(ROOT, file)} uses a shell`);
  }
});

// ---- The desktop app ----

test('desktop: only https pages and known launcher links leave the app', () => {
  for (const ok of ['https://store.steampowered.com/app/367520/', 'https://steamcommunity.com/openid/login?openid.mode=checkid_setup', 'steam://rungameid/367520', 'steam://validate/10',
    'com.epicgames.launcher://apps/abc%3Adef%3AFortnite?action=launch&silent=true', 'ms-settings:display-advancedgraphics']) {
    assert.equal(externalUrl(ok), ok === 'https://store.steampowered.com/app/367520/' ? ok : externalUrl(ok), ok);
    assert.ok(externalUrl(ok), ok);
  }
  for (const bad of ['http://example.com', 'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'steam://run/1//-console', 'steam://rungameid/1 -foo', 'steam://install/1',
    'ms-settings:privacy', 'smb://evil/share', 'https://user:pass@evil.example', 'com.epicgames.launcher://apps/x?action=launch&silent=true&-cmd=calc', '\\\\evil\\share\\x.exe', 'data:text/html,<script>', '']) {
    assert.equal(externalUrl(bad), null, bad);
  }
});

test('desktop: windows are sandboxed, IPC answers only GameShelf\'s top frame, files only from the file picker', () => {
  assert.deepEqual(
    { contextIsolation: SAFE_PREFERENCES.contextIsolation, sandbox: SAFE_PREFERENCES.sandbox, nodeIntegration: SAFE_PREFERENCES.nodeIntegration, webSecurity: SAFE_PREFERENCES.webSecurity, allowRunningInsecureContent: SAFE_PREFERENCES.allowRunningInsecureContent, webviewTag: SAFE_PREFERENCES.webviewTag },
    { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false },
  );
  // Every window in the app uses them, and none turns them off.
  const sources = ['desktop/main.js', 'desktop/localization/overlay-manager.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  for (const text of sources) {
    const windows = text.split('new BrowserWindow(').length - 1;
    assert.equal(text.split('...SAFE_PREFERENCES').length - 1, windows);
    assert.ok(!/nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false|allowRunningInsecureContent:\s*true/.test(text));
  }
  const main = sources[0];
  assert.match(main, /const fromApp = \(event\) => trustedSender\(event, origin\)/);
  assert.match(main, /if \(!fromApp\(event\)\) throw new Error\('Not allowed\.'\)/);
  assert.ok(!/ipcMain\.on\(/.test(main), 'the main window\'s IPC all goes through handle(), which checks the sender');

  const origin = 'http://127.0.0.1:43210';
  assert.equal(trustedSender({ senderFrame: { url: `${origin}/#/`, parent: null } }, origin), true);
  assert.equal(trustedSender({ senderFrame: { url: 'https://www.youtube-nocookie.com/embed/x', parent: {} } }, origin), false, 'an embedded trailer');
  assert.equal(trustedSender({ senderFrame: { url: `${origin}/x`, parent: {} } }, origin), false, 'a frame inside the page');
  assert.equal(trustedSender({ senderFrame: { url: 'https://evil.example/', parent: null } }, origin), false);
  assert.equal(trustedSender({ senderFrame: null }, origin), false);

  const allow = permissionPolicy({ origin, captureUrl: 'file:///app/desktop/overlay/capture.html' });
  assert.equal(allow('media', `${origin}/`), false, 'the page can\'t use the camera or record the screen');
  assert.equal(allow('media', 'file:///app/desktop/overlay/capture.html'), true);
  for (const p of ['geolocation', 'notifications', 'midi', 'hid', 'serial', 'usb', 'openExternal', 'clipboard-read']) assert.equal(allow(p, `${origin}/`), false, p);
  assert.equal(allow('clipboard-sanitized-write', `${origin}/#/settings`), true);
  assert.equal(allow('clipboard-sanitized-write', 'https://evil.example/'), false);

  const picked = createPickedPaths();
  picked.remember(path.join(os.tmpdir(), 'Game Folder'));
  assert.equal(picked.check(path.join(os.tmpdir(), 'Game Folder')), path.resolve(os.tmpdir(), 'Game Folder'));
  assert.throws(() => picked.check(path.join(os.tmpdir(), 'Game Folder', '..', '..', 'Windows', 'System32')), /wasn't chosen/);
  assert.throws(() => picked.check('C:\\Windows\\System32\\drivers\\etc\\hosts'), /wasn't chosen/);
});
