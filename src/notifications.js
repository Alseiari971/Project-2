// Notifications: the bell in the header. A short list per player of what
// happened for them: a friend request or its acceptance, an admin's reply to
// their support ticket, Arabic going live for a game they asked or voted for.
// Each one keeps its kind and details (not text), so the page words it in the
// player's language.
const KINDS = new Set(['friend-request', 'friend-accepted', 'support-reply', 'arabic-ready']);
const KEEP = 100; // per player; older ones are dropped
const clean = (value, max = 200) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);

function createNotifications({ db, now = () => Date.now() }) {
  const q = {
    add: db.prepare('INSERT INTO notifications (user_id, kind, data, link, created_at) VALUES (?, ?, ?, ?, ?)'),
    recent: db.prepare('SELECT id FROM notifications WHERE user_id = ? AND kind = ? AND link = ? AND created_at > ? AND read_at IS NULL'),
    list: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL'),
    readAll: db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL'),
    readOne: db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL'),
    trim: db.prepare(`DELETE FROM notifications WHERE user_id = ? AND id NOT IN
      (SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ${KEEP})`),
  };

  /**
   * Tells `userId` about something: `kind` and its details (`data`, plain values) and
   * where it leads (`link`, a page of the site). The same unread one within the hour isn't repeated.
   */
  function add(userId, kind, data = {}, link = '#/') {
    if (!Number.isInteger(userId) || !KINDS.has(kind)) return null;
    const safeLink = /^#\/[\w\-/%?=&.:]*$/.test(String(link)) ? String(link) : '#/';
    if (q.recent.get(userId, kind, safeLink, now() - 60 * 60 * 1000)) return null;
    const details = Object.fromEntries(Object.entries(data).map(([k, v]) => [clean(k, 40), typeof v === 'number' ? v : clean(v)]));
    const id = Number(q.add.run(userId, kind, JSON.stringify(details), safeLink, now()).lastInsertRowid);
    q.trim.run(userId, userId);
    return id;
  }

  const shape = (r) => ({ id: r.id, kind: r.kind, data: JSON.parse(r.data), link: r.link, createdAt: r.created_at, read: Boolean(r.read_at) });

  return {
    add,
    /** The player's newest notifications and how many are unread. */
    list: (userId, limit = 30) => ({
      items: q.list.all(userId, Math.min(Math.max(Number(limit) || 30, 1), KEEP)).map(shape),
      unread: q.unread.get(userId).n,
    }),
    /** Marks one (`id`) or all of the player's notifications read. Returns how many unread are left. */
    markRead(userId, id = null) {
      if (id == null) q.readAll.run(now(), userId);
      else q.readOne.run(now(), userId, Number(id));
      return { unread: q.unread.get(userId).n };
    },
  };
}

module.exports = { createNotifications, NOTIFICATION_KINDS: KINDS };
