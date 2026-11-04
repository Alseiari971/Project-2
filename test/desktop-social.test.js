// The desktop app's side of Steam linking and presence: reading which Steam
// account is signed in on this PC (shown only, never sent to link), and the
// heartbeat loop that tells friends what's running.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseLoginUsers, localSteamAccount } = require('../desktop/steam-account');
const { createPresenceLoop } = require('../desktop/presence');

const LOGINUSERS = `"users"
{
	"76561198000000011"
	{
		"AccountName"		"old_account"
		"PersonaName"		"Old One"
		"RememberPassword"		"1"
		"MostRecent"		"0"
		"Timestamp"		"1700000000"
	}
	"76561198000000022"
	{
		"AccountName"		"hamad_ae"
		"PersonaName"		"Hamad \\"H\\" 🇦🇪"
		"RememberPassword"		"1"
		"mostrecent"		"1"
		"Timestamp"		"1760000000"
	}
}`;

test('the Steam account signed in on this PC comes from loginusers.vdf (MostRecent "1")', async () => {
  assert.deepEqual(parseLoginUsers(LOGINUSERS), { steamId: '76561198000000022', accountName: 'hamad_ae', personaName: 'Hamad "H" 🇦🇪' });
  // One account, even without MostRecent: that one.
  assert.equal(parseLoginUsers('"users" { "76561198000000011" { "AccountName" "solo" } }').accountName, 'solo');
  // Several and none marked, junk, or not a SteamID64: nothing.
  assert.equal(parseLoginUsers('"users" { "76561198000000011" { } "76561198000000022" { } }'), null);
  assert.equal(parseLoginUsers('"users" { "12345" { "MostRecent" "1" } }'), null);
  assert.equal(parseLoginUsers('not a vdf'), null);
  assert.equal(parseLoginUsers(''), null);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-steam-'));
  try {
    assert.equal(await localSteamAccount([root]), null, 'Steam not signed in');
    await fs.mkdir(path.join(root, 'config'));
    await fs.writeFile(path.join(root, 'config', 'loginusers.vdf'), LOGINUSERS);
    assert.equal((await localSteamAccount([path.join(root, 'missing'), root])).steamId, '76561198000000022');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function fakeCloud({ signedIn = true } = {}) {
  const beats = [];
  return {
    beats,
    signedIn,
    session: async function session() { return this.signedIn ? 'token' : null; },
    async json(route, { body }) {
      assert.equal(route, '/api/presence/heartbeat');
      beats.push(body);
      return { presence: body };
    },
  };
}

test('the presence loop beats on a timer, at once when the game changes, and offline when it stops', async () => {
  const cloud = fakeCloud();
  cloud.session = cloud.session.bind(cloud);
  const timers = [];
  let now = { status: 'online' };
  const loop = createPresenceLoop({
    cloud,
    current: async () => now,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  loop.start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(cloud.beats, [{ status: 'online' }]);
  assert.equal(timers.at(-1).ms, 45000);

  // Nothing changed: no extra beat.
  assert.equal(await loop.nudge(), null);
  assert.equal(cloud.beats.length, 1);

  // A game starts, with Arabic on: friends hear now.
  now = { status: 'in_game', gameId: 'hollow-knight', gameTitle: 'Hollow Knight', steamAppId: 367520, arabicEnabled: true };
  await loop.nudge();
  assert.deepEqual(cloud.beats.at(-1), now);

  // The timer keeps it fresh.
  await timers.at(-1).fn();
  assert.equal(cloud.beats.length, 3);

  // Signed out: the loop keeps going but sends nothing.
  cloud.signedIn = false;
  await timers.at(-1).fn();
  assert.equal(cloud.beats.length, 3);
  cloud.signedIn = true;

  await loop.stop();
  assert.deepEqual(cloud.beats.at(-1), { status: 'offline' });
  const count = cloud.beats.length;
  assert.equal(await loop.beat(), null, 'stopped: no more beats');
  assert.equal(cloud.beats.length, count);
});

test('a server that can\'t be reached doesn\'t stop the loop', async () => {
  const timers = [];
  const loop = createPresenceLoop({
    cloud: { session: async () => 'token', json: async () => { throw new Error('offline'); } },
    current: async () => ({ status: 'online' }),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return 1; },
    clearTimer: () => {},
  });
  loop.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.length, 1, 'tries again at the next beat');
  await loop.stop();
});
