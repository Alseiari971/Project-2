// Reusable pieces of UI shared by several pages.
import { html, raw, hueFor, year, gameHref, profileHref, STATUS_LABELS, applyStyles } from './lib.js';
import { icon } from './icons.js';

/** Game artwork, or a colored title card when there is no image. */
export function art(game, cls = 'tile-art') {
  return game.image
    ? html`<img class="${cls}" src="${game.image}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : html`<div class="${cls} art-fallback" data-hue="${hueFor(game.name)}"><span>${game.name}</span></div>`;
}

/** Landscape game tile with a caption underneath (Apple TV style). */
export function gameTile(game, { badge = '', caption = true } = {}) {
  const id = game.id || game.gameId;
  const meta = [
    game.released !== undefined ? year(game.released) : null,
    game.genres?.length ? game.genres.slice(0, 2).join(' · ') : null,
  ].filter(Boolean).join(' · ');
  return html`
    <a class="tile" href="${gameHref(id)}" title="${game.name}">
      <div class="tile-frame">
        ${art(game)}
        ${badge}
      </div>
      ${caption ? html`<div class="tile-caption"><div class="tile-title">${game.name}</div>${meta ? html`<div class="tile-meta">${meta}</div>` : ''}</div>` : ''}
    </a>`;
}

export const statusBadge = (status) => html`<span class="status status-${status}">${STATUS_LABELS[status]}</span>`;

export const ratingBadge = (rating) => (rating ? html`<span class="rating-pill">${icon('star')}${rating}</span>` : '');

/** A library entry tile with its status and rating overlaid. */
export function libraryTile(entry) {
  return gameTile(
    { id: entry.gameId, name: entry.name, image: entry.image, genres: entry.genres },
    { badge: html`<div class="tile-badges">${statusBadge(entry.status)}${ratingBadge(entry.rating)}</div>` },
  );
}

/** Horizontally scrolling row with arrow buttons, like a streaming app. */
export function row({ title, href, items, id = '' }) {
  return html`
    <section class="row" ${raw(id ? `id="${id}"` : '')}>
      <div class="row-head">
        <h2>${title}</h2>
        ${href ? html`<a class="row-more" href="${href}">See all ${icon('right')}</a>` : ''}
      </div>
      <div class="row-viewport">
        <button class="row-arrow prev" type="button" aria-label="Scroll left">${icon('left')}</button>
        <div class="row-track">${items}</div>
        <button class="row-arrow next" type="button" aria-label="Scroll right">${icon('right')}</button>
      </div>
    </section>`;
}

/** Wires up arrow buttons for every row inside `root`. */
export function enableRows(root) {
  root.querySelectorAll('.row-viewport').forEach((viewport) => {
    const track = viewport.querySelector('.row-track');
    const update = () => {
      viewport.classList.toggle('at-start', track.scrollLeft < 8);
      viewport.classList.toggle('at-end', track.scrollLeft + track.clientWidth > track.scrollWidth - 8);
    };
    viewport.querySelector('.prev').addEventListener('click', () => track.scrollBy({ left: -track.clientWidth * 0.85, behavior: 'smooth' }));
    viewport.querySelector('.next').addEventListener('click', () => track.scrollBy({ left: track.clientWidth * 0.85, behavior: 'smooth' }));
    track.addEventListener('scroll', update, { passive: true });
    update();
  });
}

/** Round avatar with the user's chosen frame. */
export function avatar(user, size = 'sm') {
  const name = user.displayName || user.username;
  const inner = user.avatarUrl
    ? html`<img src="${user.avatarUrl}" alt="">`
    : html`<span class="avatar-letter" data-hue="${hueFor(user.username)}">${[...name][0]}</span>`;
  return html`<span class="avatar avatar-${size} frame-${user.avatarFrame || 'none'}" aria-hidden="true">${inner}</span>`;
}

export function userChip(user, extra = '') {
  return html`
    <a class="user-chip" href="${profileHref(user.username)}">
      ${avatar(user)}<span class="user-chip-name">${user.displayName}</span>${extra}
    </a>`;
}

export function levelBadge(level, size = '') {
  // Ring color changes every 10 levels, like Steam.
  const tier = Math.min(9, Math.floor(level / 10));
  return html`<span class="level level-tier-${tier} ${size}" title="Level ${level}"><span>${level}</span></span>`;
}

export const emptyState = (title, body = '', action = '') =>
  html`<div class="empty">${icon('gamepad', 'empty-icon')}<h3>${title}</h3>${body ? html`<p>${body}</p>` : ''}${action}</div>`;

export const spinner = () => html`<div class="loading"><span class="spinner"></span></div>`;

// Replace a broken image with the colored title card. Image errors don't
// bubble, so this listens in the capture phase.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('tile-art')) return;
  const name = img.closest('.tile')?.getAttribute('title') || '';
  const div = document.createElement('div');
  div.className = 'tile-art art-fallback';
  div.dataset.hue = hueFor(name);
  div.innerHTML = html`<span>${name}</span>`.value;
  const parent = img.parentElement;
  img.replaceWith(div);
  applyStyles(parent);
}, true);
