// Friends & Activity: a drawer from the top bar's friends button, on the
// website and in the desktop app. It lists friends in a game, online and
// offline (what they're playing, and a neon «يلعب بالعربية» badge when the
// game runs with GameShelf's Arabic), friend requests, and adding someone by
// friend code or @username. It refreshes every 30 seconds while open or
// while the page is visible.
//
// Presence: the desktop app reports the running game itself (desktop/presence.js);
// the website says "online" while a tab is open and visible.
import { html, bdi, th, api, mount, state, toast, gameHref, profileHref } from './lib.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { avatar } from './components.js';
import { flagBadge } from './country-picker.js';

const desktop = window.gameshelfDesktop;
const LIST_MS = 30 * 1000;
const BEAT_MS = 60 * 1000;
const OPEN_KEY = 'gameshelf-friends-open';

let data = null;
let drawer = null;
let listTimer = null;
let beatTimer = null;
let found = null;

const isOpen = () => drawer && !drawer.hidden;
const remember = (open) => {
  try { localStorage.setItem(OPEN_KEY, open ? '1' : ''); } catch {}
};

function statusLine(f) {
  const p = f.presence;
  if (p.status === 'in_game') return html`<span class="presence-text in-game">${th('Playing {game}', { game: html`<bdi>${p.game.title}</bdi>` })}</span>`;
  if (p.status === 'online') return html`<span class="presence-text online">${t('Online')}${p.source === 'desktop' ? html` · ${t('in the app')}` : ''}</span>`;
  return html`<span class="presence-text">${t('Offline')}</span>`;
}

function friendRow(f) {
  const p = f.presence;
  const game = p.game;
  const view = game ? (game.id ? gameHref(game.id) : `#/browse?q=${encodeURIComponent(game.title)}`) : null;
  return html`
    <li class="friend-row status-${p.status}">
      <a class="friend-who" href="${profileHref(f.username)}">
        <span class="presence-avatar">${avatar(f)}<span class="presence-dot" aria-hidden="true"></span></span>
        <span class="friend-text">
          <span class="friend-name">${bdi(f.displayName)} ${flagBadge(f.nationality)}</span>
          ${statusLine(f)}
          ${p.arabic ? html`<span class="arabic-neon" lang="ar" dir="rtl" title="${t('Playing with GameShelf\'s Arabic')}">يلعب بالعربية</span>` : ''}
        </span>
      </a>
      <div class="friend-actions">
        ${view ? html`<a class="btn btn-sm btn-accent" href="${view}" title="${t('View the game')}">${t('View game')}</a>` : ''}
        <button type="button" class="ghost-btn" data-menu="${f.username}" aria-label="${t('More for {name}', { name: f.displayName })}" aria-haspopup="true">${icon('sliders')}</button>
      </div>
      <div class="friend-menu" data-menu-for="${f.username}" hidden>
        <button type="button" data-act="remove" data-user="${f.username}">${t('Remove friend')}</button>
        <button type="button" data-act="block" data-user="${f.username}">${t('Block')}</button>
      </div>
    </li>`;
}

function section(title, friends, { collapsed = false, key }) {
  if (!friends.length) return '';
  return html`
    <details class="friend-section" ${collapsed ? '' : html`open`} data-section="${key}">
      <summary>${title} <span class="count">${friends.length}</span></summary>
      <ul class="friend-list">${friends.map(friendRow)}</ul>
    </details>`;
}

function personCard(user, relation) {
  const action = {
    none: html`<button type="button" class="btn btn-sm btn-light" data-act="request" data-user="${user.username}">${icon('plus')} ${t('Add friend')}</button>`,
    incoming: html`<button type="button" class="btn btn-sm btn-light" data-act="accept" data-user="${user.username}">${t('Accept')}</button>`,
    outgoing: html`<span class="muted small">${t('Request sent')}</span>`,
    friends: html`<span class="muted small">${t('Already friends')}</span>`,
    self: html`<span class="muted small">${t('That\'s you')}</span>`,
    blocked: html`<button type="button" class="btn btn-sm" data-act="unblock" data-user="${user.username}">${t('Unblock')}</button>`,
  }[relation] || '';
  return html`
    <div class="person-card">
      <a class="friend-who" href="${profileHref(user.username)}">${avatar(user)}
        <span class="friend-text"><span class="friend-name">${bdi(user.displayName)} ${flagBadge(user.nationality)}</span><span class="muted small" dir="ltr">@${user.username}</span></span></a>
      ${action}
    </div>`;
}

