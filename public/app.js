'use strict';

// ---- Helpers -----------------------------------------------------------------

const STATUS_LABELS = {
  playing: 'Playing',
  completed: 'Completed',
  played: 'Played',
  want: 'Want to play',
  dropped: 'Dropped',
};

const app = document.getElementById('app');
let currentUser = null;

// Marks a string as already-safe HTML so `html` won't escape it.
class Raw { constructor(value) { this.value = value; } }
const raw = (value) => new Raw(value);

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Tagged template that escapes every interpolated value unless wrapped in raw().
// Arrays are joined, so `${items.map((i) => html`...`)}` just works.
function html(strings, ...values) {
  const render = (v) => (v instanceof Raw ? v.value : Array.isArray(v) ? v.map(render).join('') : escapeHtml(v));
  return raw(strings.reduce((out, str, i) => out + str + (i < values.length ? render(values[i]) : ''), ''));
}

function setView(content) {
  app.innerHTML = content.value;
  applyHues(app);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Stable color per name, used for avatars and image-less game covers.
function hueFor(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// The Content-Security-Policy blocks inline style attributes, so colors are
// applied from data attributes after rendering.
function applyHues(root) {
  root.querySelectorAll('[data-hue]').forEach((el) => {
    const h = Number(el.dataset.hue);
    el.style.background = `linear-gradient(135deg, hsl(${h} 55% 38%), hsl(${(h + 50) % 360} 60% 22%))`;
  });
}

function avatar(user, size = '') {
  const name = user.displayName || user.username;
  return html`<span class="avatar ${size}" data-hue="${hueFor(user.username)}" aria-hidden="true">${[...name][0]}</span>`;
}

function cover(game) {
  if (game.image) {
    return html`<img class="cover" src="${game.image}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  }
  return html`<div class="cover cover-fallback" data-hue="${hueFor(game.name)}">${game.name}</div>`;
}

const year = (date) => (date ? date.slice(0, 4) : 'TBA');

function formatDate(date) {
  if (!date) return 'TBA';
  const d = new Date(date + (date.length === 10 ? 'T00:00:00' : 'Z'));
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function gameCard(game, extra = '') {
  return html`
    <a class="card" href="#/game/${encodeURIComponent(game.id)}">
      ${cover(game)}
      <div class="card-body">
        <div class="card-title">${game.name}</div>
        ${'released' in game
          ? html`<div class="card-meta">${year(game.released)}${game.genres?.length ? ' · ' + game.genres.slice(0, 2).join(', ') : ''}</div>`
          : ''}
        ${raw(extra.value || '')}
      </div>
    </a>`;
}

const loading = () => setView(html`<div class="loading">Loading…</div>`);

function showError(err) {
  setView(html`<div class="empty"><h2>Something went wrong</h2><p>${err.message}</p><a class="btn secondary" href="#/">Back to games</a></div>`);
}

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = currentUser
    ? html`
        <a href="#/community">Community</a>
        <a href="#/u/${encodeURIComponent(currentUser.username)}">My profile</a>
        <a href="#/settings">Settings</a>
        <button type="button" id="logout">Log out</button>`.value
    : html`
        <a href="#/community">Community</a>
        <a href="#/login">Log in</a>
        <a class="btn small" href="#/register">Sign up</a>`.value;
  document.getElementById('logout')?.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    currentUser = null;
    renderNav();
    location.hash = '#/';
  });
}

// ---- Views -------------------------------------------------------------------

async function homeView(params) {
  const query = params.get('q') || '';
  document.getElementById('search-input').value = query;
  loading();

  let page = 1;
  const data = await api(`/games?search=${encodeURIComponent(query)}&page=1`);

  const intro = query
    ? html`<div class="section-head"><h1>Results for “${query}”</h1><span class="muted">${data.count.toLocaleString()} games</span></div>`
    : html`
        <section class="hero">
          <h1>Every game. One shelf.</h1>
          <p>Look up any game, see where to buy it, and keep a list of everything you've played for friends to see.</p>
        </section>
        <div class="section-head"><h2>Popular games</h2></div>`;

  const notice = data.source === 'local'
    ? html`<div class="notice">You're seeing the built-in sample catalog. Add a free RAWG API key to search every game in the world (see the README).</div>`
    : '';

  setView(html`
    ${intro}
    ${notice}
    ${data.results.length
      ? html`<div class="grid" id="grid">${data.results.map((g) => gameCard(g))}</div>`
      : html`<div class="empty">No games found. Try another search.</div>`}
    <div class="center">${data.hasMore ? html`<button class="btn secondary" id="more">Load more</button>` : ''}</div>
  `);

  const more = document.getElementById('more');
  more?.addEventListener('click', async () => {
    more.disabled = true;
    more.textContent = 'Loading…';
    try {
      const next = await api(`/games?search=${encodeURIComponent(query)}&page=${++page}`);
      const grid = document.getElementById('grid');
      grid.insertAdjacentHTML('beforeend', next.results.map((g) => gameCard(g).value).join(''));
      applyHues(grid);
      if (next.hasMore) {
        more.disabled = false;
        more.textContent = 'Load more';
      } else {
        more.remove();
      }
    } catch (err) {
      more.disabled = false;
      more.textContent = 'Try again';
    }
  });
}

async function gameView(id) {
  loading();
  const game = await api(`/games/${encodeURIComponent(id)}`);
  document.title = `${game.name} · GameShelf`;

  const facts = [
    ['Released', formatDate(game.released)],
    ['Platforms', game.platforms.join(', ')],
    game.developers.length && ['Developer', game.developers.join(', ')],
    game.publishers.length && ['Publisher', game.publishers.join(', ')],
  ].filter(Boolean);

  const buyLinks = game.buy.links.length
    ? html`<div class="buy-list">${game.buy.links.map((l) => html`
        <a class="buy-link" href="${l.url}" target="_blank" rel="noopener noreferrer">
          <span>${l.name}<br><small>${l.direct ? 'Go to store page' : 'Search this store'}</small></span>
          <span class="go">↗</span>
        </a>`)}</div>`
    : html`<p class="muted">We don't know which stores carry this game yet.</p>`;

  const statusOptions = (selected) =>
    Object.entries(STATUS_LABELS).map(([value, label]) =>
      html`<option value="${value}" ${raw(value === selected ? 'selected' : '')}>${label}</option>`);
  const ratingOptions = (selected) =>
    [html`<option value="">No rating</option>`].concat(
      Array.from({ length: 10 }, (_, i) => 10 - i).map((n) =>
        html`<option value="${n}" ${raw(n === selected ? 'selected' : '')}>${n}/10</option>`));

  const listBox = currentUser
    ? html`
        <form class="list-box" id="list-form">
          <strong>${game.myEntry ? 'On your list' : 'Add to your list'}</strong>
          <div class="row">
            <select class="input" name="status" aria-label="Status">${statusOptions(game.myEntry?.status || 'played')}</select>
            <select class="input" name="rating" aria-label="Your rating">${ratingOptions(game.myEntry?.rating ?? null)}</select>
          </div>
          <div class="row">
            <button class="btn green" type="submit">${game.myEntry ? 'Update' : 'Add to my list'}</button>
            ${game.myEntry ? html`<button class="btn danger" type="button" id="remove">Remove</button>` : ''}
          </div>
          <p class="error" id="list-error" role="alert"></p>
        </form>`
    : html`<p class="list-box"><a class="btn green" href="#/login">Log in to add this to your list</a></p>`;

  setView(html`
    <a href="#/" class="muted">← All games</a>
    <h1 class="game-title">${game.name}</h1>
    <div class="game-hero">
      <div>
        ${cover(game)}
        <dl class="facts">${facts.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
        <div class="tags">${game.genres.map((g) => html`<span class="tag">${g}</span>`)}</div>
        ${game.description ? html`<h2 class="section-head">About this game</h2><p class="description">${game.description}</p>` : ''}
        ${game.website ? html`<p><a href="${game.website}" target="_blank" rel="noopener noreferrer">Official website ↗</a></p>` : ''}
      </div>
      <aside class="panel buy-box">
        <h2>Where to buy</h2>
        <p class="muted">GameShelf doesn't sell games. These links take you to the official stores.</p>
        ${buyLinks}
        <a href="${game.buy.compareUrl}" target="_blank" rel="noopener noreferrer">Compare prices across stores ↗</a>
        ${listBox}
      </aside>
    </div>
    <div class="section-head"><h2>Players on GameShelf</h2><span class="muted">${game.community.count}</span></div>
    ${game.community.players.length
      ? html`<div class="players">${game.community.players.map((p) => html`
          <a class="player-chip" href="#/u/${encodeURIComponent(p.username)}">
            ${avatar(p)} <span>${p.displayName}</span> <span class="badge ${p.status}">${STATUS_LABELS[p.status]}</span>
          </a>`)}</div>`
      : html`<p class="muted">Nobody has added this game yet. Be the first!</p>`}
  `);

  const form = document.getElementById('list-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api(`/me/library/${encodeURIComponent(game.id)}`, {
        method: 'PUT',
        body: { status: fd.get('status'), rating: fd.get('rating') ? Number(fd.get('rating')) : null },
      });
      route();
    } catch (err) {
      document.getElementById('list-error').textContent = err.message;
    }
  });
  document.getElementById('remove')?.addEventListener('click', async () => {
    await api(`/me/library/${encodeURIComponent(game.id)}`, { method: 'DELETE' });
    route();
  });
}

