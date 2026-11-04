// Players and admins improving GameShelf's Arabic: the glossary made before a
// game is translated (and given to every batch), votes and the "Most
// requested games" leaderboard, "Report a translation issue" with one-click
// approval and a signed update of the game's Arabic, and the Arabic font an
// admin picks for a game.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { openDatabase } = require('../src/db');
const { createLocalProvider } = require('../src/games/local');
const { createTranslationMemory, sha256 } = require('../src/translation-memory');
const { createArabicGames } = require('../src/arabic-games');
const { createSubmissions } = require('../src/submissions');
const { createCloudClient } = require('../desktop/cloud');
const { createStudio } = require('../desktop/localization/studio');
const { findBuilder } = require('../desktop/localization/builder');
const { parseCsv, readLines, search } = require('../desktop/localization/lines');

const REPO = path.join(__dirname, '..');
const keys = crypto.generateKeyPairSync('ed25519');
const PUBLIC = keys.publicKey.export({ type: 'spki', format: 'pem' });
const sign = (text) => crypto.sign(null, Buffer.from(text, 'utf8'), keys.privateKey).toString('base64');

/** A stand-in for the AI provider: glossaries for glossary requests, "عربي ..." for lines; it records every request. */
function fakeAi() {
  const asked = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const [system, user] = [body.messages[0].content, body.messages[1].content];
    asked.push({ system, user });
    let content;
    if (system.startsWith('You prepare a translation glossary')) {
      const { terms, samples } = JSON.parse(user);
      content = { terms: Object.fromEntries(terms.map((t) => [t, `عربي-${t}`])), player: { gender: samples.some((s) => /my lady/i.test(s)) ? 'feminine' : 'unknown', name: '' } };
    } else {
      const lines = JSON.parse(user.slice(user.indexOf('[')));
      content = { translations: lines.map(({ id, text }) => ({ id, arabic: `عربي ${text}` })) };
    }
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  };
  return { asked, fetch };
}

async function start(t, { env = {} } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-community-'));
  const saved = process.env.ADMIN_USERS;
  process.env.ADMIN_USERS = 'hamad';
  t.after(async () => {
    if (saved === undefined) delete process.env.ADMIN_USERS;
    else process.env.ADMIN_USERS = saved;
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const db = openDatabase(':memory:');
  const ai = fakeAi();
  const translations = createTranslationMemory({ db, env: { OPENAI_API_KEY: 'server-key', ...env }, fetch: ai.fetch });
  const arabicGames = createArabicGames({ db, translations });
  const submissions = createSubmissions({ db, translations, publicKeys: [PUBLIC] });
  const server = createApp({ db, games: createLocalProvider(), translations, dataDir: tmp, arabicGames, submissions }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const users = {};
  const as = async (username) => {
    if (!users[username]) {
      const res = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'correct horse', email: `${username}@test.example`, nationality: 'AE' }) });
      const cookie = /gs_session=([^;]+)/.exec(res.headers.get('set-cookie'))[1];
      users[username] = createCloudClient({ server: () => base, session: async () => cookie });
    }
    return users[username];
  };
  const anonymous = createCloudClient({ server: () => base, session: async () => null });
  return { tmp, db, ai, base, as, anonymous, translations, submissions };
}

const status = (code) => (err) => err.status === code;

// ---- The glossary -------------------------------------------------------------------

