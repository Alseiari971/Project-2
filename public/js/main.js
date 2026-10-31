import { html, bdi, th, api, mount, state, refreshMe, refreshLibrary, runCleanups, profileHref, gameHref } from './lib.js';
import { t, lang, LANGUAGES, setLang, applyLang } from './i18n.js';
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
import { legalView } from './views/legal.js';
import { applySeason } from './seasons.js';
import { appSettingsView } from './views/app-settings.js';
import { installedView } from './views/installed.js';
import { adminView } from './views/admin.js';

const app = document.getElementById('app');
const SIDEBAR_GAMES = 12;
// Set by the desktop app (desktop/preload.js); undefined on the website.
const desktop = window.gameshelfDesktop;

let current = { section: 'home', gameId: null };

// ---- Top bar ----------------------------------------------------------------------

function renderTopbar() {
  const label = (id, text) => document.getElementById(id).setAttribute('aria-label', t(text));
  mount(document.getElementById('go-back'), icon('back', 'flip'));
  mount(document.getElementById('go-forward'), icon('forward', 'flip'));
  mount(document.getElementById('home-btn'), icon('home'));
  mount(document.getElementById('search-open'), html`${icon('search')}<span>${t('Search')}</span><kbd>Ctrl K</kbd>`);
  label('go-back', 'Back');
  label('go-forward', 'Forward');
  label('home-btn', 'Home');
  label('search-open', 'Search games (Ctrl+K)');
  document.querySelector('.topbar .logo').setAttribute('aria-label', t('GameShelf home'));
  mount(document.querySelector('.footer'), html`
    <p>${th("GameShelf doesn't sell anything. Every buy button goes straight to the store. {legal}", { legal: html`<a href="#/legal">${t('About & legal')}</a>` })}</p>
    <p id="data-credit"></p>
    <p>${t('Game names, art and trademarks belong to their owners. Not affiliated with Valve, Twitch or any publisher.')}</p>`);
  document.getElementById('go-back').addEventListener('click', () => history.back());
  document.getElementById('go-forward').addEventListener('click', () => history.forward());
  document.getElementById('search-open').addEventListener('click', () => openPalette());
  renderWindowControls();
}

// Windows and Linux: minimize, maximize and close, round and grey, at the end
// of the top bar (the right in English, the left in Arabic). A Mac draws its own.
function renderWindowControls() {
  if (!desktop?.closeWindow || desktop.platform === 'darwin') return;
  const topbar = document.getElementById('topbar');
  const box = document.createElement('div');
  box.className = 'window-controls';
  topbar.append(box);
  topbar.classList.add('has-window-controls');
  const draw = (maximized) => {
    mount(box, html`
      <button type="button" class="window-btn" id="win-min" aria-label="${t('Minimize')}" title="${t('Minimize')}">${icon('minus')}</button>
      <button type="button" class="window-btn" id="win-max" aria-label="${t(maximized ? 'Restore' : 'Maximize')}" title="${t(maximized ? 'Restore' : 'Maximize')}">${icon(maximized ? 'win-restore' : 'win-max')}</button>
      <button type="button" class="window-btn close" id="win-close" aria-label="${t('Close')}" title="${t('Close')}">${icon('x')}</button>`);
    box.querySelector('#win-min').addEventListener('click', () => desktop.minimizeWindow());
    box.querySelector('#win-max').addEventListener('click', () => desktop.toggleMaximizeWindow());
    box.querySelector('#win-close').addEventListener('click', () => desktop.closeWindow());
  };
  draw(false);
  desktop.isWindowMaximized().then(draw);
  desktop.onWindowMaximized(draw);
}