async function profileView(username, params) {
  loading();
  const { user, stats, library } = await api(`/users/${encodeURIComponent(username)}`);
  document.title = `${user.displayName} · GameShelf`;
  const filter = params.get('status') || 'all';
  const isMe = currentUser && currentUser.username.toLowerCase() === user.username.toLowerCase();
  const shown = filter === 'all' ? library : library.filter((e) => e.status === filter);
  const joined = new Date(user.joinedAt.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { year: 'numeric', month: 'long' });

  const tab = (key, label, count) => html`
    <a class="stat ${key === filter ? 'active' : ''}" href="#/u/${encodeURIComponent(user.username)}${key === 'all' ? '' : '?status=' + key}">
      <strong>${count}</strong>${label}
    </a>`;

  setView(html`
    <section class="panel profile-head">
      ${avatar(user, 'large')}
      <div>
        <h1>${user.displayName}</h1>
        <div class="muted">@${user.username} · Joined ${joined}</div>
        ${user.bio ? html`<p class="bio">${user.bio}</p>` : ''}
        ${isMe ? html`<p><a class="btn small secondary" href="#/settings">Edit profile</a></p>` : ''}
      </div>
    </section>
    <nav class="stats">
      ${tab('all', 'All games', library.length)}
      ${Object.entries(STATUS_LABELS).map(([k, label]) => tab(k, label, stats[k]))}
    </nav>
    ${shown.length
      ? html`<div class="grid">${shown.map((e) => gameCard(
          { id: e.gameId, name: e.name, image: e.image },
          html`<div><span class="badge ${e.status}">${STATUS_LABELS[e.status]}</span>
               ${e.rating ? html`<span class="rating">★ ${e.rating}/10</span>` : ''}</div>`,
        ))}</div>`
      : html`<div class="empty">${isMe
          ? html`Your list is empty. <a href="#/">Find a game</a> and add it!`
          : 'No games here yet.'}</div>`}
  `);
}

