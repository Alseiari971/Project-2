import { html, bdi, api, mount, profileHref } from '../lib.js';
import { avatar, emptyState } from '../components.js';
import { icon } from '../icons.js';
import { t, tn } from '../i18n.js';

export async function communityView(app, params) {
  const search = params.get('q') || '';
  const { users } = await api(`/users?search=${encodeURIComponent(search)}`);
  mount(app, html`
    <div class="page">
      <div class="browse-head"><h1>${t('Community')}</h1></div>
      <form class="big-search" id="user-search" role="search">
        ${icon('search')}
        <input type="search" name="q" value="${search}" placeholder="${t('Find people by name…')}" aria-label="${t('Find people')}" autocomplete="off">
      </form>
      ${users.length
        ? html`<div class="people">${users.map((u) => html`
            <a class="person" href="${profileHref(u.username)}" data-accent="${u.accent}">
              ${u.backgroundImage
                ? html`<div class="person-banner" data-bg="${u.backgroundImage}"></div>`
                : html`<div class="person-banner bg-${u.background.startsWith('game:') ? 'midnight' : u.background}"></div>`}
              ${avatar(u, 'lg')}
              <strong>${bdi(u.displayName)}</strong>
              <span class="muted small">${bdi(u.headline || `@${u.username}`)}</span>
              <span class="person-count">${tn(u.gameCount, 'game')}</span>
            </a>`)}</div>`
        : emptyState(t('No players found'), search ? t('Try another name.') : t('Be the first to sign up!'))}
    </div>
  `);
  document.getElementById('user-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = new FormData(e.target).get('q').trim();
    location.hash = q ? `#/community?q=${encodeURIComponent(q)}` : '#/community';
  });
}
