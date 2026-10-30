// Discord activity ("Rich Presence"): shows the game being played on the
// player's Discord profile. It talks to the Discord app on this computer over
// its local connection, so no Discord login or token is involved; it needs the
// ID of a Discord application named GameShelf (see README). When Discord isn't
// open, nothing happens and it tries again later.
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const RETRY_MS = 20 * 1000;
// Discord's status line shows the activity's details (the game's name) rather than "GameShelf".
const SHOW_DETAILS = 2;

function pipePaths() {
  if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp';
  return Array.from({ length: 10 }, (_, i) => path.join(base, `discord-ipc-${i}`));
}

/** One message to Discord: operation code, length, then JSON. */
function encode(op, data) {
  const body = Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Splits incoming bytes into messages, which can arrive split or joined together. */
function createDecoder(onMessage) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 8) {
      const op = pending.readInt32LE(0);
      const length = pending.readInt32LE(4);
      if (pending.length < 8 + length) return;
      let data = null;
      try {
        data = JSON.parse(pending.subarray(8, 8 + length).toString('utf8'));
      } catch {}
      pending = pending.subarray(8 + length);
      onMessage(op, data);
    }
  };
}

const clip = (text, max) => String(text).slice(0, max);
const isHttps = (url) => typeof url === 'string' && url.startsWith('https://') && url.length <= 512;

/**
 * What Discord shows: the game, the launcher, time played, its cover with a
 * GameShelf badge, and buttons (seen by friends, not on your own profile) to
 * the game's page and to where to get GameShelf.
 */
function buildActivity({ name, launcher, startedAt, image, badge, url, getUrl }, { showDetails = true } = {}) {
  const activity = {
    type: 0,
    details: clip(name, 128).padEnd(2, ' '),
    state: launcher === 'This PC' ? 'On PC' : `On ${launcher}`,
    timestamps: { start: startedAt },
    instance: false,
  };
  const assets = {};
  if (isHttps(image)) Object.assign(assets, { large_image: image, large_text: clip(name, 128).padEnd(2, ' ') });
  // The small round badge on the cover's corner.
  if (isHttps(badge)) Object.assign(assets, { small_image: badge, small_text: 'GameShelf' });
  if (Object.keys(assets).length) activity.assets = assets;
  const buttons = [
    isHttps(url) && { label: 'View game', url },
    isHttps(getUrl) && { label: 'Get GameShelf', url: getUrl },
  ].filter(Boolean);
  if (buttons.length) activity.buttons = buttons;
  if (showDetails) activity.status_display_type = SHOW_DETAILS;
  return activity;
}

function createDiscordPresence({ clientId, connect = net.createConnection, paths = pipePaths() }) {
  let socket = null;
  let ready = false;
  let connecting = false;
  let closed = false;
  let retryTimer = null;
  let wanted = null; // what to show, or null for nothing
  let showDetails = true;
  let lastNonce = null;

  const scheduleRetry = () => {
    clearTimeout(retryTimer);
    if (wanted && !closed) retryTimer = setTimeout(tryConnect, RETRY_MS);
  };

  function push() {
    if (!ready) return;
    lastNonce = crypto.randomUUID();
    socket.write(encode(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: wanted ? buildActivity(wanted, { showDetails }) : null },
      nonce: lastNonce,
    }));
  }

  function attach(s) {
    socket = s;
    s.on('data', createDecoder((op, data) => {
      if (op === OP.PING) s.write(encode(OP.PONG, data));
      else if (op === OP.CLOSE) s.destroy();
      else if (op === OP.FRAME && data?.evt === 'READY') {
        ready = true;
        push();
      } else if (op === OP.FRAME && data?.evt === 'ERROR' && data.nonce === lastNonce && showDetails) {
        // An older Discord that doesn't know the status line option: send it without.
        showDetails = false;
        push();
      }
    }));
    s.on('error', () => {});
    s.on('close', () => {
      socket = null;
      ready = false;
      scheduleRetry();
    });
    s.write(encode(OP.HANDSHAKE, { v: 1, client_id: clientId }));
  }

  async function tryConnect() {
    if (connecting || socket || closed || !clientId) return;
    connecting = true;
    for (const p of paths) {
      const s = await new Promise((resolve) => {
        const c = connect(p);
        c.once('connect', () => resolve(c));
        c.once('error', () => resolve(null));
      });
      if (s) {
        attach(s);
        break;
      }
    }
    connecting = false;
    if (!socket) scheduleRetry();
  }

  return {
    /** Shows `activity` ({ name, launcher, startedAt, image, url }), or clears it with null. */
    set(activity) {
      const same = JSON.stringify(activity) === JSON.stringify(wanted);
      wanted = activity;
      if (ready) {
        if (!same) push();
      } else if (activity) {
        tryConnect();
      }
    },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      socket?.destroy();
    },
  };
}

module.exports = { createDiscordPresence, buildActivity, encode, createDecoder };
