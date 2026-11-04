// Friends and live presence.
//
// Each account has a friend code (GS-XXXX-XXXX); players add each other by
// code or exact @username. A request waits until the other player accepts it
// (or sends one back, which accepts both); either can decline, remove or block.
// A block removes the friendship and any requests, and stops new ones both ways.
//
// Presence comes from heartbeats (POST /api/presence/heartbeat): the desktop app
// sends one about every 45 seconds, with the game running and whether its
// Arabic is on; the website sends "online" while it's open. Two minutes without
// one reads as offline. Only friends see a player's presence.
const crypto = require('node:crypto');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PRESENCE_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING = 100;
const GAME_ID_RE = /^[a-z0-9][a-z0-9-]{0,149}$/;
const CODE_RE = /^GS-?([A-HJ-NP-Z2-9]{4})-?([A-HJ-NP-Z2-9]{4})$/;

class FriendError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function randomCode() {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `GS-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** A friend code no account has yet. */
function newFriendCode(db) {
  const taken = db.prepare('SELECT 1 FROM users WHERE friend_code = ?');
  for (;;) {
    const code = randomCode();
    if (!taken.get(code)) return code;
  }
}

/** Gives every account without a friend code one (accounts made before friends). */
function assignFriendCodes(db) {
  const missing = db.prepare('SELECT id FROM users WHERE friend_code IS NULL').all();
  const set = db.prepare('UPDATE users SET friend_code = ? WHERE id = ?');
  for (const { id } of missing) set.run(newFriendCode(db), id);
}

/** 'GS-ABCD-EFGH' from what a player typed ('gs abcd efgh', 'ABCDEFGH'...), or null. */
function normalizeCode(text) {
  const match = CODE_RE.exec(String(text || '').toUpperCase().replace(/[\s_]/g, '').replace(/^(?!GS)/, 'GS'));
  return match ? `GS-${match[1]}-${match[2]}` : null;
}

const clean = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

function createFriends({ db, now = () => Date.now() }) {
  const pair = (a, b) => (a < b ? [a, b] : [b, a]);
  const q = {
    byName: db.prepare('SELECT * FROM users WHERE username = ?'),
    byCode: db.prepare('SELECT * FROM users WHERE friend_code = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    isFriend: db.prepare('SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?'),
    addFriend: db.prepare('INSERT OR IGNORE INTO friendships (user_a, user_b) VALUES (?, ?)'),
    dropFriend: db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?'),
    request: db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?'),
    addRequest: db.prepare('INSERT OR IGNORE INTO friend_requests (from_id, to_id) VALUES (?, ?)'),
    dropRequest: db.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?'),
    pending: db.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE from_id = ?'),
    blocked: db.prepare('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?'),
    block: db.prepare('INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)'),
    unblock: db.prepare('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?'),
    friends: db.prepare(`SELECT u.*, f.since, p.status AS p_status, p.game_id AS p_game_id, p.game_title AS p_game_title,
        p.steam_app_id AS p_steam_app_id, p.arabic AS p_arabic, p.source AS p_source, p.started_at AS p_started, p.updated_at AS p_updated
      FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
      LEFT JOIN presence p ON p.user_id = u.id
      WHERE f.user_a = ? OR f.user_b = ?`),
    incoming: db.prepare('SELECT u.*, r.created_at AS requested_at FROM friend_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ? ORDER BY r.created_at DESC'),
    outgoing: db.prepare('SELECT u.*, r.created_at AS requested_at FROM friend_requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = ? ORDER BY r.created_at DESC'),
    blockedList: db.prepare('SELECT u.* FROM user_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC'),
    putPresence: db.prepare(`INSERT INTO presence (user_id, status, game_id, game_title, steam_app_id, arabic, source, started_at, updated_at)
      VALUES (@user, @status, @gameId, @title, @steamAppId, @arabic, @source, @now, @now)
      ON CONFLICT (user_id) DO UPDATE SET status = excluded.status, game_id = excluded.game_id, game_title = excluded.game_title,
        steam_app_id = excluded.steam_app_id, arabic = excluded.arabic, source = excluded.source, updated_at = excluded.updated_at,
        started_at = CASE WHEN presence.status = excluded.status AND COALESCE(presence.game_id, '') = COALESCE(excluded.game_id, '')
          AND presence.game_title = excluded.game_title AND presence.updated_at > @expired THEN presence.started_at ELSE excluded.started_at END`),
    getPresence: db.prepare('SELECT * FROM presence WHERE user_id = ?'),
    dropPresence: db.prepare('DELETE FROM presence WHERE user_id = ?'),
  };

  const summary = (u) => ({
    username: u.username,
    displayName: u.display_name,
    nationality: u.nationality || null,
    accent: u.accent,
    avatarUrl: u.avatar_version ? `/api/users/${encodeURIComponent(u.username)}/avatar?v=${u.avatar_version}` : null,
  });

  /** What a presence row means now: { status, game, arabic, since, lastSeen }. */
  function presenceOf(row) {
    const fresh = row && row.updated_at > now() - PRESENCE_TTL_MS;
    if (!fresh) return { status: 'offline', game: null, arabic: false, since: null, lastSeen: row?.updated_at || null };
    const game = row.status === 'in_game' ? { id: row.game_id || null, title: row.game_title, steamAppId: row.steam_app_id || null } : null;
    return { status: row.status, game, arabic: Boolean(game && row.arabic), since: row.started_at, lastSeen: row.updated_at, source: row.source };
  }

  /** The player `target` means ({ username } or { code }, or text that's either), or throws. */
  function findTarget(target) {
    // { username } always means a username; { code } or plain text may be either.
    const text = target?.username ? `@${String(target.username).trim().replace(/^@/, '')}` : String(target?.code || target || '').trim();
    const code = /^@/.test(text) ? null : normalizeCode(text);
    // A code first (when it reads as one), else an exact username.
    const user = (code && q.byCode.get(code)) || q.byName.get(text.replace(/^@/, '').toLowerCase());
    if (!user) throw new FriendError('No player has that username or friend code.', 404);
    return user;
  }

  function relation(me, other) {
    if (me.id === other.id) return 'self';
    if (q.blocked.get(me.id, other.id)) return 'blocked';
    if (q.blocked.get(other.id, me.id)) return 'blocked_by';
    if (q.isFriend.get(...pair(me.id, other.id))) return 'friends';
    if (q.request.get(me.id, other.id)) return 'outgoing';
    if (q.request.get(other.id, me.id)) return 'incoming';
    return 'none';
  }

  function befriend(a, b) {
    q.dropRequest.run(a.id, b.id);
    q.dropRequest.run(b.id, a.id);
    q.addFriend.run(...pair(a.id, b.id));
  }

  /** Sends a request (or accepts theirs, when they sent one first). Returns { relation }. */
  function request(me, target) {
    const other = findTarget(target);
    const rel = relation(me, other);
    if (rel === 'self') throw new FriendError('That\'s your own friend code.');
    // A block is never shown to the player it stops.
    if (rel === 'blocked' || rel === 'blocked_by') throw new FriendError('You can\'t add this player.', 403);
    if (rel === 'friends' || rel === 'outgoing') return { relation: rel, user: summary(other) };
    if (rel === 'incoming') {
      befriend(me, other);
      return { relation: 'friends', user: summary(other) };
    }
    if (q.pending.get(me.id).n >= MAX_PENDING) throw new FriendError('You have too many friend requests waiting. Cancel some first.', 429);
    q.addRequest.run(me.id, other.id);
    return { relation: 'outgoing', user: summary(other) };
  }

  function accept(me, target) {
    const other = findTarget(target);
    if (!q.request.get(other.id, me.id)) throw new FriendError('There\'s no friend request from that player.', 404);
    befriend(me, other);
    return { relation: 'friends', user: summary(other) };
  }

  function decline(me, target) {
    const other = findTarget(target);
    q.dropRequest.run(other.id, me.id);
    return { relation: relation(me, other), user: summary(other) };
  }

  /** Ends a friendship, or cancels a request either way. */
  function remove(me, target) {
    const other = findTarget(target);
    q.dropFriend.run(...pair(me.id, other.id));
    q.dropRequest.run(me.id, other.id);
    q.dropRequest.run(other.id, me.id);
    return { relation: relation(me, other), user: summary(other) };
  }

  function block(me, target) {
    const other = findTarget(target);
    if (other.id === me.id) throw new FriendError('You can\'t block yourself.');
    remove(me, `@${other.username}`);
    q.block.run(me.id, other.id);
    return { relation: 'blocked', user: summary(other) };
  }

  function unblock(me, target) {
    const other = findTarget(target);
    q.unblock.run(me.id, other.id);
    return { relation: relation(me, other), user: summary(other) };
  }

  /** Who a signed-in player can see: friends (with presence, playing first), requests and blocks. */
  function list(me) {
    const rank = { in_game: 0, online: 1, offline: 2 };
    const friends = q.friends.all(me.id, me.id, me.id).map((u) => ({
      ...summary(u),
      since: u.since,
      presence: presenceOf(u.p_updated ? {
        status: u.p_status, game_id: u.p_game_id, game_title: u.p_game_title, steam_app_id: u.p_steam_app_id,
        arabic: u.p_arabic, source: u.p_source, started_at: u.p_started, updated_at: u.p_updated,
      } : null),
    })).sort((a, b) => rank[a.presence.status] - rank[b.presence.status] || a.displayName.localeCompare(b.displayName));
    const self = q.byId.get(me.id);
    return {
      code: self.friend_code,
      friends,
      incoming: q.incoming.all(me.id).map((u) => ({ ...summary(u), requestedAt: u.requested_at })),
      outgoing: q.outgoing.all(me.id).map((u) => ({ ...summary(u), requestedAt: u.requested_at })),
      blocked: q.blockedList.all(me.id).map(summary),
      online: friends.filter((f) => f.presence.status !== 'offline').length,
    };
  }

  /** A player looking another up before adding them: { user, relation }. */
  function lookup(me, target) {
    const other = findTarget(target);
    const rel = relation(me, other);
    if (rel === 'blocked_by') throw new FriendError('No player has that username or friend code.', 404);
    return { user: summary(other), relation: rel };
  }

  /** A heartbeat: { status: 'online' | 'in_game' | 'offline', gameId, gameTitle, steamAppId, arabicEnabled }. */
  function heartbeat(me, body = {}, source = 'web') {
    const status = String(body.status || 'online');
    if (status === 'offline') {
      q.dropPresence.run(me.id);
      return presenceOf(null);
    }
    if (!['online', 'in_game'].includes(status)) throw new FriendError('Status must be online, in_game or offline.');
    const title = clean(body.gameTitle, 120);
    if (status === 'in_game' && !title) throw new FriendError('Say which game is running (gameTitle).');
    const gameId = status === 'in_game' && GAME_ID_RE.test(String(body.gameId || '')) ? String(body.gameId) : null;
    const steamAppId = status === 'in_game' && Number.isInteger(Number(body.steamAppId)) && Number(body.steamAppId) > 0 ? Number(body.steamAppId) : null;
    const t = now();
    q.putPresence.run({
      user: me.id, status, gameId, title: status === 'in_game' ? title : '', steamAppId,
      arabic: status === 'in_game' && body.arabicEnabled ? 1 : 0, source, now: t, expired: t - PRESENCE_TTL_MS,
    });
    return presenceOf(q.getPresence.get(me.id));
  }

  return { request, accept, decline, remove, block, unblock, list, lookup, heartbeat, relation, presenceOf, findTarget };
}

module.exports = { createFriends, FriendError, newFriendCode, assignFriendCodes, normalizeCode, PRESENCE_TTL_MS };
