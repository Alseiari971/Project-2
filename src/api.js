// JSON API. The website uses it today, and a future mobile app can use the
// exact same endpoints.
const crypto = require('node:crypto');
const express = require('express');
const {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  requireUser,
  rateLimit,
} = require('./auth');
const { GENRES, findGenre } = require('./games/genres');
const profile = require('./profile');
const { SteamError } = require('./steam');
const { steamArt } = require('./games/steam-art');

const STATUSES = ['playing', 'completed', 'played', 'want', 'dropped'];
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const GAME_ID_RE = /^[a-z0-9][a-z0-9-]{0,149}$/;
const SORTS = ['popular', 'new', 'top'];
// New profiles start with the site's own orange rather than a stock blue.
const DEFAULT_ACCENT = '#f97316';
// Big Steam libraries are capped to the most-played games to keep matching quick.
const STEAM_IMPORT_MAX = 300;
const PREVIEW_TTL_MS = 30 * 60 * 1000;

// Guess a list status from Steam playtime (minutes).
function suggestStatus({ playtime, recentPlaytime }) {
  if (recentPlaytime > 0) return 'playing';
  if (playtime > 0) return 'played';
  return 'want';
}

const publicUser = (u) => ({
  username: u.username,
  displayName: u.display_name,
  headline: u.headline,
  bio: u.bio,
  country: u.country,
  avatarUrl: u.avatar_version ? `/api/users/${encodeURIComponent(u.username)}/avatar?v=${u.avatar_version}` : null,
  avatarFrame: u.avatar_frame,
  accent: u.accent,
  background: u.background,
  joinedAt: u.created_at,
});

const libraryEntry = (row) => ({
  gameId: row.game_id,
  name: row.game_name,
  image: row.game_image,
  backdrop: row.game_backdrop,
  logo: row.game_logo ?? null,
  genres: JSON.parse(row.game_genres || '[]'),
  status: row.status,
  rating: row.rating,
  playtime: row.playtime_minutes ?? null,
  updatedAt: row.updated_at,
});

