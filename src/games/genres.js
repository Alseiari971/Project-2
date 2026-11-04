// Genres people can browse by.
// `rawg` is the matching RAWG genre slug; `steamTag` is Steam's store tag for it
// (store.steampowered.com/tag/browse), which the Steam + Wikidata catalog browses by.
const GENRES = [
  { name: 'Action', rawg: 'action', steamTag: 19 },
  { name: 'Adventure', rawg: 'adventure', steamTag: 21 },
  { name: 'RPG', rawg: 'role-playing-games-rpg', steamTag: 122 },
  { name: 'Shooter', rawg: 'shooter', steamTag: 1774 },
  { name: 'Indie', rawg: 'indie', steamTag: 492 },
  { name: 'Strategy', rawg: 'strategy', steamTag: 9 },
  { name: 'Platformer', rawg: 'platformer', steamTag: 1625 },
  { name: 'Simulation', rawg: 'simulation', steamTag: 599 },
  { name: 'Puzzle', rawg: 'puzzle', steamTag: 1664 },
  { name: 'Racing', rawg: 'racing', steamTag: 699 },
  { name: 'Sports', rawg: 'sports', steamTag: 701 },
  { name: 'Fighting', rawg: 'fighting', steamTag: 1743 },
  { name: 'Casual', rawg: 'casual', steamTag: 597 },
  { name: 'Family', rawg: 'family', steamTag: 5350 },
];

const findGenre = (name) => GENRES.find((g) => g.name.toLowerCase() === String(name).toLowerCase()) || null;

module.exports = { GENRES, findGenre };
