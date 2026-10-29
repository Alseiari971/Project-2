import { html, api, mount, state, year, gameHref } from '../lib.js';
import { gameTile, libraryTile, rankTile, row, enableRows, titleArt } from '../components.js';
import { icon } from '../icons.js';

const NEW_DAYS = 60;
const isNew = (released) => released && Date.now() - new Date(released).getTime() < NEW_DAYS * 24 * 60 * 60 * 1000;

function featured(games) {
  return html`
    <section class="feature" aria-label="Featured games">
      <div class="feature-head">
        <h1 id="feature-title">${games[0].name}</h1>
        <div class="feature-arrows">
          <button type="button" class="round-btn small" id="feature-prev" aria-label="Previous">${icon('left')}</button>
          <button type="button" class="round-btn small" id="feature-next" aria-label="Next">${icon('right')}</button>
        </div>
      </div>
      <div class="feature-track" id="feature-track">
        ${games.map((g) => html`
          <a class="feature-card" href="${gameHref(g.id)}" data-name="${g.name}">
            <span class="feature-bg" data-bg="${g.backdrop}"></span>
            <span class="feature-shade"></span>
            ${isNew(g.released) ? html`<span class="tag tag-new feature-tag">NEW</span>` : ''}
            <span class="feature-info">
              ${titleArt(g, 'span')}
              <span class="feature-meta">${year(g.released)} · ${g.genres.slice(0, 2).join(', ')}</span>
            </span>
          </a>`)}
      </div>
    </section>`;
}

// The heading shows whichever featured game is in view, like a launcher's carousel.
function wireFeatured(root) {
  const track = root.querySelector('#feature-track');
  if (!track) return;
  const cards = [...track.children];
  const title = root.querySelector('#feature-title');
  const step = () => cards[0].getBoundingClientRect().width + parseFloat(getComputedStyle(track).columnGap || 0);
  const current = () => Math.round(track.scrollLeft / step());
  track.addEventListener('scroll', () => {
    title.textContent = cards[Math.min(cards.length - 1, current())].dataset.name;
  }, { passive: true });
  root.querySelector('#feature-prev').addEventListener('click', () => track.scrollTo({ left: (current() - 1) * step(), behavior: 'smooth' }));
  root.querySelector('#feature-next').addEventListener('click', () => {
    const next = current() + 1 >= cards.length ? 0 : current() + 1;
    track.scrollTo({ left: next * step(), behavior: 'smooth' });
  });
}

// Tips about GameShelf, in the spirit of a launcher's "what's new" cards.
function tips(backdrops) {
  const signedIn = Boolean(state.user);
  const cards = [
    signedIn
      ? { title: 'Bring your Steam library', body: 'Every game you own, with your hours played, in one go.', link: '#/import', cta: 'Import now' }
      : { title: 'Track every game', body: 'Mark what you are playing, finished or saving for later, and rate it.', link: '#/register', cta: 'Join free' },
    { title: 'Never overpay', body: 'Every game page shows live PC prices across stores and the all-time low.', link: '#/browse', cta: 'Find a game' },
    signedIn
      ? { title: 'Make your profile yours', body: 'Pick a background, an avatar frame and showcases for your favorites.', link: '#/customize', cta: 'Customize' }
      : { title: 'Show off your taste', body: 'Profiles with showcases, badges and levels earned from your list.', link: '#/register', cta: 'Get started' },
    { title: 'Find your people', body: 'See what others are playing and leave a comment on their profile.', link: '#/community', cta: 'Browse players' },
  ];
  return html`
    <section class="row">
      <div class="row-head"><h2>Get more from GameShelf</h2></div>
      <div class="tip-grid">
        ${cards.map((c, i) => html`
          <a class="tip-card" href="${c.link}">
            ${backdrops[i] ? html`<span class="tip-art" data-bg="${backdrops[i]}"></span>` : ''}
            <span class="tip-text">
              <strong>${c.title}</strong>
              <span>${c.body} <em>${c.cta} →</em></span>
            </span>
          </a>`)}
      </div>
    </section>`;
}

export async function homeView(app) {
  const home = await api('/home');

  const gameRows = home.rows.map((r) => {
    if (r.id === 'top10') {
      return row({ title: r.title, cls: 'row-top10', items: r.games.map((g, i) => rankTile(g, i + 1)) });
    }
    return row({
      title: r.title,
      href: r.genre ? `#/browse?genre=${encodeURIComponent(r.genre)}` : r.id === 'community' ? null : `#/browse?sort=${r.id === 'new' ? 'new' : 'popular'}`,
      items: r.games.map((g) => gameTile(g, {
        tag: g.players ? `${g.players} ${g.players === 1 ? 'player' : 'players'}` : isNew(g.released) ? 'New' : '',
      })),
    });
  });

  const backdrops = home.featured.slice(1).map((g) => g.backdrop).filter(Boolean);
  mount(app, html`
    <div class="page home">
      ${home.featured.length ? featured(home.featured) : ''}
      ${state.library.length
        ? row({ title: 'My games', href: '#/library', cls: 'row-small', items: state.library.slice(0, 20).map(libraryTile) })
        : ''}
      ${gameRows.slice(0, 2)}
      ${tips(backdrops)}
      ${gameRows.slice(2)}
      <section class="row">
        <div class="row-head"><h2>Browse by genre</h2></div>
        <div class="genre-grid">
          ${home.genres.map((g) => html`
            <a class="genre-card" href="#/browse?genre=${encodeURIComponent(g.name)}">
              ${g.image ? html`<span class="genre-art" data-bg="${g.image}"></span>` : ''}
              <span class="genre-name">${g.name}</span>
            </a>`)}
        </div>
      </section>
      ${home.source === 'local' ? html`
        <p class="catalog-note">This is a 35-game sample catalog. Add a free RAWG API key (see the README) to search all 500,000+ games.</p>` : ''}
    </div>
  `);
  enableRows(app);
  wireFeatured(app);
}