async function communityView(params) {
  const search = params.get('q') || '';
  loading();
  const { users } = await api(`/users?search=${encodeURIComponent(search)}`);
  setView(html`
    <div class="section-head"><h1>Community</h1></div>
    <form class="form" id="user-search">
      <input type="search" name="q" value="${search}" placeholder="Find people by name…" aria-label="Find people">
    </form>
    <div class="section-head"><h2>${search ? 'Matching players' : 'Players'}</h2></div>
    ${users.length
      ? html`<div class="user-list">${users.map((u) => html`
          <a class="user-card" href="#/u/${encodeURIComponent(u.username)}">
            ${avatar(u)}
            <div><strong>${u.displayName}</strong><div class="muted">@${u.username} · ${u.gameCount} games</div></div>
          </a>`)}</div>`
      : html`<div class="empty">No players found.</div>`}
  `);
  document.getElementById('user-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = new FormData(e.target).get('q').trim();
    location.hash = q ? `#/community?q=${encodeURIComponent(q)}` : '#/community';
  });
}

function authView(mode) {
  const isLogin = mode === 'login';
  setView(html`
    <section class="panel auth-panel">
      <h1>${isLogin ? 'Welcome back' : 'Create your account'}</h1>
      <p class="muted">${isLogin ? 'Log in to manage your game list.' : 'Make a profile and start sharing the games you play.'}</p>
      <form class="form" id="auth-form">
        <label>Username
          <input name="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]+" autocomplete="username" autofocus>
        </label>
        <label>Password
          <input name="password" type="password" required minlength="8" autocomplete="${isLogin ? 'current-password' : 'new-password'}">
        </label>
        <p class="error" id="auth-error" role="alert"></p>
        <button class="btn" type="submit">${isLogin ? 'Log in' : 'Sign up'}</button>
        <p class="muted">${isLogin
          ? html`New here? <a href="#/register">Create an account</a>`
          : html`Already have an account? <a href="#/login">Log in</a>`}</p>
      </form>
    </section>
  `);
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { user } = await api(`/auth/${isLogin ? 'login' : 'register'}`, {
        method: 'POST',
        body: { username: fd.get('username'), password: fd.get('password') },
      });
      currentUser = user;
      renderNav();
      location.hash = `#/u/${encodeURIComponent(user.username)}`;
    } catch (err) {
      document.getElementById('auth-error').textContent = err.message;
    }
  });
}

