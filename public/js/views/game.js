import { html, api, mount, state, year, formatDate, STATUS_LABELS, toast, hueFor, onLeave } from '../lib.js';
import { gameTile, row, enableRows, userChip, statusBadge, titleArt, starInput, wireStarInput, starValue, formatHours } from '../components.js';
import { icon } from '../icons.js';

function listActions(game) {
  if (!state.user) {
    return html`<div class="list-actions"><a class="btn btn-light btn-lg" href="#/login">${icon('plus')} Add to list</a></div>`;
  }
  const entry = game.myEntry;
  return html`
    <div class="list-actions" id="list-actions">
      <div class="dropdown">
        <button type="button" class="btn ${entry ? 'btn-quiet' : 'btn-light'} btn-lg" id="list-button" aria-haspopup="menu" aria-expanded="false">
          ${entry ? html`${icon('check')} ${STATUS_LABELS[entry.status]}` : html`${icon('plus')} Add to list`}
          ${icon('down', 'chevron')}
        </button>
        <div class="dropdown-menu" id="list-menu" role="menu" hidden>
          ${Object.entries(STATUS_LABELS).map(([value, label]) => html`
            <button type="button" role="menuitemradio" aria-checked="${entry?.status === value}" data-status="${value}">
              <span class="check">${entry?.status === value ? icon('check') : ''}</span>${label}
            </button>`)}
          ${entry ? html`<div class="menu-sep"></div><button type="button" role="menuitem" class="danger" id="remove-entry">${icon('trash')} Remove from list</button>` : ''}
        </div>
      </div>
      <div class="rate">
        ${starInput(entry?.rating)}
        <span class="rate-label">${entry?.rating ? `${starValue(entry.rating)} / 5` : 'Rate it'}</span>
      </div>
      ${entry?.playtime ? html`<span class="playtime">${formatHours(entry.playtime)} played</span>` : ''}
    </div>`;
}

