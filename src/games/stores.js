// Stores we can send people to. We never sell anything ourselves: every
// "buy" button is an outbound link to the real store.
const STORES = {
  steam:       { name: 'Steam',              search: (q) => `https://store.steampowered.com/search/?term=${q}` },
  epic:        { name: 'Epic Games Store',   search: (q) => `https://store.epicgames.com/en-US/browse?q=${q}` },
  gog:         { name: 'GOG',                search: (q) => `https://www.gog.com/en/games?query=${q}` },
  playstation: { name: 'PlayStation Store',  search: (q) => `https://store.playstation.com/en-us/search/${q}` },
  xbox:        { name: 'Xbox Store',         search: (q) => `https://www.xbox.com/en-US/Search/Results?q=${q}` },
  nintendo:    { name: 'Nintendo eShop',     search: (q) => `https://www.nintendo.com/us/search/#q=${q}` },
  itch:        { name: 'itch.io',            search: (q) => `https://itch.io/search?q=${q}` },
  apple:       { name: 'App Store',          search: (q) => `https://www.apple.com/us/search/${q}?src=globalnav` },
  googleplay:  { name: 'Google Play',        search: (q) => `https://play.google.com/store/search?q=${q}&c=apps` },
};

// RAWG store slugs -> our store keys.
const RAWG_STORE_KEYS = {
  steam: 'steam',
  'epic-games': 'epic',
  gog: 'gog',
  'playstation-store': 'playstation',
  'xbox-store': 'xbox',
  xbox360: 'xbox',
  nintendo: 'nintendo',
  itch: 'itch',
  'apple-appstore': 'apple',
  'google-play': 'googleplay',
};

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Builds the list of "where to buy" links for a game.
 * @param {string} gameName
 * @param {Array<{key: string, url?: string}>} stores  stores the game is sold on;
 *   `url` is a direct product page when known, otherwise we link to a store search.
 */
function buildBuyLinks(gameName, stores) {
  const q = encodeURIComponent(gameName);
  const seen = new Set();
  const links = [];
  for (const { key, url } of stores) {
    const store = STORES[key];
    if (!store || seen.has(key)) continue;
    seen.add(key);
    const direct = url && isHttpUrl(url);
    links.push({ store: key, name: store.name, url: direct ? url : store.search(q), direct: Boolean(direct) });
  }
  return {
    links,
    compareUrl: `https://isthereanydeal.com/search/?q=${q}`,
  };
}

module.exports = { STORES, RAWG_STORE_KEYS, buildBuyLinks };
