// Reads a player's owned games and playtime from Steam. This needs a free
// Steam Web API key (https://steamcommunity.com/dev/apikey) set as
// STEAM_API_KEY, and the player's game details must be public on Steam.

const USER_AGENT = 'GameShelf/0.3 (+https://github.com/Alseiari971/Project-2)';

class SteamError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Accepts a 17-digit SteamID64, a profile URL (/profiles/<id> or /id/<name>)
 * or a bare custom name, and returns { steamId } or { vanity }.
 */
function parseProfileInput(input) {
  const text = String(input || '').trim();
  if (/^\d{17}$/.test(text)) return { steamId: text };
  const url = /steamcommunity\.com\/(profiles|id)\/([^/?#\s]+)/i.exec(text);
  if (url) return url[1].toLowerCase() === 'profiles' ? { steamId: url[2] } : { vanity: url[2] };
  if (/^[A-Za-z0-9_-]{2,32}$/.test(text)) return { vanity: text };
  return null;
}

function createSteamService(apiKey = process.env.STEAM_API_KEY, { fetchImpl = fetch } = {}) {
  async function get(url) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 401 || res.status === 403) throw new SteamError('bad_key', 'The Steam API key was rejected.');
    if (!res.ok) throw new SteamError('unavailable', `Steam returned status ${res.status}.`);
    return res;
  }

  // Custom profile names resolve through the public profile XML, which needs no key.
  async function resolveVanity(vanity) {
    const res = await get(`https://steamcommunity.com/id/${encodeURIComponent(vanity)}?xml=1`);
    const id = /<steamID64>(\d{17})<\/steamID64>/.exec(await res.text())?.[1];
    if (!id) throw new SteamError('not_found', 'We couldn’t find that Steam profile.');
    return id;
  }

  return {
    enabled: Boolean(apiKey),

    async ownedGames(input) {
      if (!apiKey) throw new SteamError('no_key', 'Steam import isn’t set up on this server yet.');
      const parsed = parseProfileInput(input);
      if (!parsed || (parsed.steamId && !/^\d{17}$/.test(parsed.steamId))) {
        throw new SteamError('bad_input', 'Paste your Steam profile link, like steamcommunity.com/id/yourname.');
      }
      const steamId = parsed.steamId || (await resolveVanity(parsed.vanity));

      const url = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/');
      url.search = new URLSearchParams({
        key: apiKey,
        steamid: steamId,
        include_appinfo: '1',
        include_played_free_games: '1',
        format: 'json',
      });
      const data = await (await get(url)).json();
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
  };
}

module.exports = { createSteamService, parseProfileInput, SteamError };