test('a game\'s glossary is made once, grows with new terms, keeps an admin\'s edits, and every batch gets its own terms', async (t) => {
  const { ai, as, translations } = await start(t);
  const alice = await as('alice');
  const game = 'steam:4242';
  const made = await alice.json('/api/translations/glossary', { method: 'POST', body: { game, terms: ['Brok', 'Midgard', 'Health Potion'], samples: ['Thank you, my lady.'], context: 'A Norse saga' } });
  assert.deepEqual(made, { terms: { Brok: 'عربي-Brok', Midgard: 'عربي-Midgard', 'Health Potion': 'عربي-Health Potion' }, player: { gender: 'feminine', name: '' } });
  assert.equal(ai.asked.length, 1);
  assert.match(ai.asked[0].user, /A Norse saga/);

  // The same terms again: nothing asked. New ones: only those.
  await alice.json('/api/translations/glossary', { method: 'POST', body: { game, terms: ['Brok', 'Midgard'], samples: ['Thank you, my lady.'] } });
  assert.equal(ai.asked.length, 1);
  await alice.json('/api/translations/glossary', { method: 'POST', body: { game, terms: ['Brok', 'Leviathan Axe'], samples: [] } });
  assert.deepEqual(JSON.parse(ai.asked[1].user).terms, ['Leviathan Axe']);

  // An admin fixes a name and the player's gender; the automatic pass never changes them back.
  await assert.rejects(alice.json(`/api/admin/glossaries/${encodeURIComponent(game)}`, { method: 'PUT', body: {} }), status(403));
  const admin = await as('hamad');
  const fixed = await admin.json(`/api/admin/glossaries/${encodeURIComponent(game)}`, {
    method: 'PUT', body: { terms: { Brok: 'بروك', Midgard: 'ميدغارد', Bad: 'Not Arabic' }, player: { gender: 'masculine', name: 'Atreus' } },
  });
  assert.deepEqual([fixed.glossary.terms, fixed.glossary.locked, fixed.glossary.player.gender], [{ Brok: 'بروك', Midgard: 'ميدغارد' }, true, 'masculine']);
  await alice.json('/api/translations/glossary', { method: 'POST', body: { game, terms: ['Brok', 'Freya'], samples: ['Thank you, my lady.'] } });
  const now = translations.glossary(game);
  assert.deepEqual([now.terms.Brok, now.terms.Freya, now.player.gender], ['بروك', 'عربي-Freya', 'masculine']);

  // Translating: each batch is told the Arabic for the terms in its own lines, and how to speak to the player.
  const lines = ['Brok forged the axe.', 'Freya waits in Midgard.', 'Press any key.'].map((english) => ({ hash: sha256(english), english }));
  await alice.json('/api/translations/translate', { method: 'POST', body: { game, lines } });
  const { system } = ai.asked.at(-1);
  assert.match(system, /- Brok -> بروك/);
  assert.match(system, /- Freya -> عربي-Freya/);
  assert.match(system, /- Midgard -> ميدغارد/);
  assert.doesNotMatch(system, /Health Potion/);
  assert.match(system, /The player character is male \(Atreus\).*أنتَ/);
});

test('the glossary pass counts toward the day\'s translation limit', async (t) => {
  const { ai, as } = await start(t, { env: { TRANSLATE_DAILY_LINES: '3' } });
  const alice = await as('alice');
  const answer = await alice.json('/api/translations/glossary', { method: 'POST', body: { game: 'steam:1', terms: ['Alpha', 'Beta', 'Gamma', 'Delta'], samples: [] } });
  assert.deepEqual(answer.terms, {});
  assert.equal(ai.asked.length, 0);
  await alice.json('/api/translations/glossary', { method: 'POST', body: { game: 'steam:1', terms: ['Alpha', 'Beta'], samples: [] } });
  assert.equal(ai.asked.length, 1);
});

// ---- Votes and the leaderboard ----------------------------------------------------------