function priceSection(prices) {
  if (!prices || !prices.deals.length) return '';
  const best = prices.deals[0];
  const money = (n) => `$${n.toFixed(2)}`;
  return html`
    <div class="best-price">
      <div class="best-label">Best price right now</div>
      <div class="best-row">
        <span class="best-amount">${best.price === 0 ? 'Free' : money(best.price)}</span>
        ${best.savings >= 1 ? html`<span class="discount">−${Math.round(best.savings)}%</span>` : ''}
      </div>
      <a class="btn btn-accent btn-block" href="${best.url}" target="_blank" rel="noopener noreferrer">Buy on ${best.store} ${icon('external')}</a>
      ${prices.lowestEver ? html`<div class="muted small">Lowest ever: ${money(prices.lowestEver.price)}, ${new Date(prices.lowestEver.date).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</div>` : ''}
    </div>
    ${prices.deals.length > 1 ? html`
      <h3 class="buy-subhead">All PC prices</h3>
      <div class="deal-list">
        ${prices.deals.map((d) => html`
          <a class="deal" href="${d.url}" target="_blank" rel="noopener noreferrer">
            <span class="deal-store">${d.store}</span>
            <span class="deal-price">
              ${d.savings >= 1 ? html`<s>${money(d.retailPrice)}</s>` : ''}
              <strong>${d.price === 0 ? 'Free' : money(d.price)}</strong>
            </span>
          </a>`)}
      </div>` : ''}
    <p class="fine-print">PC prices in US dollars from CheapShark, updated hourly.</p>`;
}

export async function gameView(app, id, params) {
  const game = await api(`/games/${encodeURIComponent(id)}`);
  document.title = `${game.name} · GameShelf`;

  const facts = [
    ['Released', formatDate(game.released)],
    ['Platforms', game.platforms.join(', ')],
    game.developers.length && ['Developer', game.developers.join(', ')],
    game.publishers.length && ['Publisher', game.publishers.join(', ')],
    ['Genres', game.genres.join(', ')],
  ].filter((f) => f && f[1]);

  mount(app, html`
    <section class="game-hero">
      <div class="hero-media">
        ${game.backdrop || game.image
          ? html`<div class="hero-bg" data-bg="${game.backdrop || game.image}"></div>`
          : html`<div class="hero-bg" data-hue="${hueFor(game.name)}"></div>`}
        <div class="hero-shade"></div>
      </div>
      <div class="hero-content">
        ${titleArt(game)}
        <div class="hero-meta">
          <span>${year(game.released)}</span>
          ${game.genres.slice(0, 3).map((g) => html`<span class="dot">${g}</span>`)}
          ${game.community.count ? html`<span class="dot">${game.community.count} ${game.community.count === 1 ? 'player' : 'players'} here</span>` : ''}
        </div>
        ${listActions(game)}
      </div>
    </section>

    <div class="page-body">
      <div class="game-layout">
        <div>
          ${game.description ? html`
            <section class="section">
              <h2>About</h2>
              <p class="prose">${game.description}</p>
            </section>` : ''}
          <section class="section">
            <h2>Details</h2>
            <dl class="facts">${facts.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
            ${game.website ? html`<a class="text-link" href="${game.website}" target="_blank" rel="noopener noreferrer">Official website ${icon('external')}</a>` : ''}
          </section>
          <section class="section">
            <h2>Players on GameShelf</h2>
            ${game.community.players.length
              ? html`<div class="chip-list">${game.community.players.map((p) => userChip(p, statusBadge(p.status)))}</div>`
              : html`<p class="muted">No one has added this yet.</p>`}
          </section>
        </div>

        <aside class="buy-card" id="buy">
          <h2>Where to buy</h2>
          <div id="prices"><div class="sk sk-line wide"></div><div class="sk sk-line"></div></div>
          ${game.buy.links.length ? html`
            <h3 class="buy-subhead">Stores</h3>
            <div class="store-list">${game.buy.links.map((l) => html`
              <a class="store" href="${l.url}" target="_blank" rel="noopener noreferrer">
                <span>${l.name}</span>
                <span class="store-kind">${l.direct ? 'Store page' : 'Search'} ${icon('external')}</span>
              </a>`)}</div>` : ''}
          <a class="text-link small" href="${game.buy.compareUrl}" target="_blank" rel="noopener noreferrer">Compare on IsThereAnyDeal ${icon('external')}</a>
        </aside>
      </div>

      ${game.similar.length ? row({ title: 'More like this', items: game.similar.map((g) => gameTile(g)) }) : ''}
    </div>
  `);
  enableRows(app);
  if (params.get('section') === 'buy') document.getElementById('buy').scrollIntoView({ block: 'center' });

  // Prices come from a separate, slower service, so they load after the page.
  api(`/games/${encodeURIComponent(game.id)}/prices`)
    .catch(() => null)
    .then((prices) => {
      const el = document.getElementById('prices');
      if (el) mount(el, priceSection(prices));
    });

  if (!document.getElementById('list-actions')) return;

  // Clicking anywhere else closes the list menu.
  const closeMenus = () => document.querySelectorAll('#list-menu').forEach((m) => {
    m.hidden = true;
    document.getElementById('list-button')?.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', closeMenus);
  onLeave(() => document.removeEventListener('click', closeMenus));

  const save = async (body, message) => {
    try {
      const { entry } = await api(`/me/library/${encodeURIComponent(game.id)}`, { method: 'PUT', body });
      game.myEntry = entry;
      rerender();
      toast(message);
    } catch (err) {
      toast(err.message, { error: true });
    }
  };

  function rerender() {
    const el = document.getElementById('list-actions');
    el.outerHTML = listActions(game).value;
    wire();
  }

  function wire() {
    const el = document.getElementById('list-actions');
    const button = el.querySelector('#list-button');
    const menu = el.querySelector('#list-menu');
    const close = closeMenus;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      button.setAttribute('aria-expanded', String(!menu.hidden));
    });

    menu.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => {
      close();
      save({ status: b.dataset.status, rating: game.myEntry?.rating ?? null }, `Moved to ${STATUS_LABELS[b.dataset.status]}`);
    }));
    menu.querySelector('#remove-entry')?.addEventListener('click', async () => {
      close();
      await api(`/me/library/${encodeURIComponent(game.id)}`, { method: 'DELETE' });
      game.myEntry = null;
      rerender();
      toast('Removed from your list');
    });

    wireStarInput(el.querySelector('.star-input'), (n) => {
      // Picking your current rating again clears it. Rating a game that isn't
      // on your list yet adds it as Played.
      const rating = game.myEntry?.rating === n ? null : n;
      save({ status: game.myEntry?.status || 'played', rating }, rating ? `Rated ${starValue(rating)} stars` : 'Rating cleared');
    });
  }
  wire();
}
