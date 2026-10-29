import { html, api, mount, state, refreshMe, refreshLibrary, runCleanups, profileHref, gameHref } from './lib.js';
import { avatar, skeleton, emptyState } from './components.js';
import { icon } from './icons.js';
import { openPalette } from './palette.js';
import { homeView } from './views/home.js';
import { browseView } from './views/browse.js';
import { gameView } from './views/game.js';
import { libraryView } from './views/library.js';
import { profileView } from './views/profile.js';
import { customizeView } from './views/customize.js';
import { communityView } from './views/community.js';
import { authView } from './views/auth.js';
import { importView } from './views/import.js';

const app = document.getElementById('app');
const SIDEBAR_GAMES = 12;

let current = { section: 'home', gameId: null };

// ---- Top bar ----------------------------------------------------------------------

function renderTopbar() {
  mount(document.getElementById('go-back'), icon('back'));
  mount(document.getElementById('go-forward'), icon('forward'));
  mount(document.getElementById('home-btn'), icon('home'));
  mount(document.getElementById('search-open'), html`${icon('search')}<span>Search</span><kbd>Ctrl K</kbd>`);
  document.getElementById('go-back').addEventListener('click', () => history.back());
  document.getElementById('go-forward').addEventListener('click', () => history.forward());
  document.getElementById('search-open').addEventListener('click', () => openPalette());
}

function renderAccount() {
  mount(document.getElementById('nav-right'), state.user
    ? html`
      <div class="menu">
        <button class="menu-button" type="button" id="menu-button" aria-haspopup="true" aria-expanded="false" aria-label="Account menu">
          ${avatar(state.user)}
        </button>
        <div class="menu-list" id="menu-list" hidden>
          <div class="menu-user">${avatar(state.user)}<div><strong>${state.user.displayName}</strong><div class="muted small">@${state.user.username}</div></div></div>
          <a href="${profileHref(state.user.username)}">My profile</a>
          <a href="#/customize">Edit profile</a>
          <a href="#/import">Import from Steam</a>
          <div class="menu-sep"></div>
          <button type="button" id="logout">Log out</button>
        </div>
      </div>`
    : html`<a class="nav-login" href="#/login">Log in</a><a class="pill-btn pill-light" href="#/register">Join free</a>`);

  const button = document.getElementById('menu-button');
  const list = document.getElementById('menu-list');
  button?.addEventListener('click', (e) => {
    e.stopPropagation();
    list.hidden = !list.hidden;
    button.setAttribute('aria-expanded', String(!list.hidden));
  });
  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    state.user = null;
    state.library = [];
    location.hash = '#/';
    renderChrome();
  });
}

document.addEventListener('click', () => {
  const list = document.getElementById('menu-list');
  if (list) list.hidden = true;
});

// ---- Sidebar ----------------------------------------------------------------------

