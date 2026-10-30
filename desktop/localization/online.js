// GameShelf's server for Arabic subtitles (config.json's arabicServer): which
// games have Arabic ready, and players asking for the ones that don't. Each copy
// of the app gets its own device token from the server the first time, so
// players need no account; it's kept in <data>/localization/online.json.
const fs = require('node:fs/promises');
const path = require('node:path');

class OnlineError extends Error {}

/** "steam:<app id>" or "game:<GameShelf id>", as the server knows games; null when neither fits. */
function gameKey({ steamAppId, gameId }) {
  if (steamAppId && /^\d{1,10}$/.test(String(steamAppId))) return `steam:${steamAppId}`;
  if (gameId && /^[a-z0-9][a-z0-9-]{0,149}$/.test(String(gameId))) return `game:${gameId}`;
  return null;
}

function createArabicOnline({ server, dataDir, fetch = globalThis.fetch, timeoutMs = 15000 }) {
  const base = server ? String(server).replace(/\/+$/, '') : null;
  const file = path.join(dataDir, 'localization', 'online.json');
  let token = null;

  async function readToken() {
    if (token) return token;
    try {
      token = JSON.parse(await fs.readFile(file, 'utf8')).token || null;
    } catch {
      token = null;
    }
    return token;
  }

  async function send(route, body, auth) {
    let res;
    try {
      res = await fetch(`${base}/api${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new OnlineError('GameShelf couldn\'t reach its server. Check your internet connection.');
    }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  async function register() {
    const { status, data } = await send('/arabic/devices', {});
    if (status !== 201 || !data.token) throw new OnlineError(data.error || 'GameShelf\'s server didn\'t answer as expected.');
    token = data.token;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ token }), { mode: 0o600 });
    return token;
  }

  /** A POST with this app's device token; a token the server no longer knows is replaced once. */
  async function call(route, body) {
    if (!base) throw new OnlineError('This copy of GameShelf has no server for Arabic subtitles.');
    let auth = (await readToken()) || (await register());
    let { status, data } = await send(route, body, auth);
    if (status === 401) {
      auth = await register();
      ({ status, data } = await send(route, body, auth));
    }
    if (status >= 400) throw new OnlineError(data.error || 'GameShelf\'s server didn\'t answer as expected.');
    return data;
  }

  return {
    configured: Boolean(base),
    server: base,
    /** The device token, for the pack builder (it's sent only to the server, in a header). */
    token: async () => (await readToken()) || (await register()),
    /** { status: 'ready' | 'partial' | 'none', total, translated, requests, asked, fontTargets } */
    async status(key) {
      return (await call('/arabic/status', { games: [key] })).games?.[key] || null;
    },
    async request(key, name) {
      return call('/arabic/requests', { game: key, name });
    },
  };
}

module.exports = { createArabicOnline, gameKey, OnlineError };
