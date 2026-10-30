import { html, api, mount, applyStyles, year } from '../lib.js';
import { gameTile, gameListRow, emptyState, pillGroup, viewToggle, savedView, saveView } from '../components.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

const SORTS = { popular: t('Popular'), new: t('New releases'), top: t('Top rated') };

export async function browseView(app, params) {
  const query = params.get('q') || '';
  const genre = params.get('genre') || '';
  const sort = params.get('sort') || 'popular';
  let view = savedView();

  const qs = (overrides) => {
    const p = new URLSearchParams({ q: query, genre, sort, ...overrides });
    for (const [k, v] of [...p]) if (!v || (k === 'sort' && v === 'popular')) p.delete(k);
    const s = p.toString();
    return `#/browse${s ? '?' + s : ''}`;
  };
  const fetchPage = (page) => api(`/games?${new URLSearchParams({ search: query, genre, sort, page })}`);

  const [info, data] = await Promise.all([api('/info'), fetchPage(1)]);
  const sorts = info.source !== 'local' ? SORTS : { popular: SORTS.popular, new: SORTS.new };
  const title = query ? t('Results for “{q}”', { q: query }) : genre ? t('{genre} games', { genre: t(genre) }) : t('Browse');

  const meta = (g) => [g.released ? year(g.released) : '', (g.genres || []).slice(0, 3).map((x) => t(x)).join(t(', '))];
  const items = (games) => (view === 'grid'
    ? html`${games.map((g) => gameTile(g))}`
    : html`${games.map((g) => gameListRow(g, meta(g)))}`);
  let games = data.results;

  mount(app, html`
    <div class="page browse">
      <div class="page-head">
        <h1>${title}</h1>
        ${viewToggle(view)}
      </div>
      <form class="search-bar" id="browse-search" role="search">
        <label class="search-field">${icon('search')}<input type="search" name="q" value="${query}" placeholder="${t('Search')}" aria-label="${t('Search games')}" autocomplete="off"></label>
        <button class="pill-btn" type="submit">${t('Go')}</button>
      </form>
      <div class="filter-row">
        ${pillGroup([{ key: '', label: t('All'), href: qs({ genre: '' }) }, ...info.genres.map((g) => ({ key: g, label: t(g), href: qs({ genre: g }) }))], genre)}
        ${query ? '' : pillGroup(Object.entries(sorts).map(([k, label]) => ({ key: k, label, href: qs({ sort: k }) })), sort, { label: t('Sort by') })}
      </div>
      ${games.length
        ? html`<div class="${view === 'grid' ? 'card-grid' : 'list'}" id="results">${items(games)}</div>`
        : emptyState(t('No games found'), t('Try a different search or genre.'))}
      <div class="center">${data.hasMore ? html`<button class="pill-btn" id="more">${t('Load more')}</button>` : ''}</div>
    </div>
  `);

  const input = app.querySelector('#browse-search input');
  if (params.has('focus')) input.focus();
  document.getElementById('browse-search').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = qs({ q: input.value.trim() });
  });

  // Switching views redraws the results already loaded.
  app.querySelector('.view-toggle').addEventListener('click', (e) => {
    const button = e.target.closest('[data-view]');
    if (!button || button.dataset.view === view) return;
    view = button.dataset.view;
    saveView(view);
    app.querySelectorAll('.view-toggle button').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === view);
      b.setAttribute('aria-pressed', String(b.dataset.view === view));
    });
    const results = document.getElementById('results');
    if (!results) return;
    results.className = view === 'grid' ? 'card-grid' : 'list';
    mount(results, items(games));
  });

  let page = 1;
  const more = document.getElementById('more');
  more?.addEventListener('click', async () => {
    more.disabled = true;
    more.textContent = t('Loading…');
    try {
      const next = await fetchPage(++page);
      games = games.concat(next.results);
      const results = document.getElementById('results');
      results.insertAdjacentHTML('beforeend', items(next.results).value);
      applyStyles(results);
      if (!next.hasMore) return more.remove();
      more.textContent = t('Load more');
    } catch {
      page--;
      more.textContent = t('Try again');
    } finally {
      more.disabled = false;
    }
  });
}
