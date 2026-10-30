// What the home page shows in each season. The page picks the season from the
// visitor's own calendar (public/js/seasons.js) and asks for it by id; this
// file decides which games fill it.
//
// A query lists groups of IGDB genres, themes and game modes. A game must match
// every group in `all` (any name within a group), and none of `not`. Sorts:
// popular, top (highest rated), new (released this past year), year (best of
// this calendar year) and upcoming (out in the next three months).
const NOT_FOR_EVERYONE = { themes: ['horror', 'erotic'] };

const UPCOMING = { id: 'upcoming', title: 'Coming soon', kicker: 'The most anticipated releases', layout: 'countdown', query: { sort: 'upcoming' } };

const SEASONS = {
  // Halloween.
  'fright-night': {
    spotlight: { all: [{ themes: ['horror'] }], sort: 'popular' },
    sections: [
      { id: 'survival-horror', title: 'Survival horror', kicker: 'Can you make it to sunrise?', layout: 'bento', query: { all: [{ themes: ['horror'] }], sort: 'top' } },
      { id: 'scream-together', title: 'Scream together', kicker: 'Horror is better with friends', layout: 'row', query: { all: [{ themes: ['horror'] }, { modes: ['co-operative', 'multiplayer'] }], sort: 'popular' } },
      { id: 'fresh-nightmares', title: 'Fresh nightmares', kicker: 'New horror from the past year', layout: 'posters', query: { all: [{ themes: ['horror'] }], sort: 'new' } },
      UPCOMING,
    ],
  },
  // The winter holidays and the turn of the year.
  winter: {
    spotlight: { sort: 'year' },
    sections: [
      { id: 'best-of-year', title: 'The best of {year}', kicker: 'This year’s highest rated', layout: 'bento', query: { sort: 'year' } },
      { id: 'recap', title: 'Your {year} on GameShelf', kicker: 'Wrapped up', layout: 'recap' },
      { id: 'cozy', title: 'Cozy nights in', kicker: 'Low stakes, warm blankets', layout: 'row', query: { all: [{ genres: ['simulator', 'puzzle'], themes: ['kids', 'sandbox'] }], not: { themes: ['horror', 'erotic', 'warfare'] }, sort: 'popular' } },
      { id: 'couch-co-op', title: 'Couch co-op for the holidays', kicker: 'One screen, everyone playing', layout: 'posters', query: { all: [{ modes: ['split screen'] }], not: NOT_FOR_EVERYONE, sort: 'popular' } },
      UPCOMING,
    ],
  },
  'lunar-new-year': {
    spotlight: null,
    sections: [
      { id: 'reunion', title: 'Family reunion games', kicker: 'For everyone around the table', layout: 'bento', query: { all: [{ themes: ['party', 'kids'], modes: ['split screen'] }], not: NOT_FOR_EVERYONE, sort: 'popular' } },
      { id: 'fighting-spirit', title: 'Fighting spirit', kicker: 'Martial arts and one-on-one battles', layout: 'row', query: { all: [{ genres: ['fighting', 'hack and slash'] }], sort: 'popular' } },
      { id: 'legends', title: 'Myths and legends', kicker: 'Epic stories worth the holiday', layout: 'posters', query: { all: [{ themes: ['fantasy', 'historical'] }, { genres: ['role-playing', 'adventure'] }], not: NOT_FOR_EVERYONE, sort: 'top' } },
      UPCOMING,
    ],
  },
  // The month of Ramadan.
  ramadan: {
    spotlight: { all: [{ modes: ['co-operative'] }], not: NOT_FOR_EVERYONE, sort: 'popular' },
    sections: [
      { id: 'after-iftar', title: 'After iftar, together', kicker: 'Co-op for the whole night', layout: 'bento', query: { all: [{ modes: ['co-operative'] }], not: NOT_FOR_EVERYONE, sort: 'top' } },
      { id: 'majlis', title: 'Party games for the majlis', kicker: 'Easy to pick up, loud to play', layout: 'row', query: { all: [{ themes: ['party'], genres: ['quiz', 'music', 'card'] }], not: NOT_FOR_EVERYONE, sort: 'popular' } },
      { id: 'late-nights', title: 'Stories for late nights', kicker: 'Long adventures until suhoor', layout: 'posters', query: { all: [{ genres: ['role-playing', 'adventure'] }, { themes: ['fantasy', 'drama', 'mystery'] }], not: NOT_FOR_EVERYONE, sort: 'top' } },
      UPCOMING,
    ],
  },
  // Eid al-Fitr and Eid al-Adha.
  eid: {
    spotlight: null,
    sections: [
      { id: 'gifts', title: 'Gifts worth giving', kicker: 'Top rated, loved by everyone', layout: 'bento', query: { not: NOT_FOR_EVERYONE, sort: 'top' } },
      { id: 'family-night', title: 'Family game night', kicker: 'Something for every age', layout: 'row', query: { all: [{ themes: ['kids', 'party'] }], not: NOT_FOR_EVERYONE, sort: 'popular' } },
      { id: 'cousins', title: 'Squad up with the cousins', kicker: 'Co-op and split screen', layout: 'posters', query: { all: [{ modes: ['co-operative', 'split screen'] }], not: NOT_FOR_EVERYONE, sort: 'popular' } },
      UPCOMING,
    ],
  },
  summer: {
    spotlight: { all: [{ themes: ['open world'] }], sort: 'popular' },
    sections: [
      { id: 'open-worlds', title: 'Worlds to get lost in', kicker: 'Long days, bigger maps', layout: 'bento', query: { all: [{ themes: ['open world'] }], sort: 'top' } },
      { id: 'summer-co-op', title: 'Summer co-op', kicker: 'New this year, better together', layout: 'row', query: { all: [{ modes: ['co-operative'] }], sort: 'new' } },
      { ...UPCOMING, title: 'Coming this summer' },
    ],
  },
  // Any other time of year.
  default: {
    spotlight: null,
    sections: [UPCOMING],
  },
};