test('votes, the most requested games first, and taking a vote back', async (t) => {
  const { db, as, anonymous } = await start(t);
  const vote = async (who, game, name) => (await as(who)).json('/api/arabic/requests', { method: 'POST', body: { game, name } });
  for (const who of ['amira', 'bilal', 'carmen']) await vote(who, 'steam:100', 'Lantern');
  for (const who of ['amira', 'bilal']) await vote(who, 'steam:200', 'Forge');
  await vote('carmen', 'steam:300', 'Tide');
  await vote('carmen', 'steam:300', 'Tide'); // one vote per player
  // A game whose Arabic is approved is done: it leaves the board.
  await vote('amira', 'steam:400', 'Done Already');
  db.prepare(`INSERT INTO arabic_sets (id, version, game, engine, tier, body, signature, sha256, size) VALUES ('gameshelf-steam-400-ar', '1.1.0', 'steam:400', 'unity', 'unity-bepinex', '{}', 'x', 'x', 2)`).run();

  const board = (await anonymous.json('/api/arabic/leaderboard')).games;
  assert.deepEqual(board.map((g) => [g.rank, g.game, g.name, g.votes, g.voted, g.steamAppId]),
    [[1, 'steam:100', 'Lantern', 3, false, 100], [2, 'steam:200', 'Forge', 2, false, 200], [3, 'steam:300', 'Tide', 1, false, 300]]);
  const mine = (await (await as('carmen')).json('/api/arabic/leaderboard')).games;
  assert.deepEqual(mine.map((g) => g.voted), [true, false, true]);

  const after = await (await as('carmen')).json('/api/arabic/requests/steam%3A100', { method: 'DELETE' });
  assert.deepEqual([after.requests, after.asked], [2, false]);
  assert.deepEqual((await anonymous.json('/api/arabic/leaderboard')).games.map((g) => [g.game, g.votes]), [['steam:100', 2], ['steam:200', 2], ['steam:300', 1]]);
  await assert.rejects(anonymous.json('/api/arabic/requests/steam%3A100', { method: 'DELETE' }), status(401));
});

// ---- Translation fixes -------------------------------------------------------------------

async function approvedGame(t) {
  const ctx = await start(t);
  const alice = await ctx.as('alice');
  const game = 'steam:4242';
  const english = ['Hello, {0}! Welcome to Riverwood.', 'The bridge is out.'];
  await alice.json('/api/translations/translate', { method: 'POST', body: { game, lines: english.map((e) => ({ hash: sha256(e), english: e })) } });
  const { id } = await alice.json('/api/arabic/submissions', { method: 'POST', body: { game, name: 'Riverwood', engine: 'renpy', lines: english } });
  const admin = await ctx.as('hamad');
  const { set } = await admin.json(`/api/admin/submissions/${id}/set`);
  await admin.json(`/api/admin/submissions/${id}/approve`, { method: 'POST', body: { set, signature: sign(set) } });
  return { ...ctx, alice, admin, game, english };
}

