// Games GameShelf doesn't carry: the ones an admin blocked (the blocked_games
// table), and the ones Steam itself describes as adult content. Steam's content
// descriptors are numbers on each store item: 3 is "Adult Only Sexual Content"
// and 4 is "Frequent Nudity or Sexual Content" (BLOCKED_CONTENT_DESCRIPTORS, a
// comma-separated list, replaces the default "3,4"; empty turns that off).
//
// A game left out is left out everywhere: catalog lists and search, its page,
// and the translation and Arabic request endpoints, which take a game key
// ("steam:<appid>" or "game:<id>").

const KEY_RE = /^(steam):(\d{1,10})$|^(game):([a-z0-9][a-z0-9-]{0,149})$/;
const REASONS = ['policy_violation', 'adult_content', 'gambling', 'publisher_request', 'legal', 'other'];

class BlockError extends Error {}

function createGameBlocks({ db, games = null, env = process.env }) {
  const descriptorIds = new Set(String(env.BLOCKED_CONTENT_DESCRIPTORS ?? '3,4').split(',').map((n) => Number(n.trim())).filter((n) => Number.isInteger(n) && n > 0));
  const q = {
    byApp: db.prepare('SELECT * FROM blocked_games WHERE steam_appid = ?'),
    byGame: db.prepare('SELECT * FROM blocked_games WHERE game_id = ?'),
    byId: db.prepare('SELECT * FROM blocked_games WHERE id = ?'),
    all: db.prepare('SELECT b.*, u.username AS blocked_by_name FROM blocked_games b LEFT JOIN users u ON u.id = b.blocked_by ORDER BY b.blocked_at DESC, b.id DESC'),
    insert: db.prepare('INSERT INTO blocked_games (steam_appid, game_id, title, reason, blocked_by) VALUES (?, ?, ?, ?, ?)'),
    remove: db.prepare('DELETE FROM blocked_games WHERE id = ?'),
  };
  const view = (row) => ({
    id: row.id, steamAppId: row.steam_appid || null, gameId: row.game_id || null, title: row.title, reason: row.reason,
    blockedAt: row.blocked_at, blockedBy: row.blocked_by_name || null,
  });

  /** The admin's block on a game ({ id, steamAppId }), or null. */
  function blockOf(game) {
    const appid = Number(game?.steamAppId);
    return (Number.isInteger(appid) && appid > 0 && q.byApp.get(appid)) || (game?.id && q.byGame.get(String(game.id))) || null;
  }

  /** Steam app ids, of these, that Steam describes as adult content. Unknown (Steam didn't answer) isn't blocked. */
  async function adultApps(appids) {
    const out = new Set();
    const wanted = [...new Set(appids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!descriptorIds.size || !wanted.length || typeof games?.contentDescriptors !== 'function') return out;
    let found;
    try {
      found = await games.contentDescriptors(wanted);
    } catch {
      return out;
    }
    for (const appid of wanted) {
      if ((found.get(appid) || []).some((id) => descriptorIds.has(Number(id)))) out.add(appid);
    }
    return out;
  }

  /** Why a game isn't carried: { reason, title } or null. */
  async function refusal(game) {
    const block = blockOf(game);
    if (block) return { reason: block.reason, title: block.title };
    const appid = Number(game?.steamAppId);
    if (Number.isInteger(appid) && appid > 0 && (await adultApps([appid])).has(appid)) return { reason: 'adult_content', title: game.name || null };
    return null;
  }

  /** A list of games without the ones that aren't carried. */
  async function filter(list) {
    if (!Array.isArray(list) || !list.length) return list;
    const kept = list.filter((g) => !blockOf(g));
    const adult = await adultApps(kept.map((g) => g?.steamAppId).filter(Boolean));
    return adult.size ? kept.filter((g) => !adult.has(Number(g.steamAppId))) : kept;
  }

  /** The same for a game key ("steam:<appid>" or "game:<id>"), as the translation endpoints get it. */
  async function keyRefusal(key) {
    const m = KEY_RE.exec(String(key || ''));
    if (!m) return null;
    return refusal(m[1] ? { steamAppId: Number(m[2]) } : { id: m[4] });
  }

  return {
    refusal,
    filter,
    keyRefusal,
    list: () => q.all.all().map(view),

    /** Blocks a game by its Steam app id, its GameShelf id, or both. */
    block({ steamAppId, gameId, title, reason }, admin) {
      const appid = steamAppId === undefined || steamAppId === null || steamAppId === '' ? null : Number(steamAppId);
      const id = gameId ? String(gameId).trim().toLowerCase() : null;
      if (appid !== null && (!Number.isInteger(appid) || appid <= 0 || appid > 4294967295)) throw new BlockError('The Steam app ID is a number.');
      if (id !== null && !/^[a-z0-9][a-z0-9-]{0,149}$/.test(id)) throw new BlockError('That isn\'t a GameShelf game ID.');
      if (appid === null && id === null) throw new BlockError('Give the game\'s Steam app ID or its GameShelf game ID.');
      const name = String(title || '').trim().slice(0, 200);
      if (!name) throw new BlockError('Give the game\'s title.');
      const why = REASONS.includes(reason) ? reason : 'policy_violation';
      if ((appid !== null && q.byApp.get(appid)) || (id !== null && q.byGame.get(id))) throw new BlockError('That game is already blocked.');
      const { lastInsertRowid } = q.insert.run(appid, id, name, why, admin?.id || null);
      return view(q.all.all().find((row) => row.id === Number(lastInsertRowid)));
    },

    unblock(id) {
      const row = q.byId.get(Number(id));
      if (!row) throw new BlockError('That block isn\'t there any more.');
      q.remove.run(row.id);
      return { ok: true };
    },
  };
}

module.exports = { createGameBlocks, BlockError, REASONS };
