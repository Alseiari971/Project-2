import { html, api, mount, state, refreshMe, runCleanups, profileHref } from './lib.js';
import { avatar, skeleton, emptyState } from './components.js';
import { icon } from './icons.js';
import { homeView } from './views/home.js';
import { browseView } from './views/browse.js';
import { gameView } from './views/game.js';
import { profileView } from './views/profile.js';
import { customizeView } from './views/customize.js';
import { communityView } from './views/community.js';
import { authView } from './views/auth.js';
import { importView } from './views/import.js';

const app = document.getElementById('app');

// ---- Navigation -----------------------------------------------------------------

function renderNav(section) {
  const link = (href, label, key) => html`<a href="${href}" class="${section === key ? 'active' : ''}">${label}</a>`;
  mount(document.getElementById('nav-links'), html`
    ${link('#/', 'Home', 'home')}
    ${link('#/browse', 'Browse', 'browse')}
    ${link('#/community', 'Community', 'community')}
  `);

  mount(document.getElementById('nav-right'), html`
    <a class="icon-btn" href="#/browse?focus=1" aria-label="Search">${icon('search')}</a>
    ${state.user
      ? html`
        <div class="menu">
          <button class="menu-button" type="button" id="menu-button" aria-haspopup="true" aria-expanded="false" aria-label="Account menu">
            ${avatar(state.user)}
          </button>
          <div class="menu-list glass" id="menu-list" hidden>
            <div class="menu-user">${avatar(state.user)}<div><strong>${state.user.displayName}</strong><div class="muted small">@${state.user.username}</div></div></div>
            <a href="${profileHref(state.user.username)}">${icon('user')} My profile</a>
            <a href="#/customize">${icon('sliders')} Edit profile</a>
            <a href="#/import">${icon('upload')} Import from Steam</a>
            <button type="button" id="logout">${icon('logout')} Log out</button>
          </div>
        </div>`
      : html`<a class="nav-login" href="#/login">Log in</a><a class="btn btn-light btn-sm" href="#/register">Join free</a>`}
  `);

  const tab = (href, label, iconName, key) => html`
    <a href="${href}" class="${section === key ? 'active' : ''}">${icon(iconName)}<span>${label}</span></a>`;
  mount(document.getElementById('tabbar'), html`
    ${tab('#/', 'Home', 'home', 'home')}
    ${tab('#/browse', 'Search', 'search', 'browse')}
    ${tab('#/community', 'Community', 'users', 'community')}
    ${state.user
      ? tab(profileHref(state.user.username), 'Profile', 'user', 'me')
      : tab('#/login', 'Log in', 'user', 'login')}
  `);

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
    location.hash = '#/';
    renderNav('home');
  });
}

document.addEventListener('click', () => {
  const list = document.getElementById('menu-list');
  if (list) list.hidden = true;
});

// Solid nav once you scroll past the top, transparent over the hero.
const topbar = document.getElementById('topbar');
const onScroll = () => topbar.classList.toggle('scrolled', window.scrollY > 24);
window.addEventListener('scroll', onScroll, { passive: true });

// ---- Router ---------------------------------------------------------------------

let currentSection = 'home';

async function route() {
  runCleanups();
  const [path, queryString = ''] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(queryString);
  const parts = (path || '/').split('/').filter(Boolean).map(decodeURIComponent);
  const isMe = parts[0] === 'u' && state.user && parts[1]?.toLowerCase() === state.user.username.toLowerCase();
  currentSection = { undefined: 'home', browse: 'browse', community: 'community', u: isMe ? 'me' : 'community', login: 'login' }[parts[0]] || '';

  document.title = 'GameShelf';
  renderNav(currentSection);
  window.scrollTo(0, 0);
  mount(app, skeleton({ undefined: 'home', game: 'game' }[parts[0]] || 'page'));
  app.classList.remove('view-in');

  try {
    switch (parts[0]) {
      case undefined: await homeView(app); break;
      case 'browse': await browseView(app, params); break;
      case 'game': await gameView(app, parts[1], params); break;
      case 'u': await profileView(app, parts[1], params); break;
      case 'customize': await customizeView(app); break;
      case 'import': await importView(app); break;
      case 'community': await communityView(app, params); break;
      case 'login': await authView(app, 'login'); break;
      case 'register': await authView(app, 'register'); break;
      default:
        mount(app, html`<div class="page">${emptyState('Page not found', '', html`<a class="btn btn-light" href="#/">Go home</a>`)}</div>`);
    }
  } catch (err) {
    mount(app, html`<div class="page">${emptyState(err.status === 404 ? 'Not found' : 'Something went wrong', err.message, html`<a class="btn btn-light" href="#/">Go home</a>`)}</div>`);
  }
  void app.offsetWidth; // restart the fade-in animation
  app.classList.add('view-in');
  onScroll();
}

window.addEventListener('hashchange', route);
document.addEventListener('user-changed', () => renderNav(currentSection));

(async function init() {
  try {
    await refreshMe();
  } catch {
    state.user = null;
  }
  api('/info').then(({ source }) => {
    if (source === 'rawg') {
      mount(document.getElementById('data-credit'),
        html`Game data from <a href="https://rawg.io" target="_blank" rel="noopener noreferrer">RAWG</a>.`);
    }
  }).catch(() => {});
  await route();
})();
