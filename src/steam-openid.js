// Linking a Steam account, proved with Steam's own sign-in (OpenID 2.0).
//
// GET /api/auth/steam/link (or POST, for the desktop app) sends the player to
// https://steamcommunity.com/openid/login. They sign in to Steam there, and
// Steam sends them back to /api/auth/steam/return with a signed answer naming
// their SteamID64. GameShelf never trusts that answer by itself: it checks the
// return address, the endpoint and the fields that must be signed, then asks
// Valve's server whether the signature is genuine (check_authentication). Only
// a SteamID64 Valve vouches for is linked, and one Steam account can be linked
// to only one GameShelf account.
//
// Each attempt is a single-use state (ten minutes) tied to the GameShelf
// account that started it. When the answer comes back in the same browser,
// signed in to that account, it's linked at once. When it comes back elsewhere
// (the desktop app opens Steam's sign-in in the system browser), a page asks
// "link Steam account … to @username?" first, so a link sent by someone else
// can't attach your Steam account to their GameShelf account unnoticed.
const crypto = require('node:crypto');
const { hashToken } = require('./auth');

const OP = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/;
const STATE_TTL_MS = 10 * 60 * 1000;
const NONCE_MAX_AGE_MS = 10 * 60 * 1000;
const MUST_SIGN = ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle'];

