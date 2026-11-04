// Live presence for friends: while the app is open and signed in, it tells
// GameShelf's server every 45 seconds what's happening (online, or in a game,
// with whether its Arabic is switched on), and at once when a game starts or
// stops. The server forgets presence two minutes after the last heartbeat, so
// a closed or crashed app shows as offline on its own.
const BEAT_MS = 45 * 1000;

/**
 * `cloud` is the app's client for GameShelf's server (cloud.js); `current()`
 * says what to report: { status: 'online' } or { status: 'in_game', gameId,
 * gameTitle, steamAppId, arabicEnabled }.
 */
function createPresenceLoop({ cloud, current, intervalMs = BEAT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let last = '';
  let stopped = true;

  async function beat() {
    clearTimer(timer);
    timer = null;
    if (stopped) return null;
    let sent = null;
    try {
      if (await cloud.session()) {
        const body = { status: 'online', ...(await current()) };
        await cloud.json('/api/presence/heartbeat', { method: 'POST', body });
        last = JSON.stringify(body);
        sent = body;
      }
    } catch {
      // Offline or signed out: the next beat tries again.
    } finally {
      if (!stopped) timer = setTimer(beat, intervalMs);
    }
    return sent;
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      beat();
    },
    /** A game started or stopped: say so now instead of at the next beat. */
    async nudge() {
      if (stopped) return null;
      const body = JSON.stringify({ status: 'online', ...(await current()) });
      return body === last ? null : beat();
    },
    /** Signing out or quitting: offline now. */
    async stop() {
      stopped = true;
      clearTimer(timer);
      timer = null;
      try {
        if (await cloud.session()) await cloud.json('/api/presence/heartbeat', { method: 'POST', body: { status: 'offline' }, timeout: 3000 });
      } catch {}
      last = '';
    },
    beat,
  };
}

module.exports = { createPresenceLoop, BEAT_MS };
