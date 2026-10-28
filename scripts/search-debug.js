// Shows what RAWG returns for a search and which results GameShelf keeps.
// Usage: npm run search-debug -- fortnite
const path = require('node:path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {}

const { createRawgProvider } = require('../src/games/rawg');

const STORE_NAMES = { 1: 'Steam', 2: 'Xbox', 3: 'PlayStation', 4: 'App Store', 5: 'GOG', 6: 'Nintendo', 7: 'Xbox 360', 8: 'Google Play', 9: 'itch.io', 11: 'Epic' };

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  const key = process.env.RAWG_API_KEY;
  if (!query) return console.log('Usage: npm run search-debug -- <search words>');
  if (!key) return console.log('RAWG_API_KEY is not set in .env');

  // The same request GameShelf makes, without any filtering.
  const url = new URL('https://api.rawg.io/api/games');
  url.search = new URLSearchParams({ key, search: query, search_precise: 'true', exclude_additions: 'true', page_size: '40' });
  const raw = await (await fetch(url, { headers: { 'User-Agent': 'GameShelf/0.3' } })).json();

  const kept = new Set((await createRawgProvider(key).search({ query })).results.map((g) => g.id));
  const rows = raw.results.map((g) => ({
    kept: kept.has(g.slug) ? 'yes' : '-',
    name: g.name.slice(0, 40),
    added: g.added,
    ratings: g.ratings_count,
    metacritic: g.metacritic ?? '',
    stores: (g.stores || []).map((s) => STORE_NAMES[s.store.id] || s.store.slug).join(', '),
  }));
  console.table(rows);
}

main().catch((err) => console.error(err.message));
