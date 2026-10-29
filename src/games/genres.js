// Genres people can browse by.
// `rawg` is the matching RAWG genre slug. `igdb` lists words that IGDB genre or
// theme names contain (IGDB files "Action" as a theme, and has no "Casual").
const GENRES = [
  { name: 'Action', rawg: 'action', igdb: { themes: ['action'] } },
  { name: 'Adventure', rawg: 'adventure', igdb: { genres: ['adventure'] } },
  { name: 'RPG', rawg: 'role-playing-games-rpg', igdb: { genres: ['role-playing'] } },
  { name: 'Shooter', rawg: 'shooter', igdb: { genres: ['shooter'] } },
  { name: 'Indie', rawg: 'indie', igdb: { genres: ['indie'] } },
  { name: 'Strategy', rawg: 'strategy', igdb: { genres: ['strategy'] } },
  { name: 'Platformer', rawg: 'platformer', igdb: { genres: ['platform'] } },
  { name: 'Simulation', rawg: 'simulation', igdb: { genres: ['simulator'] } },
  { name: 'Puzzle', rawg: 'puzzle', igdb: { genres: ['puzzle'] } },
  { name: 'Racing', rawg: 'racing', igdb: { genres: ['racing'] } },
  { name: 'Sports', rawg: 'sports', igdb: { genres: ['sport'] } },
  { name: 'Fighting', rawg: 'fighting', igdb: { genres: ['fighting'] } },
  { name: 'Casual', rawg: 'casual', igdb: { genres: ['card', 'quiz', 'pinball'], themes: ['party'] } },
  { name: 'Family', rawg: 'family', igdb: { themes: ['kids'] } },
];

const findGenre = (name) => GENRES.find((g) => g.name.toLowerCase() === String(name).toLowerCase()) || null;

module.exports = { GENRES, findGenre };
