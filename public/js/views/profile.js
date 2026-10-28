import { html, api, mount, state, STATUS_LABELS, timeAgo, parseDbTime, gameHref, profileHref, toast } from '../lib.js';
import { avatar, libraryTile, levelBadge, statusBadge, ratingBadge, emptyState } from '../components.js';
import { icon, BADGE_ICONS } from '../icons.js';

const SHOWCASE_TITLES = {
  favorite: 'Favorite game',
  toprated: 'Highest rated',
  completed: 'Completion showcase',
  stats: 'Gaming stats',
};

function statBlocks(stats) {
  return html`
    <div class="stat-blocks">
      <div><strong>${stats.games}</strong><span>Games</span></div>
      <div><strong>${stats.completed}</strong><span>Completed</span></div>
      <div><strong>${stats.averageRating ?? '–'}</strong><span>Avg rating</span></div>
      <div><strong>${stats.completionRate}%</strong><span>Completion</span></div>
      <div><strong>${stats.genres}</strong><span>Genres</span></div>
    </div>`;
}

function showcase(s, stats) {
  if (s.type === 'favorite') {
    const g = s.game;
    return html`
      <section class="showcase showcase-favorite">
        <div class="showcase-title">${SHOWCASE_TITLES.favorite}</div>
        <a class="favorite-card" href="${gameHref(g.gameId)}">
          <div class="favorite-bg" data-bg="${g.backdrop || g.image || ''}"></div>
          <div class="favorite-info">
            <h3>${g.name}</h3>
            <div class="favorite-meta">${statusBadge(g.status)}${ratingBadge(g.rating)}</div>
          </div>
        </a>
      </section>`;
  }
  if (s.type === 'stats') {
    return html`<section class="showcase"><div class="showcase-title">${SHOWCASE_TITLES.stats}</div>${statBlocks(stats)}</section>`;
  }
  if (s.type === 'info') {
    return html`<section class="showcase"><div class="showcase-title">${s.title}</div><p class="prose">${s.text}</p></section>`;
  }
  // collection, toprated, completed: a grid of games.
  const title = s.title || SHOWCASE_TITLES[s.type];
  return html`
    <section class="showcase">
      <div class="showcase-title">${title}</div>
      ${s.games.length
        ? html`<div class="showcase-grid">${s.games.map(libraryTile)}</div>`
        : html`<p class="muted">Nothing to show here yet.</p>`}
    </section>`;
}

function backgroundLayer(bg) {
  return bg.image
    ? html`<div class="profile-bg"><div class="profile-bg-img" data-bg="${bg.image}"></div></div>`
    : html`<div class="profile-bg bg-${bg.preset}"></div>`;
}

function commentItem(c, profileUser) {
  const canDelete = state.user && (state.user.username === c.author.username || state.user.username === profileUser.username);
  return html`
    <li class="comment">
      <a href="${profileHref(c.author.username)}">${avatar(c.author)}</a>
      <div class="comment-body">
        <div class="comment-head">
          <a href="${profileHref(c.author.username)}"><strong>${c.author.displayName}</strong></a>
          <span class="muted small">${timeAgo(c.createdAt)}</span>
          ${canDelete ? html`<button class="link-btn" type="button" data-delete-comment="${c.id}" aria-label="Delete comment">${icon('trash')}</button>` : ''}
        </div>
        <p>${c.body}</p>
      </div>
    </li>`;
}