class SteamLinkError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** The address this server is reached at: PUBLIC_URL, or the request's own. */
function baseUrl(req, env = process.env) {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function createSteamOpenId({ db, fetchImpl = fetch, steam = null, now = () => Date.now() }) {
  const q = {
    putState: db.prepare('INSERT INTO steam_link_states (state_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    getState: db.prepare('SELECT * FROM steam_link_states WHERE state_hash = ?'),
    stage: db.prepare('UPDATE steam_link_states SET steam_id = ?, confirm_hash = ? WHERE state_hash = ?'),
    useState: db.prepare('UPDATE steam_link_states SET used = 1 WHERE state_hash = ? AND used = 0'),
    oldStates: db.prepare('DELETE FROM steam_link_states WHERE expires_at < ?'),
    owner: db.prepare('SELECT id, username FROM users WHERE steam_id = ?'),
    link: db.prepare("UPDATE users SET steam_id = ?, steam_name = ?, steam_avatar = ?, steam_linked_at = datetime('now') WHERE id = ?"),
    unlink: db.prepare("UPDATE users SET steam_id = NULL, steam_name = '', steam_avatar = '', steam_linked_at = NULL WHERE id = ?"),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
  };

  const returnTo = (base, state) => `${base}/api/auth/steam/return?state=${encodeURIComponent(state)}`;

  /** Starts a link for `userId`: the address of Steam's sign-in page. */
  function begin(userId, base) {
    q.oldStates.run(now());
    const state = crypto.randomBytes(24).toString('base64url');
    q.putState.run(hashToken(state), userId, now() + STATE_TTL_MS);
    const url = new URL(OP);
    url.search = new URLSearchParams({
      'openid.ns': NS,
      'openid.mode': 'checkid_setup',
      'openid.return_to': returnTo(base, state),
      'openid.realm': base,
      'openid.identity': IDENTIFIER_SELECT,
      'openid.claimed_id': IDENTIFIER_SELECT,
    });
    return { url: url.toString(), state };
  }

  function openState(state) {
    const row = state ? q.getState.get(hashToken(String(state))) : null;
    if (!row || row.used || row.expires_at < now()) throw new SteamLinkError('This Steam sign-in expired. Start linking again from GameShelf.', 410);
    return row;
  }

  /** Checks Steam's answer (the return request's query) and asks Valve whether it's genuine. Returns the SteamID64. */
  async function verify(query, base) {
    const params = Object.fromEntries(Object.entries(query).filter(([k]) => k.startsWith('openid.')).map(([k, v]) => [k, String(v)]));
    if (params['openid.mode'] === 'cancel') throw new SteamLinkError('The Steam sign-in was cancelled.');
    if (params['openid.mode'] !== 'id_res' || params['openid.ns'] !== NS || params['openid.op_endpoint'] !== OP) {
      throw new SteamLinkError('That answer didn\'t come from Steam\'s sign-in.');
    }
    if (params['openid.return_to'] !== returnTo(base, String(query.state || ''))) throw new SteamLinkError('That answer was meant for another address.');
    const claimed = CLAIMED_RE.exec(params['openid.claimed_id'] || '');
    if (!claimed || params['openid.identity'] !== params['openid.claimed_id']) throw new SteamLinkError('That answer doesn\'t name a Steam account.');
    const signed = String(params['openid.signed'] || '').split(',');
    if (!MUST_SIGN.every((field) => signed.includes(field)) || !params['openid.sig']) throw new SteamLinkError('That answer isn\'t signed by Steam.');
    const stamp = Date.parse(String(params['openid.response_nonce'] || '').slice(0, 20));
    if (!Number.isFinite(stamp) || Math.abs(now() - stamp) > NONCE_MAX_AGE_MS) throw new SteamLinkError('That answer from Steam is too old. Try again.');

    let reply;
    try {
      const res = await fetchImpl(OP, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...params, 'openid.mode': 'check_authentication' }).toString(),
        // Straight to Valve: a redirect to anywhere else is a failure, not something to follow.
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      reply = res.ok ? await res.text() : '';
    } catch {
      throw new SteamLinkError('Steam didn\'t answer. Try again in a moment.', 502);
    }
    if (!/^is_valid\s*:\s*true\s*$/m.test(reply)) throw new SteamLinkError('Steam didn\'t confirm that sign-in.');
    return claimed[1];
  }

  // The linked account's public name and avatar (the avatar shows when the player has no picture of their own).
  async function persona(steamId) {
    try {
      if (steam?.playerSummary) return await steam.playerSummary(steamId);
      return { name: (await steam?.playerName?.(steamId)) || '', avatar: '' };
    } catch {
      return { name: '', avatar: '' };
    }
  }

  async function link(userId, steamId) {
    const owner = q.owner.get(steamId);
    if (owner && owner.id !== userId) throw new SteamLinkError('That Steam account is already linked to another GameShelf account.', 409);
    const current = q.user.get(userId);
    if (current.steam_id && current.steam_id !== steamId) throw new SteamLinkError('This GameShelf account is linked to another Steam account. Unlink it first.', 409);
    try {
      const p = await persona(steamId);
      q.link.run(steamId, String(p.name || '').slice(0, 64), String(p.avatar || '').slice(0, 300), userId);
    } catch (err) {
      // Two links racing for the same Steam account: the unique index keeps one.
      if (/UNIQUE/.test(err.message)) throw new SteamLinkError('That Steam account is already linked to another GameShelf account.', 409);
      throw err;
    }
    return status(q.user.get(userId));
  }

  /**
   * Steam's answer arriving at /return. `sessionUserId` is who is signed in to
   * this browser (or null). Returns { linked } or, from another browser,
   * { confirm, steamId, username } for the confirmation page.
   */
  async function complete(query, base, sessionUserId) {
    const row = openState(query.state);
    const steamId = await verify(query, base);
    if (sessionUserId === row.user_id) {
      if (q.useState.run(row.state_hash).changes !== 1) throw new SteamLinkError('This Steam sign-in was already used.', 410);
      return { linked: await link(row.user_id, steamId) };
    }
    const confirm = crypto.randomBytes(24).toString('base64url');
    q.stage.run(steamId, hashToken(confirm), row.state_hash);
    return { confirm, steamId, username: q.user.get(row.user_id).username };
  }

  /** The confirmation page's "Link" button. */
  async function confirm(state, token) {
    const row = openState(state);
    if (!row.steam_id || !row.confirm_hash || !token || hashToken(String(token)) !== row.confirm_hash) {
      throw new SteamLinkError('This Steam sign-in can\'t be confirmed. Start linking again from GameShelf.', 410);
    }
    if (q.useState.run(row.state_hash).changes !== 1) throw new SteamLinkError('This Steam sign-in was already used.', 410);
    return link(row.user_id, row.steam_id);
  }

  function status(user) {
    return user?.steam_id
      ? { linked: true, steamId: user.steam_id, name: user.steam_name || '', linkedAt: user.steam_linked_at, profileUrl: `https://steamcommunity.com/profiles/${user.steam_id}` }
      : { linked: false, steamId: null, name: '', linkedAt: null, profileUrl: null };
  }

  const unlink = (userId) => {
    q.unlink.run(userId);
    return status(q.user.get(userId));
  };

  const statusOf = (userId) => status(q.user.get(userId));

  return { begin, verify, complete, confirm, link, unlink, status, statusOf };
}

module.exports = { createSteamOpenId, SteamLinkError, baseUrl, OP, CLAIMED_RE };