function render() {
  if (!drawer || !data) return;
  const inGame = data.friends.filter((f) => f.presence.status === 'in_game');
  const online = data.friends.filter((f) => f.presence.status === 'online');
  const offline = data.friends.filter((f) => f.presence.status === 'offline');
  const openSections = new Set([...drawer.querySelectorAll('.friend-section[open]')].map((d) => d.dataset.section));
  const scroll = drawer.querySelector('.friends-body')?.scrollTop || 0;
  // A refresh mustn't wipe what's being typed into "add a friend".
  const typed = drawer.querySelector('#add-friend input');
  const typing = { value: typed?.value || '', focused: document.activeElement === typed };
  mount(drawer, html`
    <header class="friends-head">
      <h2>${t('Friends & Activity')}</h2>
      <button type="button" class="ghost-btn" id="friends-close" aria-label="${t('Close')}">${icon('x')}</button>
    </header>
    <div class="friends-body">
      <div class="my-code">
        <span class="muted small">${t('Your friend code')}</span>
        <button type="button" class="code-chip" id="copy-code" dir="ltr" title="${t('Copy')}"><code>${data.code}</code>${icon('check')}</button>
      </div>
      <form class="add-friend" id="add-friend" role="search">
        <input class="input" name="q" placeholder="${t('Friend code or @username')}" aria-label="${t('Friend code or @username')}" autocomplete="off" dir="ltr" spellcheck="false">
        <button class="btn btn-light" type="submit">${t('Find')}</button>
      </form>
      <div id="found">${found ? personCard(found.user, found.relation) : ''}</div>

      ${data.incoming.length ? html`
        <div class="friend-requests">
          <h3>${t('Friend requests')} <span class="count">${data.incoming.length}</span></h3>
          ${data.incoming.map((u) => html`
            <div class="person-card">
              <a class="friend-who" href="${profileHref(u.username)}">${avatar(u)}<span class="friend-text"><span class="friend-name">${bdi(u.displayName)} ${flagBadge(u.nationality)}</span><span class="muted small" dir="ltr">@${u.username}</span></span></a>
              <div class="row-actions">
                <button type="button" class="btn btn-sm btn-light" data-act="accept" data-user="${u.username}">${t('Accept')}</button>
                <button type="button" class="btn btn-sm" data-act="decline" data-user="${u.username}">${t('Decline')}</button>
              </div>
            </div>`)}
        </div>` : ''}

      ${data.friends.length ? html`
        ${section(t('In game'), inGame, { key: 'in_game' })}
        ${section(t('Online'), online, { key: 'online' })}
        ${section(t('Offline'), offline, { key: 'offline', collapsed: !openSections.has('offline') })}`
        : html`<div class="friends-empty">${icon('users')}<p>${t('No friends yet. Share your friend code, or find someone by theirs.')}</p></div>`}

      ${data.outgoing.length ? html`
        <details class="friend-section" data-section="outgoing" ${openSections.has('outgoing') ? html`open` : ''}>
          <summary>${t('Sent requests')} <span class="count">${data.outgoing.length}</span></summary>
          ${data.outgoing.map((u) => html`<div class="person-card">${avatar(u)}<span class="friend-name">${bdi(u.displayName)}</span><button type="button" class="btn btn-sm" data-act="remove" data-user="${u.username}">${t('Cancel')}</button></div>`)}
        </details>` : ''}
    </div>`);
  drawer.querySelector('.friends-body').scrollTop = scroll;
  const input = drawer.querySelector('#add-friend input');
  input.value = typing.value;
  if (typing.focused) input.focus({ preventScroll: true });
}

