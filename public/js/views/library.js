// "My games": the logged-in user's list, with filters, sorting and grid or list views.
import { html, mount, state, refreshLibrary, STATUS_LABELS, parseDbTime } from '../lib.js';
import { libraryTile, gameListRow, emptyState, pillGroup, viewToggle, savedView, saveView, stars, formatHours, statusBadge } from '../components.js';
import { icon } from '../icons.js';

const SORTS = {
  recent: { label: 'Recently updated', compare: (a, b) => parseDbTime(b.updatedAt) - parseDbTime(a.updatedAt) },
  az: { label: 'A-Z', compare: (a, b) => a.name.localeCompare(b.name) },
  rating: { label: 'Rating', compare: (a, b) => (b.rating || 0) - (a.rating || 0) },
  hours: { label: 'Hours', compare: (a, b) => (b.playtime || 0) - (a.playtime || 0) },
};

export async function libraryView(app) {
  if (!state.user) {
    location.hash = '#/login';
    return;
  }
  await refreshLibrary();
  const ui = { status: 'all', sort: 'recent', query: '', view: savedView() };

  const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, 0]));
  for (const e of state.library) counts[e.status]++;

  const listColumns = (e) => [
    statusBadge(e.status),
    e.rating ? stars(e.rating) : html`<span class="muted small">Not rated</span>`,
    formatHours(e.playtime) || '',
    (e.genres || []).slice(0, 3).join(', '),
  ];
  const block = (entries) => (ui.view === 'grid'
    ? html`<div class="card-grid">${entries.map(libraryTile)}</div>`
    : html`<div class="list">${entries.map((e) => gameListRow({ ...e, id: e.gameId }, listColumns(e)))}</div>`);

  function results() {
    const q = ui.query.toLowerCase();
    const shown = state.library
      .filter((e) => (ui.status === 'all' || e.status === ui.status) && (!q || e.name.toLowerCase().includes(q)))
      .sort(SORTS[ui.sort].compare);
    if (!state.library.length) {
      return emptyState('Nothing on your shelf yet', 'Add games from any game page, or bring in your whole Steam library.',
        html`<div class="empty-actions"><a class="pill-btn pill-light" href="#/import">Import from Steam</a><a class="pill-btn" href="#/browse">Find games</a></div>`);
    }
    if (!shown.length) return emptyState('No games match', 'Try another search or filter.');
    if (ui.status !== 'all') return block(shown);
    // "All" groups games by status, like a launcher's "Ready to play" sections.
    return html`${Object.entries(STATUS_LABELS).map(([key, label]) => {
      const group = shown.filter((e) => e.status === key);
      return group.length ? html`<section class="lib-section"><h2>${label} <span>${group.length}</span></h2>${block(group)}</section>` : '';
    })}`;
  }

  const statusOptions = [
    { key: 'all', label: 'All', count: state.library.length },
    ...Object.entries(STATUS_LABELS).map(([key, label]) => ({ key, label, count: counts[key] })),
  ];

  function render() {
    mount(app, html`
      <div class="page library">
        <div class="page-head">
          <h1>My games</h1>
          ${viewToggle(ui.view)}
        </div>
        <form class="search-bar" id="lib-search" role="search">
          <label class="search-field">${icon('search')}<input type="search" name="q" value="${ui.query}" placeholder="Search your games" aria-label="Search your games" autocomplete="off"></label>
          <button class="pill-btn" type="submit">Go</button>
        </form>
        <div class="filter-row">
          ${pillGroup(statusOptions, ui.status, { name: 'status' })}
          ${pillGroup(Object.entries(SORTS).map(([key, s]) => ({ key, label: s.label })), ui.sort, { label: 'Sort by', name: 'sort' })}
        </div>
        <div id="lib-results">${results()}</div>
      </div>
    `);
  }
  render();

  const update = () => mount(document.getElementById('lib-results'), results());
  app.querySelector('.library').addEventListener('click', (e) => {
    const option = e.target.closest('[data-group] [data-value]');
    if (option) {
      const group = option.closest('[data-group]').dataset.group;
      ui[group] = option.dataset.value;
      option.parentElement.querySelectorAll('[data-value]').forEach((b) => b.classList.toggle('active', b === option));
      update();
      return;
    }
    const toggle = e.target.closest('[data-view]');
    if (toggle && toggle.dataset.view !== ui.view) {
      ui.view = toggle.dataset.view;
      saveView(ui.view);
      app.querySelectorAll('.view-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === ui.view));
      update();
    }
  });
  // Filters as you type; the Go button is there for habit.
  const input = app.querySelector('#lib-search input');
  input.addEventListener('input', () => {
    ui.query = input.value.trim();
    update();
  });
  app.querySelector('#lib-search').addEventListener('submit', (e) => e.preventDefault());
}
