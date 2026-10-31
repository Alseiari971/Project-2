// "My games": the logged-in user's list, with filters, sorting and grid or list
// views. In the desktop app it starts with the games on this PC (found in Steam,
// Epic and GOG), each with how it stands for Arabic subtitles.
import { html, mount, state, refreshLibrary, STATUS_LABELS, parseDbTime, onLeave, toast } from '../lib.js';
import { desktop, installedTile, wireLaunchButtons, wireArabicBadges, syncPcGames } from '../desktop.js';
import { libraryTile, gameListRow, emptyState, pillGroup, viewToggle, savedView, saveView, stars, formatHours, statusBadge } from '../components.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

const SORTS = {
  recent: { label: t('Recently updated'), compare: (a, b) => parseDbTime(b.updatedAt) - parseDbTime(a.updatedAt) },
  az: { label: 'A-Z', compare: (a, b) => a.name.localeCompare(b.name) },
  rating: { label: t('Rating'), compare: (a, b) => (b.rating || 0) - (a.rating || 0) },
  hours: { label: t('Hours'), compare: (a, b) => (b.playtime || 0) - (a.playtime || 0) },
};

export async function libraryView(app, params) {
  if (!state.user) {
    location.hash = '#/login';
    return;
  }
  await refreshLibrary();
  const pc = desktop ? { games: await desktop.installedGames().catch(() => []), sync: await desktop.librarySyncSettings().catch(() => ({ auto: null })) } : null;
  // A link can open the list on one status, e.g. #/library?status=want.
  const linked = params?.get('status');
  const ui = { status: STATUS_LABELS[linked] ? linked : 'all', sort: 'recent', query: '', view: savedView() };

  const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, 0]));
  for (const e of state.library) counts[e.status]++;

  const listColumns = (e) => [
    statusBadge(e.status),
    e.rating ? stars(e.rating) : html`<span class="muted small">${t('Not rated')}</span>`,
    formatHours(e.playtime) || '',
    (e.genres || []).slice(0, 3).map((x) => t(x)).join(t(', ')),
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
      return emptyState(t('Nothing on your shelf yet'), t('Add games from any game page, or bring in your whole Steam library.'),
        html`<div class="empty-actions"><a class="pill-btn pill-light" href="#/import">${t('Import from Steam')}</a><a class="pill-btn" href="#/browse">${t('Find games')}</a></div>`);
    }
    if (!shown.length) return emptyState(t('No games match'), t('Try another search or filter.'));
    if (ui.status !== 'all') return block(shown);
    // "All" groups games by status, like a launcher's "Ready to play" sections.
    return html`${Object.entries(STATUS_LABELS).map(([key, label]) => {
      const group = shown.filter((e) => e.status === key);
      return group.length ? html`<section class="lib-section"><h2>${label} <span>${group.length}</span></h2>${block(group)}</section>` : '';
    })}`;
  }

  const statusOptions = [
    { key: 'all', label: t('All'), count: state.library.length },
    ...Object.entries(STATUS_LABELS).map(([key, label]) => ({ key, label, count: counts[key] })),
  ];

  // Games on this PC that GameShelf knows and that aren't on My games yet.
  const notListed = () => pc.games.filter((g) => g.game.id && !state.library.some((e) => e.gameId === g.game.id));

  function pcShelf() {
    if (!pc) return '';
    const missing = notListed().length;
    const prompt = pc.sync.auto === null && missing
      ? html`<div class="pc-prompt" role="region" aria-label="${t('My games')}">
          <p>${t('Put the games on this PC on My games too? ({count}) Steam games you\'ve played start as Played; the rest as Want to play. You can change any of them later.', { count: missing })}</p>
          <div class="pc-prompt-actions">
            <button class="pill-btn pill-light" type="button" data-sync="yes">${t('Add them, and new games too')}</button>
            <button class="pill-btn" type="button" data-sync="no">${t('Not now')}</button>
          </div>
        </div>`
      : '';
    return html`
      <section class="lib-section pc-shelf">
        <div class="pc-head">
          <h2>${t('On this PC')} <span>${pc.games.length}</span></h2>
          <div class="pc-actions">
            ${pc.sync.auto === false && missing ? html`<button class="pill-btn" type="button" data-sync="once">${icon('plus')}<span>${t('Add to My games')}</span></button>` : ''}
            <button class="pill-btn" type="button" id="rescan">${icon('refresh')}<span>${t('Rescan PC games')}</span></button>
          </div>
        </div>
        ${prompt}
        ${pc.games.length
          ? html`<div class="card-grid">${pc.games.map((g) => installedTile(g, { badge: true }))}</div>`
          : html`<p class="muted">${t('No games from Steam, Epic Games or GOG found on this PC. Installed one just now? Press Rescan PC games.')}</p>`}
      </section>`;
  }

  function wirePc() {
    if (!pc) return;
    wireLaunchButtons(app.querySelector('.pc-shelf'));
    onLeave(wireArabicBadges(app.querySelector('.pc-shelf')));
  }

  function render() {
    mount(app, html`
      <div class="page library">
        <div class="page-head">
          <h1>${t('My games')}</h1>
          ${viewToggle(ui.view)}
        </div>
        ${pcShelf()}
        <form class="search-bar" id="lib-search" role="search">
          <label class="search-field">${icon('search')}<input type="search" name="q" value="${ui.query}" placeholder="${t('Search your games')}" aria-label="${t('Search your games')}" autocomplete="off"></label>
          <button class="pill-btn" type="submit">${t('Go')}</button>
        </form>
        <div class="filter-row">
          ${pillGroup(statusOptions, ui.status, { name: 'status' })}
          ${pillGroup(Object.entries(SORTS).map(([key, s]) => ({ key, label: s.label })), ui.sort, { label: t('Sort by'), name: 'sort' })}
        </div>
        <div id="lib-results">${results()}</div>
      </div>
    `);
  }
  render();
  wirePc();

  const update = () => mount(document.getElementById('lib-results'), results());
  // Only the shelf and the list change; the filters stay as they are.
  const redraw = () => {
    const box = document.createElement('div');
    mount(box, pcShelf());
    app.querySelector('.pc-shelf').replaceWith(box.firstElementChild);
    wirePc();
    update();
  };
  app.querySelector('.library').addEventListener('click', async (e) => {
    const rescan = e.target.closest('#rescan');
    const sync = e.target.closest('[data-sync]');
    if (!rescan && !sync) return;
    const button = rescan || sync;
    if (button.disabled) return;
    button.disabled = true;
    try {
      let listChanged = false;
      if (rescan) {
        pc.games = await desktop.rescanGames();
        if (pc.sync.auto) listChanged = (await syncPcGames({ quiet: true })) > 0;
        toast(t('Found {count} games on this PC', { count: pc.games.length }));
      } else if (sync.dataset.sync === 'no') {
        pc.sync = await desktop.setLibrarySync(false);
      } else {
        if (sync.dataset.sync === 'yes') pc.sync = await desktop.setLibrarySync(true);
        listChanged = (await syncPcGames()) > 0;
      }
      // New games on the list change its counts too: draw the whole page again.
      if (listChanged) await libraryView(app, params);
      else redraw();
    } catch (err) {
      toast(t(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), { error: true });
      button.disabled = false;
    }
  });
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