const SEASON_IDS = Object.keys(SEASONS);

/**
 * The season's plan with the year filled in, or the default season for an
 * unknown id. In early January the year being looked back on is the last one.
 */
function seasonPlan(id, now = new Date()) {
  const plan = SEASONS[id] || SEASONS.default;
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const withYear = (query) => (query?.sort === 'year' ? { ...query, year } : query);
  return {
    id: SEASONS[id] ? id : 'default',
    spotlight: withYear(plan.spotlight),
    sections: plan.sections.map((s) => ({ ...s, title: s.title.replace('{year}', year), query: withYear(s.query) })),
  };
}

// "What are you in the mood for?" on the home page: each mood fills one row.
const MOODS = [
  { id: 'scary', label: 'Scary', query: { all: [{ themes: ['horror', 'thriller'] }], sort: 'top' } },
  { id: 'chill', label: 'Chill', query: { all: [{ genres: ['simulator', 'puzzle'], themes: ['sandbox', 'kids'] }], not: { themes: ['horror', 'warfare', 'erotic'] }, sort: 'top' } },
  { id: 'friends', label: 'With friends', query: { all: [{ modes: ['co-operative', 'split screen'] }], not: NOT_FOR_EVERYONE, sort: 'top' } },
  { id: 'story', label: 'A great story', query: { all: [{ genres: ['role-playing', 'adventure', 'visual novel'] }, { themes: ['drama', 'mystery', 'fantasy', 'science fiction'] }], sort: 'top' } },
  { id: 'competitive', label: 'Competitive', query: { all: [{ modes: ['multiplayer', 'battle royale'] }, { genres: ['shooter', 'moba', 'fighting', 'sport', 'racing', 'real time strategy'] }], sort: 'popular' } },
  { id: 'quick', label: 'Quick fun', query: { all: [{ genres: ['arcade', 'platform', 'racing', 'fighting', 'pinball'] }], not: NOT_FOR_EVERYONE, sort: 'top' } },
  { id: 'brainy', label: 'Brain teasers', query: { all: [{ genres: ['puzzle', 'turn-based strategy', 'tactical', 'point-and-click'] }], sort: 'top' } },
  { id: 'open-world', label: 'Open world', query: { all: [{ themes: ['open world'] }], sort: 'top' } },
];

const findMood = (id) => MOODS.find((m) => m.id === id) || null;

module.exports = { SEASON_IDS, seasonPlan, MOODS, findMood };