test('a player reports a line; an admin approves it in one click, and the game\'s Arabic is signed again with it', async (t) => {
  const { tmp, as, alice, admin, anonymous, game, english, translations } = await approvedGame(t);
  const report = (who, body) => who.json('/api/arabic/fixes', { method: 'POST', body: { game, ...body } });
  // Checked before it waits: tags kept, something changed, signed in.
  await assert.rejects(report(alice, { english: english[0], current: 'عربي Hello, {0}! Welcome to Riverwood.', suggestion: 'مرحبًا! أهلًا بك في ريفروود.' }), /changed \{0\}|\{0\}/);
  await assert.rejects(report(alice, { english: english[1], current: 'عربي The bridge is out.', suggestion: 'عربي The bridge is out.' }), /same as the Arabic/);
  await assert.rejects(report(anonymous, { english: english[1], suggestion: 'الجسر مدمر.' }), status(401));
  const first = await report(alice, { english: english[1], current: 'عربي The bridge is out.', suggestion: 'الجسر مكسور.', note: 'sounds odd' });
  const again = await report(alice, { english: english[1], current: 'عربي The bridge is out.', suggestion: 'الجسر مدمّر.' });
  assert.deepEqual([again.id, again.updated], [first.id, true]); // one waiting report per player and line
  await report(await as('bob'), { english: english[1], current: 'عربي The bridge is out.', suggestion: 'انهار الجسر.' });

  await assert.rejects(alice.json('/api/admin/fixes'), status(403));
  const { fixes, published } = await admin.json('/api/admin/fixes');
  assert.deepEqual(fixes.map((f) => [f.english, f.suggestion, f.reports, f.reporter]).sort(),
    [['The bridge is out.', 'الجسر مدمّر.', 2, 'alice'], ['The bridge is out.', 'انهار الجسر.', 2, 'bob']]);
  assert.equal(published[game], true);
  assert.equal(fixes[0].name, 'Riverwood');

  // Approving, with the admin's own wording: reviewed Arabic in the memory, the other report settled with it.
  const mine = fixes.find((f) => f.reporter === 'alice');
  const approved = await admin.json(`/api/admin/fixes/${mine.id}/approve`, { method: 'POST', body: { arabic: 'الجسر مُدمَّر.' } });
  assert.deepEqual([approved.fix.status, approved.fix.suggestion, approved.republish], ['approved', 'الجسر مُدمَّر.', true]);
  assert.deepEqual(translations.lookup(game, [sha256(english[1])]), { [sha256(english[1])]: 'الجسر مُدمَّر.' });
  assert.deepEqual((await admin.json('/api/admin/fixes')).fixes, []);
  await assert.rejects(admin.json(`/api/admin/fixes/${mine.id}/approve`, { method: 'POST', body: {} }), status(409));

  // "Sign & publish fixes": the admin's app signs the game's Arabic again, as a new version, with the fix in it.
  const keyFile = path.join(tmp, 'admin', 'pack-signing.key');
  await fs.mkdir(path.dirname(keyFile), { recursive: true });
  await fs.writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const studio = createStudio({ paths: findBuilder({ packaged: false, repoDir: REPO, env: {} }), dataDir: path.join(tmp, 'admin'), cloud: admin, appKeys: [PUBLIC] });
  studio.saveSettings({ keyFile });
  const pack = await studio.republish(game);
  assert.equal(pack.version, '1.2.0');
  const { set } = await alice.json(`/api/localization/sets/${pack.id}/download`);
  assert.deepEqual(JSON.parse(set).lines.find(([hash]) => hash === sha256(english[1])), [sha256(english[1]), 'الجسر مُدمَّر.']);
  assert.equal((await anonymous.json('/api/localization/packs')).packs.find((p) => p.id === pack.id).version, '1.2.0');
  // Signed with anything else, or the same version twice: refused.
  const next = await admin.json(`/api/admin/sets/${encodeURIComponent(game)}/next`);
  const other = crypto.generateKeyPairSync('ed25519');
  await assert.rejects(admin.json(`/api/admin/sets/${encodeURIComponent(game)}/publish`, { method: 'POST', body: { set: next.set, signature: crypto.sign(null, Buffer.from(next.set), other.privateKey).toString('base64') } }), /signature/);
  await admin.json(`/api/admin/sets/${encodeURIComponent(game)}/publish`, { method: 'POST', body: { set: next.set, signature: sign(next.set) } });
  await assert.rejects(admin.json(`/api/admin/sets/${encodeURIComponent(game)}/publish`, { method: 'POST', body: { set: next.set, signature: sign(next.set) } }), status(409));
});

test('turning a report down leaves the Arabic as it was', async (t) => {
  const { alice, admin, game, english, translations } = await approvedGame(t);
  const { id } = await alice.json('/api/arabic/fixes', { method: 'POST', body: { game, english: english[1], current: 'عربي The bridge is out.', suggestion: 'الجسر ذهب.' } });
  assert.equal((await admin.json(`/api/admin/fixes/${id}/reject`, { method: 'POST', body: {} })).fix.status, 'rejected');
  assert.deepEqual(Object.values(translations.lookup(game, [sha256(english[1])])), ['عربي The bridge is out.']);
  assert.equal((await admin.json('/api/admin/fixes?status=rejected')).fixes.length, 1);
});

// ---- The admin's font for a game ----------------------------------------------------------

test('an admin picks the Arabic font for a game, and its signed Arabic carries it', async (t) => {
  const { as, game } = await approvedGame(t);
  const alice = await as('alice');
  const admin = await as('hamad');
  await assert.rejects(alice.json(`/api/admin/games/${encodeURIComponent(game)}/font-style`, { method: 'PUT', body: { fontStyle: 'cairo' } }), status(403));
  await assert.rejects(admin.json(`/api/admin/games/${encodeURIComponent(game)}/font-style`, { method: 'PUT', body: { fontStyle: 'papyrus' } }), status(400));
  const saved = await admin.json(`/api/admin/games/${encodeURIComponent(game)}/font-style`, { method: 'PUT', body: { fontStyle: 'naskh' } });
  assert.equal(saved.fontStyle, 'naskh');
  const { set } = await admin.json(`/api/admin/sets/${encodeURIComponent(game)}/next`);
  assert.equal(JSON.parse(set).fontStyle, 'naskh');
});

