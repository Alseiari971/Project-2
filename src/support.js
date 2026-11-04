// Customer support: tickets and their conversations.
//
// A player opens a ticket (a category, a subject, optionally a game, and a
// message) and sees it under My tickets. Statuses:
//   open      waiting for GameShelf's team (new, or the player replied)
//   replied   an admin answered ("Admin Replied")
//   resolved  an admin marked it solved; a reply from the player reopens it
//   closed    finished; no more replies (the player can open a new ticket)
// Admins see every ticket in Admin Panel, Support, with who sent it.
const CATEGORIES = ['account', 'steam', 'arabic', 'request', 'other'];
const STATUSES = ['open', 'replied', 'resolved', 'closed'];
const MAX_SUBJECT = 120;
const MAX_BODY = 5000;
const MAX_OPEN = 10;
const GAME_ID_RE = /^[a-z0-9][a-z0-9-]{0,149}$/;

class SupportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const text = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

function createSupport({ db, games = null, plans = null }) {
  const q = {
    insert: db.prepare('INSERT INTO support_tickets (user_id, category, subject, game_id, game_name) VALUES (?, ?, ?, ?, ?)'),
    addMessage: db.prepare('INSERT INTO support_messages (ticket_id, author_id, from_admin, body) VALUES (?, ?, ?, ?)'),
    ticket: db.prepare('SELECT * FROM support_tickets WHERE id = ?'),
    setStatus: db.prepare("UPDATE support_tickets SET status = ?, updated_at = datetime('now') WHERE id = ?"),
    messages: db.prepare(`SELECT m.*, u.username, u.display_name FROM support_messages m LEFT JOIN users u ON u.id = m.author_id
      WHERE m.ticket_id = ? ORDER BY m.id`),
    mine: db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS messages
      FROM support_tickets t WHERE t.user_id = ? ORDER BY t.updated_at DESC, t.id DESC`),
    openCount: db.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ? AND status IN ('open', 'replied')"),
    queue: db.prepare(`SELECT t.*, u.username, u.display_name, u.nationality, u.steam_id, u.twofa_method, u.email_verified,
        (SELECT COUNT(*) FROM support_tickets o WHERE o.user_id = t.user_id) AS user_tickets,
        (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS messages
      FROM support_tickets t JOIN users u ON u.id = t.user_id
      WHERE (@status = '' OR t.status = @status) AND (@category = '' OR t.category = @category)
      ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'replied' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END, t.updated_at DESC
      LIMIT 300`),
    counts: db.prepare('SELECT status, COUNT(*) AS n FROM support_tickets GROUP BY status'),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    history: db.prepare('SELECT id, subject, status, category, created_at FROM support_tickets WHERE user_id = ? AND id != ? ORDER BY id DESC LIMIT 20'),
  };

  const summary = (t) => ({
    id: t.id,
    category: t.category,
    subject: t.subject,
    game: t.game_id || t.game_name ? { id: t.game_id || null, name: t.game_name } : null,
    status: t.status,
    messages: t.messages ?? undefined,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  });

  const thread = (id) => q.messages.all(id).map((m) => ({
    id: m.id,
    fromAdmin: Boolean(m.from_admin),
    author: m.from_admin ? 'GameShelf' : (m.username || null),
    authorName: m.from_admin ? 'GameShelf' : (m.display_name || m.username || null),
    body: m.body,
    createdAt: m.created_at,
  }));

  const sender = (u) => ({
    username: u.username,
    displayName: u.display_name,
    nationality: u.nationality || null,
    steamLinked: Boolean(u.steam_id),
    guard: u.twofa_method || null,
    emailVerified: Boolean(u.email_verified),
    // GameShelf Supporters' tickets come first in the queue (priority support).
    supporter: Boolean(plans?.isSupporter(u.user_id ?? u.id)),
  });

  function ownTicket(user, id) {
    const t = q.ticket.get(Number(id));
    if (!t || t.user_id !== user.id) throw new SupportError('That ticket isn\'t there.', 404);
    return t;
  }

  function anyTicket(id) {
    const t = q.ticket.get(Number(id));
    if (!t) throw new SupportError('That ticket isn\'t there.', 404);
    return t;
  }

  async function create(user, body = {}) {
    const category = String(body.category || '');
    if (!CATEGORIES.includes(category)) throw new SupportError('Pick what the ticket is about.');
    const subject = text(body.subject, MAX_SUBJECT);
    if (subject.length < 4) throw new SupportError('Give the ticket a subject.');
    const message = text(body.message, MAX_BODY);
    if (message.length < 10) throw new SupportError('Tell us a little more about it (at least 10 characters).');
    if (q.openCount.get(user.id).n >= MAX_OPEN) throw new SupportError('You have 10 tickets waiting already. Reply on one of those instead.', 429);
    // The game's name comes from the catalog, not from the form.
    let gameId = null;
    let gameName = '';
    if (body.gameId) {
      const id = String(body.gameId);
      const game = GAME_ID_RE.test(id) && games ? await games.getGame(id).catch(() => null) : null;
      if (!game) throw new SupportError('That game isn\'t in the catalog.');
      gameId = game.id;
      gameName = game.name;
    }
    const { lastInsertRowid } = q.insert.run(user.id, category, subject, gameId, gameName);
    q.addMessage.run(lastInsertRowid, user.id, 0, message);
    return get(user, lastInsertRowid);
  }

  const get = (user, id) => {
    const t = ownTicket(user, id);
    return { ticket: summary(t), messages: thread(t.id) };
  };

  const mine = (user) => ({ tickets: q.mine.all(user.id).map(summary), categories: CATEGORIES });

  function reply(user, id, body) {
    const t = ownTicket(user, id);
    if (t.status === 'closed') throw new SupportError('This ticket is closed. Open a new one if you still need help.', 409);
    const message = text(body, MAX_BODY);
    if (!message) throw new SupportError('Write a message first.');
    q.addMessage.run(t.id, user.id, 0, message);
    q.setStatus.run('open', t.id);
    return get(user, t.id);
  }

  function close(user, id) {
    const t = ownTicket(user, id);
    q.setStatus.run('closed', t.id);
    return get(user, t.id);
  }

  // ---- Admins ----

  function queue({ status = '', category = '' } = {}) {
    const s = STATUSES.includes(status) ? status : '';
    const c = CATEGORIES.includes(category) ? category : '';
    const counts = Object.fromEntries(STATUSES.map((x) => [x, 0]));
    for (const row of q.counts.all()) counts[row.status] = row.n;
    const order = { open: 0, replied: 1, resolved: 2, closed: 3 };
    const tickets = q.queue.all({ status: s, category: c }).map((t) => ({ ...summary(t), from: sender(t), userTickets: t.user_tickets }));
    // Same status: supporters first, then the order it already had.
    tickets.forEach((t, i) => { t.rank = i; });
    tickets.sort((a, b) => order[a.status] - order[b.status] || Number(b.from.supporter) - Number(a.from.supporter) || a.rank - b.rank);
    tickets.forEach((t) => { delete t.rank; });
    return {
      tickets,
      counts,
      categories: CATEGORIES,
      statuses: STATUSES,
    };
  }

  function adminGet(id) {
    const t = anyTicket(id);
    const u = q.user.get(t.user_id);
    return {
      ticket: summary(t),
      messages: thread(t.id),
      from: u ? sender(u) : null,
      history: u ? q.history.all(u.id, t.id).map((h) => ({ id: h.id, subject: h.subject, status: h.status, category: h.category, createdAt: h.created_at })) : [],
    };
  }

  /** An admin's answer; the ticket becomes "replied" unless `status` says resolved or closed. */
  function adminReply(admin, id, body, status = null) {
    const t = anyTicket(id);
    const message = text(body, MAX_BODY);
    if (!message) throw new SupportError('Write a message first.');
    q.addMessage.run(t.id, admin.id, 1, message);
    q.setStatus.run(['resolved', 'closed'].includes(status) ? status : 'replied', t.id);
    return adminGet(t.id);
  }

  function adminStatus(id, status) {
    const t = anyTicket(id);
    if (!STATUSES.includes(status)) throw new SupportError('Pick a status: open, replied, resolved or closed.');
    q.setStatus.run(status, t.id);
    return adminGet(t.id);
  }

  return { create, get, mine, reply, close, queue, adminGet, adminReply, adminStatus };
}

module.exports = { createSupport, SupportError, CATEGORIES, STATUSES };
