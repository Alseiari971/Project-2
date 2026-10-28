import { html, api, mount, state, year, formatDate, STATUS_LABELS, toast, hueFor } from '../lib.js';
import { gameTile, row, enableRows, userChip, statusBadge } from '../components.js';
import { icon } from '../icons.js';

function listControls(game) {
  if (!state.user) {
    return html`<a class="btn btn-light btn-lg" href="#/login">${icon('plus')} Log in to add to your list</a>`;
  }
  const entry = game.myEntry;
  return html`
    <div class="list-controls" id="list-controls">
      <div class="segmented" role="group" aria-label="Status">
        ${Object.entries(STATUS_LABELS).map(([value, label]) => html`
          <button type="button" class="${entry?.status === value ? 'active' : ''}" data-status="${value}" aria-pressed="${entry?.status === value}">
            ${entry?.status === value ? icon('check') : ''}${label}
          </button>`)}
      </div>
      <div class="rating-picker ${entry ? '' : 'disabled'}" role="group" aria-label="Your rating">
        <span class="rating-label">${entry ? 'Your rating' : 'Pick a status to rate'}</span>
        ${Array.from({ length: 10 }, (_, i) => i + 1).map((n) => html`
          <button type="button" data-rating="${n}" class="${entry?.rating >= n ? 'on' : ''}" aria-label="${n} out of 10" ${entry ? '' : html`disabled`}>${n}</button>`)}
        ${entry ? html`<button type="button" class="link-btn" id="remove-entry">${icon('trash')} Remove</button>` : ''}
      </div>
    </div>`;
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
      ${game.backdrop || game.image
        ? html`<div class="hero-bg" data-bg="${game.backdrop || game.image}"></div>`
        : html`<div class="hero-bg" data-hue="${hueFor(game.name)}"></div>`}
      <div class="hero-shade"></div>
      <div class="hero-content">
        <h1 class="hero-title">${game.name}</h1>
        <div class="hero-meta">
          <span>${year(game.released)}</span>
          ${game.genres.slice(0, 3).map((g) => html`<span class="dot">${g}</span>`)}
          ${game.community.count ? html`<span class="dot">${game.community.count} on GameShelf</span>` : ''}
        </div>
        ${listControls(game)}
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
              : html`<p class="muted">Nobody has added this game yet. Be the first.</p>`}
          </section>
        </div>

        <aside class="glass buy-card" id="buy">
          <h2>${icon('bag')} Where to buy</h2>
          <p class="muted small">GameShelf doesn't sell games. These buttons open the official stores.</p>
          ${game.buy.links.length
            ? html`<div class="store-list">${game.buy.links.map((l) => html`
                <a class="store" href="${l.url}" target="_blank" rel="noopener noreferrer">
                  <span class="store-name">${l.name}<small>${l.direct ? 'Store page' : 'Search store'}</small></span>
                  ${icon('external')}
                </a>`)}</div>`
            : html`<p class="muted">We don't know which stores carry this game yet.</p>`}
          <a class="btn btn-glass btn-block" href="${game.buy.compareUrl}" target="_blank" rel="noopener noreferrer">Compare prices ${icon('external')}</a>
        </aside>
      </div>

      ${game.similar.length ? row({ title: 'More like this', items: game.similar.map((g) => gameTile(g)) }) : ''}
    </div>
  `);
  enableRows(app);
  if (params.get('section') === 'buy') document.getElementById('buy').scrollIntoView({ block: 'center' });

  if (!document.getElementById('list-controls')) return;

  const save = async (body, message) => {
    try {
      const { entry } = await api(`/me/library/${encodeURIComponent(game.id)}`, { method: 'PUT', body });
      game.myEntry = entry;
      document.getElementById('list-controls').outerHTML = listControls(game).value;
      wire();
      toast(message);
    } catch (err) {
      toast(err.message, { error: true });
    }
  };

  function wire() {
    const el = document.getElementById('list-controls');
    el.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () =>
      save({ status: b.dataset.status, rating: game.myEntry?.rating ?? null }, `Marked as ${STATUS_LABELS[b.dataset.status]}`)));
    el.querySelectorAll('[data-rating]').forEach((b) => b.addEventListener('click', () => {
      const n = Number(b.dataset.rating);
      // Clicking your current rating again clears it.
      const rating = game.myEntry?.rating === n ? null : n;
      save({ status: game.myEntry.status, rating }, rating ? `Rated ${rating}/10` : 'Rating cleared');
    }));
    el.querySelector('#remove-entry')?.addEventListener('click', async () => {
      await api(`/me/library/${encodeURIComponent(game.id)}`, { method: 'DELETE' });
      game.myEntry = null;
      el.outerHTML = listControls(game).value;
      wire();
      toast('Removed from your list');
    });
  }
  // The controls are re-rendered after every change, so wire() looks them up fresh.
  wire();
}
