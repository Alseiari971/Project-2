// Reads a player's owned games and playtime from Steam, for the Steam account
// they linked with Steam's own sign-in (src/steam-openid.js): never for a
// Steam ID or profile someone typed in. This needs a free Steam Web API key
// (https://steamcommunity.com/dev/apikey) set as STEAM_API_KEY, and the
// player's game details must be public on Steam.

const USER_AGENT = 'GameShelf/0.3 (+https://github.com/Alseiari971/Project-2)';
const STEAM_ID_RE = /^7656119\d{10}$/;

class SteamError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function createSteamService(apiKey = process.env.STEAM_API_KEY, { fetchImpl = fetch } = {}) {
  async function get(url) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 401 || res.status === 403) throw new SteamError('bad_key', 'The Steam API key was rejected.');
    if (!res.ok) throw new SteamError('unavailable', `Steam returned status ${res.status}.`);
    return res;
  }

  const apiUrl = (path, params) => {
    const url = new URL(`https://api.steampowered.com/${path}`);
    url.search = new URLSearchParams({ key: apiKey, format: 'json', ...params });
    return url;
  };

  return {
    enabled: Boolean(apiKey),

    /** The games of a verified, linked Steam account (a SteamID64). */
    async ownedGames(steamId) {
      if (!apiKey) throw new SteamError('no_key', 'Steam import isn’t set up on this server yet.');
      if (!STEAM_ID_RE.test(String(steamId || ''))) throw new SteamError('link_required', 'Link your Steam account first.');
      const data = await (await get(apiUrl('IPlayerService/GetOwnedGames/v1/', {
        steamid: steamId, include_appinfo: '1', include_played_free_games: '1',
      }))).json();
      // Steam returns an empty response when the profile's game details are private.
      if (!data.response || !Array.isArray(data.response.games)) {
        throw new SteamError('private', 'That profile’s game details are private. Set them to Public in Steam’s privacy settings and try again.');
      }
      return {
        steamId,
        games: data.response.games.map((g) => ({
          appid: g.appid,
          name: g.name,
          playtime: g.playtime_forever || 0,
          recentPlaytime: g.playtime_2weeks || 0,
        })),
      };
    },

    /** A Steam account's public name (persona), or '' without a key. */
    async playerName(steamId) {
      if (!apiKey || !STEAM_ID_RE.test(String(steamId || ''))) return '';
      const data = await (await get(apiUrl('ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId }))).json();
      return String(data?.response?.players?.[0]?.personaname || '');
    },
  };
}

module.exports = { createSteamService, SteamError, STEAM_ID_RE };
