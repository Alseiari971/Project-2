const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createDiscordPresence, buildActivity, encode, createDecoder } = require('../desktop/discord');

test('messages survive being split or joined in transit', () => {
  const got = [];
  const decode = createDecoder((op, data) => got.push([op, data]));
  const bytes = Buffer.concat([encode(1, { a: 1 }), encode(3, { b: 2 })]);
  decode(bytes.subarray(0, 5));
  decode(bytes.subarray(5, 20));
  decode(bytes.subarray(20));
  assert.deepStrictEqual(got, [[1, { a: 1 }], [3, { b: 2 }]]);
});

test('the activity shows the game, its launcher, play time, cover and a link', () => {
  assert.deepStrictEqual(buildActivity({
    name: 'Resident Evil Requiem', launcher: 'Steam', startedAt: 1700000000000,
    image: 'https://images.igdb.com/cover.jpg', badge: 'https://example.com/gameshelf.png', url: 'https://www.igdb.com/games/resident-evil-requiem',
  }), {
    type: 0,
    details: 'Resident Evil Requiem',
    state: 'On Steam',
    timestamps: { start: 1700000000000 },
    instance: false,
    assets: {
      large_image: 'https://images.igdb.com/cover.jpg',
      large_text: 'Resident Evil Requiem',
      small_image: 'https://example.com/gameshelf.png',
      small_text: 'GameShelf',
    },
    buttons: [{ label: 'View game', url: 'https://www.igdb.com/games/resident-evil-requiem' }],
    status_display_type: 2,
  });
  // Games added by hand, without a cover or a public page.
  const plain = buildActivity({ name: 'My Mod', launcher: 'This PC', startedAt: 1, image: null, url: 'http://insecure' });
  assert.strictEqual(plain.state, 'On PC');
  assert.strictEqual('assets' in plain, false);
  assert.strictEqual('buttons' in plain, false);
});

// A stand-in for the Discord app's local connection.
function fakeDiscord() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-'));
  const socketPath = path.join(dir, 'discord-ipc-0');
  const received = [];
  let rejectStatusOption = false;
  const server = net.createServer((conn) => {
    conn.on('data', createDecoder((op, data) => {
      received.push([op, data]);
      if (op === 0) conn.write(encode(1, { cmd: 'DISPATCH', evt: 'READY', data: {} }));
      if (op === 1 && rejectStatusOption && data.args.activity?.status_display_type) {
        conn.write(encode(1, { cmd: 'SET_ACTIVITY', evt: 'ERROR', nonce: data.nonce, data: { message: 'unknown field' } }));
      }
    }));
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve({
    socketPath, received, server, rejectOption: () => { rejectStatusOption = true; },
  })));
}

const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

test('connects to Discord, sets the activity, and clears it', async () => {
  const discord = await fakeDiscord();
  const presence = createDiscordPresence({ clientId: '1234567890123456789', paths: ['/no/such/pipe', discord.socketPath] });
  presence.set({ name: 'Hades', launcher: 'Steam', startedAt: 5, image: null, url: null });
  await until(() => discord.received.length >= 2);
  assert.deepStrictEqual(discord.received[0], [0, { v: 1, client_id: '1234567890123456789' }]);
  assert.strictEqual(discord.received[1][1].cmd, 'SET_ACTIVITY');
  assert.strictEqual(discord.received[1][1].args.activity.details, 'Hades');

  presence.set(null);
  await until(() => discord.received.length >= 3);
  assert.strictEqual(discord.received[2][1].args.activity, null);
  presence.close();
  discord.server.close();
});

test('an older Discord that refuses the status line option gets the activity without it', async () => {
  const discord = await fakeDiscord();
  discord.rejectOption();
  const presence = createDiscordPresence({ clientId: '1234567890123456789', paths: [discord.socketPath] });
  presence.set({ name: 'Hades', launcher: 'Steam', startedAt: 5, image: null, url: null });
  await until(() => discord.received.length >= 3);
  assert.strictEqual(discord.received[2][1].args.activity.details, 'Hades');
  assert.strictEqual('status_display_type' in discord.received[2][1].args.activity, false);
  presence.close();
  discord.server.close();
});