export async function profileView(app, username, params) {
  const data = await api(`/users/${encodeURIComponent(username)}`);
  const { user, stats, progression, library, showcases, background } = data;
  let comments = data.comments;
  document.title = `${user.displayName} · GameShelf`;

  const isMe = state.user?.username.toLowerCase() === user.username.toLowerCase();
  const filter = params.get('status') || 'all';
  const shown = filter === 'all' ? library : library.filter((e) => e.status === filter);
  const joined = parseDbTime(user.joinedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
  const earned = progression.badges.filter((b) => b.earned);

  const tab = (key, label, count) => html`
    <a class="tab ${key === filter ? 'active' : ''}" href="${profileHref(user.username)}${key === 'all' ? '' : '?status=' + key}">
      ${label}<span class="tab-count">${count}</span>
    </a>`;

  const renderComments = () => html`
    ${state.user ? html`
      <form class="comment-form" id="comment-form">
        ${avatar(state.user)}
        <textarea name="body" maxlength="500" rows="2" placeholder="Leave a comment for ${user.displayName}…" required></textarea>
        <button class="btn btn-accent" type="submit">Post</button>
      </form>` : html`<p class="muted"><a href="#/login">Log in</a> to leave a comment.</p>`}
    ${comments.length
      ? html`<ul class="comments">${comments.map((c) => commentItem(c, user))}</ul>`
      : html`<p class="muted">No comments yet.</p>`}`;

  mount(app, html`
    <div class="profile" data-accent="${user.accent}">
      ${backgroundLayer(background)}
      <div class="profile-inner">
        <header class="glass profile-header">
          ${avatar(user, 'xl')}
          <div class="profile-id">
            <h1>${user.displayName}</h1>
            ${user.headline ? html`<div class="headline">${user.headline}</div>` : ''}
            <div class="profile-sub">
              <span>@${user.username}</span>
              ${user.country ? html`<span>${icon('pin')}${user.country}</span>` : ''}
              <span>Joined ${joined}</span>
            </div>
            ${user.bio ? html`<p class="bio">${user.bio}</p>` : ''}
          </div>
          <div class="profile-level">
            <div class="level-row">Level ${levelBadge(progression.level, 'lg')}</div>
            <div class="xp-bar" data-progress="${progression.levelProgress}"><span></span></div>
            <div class="muted small">${progression.xpToNext} XP to level ${progression.level + 1}</div>
            <div class="profile-actions">
              ${isMe
                ? html`<a class="btn btn-accent" href="#/customize">${icon('sliders')} Edit profile</a>`
                : ''}
              <button class="btn btn-glass" type="button" id="share">${icon('link')} Share</button>
            </div>
          </div>
        </header>

        <div class="profile-layout">
          <main class="profile-main">
            ${showcases.map((s) => showcase(s, stats))}
            ${isMe && !showcases.length ? html`
              <section class="showcase showcase-cta">
                <div>
                  <h3>Make this profile yours</h3>
                  <p class="muted">Add showcases for your favorite game, a top-rated collection, your stats and more. Pick a background and colors to match.</p>
                </div>
                <a class="btn btn-accent" href="#/customize">${icon('sparkle')} Customize profile</a>
              </section>` : ''}

            <section class="showcase">
              <div class="showcase-title">Game library</div>
              <nav class="tabs">
                ${tab('all', 'All', library.length)}
                ${Object.entries(STATUS_LABELS).map(([k, label]) => tab(k, label, stats[k]))}
              </nav>
              ${shown.length
                ? html`<div class="library-grid">${shown.map(libraryTile)}</div>`
                : emptyState(
                    isMe ? 'Your list is empty' : 'Nothing here yet',
                    isMe ? 'Find a game and add it to your list.' : '',
                    isMe ? html`<a class="btn btn-accent" href="#/browse">Browse games</a>` : '',
                  )}
            </section>

            <section class="showcase" id="comments">
              <div class="showcase-title">Comments</div>
              <div id="comments-body">${renderComments()}</div>
            </section>
          </main>

          <aside class="profile-side">
            <section class="glass side-card">
              <h3>Badges <span class="muted">${earned.length}/${progression.badges.length}</span></h3>
              <div class="badges">
                ${progression.badges.map((b) => html`
                  <div class="badge ${b.earned ? 'earned' : 'locked'}" title="${b.name}: ${b.description} (${b.progress}/${b.target})">
                    <span class="badge-icon">${icon(BADGE_ICONS[b.id])}</span>
                    <span class="badge-name">${b.name}</span>
                  </div>`)}
              </div>
            </section>
            <section class="glass side-card">
              <h3>Stats</h3>
              <ul class="side-stats">
                <li><span>Games</span><strong>${stats.games}</strong></li>
                ${Object.entries(STATUS_LABELS).map(([k, label]) => html`<li><span>${label}</span><strong>${stats[k]}</strong></li>`)}
                <li><span>Average rating</span><strong>${stats.averageRating ?? '–'}</strong></li>
              </ul>
            </section>
            <section class="glass side-card">
              <h3>Recent activity</h3>
              ${library.length
                ? html`<ul class="activity">${library.slice(0, 5).map((e) => html`
                    <li>
                      <a href="${gameHref(e.gameId)}">${e.name}</a>
                      <div class="muted small">${STATUS_LABELS[e.status]}${e.rating ? ` · ${e.rating}/10` : ''} · ${timeAgo(e.updatedAt)}</div>
                    </li>`)}</ul>`
                : html`<p class="muted small">No activity yet.</p>`}
            </section>
          </aside>
        </div>
      </div>
    </div>
  `);

  document.getElementById('share').addEventListener('click', async () => {
    const url = `${location.origin}/${profileHref(user.username)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Profile link copied');
    } catch {
      toast(url);
    }
  });

  const commentsBody = document.getElementById('comments-body');
  const rerenderComments = () => mount(commentsBody, renderComments());
  commentsBody.addEventListener('submit', async (e) => {
    e.preventDefault();
    const textarea = e.target.querySelector('textarea');
    try {
      const { comment } = await api(`/users/${encodeURIComponent(user.username)}/comments`, {
        method: 'POST',
        body: { body: textarea.value },
      });
      comments = [comment, ...comments];
      rerenderComments();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
  commentsBody.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-delete-comment]');
    if (!button) return;
    const id = Number(button.dataset.deleteComment);
    try {
      await api(`/comments/${id}`, { method: 'DELETE' });
      comments = comments.filter((c) => c.id !== id);
      rerenderComments();
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}