function renderSidebar() {
  const { section, gameId } = current;
  const link = (href, label, iconName, key, extra = '') => html`
    <a class="side-link ${section === key ? 'active' : ''}" href="${href}">${icon(iconName)}<span>${label}</span>${extra}</a>`;

  const games = state.library.slice(0, SIDEBAR_GAMES);
  mount(document.getElementById('sidebar'), html`
    <nav class="side-main">
      ${link('#/', 'Home', 'solid-home', 'home')}
      ${link('#/browse', 'Browse', 'solid-browse', 'browse')}
      ${link(state.user ? '#/library' : '#/login', 'Library', 'solid-library', 'library')}
      ${link('#/community', 'Community', 'solid-users', 'community')}
      ${state.user ? link('#/import', 'Steam import', 'solid-import', 'import', html`<span class="tag tag-new">NEW</span>`) : ''}
    </nav>
    ${state.user
      ? html`
        <div class="side-games">
          <a class="side-label" href="#/library">My games <span>${state.library.length}</span></a>
          ${games.length
            ? games.map((g) => html`
                <a class="side-game ${g.gameId === gameId ? 'active' : ''}" href="${gameHref(g.gameId)}" title="${g.name}">
                  ${g.image ? html`<img src="${g.image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="side-game-blank"></span>`}
                  <span>${g.name}</span>
                </a>`)
            : html`<p class="side-note">Games you add show up here.</p>`}
          ${state.library.length > SIDEBAR_GAMES ? html`<a class="side-more" href="#/library">See all ${state.library.length}</a>` : ''}
        </div>`
      : html`
        <div class="side-cta">
          <strong>Track every game you play</strong>
          <p>Rate games, log your hours and show off your profile.</p>
          <a class="pill-btn pill-light" href="#/register">Join free</a>
        </div>`}
  `);
}

function renderTabbar() {
  const { section } = current;
  const tab = (href, label, iconName, key) => html`
    <a href="${href}" class="${section === key ? 'active' : ''}">${icon(iconName)}<span>${label}</span></a>`;
  mount(document.getElementById('tabbar'), html`
    ${tab('#/', 'Home', 'solid-home', 'home')}
    ${tab('#/browse', 'Browse', 'solid-browse', 'browse')}
    ${tab(state.user ? '#/library' : '#/login', 'Library', 'solid-library', 'library')}
    ${tab('#/community', 'Community', 'solid-users', 'community')}
  `);
}

function renderChrome() {
  renderAccount();
  renderSidebar();
  renderTabbar();
}

// ---- Router -----------------------------------------------------------------------

async function route() {
  runCleanups();
  const [path, queryString = ''] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(queryString);
  const parts = (path || '/').split('/').filter(Boolean).map(decodeURIComponent);
  const isMe = parts[0] === 'u' && state.user && parts[1]?.toLowerCase() === state.user.username.toLowerCase();
  current = {
    section: { undefined: 'home', browse: 'browse', library: 'library', community: 'community', import: 'import', u: isMe ? 'library' : 'community' }[parts[0]] || '',
    gameId: parts[0] === 'game' ? parts[1] : null,
  };

  document.title = 'GameShelf';
  renderSidebar();
  renderTabbar();
  window.scrollTo(0, 0);
  mount(app, skeleton({ undefined: 'home', game: 'game' }[parts[0]] || 'page'));

  try {
    switch (parts[0]) {
      case undefined: await homeView(app); break;
      case 'browse': await browseView(app, params); break;
      case 'game': await gameView(app, parts[1], params); break;
      case 'library': await libraryView(app, params); break;
      case 'u': await profileView(app, parts[1], params); break;
      case 'customize': await customizeView(app); break;
      case 'import': await importView(app); break;
      case 'community': await communityView(app, params); break;
      case 'login': await authView(app, 'login'); break;
      case 'register': await authView(app, 'register'); break;
      default:
        mount(app, html`<div class="page">${emptyState('Page not found', '', html`<a class="pill-btn pill-light" href="#/">Go home</a>`)}</div>`);
    }
  } catch (err) {
    mount(app, html`<div class="page">${emptyState(err.status === 404 ? 'Not found' : 'Something went wrong', err.message, html`<a class="pill-btn pill-light" href="#/">Go home</a>`)}</div>`);
  }
}

window.addEventListener('hashchange', route);
document.addEventListener('user-changed', async () => {
  await refreshLibrary();
  renderChrome();
});
document.addEventListener('library-changed', renderSidebar);

(async function init() {
  renderTopbar();
  try {
    await refreshMe();
    await refreshLibrary();
  } catch {
    state.user = null;
  }
  renderChrome();
  api('/info').then(({ source }) => {
    if (source === 'rawg') {
      mount(document.getElementById('data-credit'),
        html`Game data from <a href="https://rawg.io" target="_blank" rel="noopener noreferrer">RAWG</a>.`);
    }
  }).catch(() => {});
  await route();
})();
