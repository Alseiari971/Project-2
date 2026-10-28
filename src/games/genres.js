// Genres people can browse by. `rawg` is the matching RAWG genre slug.
const GENRES = [
  { name: 'Action', rawg: 'action' },
  { name: 'Adventure', rawg: 'adventure' },
  { name: 'RPG', rawg: 'role-playing-games-rpg' },
  { name: 'Shooter', rawg: 'shooter' },
  { name: 'Indie', rawg: 'indie' },
  { name: 'Strategy', rawg: 'strategy' },
  { name: 'Platformer', rawg: 'platformer' },
  { name: 'Simulation', rawg: 'simulation' },
  { name: 'Puzzle', rawg: 'puzzle' },
  { name: 'Racing', rawg: 'racing' },
  { name: 'Sports', rawg: 'sports' },
  { name: 'Fighting', rawg: 'fighting' },
  { name: 'Casual', rawg: 'casual' },
  { name: 'Family', rawg: 'family' },
];

const findGenre = (name) => GENRES.find((g) => g.name.toLowerCase() === String(name).toLowerCase()) || null;

module.exports = { GENRES, findGenre };
