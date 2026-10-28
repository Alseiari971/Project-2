// JSON API. The website uses it today, and a future mobile app can use the
// exact same endpoints.
const express = require('express');
const {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  requireUser,
  rateLimit,
} = require('./auth');

const STATUSES = ['playing', 'completed', 'played', 'want', 'dropped'];
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const GAME_ID_RE = /^[a-z0-9][a-z0-9-]{0,149}$/;

const publicUser = (u) => ({
  username: u.username,
  displayName: u.display_name,
  bio: u.bio,
  joinedAt: u.created_at,
});

const libraryEntry = (row) => ({
  gameId: row.game_id,
  name: row.game_name,
  image: row.game_image,
  status: row.status,
  rating: row.rating,
  updatedAt: row.updated_at,
});

function createApi({ db, games }) {
  const api = express.Router();
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    insertUser: db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)'),
    updateProfile: db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?'),
    searchUsers: db.prepare(`
      SELECT u.*, (SELECT COUNT(*) FROM library l WHERE l.user_id = u.id) AS game_count
      FROM users u
      WHERE u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\'
      ORDER BY game_count DESC, u.created_at DESC
      LIMIT 50
    `),
    library: db.prepare('SELECT * FROM library WHERE user_id = ? ORDER BY updated_at DESC'),
    libraryEntry: db.prepare('SELECT * FROM library WHERE user_id = ? AND game_id = ?'),
    upsertEntry: db.prepare(`
      INSERT INTO library (user_id, game_id, game_name, game_image, status, rating)
      VALUES (@userId, @gameId, @name, @image, @status, @rating)
      ON CONFLICT (user_id, game_id) DO UPDATE SET
        game_name = excluded.game_name, game_image = excluded.game_image,
        status = excluded.status, rating = excluded.rating, updated_at = datetime('now')
    `),
    deleteEntry: db.prepare('DELETE FROM library WHERE user_id = ? AND game_id = ?'),
    playersOf: db.prepare(`
      SELECT u.username, u.display_name, l.status, l.rating
      FROM library l JOIN users u ON u.id = l.user_id
      WHERE l.game_id = ?
      ORDER BY l.updated_at DESC
      LIMIT 24
    `),
    playerCount: db.prepare('SELECT COUNT(*) AS n FROM library WHERE game_id = ?'),
  };

  api.get('/info', (_req, res) => {
    res.json({ source: games.name, statuses: STATUSES });
  });

  // ---- Games ---------------------------------------------------------------

  api.get('/games', async (req, res, next) => {
    try {
      const page = Math.max(1, Math.min(500, parseInt(req.query.page, 10) || 1));
      const query = String(req.query.search || '').slice(0, 100);
      const data = await games.search({ query, page });
      res.json({ ...data, page, source: games.name });
    } catch (err) {
      next(err);
    }
  });

  api.get('/games/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!GAME_ID_RE.test(id)) return res.status(404).json({ error: 'Game not found.' });
      const game = await games.getGame(id);
      if (!game) return res.status(404).json({ error: 'Game not found.' });
      const mine = req.user && q.libraryEntry.get(req.user.id, game.id);
      res.json({
        ...game,
        community: {
          count: q.playerCount.get(game.id).n,
          players: q.playersOf.all(game.id).map((p) => ({
            username: p.username,
            displayName: p.display_name,
            status: p.status,
            rating: p.rating,
          })),
        },
        myEntry: mine ? libraryEntry(mine) : null,
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- Accounts --------------------------------------------------------------

  api.post('/auth/register', authLimiter, (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers or underscores.' });
    }
    if (password.length < 8 || password.length > 200) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (q.userByName.get(username)) {
      return res.status(409).json({ error: 'That username is taken.' });
    }
    const { lastInsertRowid } = q.insertUser.run(username, username, hashPassword(password));
    createSession(db, res, lastInsertRowid);
    res.status(201).json({ user: publicUser(q.userByName.get(username)) });
  });

  api.post('/auth/login', authLimiter, (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const user = q.userByName.get(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    createSession(db, res, user.id);
    res.json({ user: publicUser(user) });
  });

  api.post('/auth/logout', (req, res) => {
    destroySession(db, req, res);
    res.json({ ok: true });
  });

  api.get('/me', (req, res) => {
    res.json({ user: req.user ? publicUser(req.user) : null });
  });

  api.patch('/me', requireUser, (req, res) => {
    const displayName = String(req.body?.displayName ?? req.user.display_name).trim();
    const bio = String(req.body?.bio ?? req.user.bio).trim();
    if (!displayName || displayName.length > 40) {
      return res.status(400).json({ error: 'Display name must be 1–40 characters.' });
    }
    if (bio.length > 300) return res.status(400).json({ error: 'Bio must be 300 characters or less.' });
    q.updateProfile.run(displayName, bio, req.user.id);
    res.json({ user: publicUser(q.userByName.get(req.user.username)) });
  });

  // ---- Game lists ------------------------------------------------------------

  api.put('/me/library/:gameId', requireUser, async (req, res, next) => {
    try {
      const { gameId } = req.params;
      const status = String(req.body?.status || '');
      const rating = req.body?.rating == null || req.body.rating === '' ? null : Number(req.body.rating);
      if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Pick a valid status.' });
      if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 10)) {
        return res.status(400).json({ error: 'Rating must be a whole number from 1 to 10.' });
      }
      // Look the game up ourselves rather than trusting the name/image from the client.
      const game = GAME_ID_RE.test(gameId) ? await games.getGame(gameId) : null;
      if (!game) return res.status(404).json({ error: 'Game not found.' });

      q.upsertEntry.run({ userId: req.user.id, gameId: game.id, name: game.name, image: game.image, status, rating });
      res.json({ entry: libraryEntry(q.libraryEntry.get(req.user.id, game.id)) });
    } catch (err) {
      next(err);
    }
  });

  api.delete('/me/library/:gameId', requireUser, (req, res) => {
    q.deleteEntry.run(req.user.id, req.params.gameId);
    res.json({ ok: true });
  });

  // ---- Profiles --------------------------------------------------------------

  api.get('/users', (req, res) => {
    const term = String(req.query.search || '').slice(0, 40).replace(/[\\%_]/g, (c) => '\\' + c);
    const like = `%${term}%`;
    res.json({
      users: q.searchUsers.all(like, like).map((u) => ({ ...publicUser(u), gameCount: u.game_count })),
    });
  });

  api.get('/users/:username', (req, res) => {
    const user = q.userByName.get(req.params.username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const library = q.library.all(user.id).map(libraryEntry);
    const stats = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const entry of library) stats[entry.status]++;
    res.json({ user: publicUser(user), stats, library });
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  return api;
}

module.exports = { createApi, STATUSES };