function renderAccount() {
  const settings = desktop
    ? html`<a class="ghost-btn" href="#/app-settings" aria-label="${t('App settings')}" title="${t('App settings')}">${icon('sliders')}</a>`
    : '';
  // Switches to the other language, named in that language.
  const other = LANGUAGES.find((l) => l.id !== lang);
  const language = html`<button type="button" class="lang-btn" id="lang-btn" lang="${other.id}" title="${other.name}">${icon('globe')}<span>${other.name}</span></button>`;
  mount(document.getElementById('nav-right'), html`${language}${settings}${state.user
    ? html`
      <div class="menu">
        <button class="menu-button" type="button" id="menu-button" aria-haspopup="true" aria-expanded="false" aria-label="${t('Account menu')}">
          ${avatar(state.user)}
        </button>
        <div class="menu-list" id="menu-list" hidden>
          <div class="menu-user">${avatar(state.user)}<div><strong>${bdi(state.user.displayName)}</strong><div class="muted small">${bdi(`@${state.user.username}`)}</div></div></div>
          <a href="${profileHref(state.user.username)}">${t('My profile')}</a>
          <a href="#/customize">${t('Edit profile')}</a>
          <a href="#/import">${t('Import from Steam')}</a>
          <div class="menu-sep"></div>
          <button type="button" id="logout">${t('Log out')}</button>
        </div>
      </div>`
    : html`<a class="nav-login" href="#/login">${t('Log in')}</a><a class="pill-btn pill-light" href="#/register">${t('Join free')}</a>`}`);
  document.getElementById('lang-btn').addEventListener('click', () => setLang(other.id));

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
    <a class="side-link ${section === key ? 'active' : ''}" href="${href}">${icon(iconName)}<span>${t(label)}</span>${extra}</a>`;

  const games = state.library.slice(0, SIDEBAR_GAMES);
  mount(document.getElementById('sidebar'), html`
    <nav class="side-main">
      ${link('#/', 'Home', 'solid-home', 'home')}
      ${link('#/browse', 'Browse', 'solid-browse', 'browse')}
      ${link(state.user ? '#/library' : '#/login', 'Library', 'solid-library', 'library')}
      ${link('#/community', 'Community', 'solid-users', 'community')}
      ${state.user ? link('#/import', 'Steam import', 'solid-import', 'import', html`<span class="tag tag-new">${t('NEW')}</span>`) : ''}
      ${state.user?.role === 'admin' ? link('#/admin', 'Admin Panel', 'shield', 'admin') : ''}
    </nav>
    ${state.user
      ? html`
        <div class="side-games">
          <a class="side-label" href="#/library">${t('My games')} <span>${state.library.length}</span></a>
          ${games.length
            ? games.map((g) => html`
                <a class="side-game ${g.gameId === gameId ? 'active' : ''}" href="${gameHref(g.gameId)}" title="${g.name}">
                  ${g.image ? html`<img src="${g.image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="side-game-blank"></span>`}
                  <span>${bdi(g.name)}</span>
                </a>`)
            : html`<p class="side-note">${t('Games you add show up here.')}</p>`}
          ${state.library.length > SIDEBAR_GAMES ? html`<a class="side-more" href="#/library">${t('See all {n}', { n: state.library.length })}</a>` : ''}
        </div>`
      : html`
        <div class="side-cta">
          <strong>${t('Track every game you play')}</strong>
          <p>${t('Rate games, log your hours and show off your profile.')}</p>
          <a class="pill-btn pill-light" href="#/register">${t('Join free')}</a>
        </div>`}
  `);
}

function renderTabbar() {
  const { section } = current;
  const tab = (href, label, iconName, key) => html`
    <a href="${href}" class="${section === key ? 'active' : ''}">${icon(iconName)}<span>${t(label)}</span></a>`;
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
    section: { undefined: 'home', browse: 'browse', library: 'library', community: 'community', import: 'import', admin: 'admin', u: isMe ? 'library' : 'community' }[parts[0]] || '',
    gameId: parts[0] === 'game' ? parts[1] : null,
  };

  document.title = t('GameShelf');
  renderSidebar();
  renderTabbar();
  window.scrollTo(0, 0);
  mount(app, skeleton({ undefined: 'home', game: 'game' }[parts[0]] || 'page'));

  try {
    switch (parts[0]) {
      case undefined: await homeView(app); break;
      case 'browse': await browseView(app, params); break;
      case 'game': await gameView(app, parts[1], params); break;
      case 'installed':
        if (!desktop) throw Object.assign(new Error(''), { status: 404 });
        await installedView(app, parts[1]);
        break;
      case 'library': await libraryView(app, params); break;
      case 'u': await profileView(app, parts[1], params); break;
      case 'customize': await customizeView(app); break;
      case 'import': await importView(app); break;
      case 'legal': await legalView(app); break;
      case 'admin': await adminView(app, params); break;
      case 'app-settings':
        if (!desktop) throw Object.assign(new Error(''), { status: 404 });
        await appSettingsView(app, params);
        break;
      case 'community': await communityView(app, params); break;
      case 'login': await authView(app, 'login'); break;
      case 'register': await authView(app, 'register'); break;
      default:
        mount(app, html`<div class="page">${emptyState(t('Page not found'), '', html`<a class="pill-btn pill-light" href="#/">${t('Go home')}</a>`)}</div>`);
    }
  } catch (err) {
    mount(app, html`<div class="page">${emptyState(err.status === 404 ? t('Not found') : t('Something went wrong'), err.message, html`<a class="pill-btn pill-light" href="#/">${t('Go home')}</a>`)}</div>`);
  }
}

// Desktop app: signing in looks for the PC's games again and, if the player
// chose so, puts new ones on My games.
async function pcGamesOnSignIn() {
  if (!desktop?.rescanGames || !state.user) return;
  try {
    await desktop.rescanGames();
    if ((await desktop.librarySyncSettings()).auto && (await desktop.syncLibrary()).added) await refreshLibrary();
  } catch {}
}

window.addEventListener('hashchange', route);
document.addEventListener('user-changed', async () => {
  await refreshLibrary();
  renderChrome();
  pcGamesOnSignIn();
});
document.addEventListener('library-changed', renderSidebar);

(async function init() {
  applyLang();
  renderTopbar();
  applySeason();
  try {
    await refreshMe();
    await refreshLibrary();
  } catch {
    state.user = null;
  }
  renderChrome();
  pcGamesOnSignIn();
  api('/info').then(({ source }) => {
    const credit = {
      igdb: th('Game data from {igdb}. Prices from {cheapshark}.', {
        igdb: html`<a href="https://www.igdb.com" target="_blank" rel="noopener noreferrer">IGDB</a>`,
        cheapshark: html`<a href="https://www.cheapshark.com" target="_blank" rel="noopener noreferrer">CheapShark</a>`,
      }),
      rawg: th('Game data from {rawg}.', { rawg: html`<a href="https://rawg.io" target="_blank" rel="noopener noreferrer">RAWG</a>` }),
    }[source];
    if (credit) mount(document.getElementById('data-credit'), credit);
  }).catch(() => {});
  await route();
})();
