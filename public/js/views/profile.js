import { html, bdi, th, api, mount, state, STATUS_LABELS, timeAgo, parseDbTime, gameHref, profileHref, toast, onLeave } from '../lib.js';
import { avatar, libraryTile, levelBadge, statusBadge, emptyState, titleArt, stars, starValue, formatHours } from '../components.js';
import { t, locale } from '../i18n.js';
import { flagBadge, supporterBadge } from '../country-picker.js';
import { icon } from '../icons.js';

const SHOWCASE_TITLES = {
  favorite: t('Favorite game'),
  toprated: t('Highest rated'),
  completed: t('Recently completed'),
  stats: t('By the numbers'),
};

// Short labels drawn inside each badge medal.
const BADGE_GLYPHS = {
  collector: 'COL', completionist: '100%', critic: '★', explorer: 'EXP',
  veteran: 'HRS', backlog: 'TBP', curator: 'CUR', socialite: 'SOC',
};

function badgeTitle(b) {
  const status = b.tier ? t(b.tierName) : t('Locked');
  const next = b.nextTarget
    ? ` · ${t('{progress}/{target} for {tier}', { progress: b.progress, target: b.nextTarget, tier: t(['Bronze', 'Silver', 'Gold'][b.tier]) })}`
    : ` · ${t('Max tier')}`;
  return `${t(b.name)} (${status}): ${t(b.description)}${next}`;
}

function statBlocks(stats) {
  return html`
    <div class="stat-blocks">
      <div><strong>${stats.games}</strong><span>${t('Games')}</span></div>
      <div><strong>${stats.completed}</strong><span>${t('Completed')}</span></div>
      ${stats.hours ? html`<div><strong>${stats.hours.toLocaleString(locale)}</strong><span>${t('Hours played')}</span></div>` : ''}
      ${stats.averageRating ? html`<div><strong>${starValue(stats.averageRating)}</strong><span>${t('Avg stars')}</span></div>` : ''}
      <div><strong>${stats.completionRate}%</strong><span>${t('Completion rate')}</span></div>
      <div><strong>${stats.genres}</strong><span>${t('Genres')}</span></div>
    </div>`;
}

function showcase(s, stats) {
  if (s.type === 'favorite') {
    const g = s.game;
    return html`
      <section class="showcase showcase-favorite">
        <h2 class="showcase-title">${SHOWCASE_TITLES.favorite}</h2>
        <a class="favorite-card" href="${gameHref(g.gameId)}">
          <div class="favorite-bg" data-bg="${g.backdrop || g.image || ''}"></div>
          <div class="favorite-info">
            ${titleArt({ name: g.name, logo: g.logo }, 'h3')}
            <div class="favorite-meta">
              ${statusBadge(g.status)}
              ${g.rating ? stars(g.rating) : ''}
              ${g.playtime ? html`<span class="muted">${t('{hours} played', { hours: formatHours(g.playtime) })}</span>` : ''}
            </div>
          </div>
        </a>
      </section>`;
  }
  if (s.type === 'stats') {
    return html`<section class="showcase"><h2 class="showcase-title">${SHOWCASE_TITLES.stats}</h2>${statBlocks(stats)}</section>`;
  }
  if (s.type === 'info') {
    return html`<section class="showcase"><h2 class="showcase-title" dir="auto">${s.title}</h2><p class="prose" dir="auto">${s.text}</p></section>`;
  }
  // collection, toprated, completed: a grid of games.
  const title = s.title || SHOWCASE_TITLES[s.type];
  return html`
    <section class="showcase">
      <h2 class="showcase-title">${title}</h2>
      ${s.games.length
        ? html`<div class="showcase-grid">${s.games.map(libraryTile)}</div>`
        : html`<p class="muted">${t('Nothing to show here yet.')}</p>`}
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
          <a href="${profileHref(c.author.username)}"><strong>${bdi(c.author.displayName)}</strong></a>
          <span class="muted small">${timeAgo(c.createdAt)}</span>
          ${canDelete ? html`<button class="link-btn" type="button" data-delete-comment="${c.id}">${t('Delete')}</button>` : ''}
        </div>
        <p dir="auto">${c.body}</p>
      </div>
    </li>`;
}