// ---- The player's side: finding the line -------------------------------------------------------

test('the lines of a game\'s last build on this PC are found by English or Arabic', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-lines-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // As Python's csv module writes translations.csv: a BOM, quotes around commas, quotes and line breaks.
  const file = path.join(dir, 'translations.csv');
  await fs.writeFile(file, '﻿key,source,arabic,problem\r\na,"Hello, {0}!","مرحبًا، {0}!",\r\nb,"She said ""run""","قالت ""اركض""",\r\nc,"Two\nlines","سطران\nاثنان",\r\nd,No Arabic yet,,missing\r\n', 'utf8');
  assert.deepEqual(parseCsv('a,"b,c"\r\n"d""e",f'), [['a', 'b,c'], ['d"e', 'f']]);
  const lines = await readLines(file);
  assert.deepEqual(lines, [{ english: 'Hello, {0}!', arabic: 'مرحبًا، {0}!' }, { english: 'She said "run"', arabic: 'قالت "اركض"' }, { english: 'Two\nlines', arabic: 'سطران\nاثنان' }]);
  assert.deepEqual(search(lines, 'HELLO').map((l) => l.english), ['Hello, {0}!']);
  assert.deepEqual(search(lines, 'اركض').map((l) => l.english), ['She said "run"']);
  assert.deepEqual(await readLines(path.join(dir, 'missing.csv')), []);
});

const { spawnSync, execFile } = require('node:child_process');
const python = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import arabic_reshaper, bidi'], { stdio: 'ignore' }).status === 0);

test('the pack builder asks the server for the game\'s glossary before its lines, and the server gives each batch its terms',
  { skip: !python && 'the pack builder needs Python with its requirements' }, async (t) => {
    const { tmp, ai, base, as } = await start(t);
    await as('alice');
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'correct horse' }) });
    const session = /gs_session=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
    const source = path.join(tmp, 'lines.json');
    await fs.writeFile(source, JSON.stringify(['Take the Leviathan Axe to Brok.', 'Brok forged it long ago.', 'Hold the Leviathan Axe high.', 'Thank you, my lady. You saved us.', 'The bridge is out.'].map((s) => ({ source: s }))));
    // Run without blocking: the server answering it lives in this process.
    const result = await new Promise((resolve) => {
      execFile(python, [path.join(REPO, 'scripts', 'build-arabic-pack.py'), source, '--id', 'g-ar', '--version', '1.0.0', '--steam-app-id', '4242',
        '--out', path.join(tmp, 'out'), '--shared', base, '--review'], { encoding: 'utf8', timeout: 120000, env: { ...process.env, GAMESHELF_SESSION: session, GAMESHELF_TOKEN: '' } },
      (err, stdout, stderr) => resolve({ status: err ? err.code ?? 1 : 0, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(ai.asked[0].system, /^You prepare a translation glossary/);
    assert.deepEqual(JSON.parse(ai.asked[0].user).terms.sort(), ['Brok', 'Leviathan Axe']);
    const glossary = JSON.parse(await fs.readFile(path.join(tmp, 'out', 'glossary.json'), 'utf8'));
    assert.deepEqual([glossary.terms.Brok, glossary.player.gender], ['عربي-Brok', 'feminine']);
    const batch = ai.asked.slice(1).find((a) => a.user.includes('Brok forged'));
    assert.match(batch.system, /- Brok -> عربي-Brok/);
    assert.match(batch.system, /female.*أنتِ/);
    assert.match(result.stdout, /Glossary: 2 names and terms; the player is spoken to as feminine/);
  });
