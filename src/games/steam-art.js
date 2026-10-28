// Official artwork Steam publishes for every store page, built from a Steam app ID.
const asset = (appId, file) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/${file}`;

function steamArt(appId) {
  return {
    image: asset(appId, 'capsule_616x353.jpg'),
    backdrop: asset(appId, 'library_hero.jpg'),
    // Transparent title artwork, shown instead of plain text on big banners.
    logo: asset(appId, 'logo.png'),
    poster: asset(appId, 'library_600x900.jpg'),
    // Steam's store banners have the game's title built into the artwork.
    artHasTitle: true,
  };
}

module.exports = { steamArt };