// Badges for the account itself (not its games): one of GameShelf's first players, a Steam account proved with
// Steam's sign-in, GameShelf Guard on.
const ACCOUNT_BADGES = {
  founder: { label: 'Founder', note: 'One of the first players on GameShelf', icon: 'star' },
  steam: { label: 'Steam verified', note: 'Linked with Steam\'s own sign-in', icon: 'check' },
  guard: { label: 'GameShelf Guard', note: 'Signs in with a code on new browsers and PCs', icon: 'shield' },
};

/** The account's badges, its Arabic numbers and (on your own profile) your friend code to copy. */
export function accountStrip(account) {
  if (!account) return '';
  return html`<div class="account-strip">
    ${account.badges?.length ? html`<div class="account-badges">${account.badges.filter((b) => ACCOUNT_BADGES[b]).map((b) => html`
      <span class="account-badge is-${b}" title="${t(ACCOUNT_BADGES[b].note)}">${icon(ACCOUNT_BADGES[b].icon)} ${t(ACCOUNT_BADGES[b].label)}</span>`)}</div>` : ''}
    <div class="account-stats">
      <span><strong dir="ltr">${Number(account.arabic?.games || 0).toLocaleString(locale)}</strong> ${t('games played in Arabic')}</span>
      <span><strong dir="ltr">${Number(account.arabic?.requests || 0).toLocaleString(locale)}</strong> ${t('Arabic requests and votes')}</span>
    </div>
    ${account.friendCode ? html`<button type="button" class="code-chip copy-code" data-copy-code="${account.friendCode}" dir="ltr" title="${t('Copy your friend code')}"><code>${account.friendCode}</code>${icon('copy')}</button>` : ''}
  </div>`;
}

/** Copying a friend code from an account strip. */
export function wireAccountStrip(root) {
  // Once per page element (pages that redraw themselves call this again).
  if (root.dataset.accountStrip) return;
  root.dataset.accountStrip = '1';
  onLeave(() => delete root.dataset.accountStrip);
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy-code]');
    if (!b) return;
    await navigator.clipboard.writeText(b.dataset.copyCode).then(() => toast(t('Friend code copied.')), () => toast(t('Couldn\'t copy. Select the code and copy it yourself.'), { error: true }));
  });
}