function createApi({ db, games, prices, steam }) {
  const api = express.Router();
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
  const commentLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
  const importLimiter = rateLimit({ windowMs: 60 * 1000, max: 6 });
  // Matched import previews, kept briefly so the commit step can trust them.
  const previews = new Map();

  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (username, display_name, password_hash, accent) VALUES (?, ?, ?, ?)'),
    updateProfile: db.prepare(`
      UPDATE users SET display_name = @displayName, headline = @headline, bio = @bio, country = @country,
        avatar_frame = @avatarFrame, background = @background, accent = @accent, showcases = @showcases
      WHERE id = @id
    `),
    setAvatar: db.prepare('UPDATE users SET avatar = ?, avatar_type = ?, avatar_version = avatar_version + 1 WHERE id = ?'),
    clearAvatar: db.prepare('UPDATE users SET avatar = NULL, avatar_type = NULL, avatar_version = 0 WHERE id = ?'),
    searchUsers: db.prepare(`
      SELECT u.*, (SELECT COUNT(*) FROM library l WHERE l.user_id = u.id) AS game_count,
        (SELECT COALESCE(l.game_backdrop, l.game_image) FROM library l
         WHERE l.user_id = u.id AND 'game:' || l.game_id = u.background) AS background_image
      FROM users u
      WHERE u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\'
      ORDER BY game_count DESC, u.created_at DESC
      LIMIT 50
    `),
    library: db.prepare('SELECT * FROM library WHERE user_id = ? ORDER BY updated_at DESC'),
    libraryEntry: db.prepare('SELECT * FROM library WHERE user_id = ? AND game_id = ?'),
    upsertEntry: db.prepare(`
      INSERT INTO library (user_id, game_id, game_name, game_image, game_backdrop, game_logo, game_genres, status, rating)
      VALUES (@userId, @gameId, @name, @image, @backdrop, @logo, @genres, @status, @rating)
      ON CONFLICT (user_id, game_id) DO UPDATE SET
        game_name = excluded.game_name, game_image = excluded.game_image,
        game_backdrop = excluded.game_backdrop, game_logo = excluded.game_logo, game_genres = excluded.game_genres,
        status = excluded.status, rating = excluded.rating, updated_at = datetime('now')
    `),
    deleteEntry: db.prepare('DELETE FROM library WHERE user_id = ? AND game_id = ?'),
    // Imports never overwrite a status or rating you set yourself; they only refresh playtime.
    importEntry: db.prepare(`
      INSERT INTO library (user_id, game_id, game_name, game_image, game_backdrop, game_logo, game_genres, status, playtime_minutes)
      VALUES (@userId, @gameId, @name, @image, @backdrop, @logo, @genres, @status, @playtime)
      ON CONFLICT (user_id, game_id) DO UPDATE SET playtime_minutes = excluded.playtime_minutes
    `),
    playersOf: db.prepare(`
      SELECT u.*, l.status, l.rating
      FROM library l JOIN users u ON u.id = l.user_id
      WHERE l.game_id = ?
      ORDER BY l.updated_at DESC
      LIMIT 24
    `),
    playerCount: db.prepare('SELECT COUNT(*) AS n FROM library WHERE game_id = ?'),
    communityFavorites: db.prepare(`
      SELECT game_id, game_name, game_image, game_backdrop, game_genres, COUNT(*) AS players
      FROM library
      WHERE status != 'want'
      GROUP BY game_id
      ORDER BY players DESC, MAX(updated_at) DESC
      LIMIT 20
    `),
    comments: db.prepare(`
      SELECT a.*, c.id AS comment_id, c.body AS comment_body, c.created_at AS comment_created_at
      FROM comments c JOIN users a ON a.id = c.author_id
      WHERE c.profile_id = ?
      ORDER BY c.id DESC
      LIMIT 50
    `),
    commentCountBy: db.prepare('SELECT COUNT(*) AS n FROM comments WHERE author_id = ?'),
    insertComment: db.prepare('INSERT INTO comments (profile_id, author_id, body) VALUES (?, ?, ?)'),
    commentById: db.prepare('SELECT * FROM comments WHERE id = ?'),
    deleteComment: db.prepare('DELETE FROM comments WHERE id = ?'),
  };

  const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);

  // ---- Games ---------------------------------------------------------------

  api.get('/info', (_req, res) => {
    res.json({ source: games.name, statuses: STATUSES, genres: GENRES.map((g) => g.name), steamImport: steam.enabled });
  });

  // Everything the home screen needs in one request: a featured carousel and rows.
  api.get('/home', asyncRoute(async (_req, res) => {
    const rowDefs = [
      { id: 'trending', title: 'Trending now', sort: 'popular' },
      { id: 'new', title: 'New & notable', sort: 'new' },
      ...(games.name === 'rawg' ? [{ id: 'top', title: 'Critically acclaimed', sort: 'top' }] : []),
      ...['Action', 'RPG', 'Adventure', 'Indie', 'Shooter', 'Strategy'].map((genre) => ({
        id: `genre-${genre.toLowerCase()}`, title: genre, genre, sort: 'popular',
      })),
    ];
    const results = await Promise.all(rowDefs.map((r) => games.search({ genre: r.genre, sort: r.sort, pageSize: 20 })));
    const rows = rowDefs
      .map((r, i) => ({ id: r.id, title: r.title, genre: r.genre || null, games: results[i].results }))
      .filter((r) => r.games.length >= 3);

    // Netflix-style "Top 10" row with tall posters, taken from the trending list.
    rows.splice(1, 0, { id: 'top10', title: 'Top 10 this week', genre: null, games: results[0].results.slice(0, 10) });

    const community = q.communityFavorites.all().map((row) => ({ ...libraryEntry(row), id: row.game_id, players: row.players }));
    if (community.length) {
      rows.splice(2, 0, { id: 'community', title: 'Popular on GameShelf', genre: null, games: community });
    }

    const featured = results[0].results.filter((g) => g.backdrop).slice(0, 6);
    // Official Steam store art for every game on the page. The same objects
    // appear in several rows, so de-duplicate first.
    await games.addSteamArt([...new Set(results.flatMap((r) => r.results))]);

    // Each genre card borrows art from a game we already loaded, so this costs no extra requests.
    const loaded = results.flatMap((r) => r.results);
    const used = new Set();
    const genres = GENRES.map(({ name }) => {
      const game = loaded.find((g) => g.genres.includes(name) && (g.backdrop || g.image) && !used.has(g.id));
      if (game) used.add(game.id);
      return { name, image: game ? game.backdrop || game.image : null };
    });
    res.json({ source: games.name, featured, rows, genres });
  }));

  api.get('/games', asyncRoute(async (req, res) => {
    const page = Math.max(1, Math.min(500, parseInt(req.query.page, 10) || 1));
    const query = String(req.query.search || '').slice(0, 100);
    const genre = req.query.genre ? findGenre(req.query.genre)?.name : '';
    if (req.query.genre && !genre) return res.status(400).json({ error: 'Unknown genre.' });
    const sort = SORTS.includes(req.query.sort) ? req.query.sort : 'popular';
    const data = await games.search({ query, genre, sort, page });
    await games.addSteamArt(data.results);
    res.json({ ...data, page, source: games.name });
  }));

  api.get('/games/:id', asyncRoute(async (req, res) => {
    const { id } = req.params;
    if (!GAME_ID_RE.test(id)) return res.status(404).json({ error: 'Game not found.' });
    const game = await games.getGame(id);
    if (!game) return res.status(404).json({ error: 'Game not found.' });

    // "More like this" is a nice extra; never fail the page over it.
    let similar = [];
    const genre = game.genres.map(findGenre).find(Boolean);
    if (genre) {
      try {
        const data = await games.search({ genre: genre.name, pageSize: 13 });
        similar = data.results.filter((g) => g.id !== game.id).slice(0, 12);
        await games.addSteamArt(similar);
      } catch (err) {
        console.error('Could not load similar games:', err.message);
      }
    }

    const mine = req.user && q.libraryEntry.get(req.user.id, game.id);
    res.json({
      ...game,
      similar,
      community: {
        count: q.playerCount.get(game.id).n,
        players: q.playersOf.all(game.id).map((p) => ({ ...publicUser(p), status: p.status, rating: p.rating })),
      },
      myEntry: mine ? libraryEntry(mine) : null,
    });
  }));

  api.get('/games/:id/prices', asyncRoute(async (req, res) => {
    const { id } = req.params;
    const game = GAME_ID_RE.test(id) ? await games.getGame(id) : null;
    if (!game) return res.status(404).json({ error: 'Game not found.' });
    const result = await prices.pricesFor({ steamAppId: game.steamAppId, name: game.name });
    res.json(result || { currency: 'USD', deals: [], lowestEver: null });
  }));

  // ---- Accounts --------------------------------------------------------------

  api.post('/auth/register', authLimiter, (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Usernames need 3 to 20 letters, numbers or underscores.' });
    }
    if (password.length < 8 || password.length > 200) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (q.userByName.get(username)) {
      return res.status(409).json({ error: 'That username is taken.' });
    }
    const { lastInsertRowid } = q.insertUser.run(username, username, hashPassword(password), DEFAULT_ACCENT);
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

  // The logged-in user, including the settings the profile editor needs.
  api.get('/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    const user = q.userById.get(req.user.id);
    res.json({
      user: publicUser(user),
      showcases: JSON.parse(user.showcases),
      options: {
        backgrounds: profile.BACKGROUNDS,
        frames: profile.FRAMES,
        accents: profile.ACCENTS,
        showcaseTypes: profile.SHOWCASE_TYPES,
        maxShowcases: profile.MAX_SHOWCASES,
        maxCollection: profile.MAX_COLLECTION,
      },
    });
  });

  api.patch('/me', requireUser, (req, res) => {
    const current = q.userById.get(req.user.id);
    const body = req.body || {};
    const pick = (key, column) => String(body[key] ?? current[column]).trim();

    const update = {
      id: current.id,
      displayName: pick('displayName', 'display_name'),
      headline: pick('headline', 'headline'),
      bio: pick('bio', 'bio'),
      country: pick('country', 'country'),
      avatarFrame: pick('avatarFrame', 'avatar_frame'),
      background: pick('background', 'background'),
      accent: pick('accent', 'accent').toLowerCase(),
      showcases: current.showcases,
    };

    if (!update.displayName || update.displayName.length > 40) {
      return res.status(400).json({ error: 'Display names can be up to 40 characters.' });
    }
    if (update.headline.length > 60) return res.status(400).json({ error: 'Headline must be 60 characters or less.' });
    if (update.bio.length > 600) return res.status(400).json({ error: 'Bio must be 600 characters or less.' });
    if (update.country.length > 40) return res.status(400).json({ error: 'Location must be 40 characters or less.' });
    if (!profile.FRAMES.includes(update.avatarFrame)) return res.status(400).json({ error: 'Unknown avatar frame.' });
    if (!profile.ACCENTS.includes(update.accent)) return res.status(400).json({ error: 'Pick one of the theme colors.' });
    if (!profile.isValidBackground(update.background)) return res.status(400).json({ error: 'Unknown background.' });
    if (body.showcases !== undefined) {
      const parsed = profile.parseShowcases(body.showcases);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      update.showcases = JSON.stringify(parsed.showcases);
    }

    q.updateProfile.run(update);
    const user = q.userById.get(current.id);
    res.json({ user: publicUser(user), showcases: JSON.parse(user.showcases) });
  });

  // Avatars are resized in the browser and sent as a data URL.
  api.put('/me/avatar', requireUser, (req, res) => {
    const parsed = profile.parseAvatar(req.body?.image);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    q.setAvatar.run(parsed.bytes, parsed.type, req.user.id);
    res.json({ user: publicUser(q.userById.get(req.user.id)) });
  });

  api.delete('/me/avatar', requireUser, (req, res) => {
    q.clearAvatar.run(req.user.id);
    res.json({ user: publicUser(q.userById.get(req.user.id)) });
  });

  // ---- Game lists ------------------------------------------------------------

  api.put('/me/library/:gameId', requireUser, asyncRoute(async (req, res) => {
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

    q.upsertEntry.run({
      userId: req.user.id,
      gameId: game.id,
      name: game.name,
      image: game.image,
      backdrop: game.backdrop,
      logo: game.logo,
      genres: JSON.stringify(game.genres),
      status,
      rating,
    });
    res.json({ entry: libraryEntry(q.libraryEntry.get(req.user.id, game.id)) });
  }));

  // ---- Steam import ----------------------------------------------------------

  api.post('/me/import/steam/preview', requireUser, importLimiter, asyncRoute(async (req, res) => {
    let owned;
    try {
      owned = await steam.ownedGames(req.body?.profile);
    } catch (err) {
      if (err instanceof SteamError) return res.status(err.code === 'unavailable' ? 502 : 400).json({ error: err.message, code: err.code });
      throw err;
    }

    const played = [...owned.games].sort((a, b) => b.playtime - a.playtime);
    const considered = played.slice(0, STEAM_IMPORT_MAX);
    const matches = await games.matchSteamGames(considered);
    const existing = new Map(q.library.all(req.user.id).map((r) => [r.game_id, r.status]));

    const items = considered.map((g, i) => ({
      appid: g.appid,
      name: g.name,
      playtime: g.playtime,
      suggestedStatus: suggestStatus(g),
      match: matches[i],
      existingStatus: matches[i] ? existing.get(matches[i].id) || null : null,
    }));

    const previewId = crypto.randomBytes(16).toString('hex');
    for (const [id, p] of previews) if (p.expires < Date.now()) previews.delete(id);
    previews.set(previewId, { userId: req.user.id, items, expires: Date.now() + PREVIEW_TTL_MS });

    res.json({ previewId, total: owned.games.length, considered: considered.length, items });
  }));

  api.post('/me/import/steam/commit', requireUser, (req, res) => {
    const preview = previews.get(String(req.body?.previewId || ''));
    if (!preview || preview.userId !== req.user.id || preview.expires < Date.now()) {
      return res.status(410).json({ error: 'This import expired. Please load your Steam library again.' });
    }
    const chosen = Array.isArray(req.body?.items) ? req.body.items : [];
    const byAppId = new Map(preview.items.filter((i) => i.match).map((i) => [i.appid, i]));

    let added = 0;
    let updated = 0;
    db.transaction(() => {
      for (const pick of chosen) {
        const item = byAppId.get(Number(pick?.appid));
        if (!item || !STATUSES.includes(pick.status)) continue;
        const g = item.match;
        const art = steamArt(item.appid);
        q.importEntry.run({
          userId: req.user.id,
          gameId: g.id,
          name: g.name,
          // We know the exact Steam app, so use its store banner.
          image: art.image,
          backdrop: g.backdrop,
          logo: g.logo || art.logo,
          genres: JSON.stringify(g.genres),
          status: pick.status,
          playtime: item.playtime,
        });
        if (item.existingStatus) updated++;
        else added++;
      }
    })();
    previews.delete(req.body.previewId);
    res.json({ added, updated });
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
      users: q.searchUsers.all(like, like).map((u) => ({ ...publicUser(u), gameCount: u.game_count, backgroundImage: u.background_image })),
    });
  });

  api.get('/users/:username', (req, res) => {
    const user = q.userByName.get(req.params.username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const library = q.library.all(user.id).map(libraryEntry);
    const showcases = JSON.parse(user.showcases);
    const stats = profile.statsFor(library);
    res.json({
      user: publicUser(user),
      background: profile.resolveBackground(user.background, library),
      stats,
      progression: profile.progression(stats, {
        showcases: showcases.length,
        comments: q.commentCountBy.get(user.id).n,
      }),
      showcases: profile.resolveShowcases(showcases, library),
      library,
      comments: q.comments.all(user.id).map((c) => ({
        id: c.comment_id,
        body: c.comment_body,
        createdAt: c.comment_created_at,
        author: publicUser(c),
      })),
    });
  });

  api.get('/users/:username/avatar', (req, res) => {
    const user = q.userByName.get(req.params.username);
    if (!user || !user.avatar) return res.status(404).json({ error: 'No avatar.' });
    res.set({
      'Content-Type': user.avatar_type,
      // The URL carries a version number, so it can be cached for good.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.send(user.avatar);
  });

  api.post('/users/:username/comments', requireUser, commentLimiter, (req, res) => {
    const target = q.userByName.get(req.params.username);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    const body = String(req.body?.body || '').trim();
    if (!body || body.length > 500) return res.status(400).json({ error: 'Comments can be up to 500 characters.' });
    const { lastInsertRowid } = q.insertComment.run(target.id, req.user.id, body);
    const c = q.commentById.get(lastInsertRowid);
    res.status(201).json({
      comment: { id: c.id, body: c.body, createdAt: c.created_at, author: publicUser(q.userById.get(req.user.id)) },
    });
  });

  // The comment's author and the profile owner can both delete a comment.
  api.delete('/comments/:id', requireUser, (req, res) => {
    const comment = q.commentById.get(Number(req.params.id));
    if (!comment) return res.status(404).json({ error: 'Comment not found.' });
    if (comment.author_id !== req.user.id && comment.profile_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete your own comments.' });
    }
    q.deleteComment.run(comment.id);
    res.json({ ok: true });
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  return api;
}

module.exports = { createApi, STATUSES };