function settingsView() {
  if (!currentUser) {
    location.hash = '#/login';
    return;
  }
  setView(html`
    <section class="panel auth-panel">
      <h1>Edit profile</h1>
      <form class="form" id="settings-form">
        <label>Display name <input name="displayName" value="${currentUser.displayName}" required maxlength="40"></label>
        <label>Bio <textarea name="bio" maxlength="300" placeholder="What do you like to play?">${currentUser.bio}</textarea></label>
        <p class="error" id="settings-error" role="alert"></p>
        <button class="btn" type="submit">Save</button>
      </form>
    </section>
  `);
  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { user } = await api('/me', { method: 'PATCH', body: { displayName: fd.get('displayName'), bio: fd.get('bio') } });
      currentUser = user;
      location.hash = `#/u/${encodeURIComponent(user.username)}`;
    } catch (err) {
      document.getElementById('settings-error').textContent = err.message;
    }
  });
}

// ---- Router ------------------------------------------------------------------

async function route() {
  const [path, queryString = ''] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(queryString);
  const parts = (path || '/').split('/').filter(Boolean).map(decodeURIComponent);
  document.title = 'GameShelf';
  document.getElementById('search-input').value = '';

  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === `#${path}`);
  });

  try {
    switch (parts[0]) {
      case undefined: return await homeView(params);
      case 'game': return await gameView(parts[1]);
      case 'u': return await profileView(parts[1], params);
      case 'community': return await communityView(params);
      case 'login': return authView('login');
      case 'register': return authView('register');
      case 'settings': return settingsView();
      default: return setView(html`<div class="empty"><h2>Page not found</h2><a href="#/">Back to games</a></div>`);
    }
  } catch (err) {
    showError(err);
  } finally {
    window.scrollTo(0, 0);
  }
}

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  location.hash = q ? `#/?q=${encodeURIComponent(q)}` : '#/';
});

window.addEventListener('hashchange', route);

// Swap broken cover images for the colored title card. Image errors don't
// bubble, so listen in the capture phase.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('cover')) return;
  const name = img.closest('.card')?.querySelector('.card-title')?.textContent
    || document.querySelector('.game-title')?.textContent || '';
  const fallback = document.createElement('div');
  fallback.className = 'cover cover-fallback';
  fallback.dataset.hue = hueFor(name);
  fallback.textContent = name;
  img.replaceWith(fallback);
  applyHues(fallback.parentElement);
}, true);

(async function init() {
  try {
    currentUser = (await api('/me')).user;
  } catch {
    currentUser = null;
  }
  renderNav();
  api('/info').then(({ source }) => {
    if (source === 'rawg') {
      document.getElementById('data-credit').innerHTML =
        html`Game data from <a href="https://rawg.io" target="_blank" rel="noopener noreferrer">RAWG</a>.`.value;
    }
  }).catch(() => {});
  await route();
})();