export async function profileView(app, username, params) {
  const data = await api(`/users/${encodeURIComponent(username)}`);
  const { user, stats, progression, library, showcases, background } = data;
  let comments = data.comments;
  document.title = `${user.displayName} · ${t('GameShelf')}`;

  const isMe = state.user?.username.toLowerCase() === user.username.toLowerCase();
  const filter = params.get('status') || 'all';
  const shown = filter === 'all' ? library : library.filter((e) => e.status === filter);
  const joined = parseDbTime(user.joinedAt).toLocaleDateString(locale, { year: 'numeric', month: 'long' });
  const earned = progression.badges.filter((b) => b.earned);

  const tab = (key, label, count) => html`
    <a class="tab ${key === filter ? 'active' : ''}" href="${profileHref(user.username)}${key === 'all' ? '' : '?status=' + key}">
      ${label}<span class="tab-count">${count}</span>
    </a>`;

  const renderComments = () => html`
    ${state.user ? html`
      <form class="comment-form" id="comment-form">
        ${avatar(state.user)}
        <textarea name="body" maxlength="500" rows="2" placeholder="${t('Say something to {name}', { name: user.displayName })}" required></textarea>
        <button class="btn btn-accent" type="submit">${t('Post')}</button>
      </form>` : html`<p class="muted">${th('{login} to leave a comment.', { login: html`<a href="#/login">${t('Log in')}</a>` })}</p>`}
    ${comments.length
      ? html`<ul class="comments">${comments.map((c) => commentItem(c, user))}</ul>`
      : html`<p class="muted">${t('No comments yet.')}</p>`}`;

  mount(app, html`
    <div class="profile" data-accent="${user.accent}">
      ${backgroundLayer(background)}
      <div class="profile-inner">
        <header class="profile-header">
          ${avatar(user, 'xl')}
          <div class="profile-id">
            <h1>${bdi(user.displayName)} ${flagBadge(user.nationality)} ${supporterBadge(user)}</h1>
            ${user.headline ? html`<div class="headline">${bdi(user.headline)}</div>` : ''}
            <div class="profile-sub">
              <span>${bdi(`@${user.username}`)}</span>
              ${user.country ? html`<span>${user.country}</span>` : ''}
              <span>${t('Joined {date}', { date: joined })}</span>
            </div>
            ${user.bio ? html`<p class="bio" dir="auto">${user.bio}</p>` : ''}
            ${accountStrip(data.account)}
          </div>
          <div class="profile-level">
            <div class="level-row">${t('Level')} ${levelBadge(progression.level, 'lg')}</div>
            <div class="xp-bar" data-progress="${progression.levelProgress}"><span></span></div>
            <div class="muted small">${t('{xp} XP to level {level}', { xp: progression.xpToNext, level: progression.level + 1 })}</div>
            <div class="profile-actions">
              ${isMe
                ? html`<a class="btn btn-accent" href="#/customize">${t('Edit profile')}</a>`
                : ''}
              <button class="btn btn-quiet" type="button" id="share">${t('Copy link')}</button>
            </div>
          </div>
        </header>

        <div class="profile-layout">
          <main class="profile-main">
            ${showcases.map((s) => showcase(s, stats))}
            ${isMe && !showcases.length ? html`
              <section class="showcase showcase-cta">
                <div>
                  <h3>${t('Only you can see this')}</h3>
                  <p class="muted">${t('Your profile is still plain. Pin a favorite game, pick a background and choose what visitors see first.')}</p>
                </div>
                <a class="btn btn-accent" href="#/customize">${t('Customize profile')}</a>
              </section>` : ''}

            <section class="showcase">
              <div class="showcase-head">
                <h2 class="showcase-title">${t('Library')}</h2>
                ${isMe ? html`<a class="text-link small" href="#/import">${t('Import from Steam')}</a>` : ''}
              </div>
              <nav class="tabs">
                ${tab('all', t('All'), library.length)}
                ${Object.entries(STATUS_LABELS).map(([k, label]) => tab(k, label, stats[k]))}
              </nav>
              ${shown.length
                ? html`<div class="library-grid">${shown.map(libraryTile)}</div>`
                : emptyState(
                    isMe ? t('Nothing on your shelf yet') : t('Nothing here yet'),
                    isMe ? t('Add games from any game page, or import your Steam library.') : '',
                    isMe ? html`<div class="hero-actions"><a class="btn btn-accent" href="#/import">${t('Import from Steam')}</a><a class="btn btn-quiet" href="#/browse">${t('Find games')}</a></div>` : '',
                  )}
            </section>

            <section class="showcase" id="comments">
              <h2 class="showcase-title">${t('Comments')}</h2>
              <div id="comments-body">${renderComments()}</div>
            </section>
          </main>

          <aside class="profile-side">
            <section class="side-card">
              <h3>${t('Badges')} <span class="muted">${t('{n} of {total}', { n: earned.length, total: progression.badges.length })}</span></h3>
              <div class="badges">
                ${progression.badges.map((b) => html`
                  <div class="badge tier-${b.tier}" title="${badgeTitle(b)}">
                    <span class="medal"><span>${BADGE_GLYPHS[b.id]}</span></span>
                    <span class="badge-name">${t(b.name)}</span>
                  </div>`)}
              </div>
            </section>
            <section class="side-card">
              <h3>${t('Stats')}</h3>
              <ul class="side-stats">
                <li><span>${t('Games')}</span><strong>${stats.games}</strong></li>
                ${Object.entries(STATUS_LABELS).map(([k, label]) => html`<li><span>${label}</span><strong>${stats[k]}</strong></li>`)}
                ${stats.averageRating ? html`<li><span>${t('Average rating')}</span><strong>${starValue(stats.averageRating)} ★</strong></li>` : ''}
                ${stats.hours ? html`<li><span>${t('Hours played')}</span><strong>${stats.hours.toLocaleString(locale)}</strong></li>` : ''}
              </ul>
            </section>
            <section class="side-card">
              <h3>${t('Recent activity')}</h3>
              ${library.length
                ? html`<ul class="activity">${library.slice(0, 5).map((e) => html`
                    <li>
                      <a href="${gameHref(e.gameId)}">${bdi(e.name)}</a>
                      <div class="muted small">${STATUS_LABELS[e.status]}${e.rating ? ` · ${starValue(e.rating)} ★` : ''} · ${timeAgo(e.updatedAt)}</div>
                    </li>`)}</ul>`
                : html`<p class="muted small">${t('No activity yet.')}</p>`}
            </section>
          </aside>
        </div>
      </div>
    </div>
  `);

  wireAccountStrip(app);
  document.getElementById('share').addEventListener('click', async () => {
    const url = `${location.origin}/${profileHref(user.username)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast(t('Profile link copied'));
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
