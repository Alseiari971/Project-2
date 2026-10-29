// Steam-style profile customization: backgrounds, avatar frames, accent
// colors, showcases, plus levels and badges earned from your game list.

const BACKGROUNDS = ['midnight', 'aurora', 'sunset', 'ocean', 'ember', 'forest', 'nebula', 'synthwave'];
const FRAMES = ['none', 'glow', 'gold', 'neon', 'fire', 'ice'];
const ACCENTS = ['#e7ff0c', '#3b82f6', '#a855f7', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6'];
const SHOWCASE_TYPES = ['favorite', 'collection', 'toprated', 'completed', 'stats', 'info'];
const MAX_SHOWCASES = 4;
const MAX_COLLECTION = 6;
const XP_PER_LEVEL = 50;

const GAME_ID_RE = /^[a-z0-9][a-z0-9-]{0,149}$/;

// Each badge has bronze, silver and gold tiers.
const BADGES = [
  { id: 'collector', name: 'Collector', description: 'Games on your list', stat: 'games', tiers: [10, 50, 150] },
  { id: 'completionist', name: 'Completionist', description: 'Games completed', stat: 'completed', tiers: [5, 25, 75] },
  { id: 'critic', name: 'Critic', description: 'Games rated', stat: 'rated', tiers: [10, 50, 150] },
  { id: 'explorer', name: 'Explorer', description: 'Genres played', stat: 'genres', tiers: [3, 6, 10] },
  { id: 'veteran', name: 'Veteran', description: 'Hours played', stat: 'hours', tiers: [100, 500, 2000] },
  { id: 'backlog', name: 'Backlog Builder', description: 'Games saved for later', stat: 'want', tiers: [5, 20, 50] },
  { id: 'curator', name: 'Curator', description: 'Profile showcases', stat: 'showcases', tiers: [1, 2, 4] },
  { id: 'socialite', name: 'Socialite', description: 'Comments left on profiles', stat: 'comments', tiers: [5, 25, 100] },
];
const TIER_NAMES = ['Locked', 'Bronze', 'Silver', 'Gold'];

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/** Validates showcases sent by the client. Returns { showcases } or { error }. */
function parseShowcases(input) {
  if (!Array.isArray(input)) return { error: 'Showcases must be a list.' };
  if (input.length > MAX_SHOWCASES) return { error: `You can have up to ${MAX_SHOWCASES} showcases.` };
  const showcases = [];
  for (const raw of input) {
    const type = raw?.type;
    if (!SHOWCASE_TYPES.includes(type)) return { error: 'Unknown showcase type.' };
    if (type === 'favorite') {
      if (!GAME_ID_RE.test(raw.gameId || '')) return { error: 'Pick a favorite game.' };
      showcases.push({ type, gameId: raw.gameId });
    } else if (type === 'collection') {
      const gameIds = Array.isArray(raw.gameIds) ? [...new Set(raw.gameIds)].filter((id) => GAME_ID_RE.test(id)) : [];
      if (gameIds.length > MAX_COLLECTION) return { error: `A collection holds up to ${MAX_COLLECTION} games.` };
      showcases.push({ type, title: clean(raw.title, 40) || 'Game collection', gameIds });
    } else if (type === 'info') {
      showcases.push({ type, title: clean(raw.title, 40) || 'About me', text: clean(raw.text, 600) });
    } else {
      showcases.push({ type });
    }
  }
  return { showcases };
}

function statsFor(library) {
  const genres = new Set();
  const stats = { games: library.length, playing: 0, completed: 0, played: 0, want: 0, dropped: 0, rated: 0 };
  let ratingSum = 0;
  let minutes = 0;
  for (const e of library) {
    stats[e.status]++;
    minutes += e.playtime || 0;
    if (e.rating) {
      stats.rated++;
      ratingSum += e.rating;
    }
    for (const g of e.genres) genres.add(g);
  }
  stats.genres = genres.size;
  stats.hours = Math.round(minutes / 60);
  stats.averageRating = stats.rated ? Math.round((ratingSum / stats.rated) * 10) / 10 : null;
  const finished = stats.completed + stats.played + stats.dropped;
  stats.completionRate = finished ? Math.round((stats.completed / finished) * 100) : 0;
  return stats;
}

function progression(stats, { showcases = 0, comments = 0 } = {}) {
  const xp = stats.games * 10 + stats.completed * 20 + stats.rated * 5 + stats.genres * 5 + comments * 2 +
    Math.floor(stats.hours / 10);
  const level = Math.floor(xp / XP_PER_LEVEL) + 1;
  const values = { ...stats, showcases, comments };
  return {
    level,
    xp,
    levelProgress: (xp % XP_PER_LEVEL) / XP_PER_LEVEL,
    xpToNext: XP_PER_LEVEL - (xp % XP_PER_LEVEL),
    badges: BADGES.map(({ stat, tiers, ...b }) => {
      const value = values[stat];
      const tier = tiers.filter((t) => value >= t).length;
      return {
        ...b,
        tier,
        tierName: TIER_NAMES[tier],
        earned: tier > 0,
        progress: value,
        // The next tier to work towards, or null once gold is reached.
        nextTarget: tiers[tier] ?? null,
      };
    }),
  };
}

/** Turns stored showcases into renderable ones using the owner's game list. */
function resolveShowcases(showcases, library) {
  const byId = new Map(library.map((e) => [e.gameId, e]));
  const resolved = [];
  for (const s of showcases) {
    if (s.type === 'favorite') {
      const game = byId.get(s.gameId);
      if (game) resolved.push({ type: s.type, game });
    } else if (s.type === 'collection') {
      resolved.push({ type: s.type, title: s.title, games: s.gameIds.map((id) => byId.get(id)).filter(Boolean) });
    } else if (s.type === 'toprated') {
      const games = library.filter((e) => e.rating).sort((a, b) => b.rating - a.rating).slice(0, MAX_COLLECTION);
      resolved.push({ type: s.type, games });
    } else if (s.type === 'completed') {
      resolved.push({ type: s.type, games: library.filter((e) => e.status === 'completed').slice(0, MAX_COLLECTION) });
    } else {
      resolved.push({ ...s });
    }
  }
  return resolved;
}

/** Background is a preset name or "game:<id>" for art from a game on the user's list. */
function resolveBackground(background, library) {
  if (background.startsWith('game:')) {
    const game = library.find((e) => e.gameId === background.slice(5));
    if (game && (game.backdrop || game.image)) return { preset: null, image: game.backdrop || game.image };
    return { preset: 'midnight', image: null };
  }
  return { preset: BACKGROUNDS.includes(background) ? background : 'midnight', image: null };
}

function isValidBackground(value) {
  return BACKGROUNDS.includes(value) || (value.startsWith('game:') && GAME_ID_RE.test(value.slice(5)));
}

// Avatars arrive as data URLs (resized in the browser) and are checked by their
// actual bytes, not just the declared type.
function parseAvatar(dataUrl) {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) return { error: 'Avatar must be a JPEG, PNG or WebP image.' };
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 300 * 1024) return { error: 'Avatar image is too large.' };
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  const type = isJpeg ? 'image/jpeg' : isPng ? 'image/png' : isWebp ? 'image/webp' : null;
  if (!type) return { error: 'That file is not a valid image.' };
  return { bytes, type };
}

module.exports = {
  BACKGROUNDS,
  FRAMES,
  ACCENTS,
  SHOWCASE_TYPES,
  MAX_SHOWCASES,
  MAX_COLLECTION,
  parseShowcases,
  statsFor,
  progression,
  resolveShowcases,
  resolveBackground,
  isValidBackground,
  parseAvatar,
};
