import { html, api, mount, applyStyles } from '../lib.js';
import { gameTile, emptyState } from '../components.js';
import { icon } from '../icons.js';

const SORTS = { popular: 'Popular', new: 'New releases', top: 'Top rated' };

export async function browseView(app, params) {
  const query = params.get('q') || '';
  const genre = params.get('genre') || '';
  const sort = params.get('sort') || 'popular';
  const qs = (overrides) => {
    const p = new URLSearchParams({ q: query, genre, sort, ...overrides });
    for (const [k, v] of [...p]) if (!v || (k === 'sort' && v === 'popular')) p.delete(k);
    const s = p.toString();
    return `#/browse${s ? '?' + s : ''}`;
  };
  const fetchPage = (page) =>
    api(`/games?${new URLSearchParams({ search: query, genre, sort, page })}`);

  const [info, data] = await Promise.all([api('/info'), fetchPage(1)]);
  const sorts = info.source === 'rawg' ? SORTS : { popular: SORTS.popular, new: SORTS.new };
  const title = query ? `Results for “${query}”` : genre ? `${genre} games` : 'Browse games';

  mount(app, html`
    <div class="page">
      <form class="big-search" id="big-search" role="search">
        ${icon('search')}
        <input type="search" name="q" value="${query}" placeholder="Games, franchises, studios…" aria-label="Search games" autocomplete="off">
      </form>
      <div class="chips" role="list">
        <a class="chip ${genre ? '' : 'active'}" href="${qs({ genre: '' })}">All genres</a>
        ${info.genres.map((g) => html`<a class="chip ${g === genre ? 'active' : ''}" href="${qs({ genre: g })}">${g}</a>`)}
      </div>
      <div class="browse-head">
        <h1>${title}</h1>
        ${query ? '' : html`<div class="segmented small">${Object.entries(sorts).map(([k, label]) =>
          html`<a class="${k === sort ? 'active' : ''}" href="${qs({ sort: k })}">${label}</a>`)}</div>`}
      </div>
      ${data.results.length
        ? html`<div class="grid" id="grid">${data.results.map((g) => gameTile(g))}</div>`
        : emptyState('No games found', 'Try a different search or genre.')}
      <div class="center">${data.hasMore ? html`<button class="btn btn-quiet" id="more">Load more</button>` : ''}</div>
    </div>
  `);

  const input = app.querySelector('#big-search input');
  if (params.has('focus')) input.focus();
  document.getElementById('big-search').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = qs({ q: input.value.trim() });
  });

  let page = 1;
  const more = document.getElementById('more');
  more?.addEventListener('click', async () => {
    more.disabled = true;
    more.textContent = 'Loading…';
    try {
      const next = await fetchPage(++page);
      const grid = document.getElementById('grid');
      grid.insertAdjacentHTML('beforeend', next.results.map((g) => gameTile(g).value).join(''));
      applyStyles(grid);
      if (!next.hasMore) return more.remove();
      more.textContent = 'Load more';
    } catch {
      page--;
      more.textContent = 'Try again';
    } finally {
      more.disabled = false;
    }
  });
}
