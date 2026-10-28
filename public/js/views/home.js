import { html, api, mount, state, year, gameHref, onLeave } from '../lib.js';
import { gameTile, libraryTile, rankTile, row, enableRows, titleArt } from '../components.js';

const SLIDE_MS = 8000;

function hero(featured) {
  return html`
    <section class="hero" aria-roledescription="carousel" aria-label="Featured games">
      ${featured.map((g, i) => html`
        <div class="hero-slide ${i === 0 ? 'active' : ''}" aria-hidden="${i === 0 ? 'false' : 'true'}">
          <div class="hero-bg" data-bg="${g.backdrop}"></div>
          <div class="hero-shade"></div>
          <div class="hero-content">
            ${titleArt(g, i === 0 ? 'h1' : 'h2')}
            <div class="hero-meta">
              <span>${year(g.released)}</span>
              ${g.genres.slice(0, 3).map((x) => html`<span class="dot">${x}</span>`)}
            </div>
            ${g.description ? html`<p class="hero-desc">${g.description}</p>` : ''}
            <div class="hero-actions">
              <a class="btn btn-light btn-lg" href="${gameHref(g.id)}">More info</a>
              <a class="btn btn-quiet btn-lg" href="${gameHref(g.id)}?section=buy">Where to buy</a>
            </div>
          </div>
        </div>`)}
      <div class="hero-dots">
        ${featured.map((g, i) => html`<button class="${i === 0 ? 'active' : ''}" type="button" aria-label="Show ${g.name}" data-slide="${i}"></button>`)}
      </div>
    </section>`;
}

function startCarousel(root) {
  const slides = [...root.querySelectorAll('.hero-slide')];
  const dots = [...root.querySelectorAll('.hero-dots button')];
  if (slides.length < 2) return;
  let current = 0;
  const show = (i) => {
    slides[current].classList.remove('active');
    slides[current].setAttribute('aria-hidden', 'true');
    dots[current].classList.remove('active');
    current = (i + slides.length) % slides.length;
    slides[current].classList.add('active');
    slides[current].setAttribute('aria-hidden', 'false');
    dots[current].classList.add('active');
  };
  let timer = setInterval(() => show(current + 1), SLIDE_MS);
  dots.forEach((dot) => dot.addEventListener('click', () => {
    clearInterval(timer);
    show(Number(dot.dataset.slide));
    timer = setInterval(() => show(current + 1), SLIDE_MS);
  }));
  onLeave(() => clearInterval(timer));
}

export async function homeView(app) {
  const [home, mine] = await Promise.all([
    api('/home'),
    state.user ? api(`/users/${encodeURIComponent(state.user.username)}`).catch(() => null) : null,
  ]);

  // One personal row: what you're playing, then what you want to play next.
  const shelf = mine
    ? [...mine.library.filter((e) => e.status === 'playing'), ...mine.library.filter((e) => e.status === 'want')]
    : [];

  const gameRows = home.rows.map((r) => {
    if (r.id === 'top10') {
      return row({ title: r.title, cls: 'row-top10', items: r.games.map((g, i) => rankTile(g, i + 1)) });
    }
    return row({
      title: r.title,
      href: r.genre ? `#/browse?genre=${encodeURIComponent(r.genre)}` : r.id === 'community' ? null : `#/browse?sort=${r.id === 'new' ? 'new' : 'popular'}`,
      items: r.games.map((g) => gameTile(g, {
        badge: g.players ? html`<div class="tile-badges"><span class="status">${g.players} ${g.players === 1 ? 'player' : 'players'}</span></div>` : '',
      })),
    });
  });

  mount(app, html`
    ${home.featured.length ? hero(home.featured) : html`<div class="page-spacer"></div>`}
    <div class="rows ${home.featured.length ? 'over-hero' : ''}">
      ${gameRows.slice(0, 2)}
      ${shelf.length ? row({ title: 'Your shelf', href: `#/u/${encodeURIComponent(state.user.username)}`, items: shelf.map(libraryTile) }) : ''}
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
        <p class="catalog-note">
          This is a 35-game sample catalog. Add a free RAWG API key (see the README) to search all 500,000+ games.
        </p>` : ''}
    </div>
  `);
  enableRows(app);
  startCarousel(app);
}