async function act(action, username) {
  try {
    data = await api(`/friends/${action}`, { method: 'POST', body: { username } });
    if (found && found.user.username === username) found = { user: found.user, relation: data.relation };
    toast({
      request: data.relation === 'friends' ? t('You\'re now friends.') : t('Friend request sent.'),
      accept: t('You\'re now friends.'),
      decline: t('Request declined.'),
      remove: t('Removed.'),
      block: t('Blocked. They can\'t add you or find you.'),
      unblock: t('Unblocked.'),
    }[action]);
    updateButton();
    render();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function wireDrawer() {
  drawer.addEventListener('click', async (e) => {
    if (e.target.closest('#friends-close')) return openDrawer(false);
    if (e.target.closest('#copy-code')) {
      navigator.clipboard.writeText(data.code).then(() => toast(t('Friend code copied.')), () => {});
      return;
    }
    const menuButton = e.target.closest('[data-menu]');
    if (menuButton) {
      const menu = drawer.querySelector(`[data-menu-for="${CSS.escape(menuButton.dataset.menu)}"]`);
      drawer.querySelectorAll('.friend-menu').forEach((m) => { if (m !== menu) m.hidden = true; });
      menu.hidden = !menu.hidden;
      return;
    }
    const button = e.target.closest('[data-act]');
    if (!button) return;
    const { act: action, user } = button.dataset;
    if (action === 'block' && !confirm(t('Block @{name}? They won\'t be able to add or find you.', { name: user }))) return;
    if (action === 'remove' && data.friends.some((f) => f.username === user) && !confirm(t('Remove @{name} from your friends?', { name: user }))) return;
    button.disabled = true;
    await act(action, user);
  });
  drawer.addEventListener('submit', async (e) => {
    if (e.target.id !== 'add-friend') return;
    e.preventDefault();
    const q = new FormData(e.target).get('q').trim();
    if (!q) return;
    try {
      found = await api(`/friends/find?q=${encodeURIComponent(q)}`);
    } catch (err) {
      found = null;
      toast(err.message, { error: true });
    }
    render();
  });
}

function updateButton() {
  const button = document.getElementById('friends-btn');
  if (!button || !data) return;
  const n = data.online;
  const badge = button.querySelector('.friends-count');
  badge.textContent = n ? String(n) : '';
  badge.hidden = !n;
  button.classList.toggle('has-requests', data.incoming.length > 0);
  button.setAttribute('aria-label', t('Friends & Activity ({n} online)', { n }));
}

async function refresh() {
  if (!state.user) return;
  if (document.hidden && !isOpen()) return;
  try {
    data = await api('/friends');
    updateButton();
    if (isOpen()) render();
  } catch {}
}

export function openDrawer(open = !isOpen()) {
  if (!drawer) return;
  drawer.hidden = !open;
  document.body.classList.toggle('friends-open', open);
  document.getElementById('friends-btn')?.setAttribute('aria-expanded', String(open));
  remember(open);
  if (open) {
    render();
    refresh();
    drawer.querySelector('#add-friend input')?.focus({ preventScroll: true });
  }
}

/** The website's own heartbeat; the desktop app reports the running game itself. */
function beat() {
  if (!state.user || desktop || document.hidden) return;
  api('/presence/heartbeat', { method: 'POST', body: { status: 'online' } }).catch(() => {});
}

/** The top bar button (put in by main.js), the drawer, polling and the website's heartbeat. */
export function initFriends() {
  clearInterval(listTimer);
  clearInterval(beatTimer);
  drawer?.remove();
  drawer = null;
  data = null;
  found = null;
  document.body.classList.remove('friends-open');
  if (!state.user) return;
  drawer = document.createElement('aside');
  drawer.className = 'friends-drawer';
  drawer.id = 'friends-drawer';
  drawer.setAttribute('aria-label', t('Friends & Activity'));
  drawer.hidden = true;
  document.body.append(drawer);
  wireDrawer();
  refresh().then(() => {
    let wasOpen = false;
    try { wasOpen = localStorage.getItem(OPEN_KEY) === '1'; } catch {}
    if (wasOpen && window.matchMedia('(min-width: 1100px)').matches) openDrawer(true);
  });
  listTimer = setInterval(refresh, LIST_MS);
  beat();
  beatTimer = setInterval(beat, BEAT_MS);
}

/** main.js redraws the top bar; the button needs its count and click again. */
export function wireFriendsButton() {
  const button = document.getElementById('friends-btn');
  if (!button || !drawer) return;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    openDrawer();
  });
  button.setAttribute('aria-expanded', String(isOpen()));
  updateButton();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    beat();
    refresh();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isOpen()) openDrawer(false);
});
