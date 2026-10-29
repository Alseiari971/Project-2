import { html, api, mount, state, year, formatDate, STATUS_LABELS, toast, hueFor, onLeave, rememberGame, refreshLibrary } from '../lib.js';
import { gameTile, row, enableRows, userChip, statusBadge, starInput, wireStarInput, starValue, formatHours } from '../components.js';
import { icon } from '../icons.js';

function listActions(game) {
  if (!state.user) {
    return html`<div class="list-actions"><a class="pill-btn pill-lg" href="#/login">${icon('plus')} Add to list</a></div>`;
  }
  const entry = game.myEntry;
  return html`
    <div class="list-actions" id="list-actions">
      <div class="dropdown">
        <button type="button" class="pill-btn pill-lg" id="list-button" aria-haspopup="menu" aria-expanded="false">
          ${entry ? html`${icon('check')} ${STATUS_LABELS[entry.status]}` : html`${icon('plus')} Add to list`}
          ${icon('down', 'chevron')}
        </button>
        <div class="dropdown-menu" id="list-menu" role="menu" hidden>
          ${Object.entries(STATUS_LABELS).map(([value, label]) => html`
            <button type="button" role="menuitemradio" aria-checked="${entry?.status === value}" data-status="${value}">
              <span class="check">${entry?.status === value ? icon('check') : ''}</span>${label}
            </button>`)}
          ${entry ? html`<div class="menu-sep"></div><button type="button" role="menuitem" class="danger" id="remove-entry">Remove from list</button>` : ''}
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
      <a class="pill-btn pill-accent pill-block" href="${best.url}" target="_blank" rel="noopener noreferrer">Buy on ${best.store} ${icon('external')}</a>
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
  rememberGame(game);

  const details = [
    ['Released', formatDate(game.released)],
    ['Platforms', game.platforms.join(', ')],
    game.developers.length && ['Developer', game.developers.join(', ')],
    game.publishers.length && ['Publisher', game.publishers.join(', ')],
    ['Genres', game.genres.join(', ')],
  ].filter((f) => f && f[1]);

  // Small all-caps stats on the right of the header, launcher style.
  const stats = [
    ['Released', game.released ? year(game.released) : 'TBA'],
    ['Developer', game.developers[0]],
    ['On GameShelf', `${game.community.count} ${game.community.count === 1 ? 'player' : 'players'}`],
    game.myEntry?.playtime ? ['Your hours', formatHours(game.myEntry.playtime)] : ['Platforms', game.platforms.slice(0, 2).join(', ')],
  ].filter(([, v]) => v);
  const cover = game.poster || game.image;

  mount(app, html`
    <div class="game-page">
      ${game.backdrop || game.image ? html`<div class="gp-backdrop" data-bg="${game.backdrop || game.image}"></div>` : ''}
      <div class="page gp">
        <header class="gp-head">
          <div class="gp-ident">
            ${cover
              ? html`<img class="gp-cover ${game.poster ? 'tall' : ''}" src="${cover}" alt="" referrerpolicy="no-referrer">`
              : html`<span class="gp-cover art-fallback" data-hue="${hueFor(game.name)}"></span>`}
            <div class="gp-titles">
              <h1>${game.name}</h1>
              <div class="tag-row">${game.genres.slice(0, 5).map((g) => html`<a class="tag" href="#/browse?genre=${encodeURIComponent(g)}">${g}</a>`)}</div>
            </div>
          </div>
          <dl class="gp-stats">${stats.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
        </header>

        <div class="gp-actions">
          ${listActions(game)}
          <div class="gp-buy">
            ${game.website ? html`<a class="round-btn" href="${game.website}" target="_blank" rel="noopener noreferrer" aria-label="Official website" title="Official website">${icon('link')}</a>` : ''}
            <a class="pill-btn pill-light pill-lg" id="buy-btn" href="#buy">Where to buy</a>
          </div>
        </div>

        <nav class="gp-tabs pill-group" aria-label="Sections">
          <a href="#about" data-jump="about" class="active">Overview</a>
          <a href="#buy" data-jump="buy">Where to buy</a>
          <a href="#players" data-jump="players">Players</a>
          ${game.similar.length ? html`<a href="#similar" data-jump="similar">More like this</a>` : ''}
        </nav>

        <div class="gp-layout">
          <div class="gp-main">
            <section class="panel" id="about">
              <h2>About</h2>
              ${game.description ? html`<p class="prose">${game.description}</p>` : html`<p class="muted">No description yet.</p>`}
            </section>
            <section class="panel">
              <h2>Details</h2>
              <dl class="detail-rows">${details.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
            </section>
            <section class="panel" id="players">
              <h2>Players on GameShelf</h2>
              ${game.community.players.length
                ? html`<div class="chip-list">${game.community.players.map((p) => userChip(p, statusBadge(p.status)))}</div>`
                : html`<p class="muted">No one has added this yet.</p>`}
            </section>
          </div>

          <aside class="panel buy-card" id="buy">
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

        ${game.similar.length ? row({ title: 'More like this', id: 'similar', items: game.similar.map((g) => gameTile(g)) }) : ''}
      </div>
    </div>
  `);
  enableRows(app);

  // Section links scroll within the page instead of changing the route.
  app.querySelectorAll('[data-jump]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    app.querySelectorAll('.gp-tabs a').forEach((t) => t.classList.toggle('active', t === a));
    document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  document.getElementById('buy-btn').addEventListener('click', (e) => {
    if (e.currentTarget.getAttribute('href') === '#buy') {
      e.preventDefault();
      document.getElementById('buy').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  if (params.get('section') === 'buy') document.getElementById('buy').scrollIntoView({ block: 'start' });

  // Prices come from a separate, slower service, so they load after the page.
  api(`/games/${encodeURIComponent(game.id)}/prices`)
    .catch(() => null)
    .then((prices) => {
      const el = document.getElementById('prices');
      if (!el) return;
      mount(el, priceSection(prices));
      const best = prices?.deals[0];
      const button = document.getElementById('buy-btn');
      if (best && button) {
        button.href = best.url;
        button.target = '_blank';
        button.rel = 'noopener noreferrer';
        mount(button, html`Buy ${best.price === 0 ? 'free' : `$${best.price.toFixed(2)}`}<small>on ${best.store}</small>`);
      }
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
      refreshLibrary();
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
      refreshLibrary();
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
