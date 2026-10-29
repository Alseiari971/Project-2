// Reusable pieces of UI shared by several pages.
import { html, raw, hueFor, year, gameHref, profileHref, STATUS_LABELS, applyStyles, mount } from './lib.js';
import { icon } from './icons.js';

/** Game artwork, or a colored title card when there is no image. */
export function art(game, cls = 'tile-art', src = game.image) {
  return src
    ? html`<img class="${cls}" src="${src}" alt="" loading="lazy" referrerpolicy="no-referrer" ${game.fallbackImage ? html`data-fallback="${game.fallbackImage}"` : ''}>`
    : html`<div class="${cls} art-fallback" data-hue="${hueFor(game.name)}"><span>${game.name}</span></div>`;
}

// Steam store banners have the title built in. Saved list entries don't carry
// the artHasTitle flag, so recognise those banners by their address.
const STEAM_BANNER = /steamstatic\.com\/steam\/apps\/\d+\/(capsule_616x353|header)\.jpg/;
const hasTitleArt = (game) => Boolean(game.image) && (game.artHasTitle ?? STEAM_BANNER.test(game.image));

/**
 * The game's logo artwork when we have it, otherwise its name as text.
 * If the logo fails to load, the error handler below swaps in the text.
 */
export function titleArt(game, tag = 'h1') {
  const inner = game.logo
    ? html`<img class="logo-art" src="${game.logo}" alt="${game.name}" referrerpolicy="no-referrer">`
    : html`${game.name}`;
  return html`${raw(`<${tag} class="title-art${game.logo ? ' has-logo' : ''}">`)}${inner}${raw(`</${tag}>`)}`;
}

/** Ratings are stored out of 10 and shown as 5 stars with halves. */
export const starValue = (rating) => String(rating / 2);

/** Read-only star display. */
export function stars(rating, size = '') {
  const row = (cls) => html`<span class="${cls}">${[1, 2, 3, 4, 5].map(() => icon('star'))}</span>`;
  return html`<span class="stars ${size}" data-progress="${rating / 10}" role="img" aria-label="${starValue(rating)} out of 5 stars">
    ${row('stars-bg')}${row('stars-fg')}
  </span>`;
}

/** Interactive half-star rating input. Ten invisible buttons sit over the five stars. */
export function starInput(rating) {
  return html`
    <div class="star-input" data-value="${rating || 0}">
      ${stars(rating || 0, 'lg')}
      <div class="star-hit">
        ${Array.from({ length: 10 }, (_, i) => i + 1).map((n) => html`
          <button type="button" data-rating="${n}" aria-label="${starValue(n)} stars"></button>`)}
      </div>
    </div>`;
}

/** Hovering previews a rating; leaving restores the saved one. */
export function wireStarInput(el, onPick) {
  const fg = () => el.querySelector('.stars');
  const show = (n) => fg().style.setProperty('--progress', String(n / 10));
  el.querySelectorAll('[data-rating]').forEach((b) => {
    b.addEventListener('mouseenter', () => show(Number(b.dataset.rating)));
    b.addEventListener('focus', () => show(Number(b.dataset.rating)));
    b.addEventListener('click', () => onPick(Number(b.dataset.rating)));
  });
  el.addEventListener('mouseleave', () => show(Number(el.dataset.value)));
}

/**
 * Wide game card, launcher style: just the artwork. Art without the game's
 * name gets the title bottom-left; `tag` sits top-left and `corner` bottom-right.
 */
export function gameTile(game, { tag = '', corner = '' } = {}) {
  const id = game.id || game.gameId;
  // Placeholders without an image already show the name, so they need no overlay.
  const overlay = Boolean(game.image) && !hasTitleArt(game);
  return html`
    <a class="tile" href="${gameHref(id)}" title="${game.name}">
      <div class="tile-frame ${overlay ? 'needs-title' : ''}">
        ${art(game)}
        ${tag ? html`<span class="card-tag">${tag}</span>` : ''}
        <span class="tile-overlay-title ${overlay ? '' : 'visually-hidden'}">${game.name}</span>
        ${corner ? html`<span class="card-corner">${corner}</span>` : ''}
      </div>
    </a>`;
}

/** One line in a list view: thumbnail, name, then whatever columns the page passes. */
export function gameListRow(game, columns = []) {
  const id = game.id || game.gameId;
  return html`
    <a class="list-row" href="${gameHref(id)}" title="${game.name}">
      ${game.image ? html`<img class="list-thumb" src="${game.image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="list-thumb"></span>`}
      <span class="list-name">${game.name}</span>
      ${columns.map((c) => html`<span class="list-col">${c}</span>`)}
    </a>`;
}

/**
 * A group of pill toggles (All / Favorites, or Popular / New). Each option is
 * { key, label, href?, count? }; links when href is given, buttons otherwise.
 */
export function pillGroup(options, active, { label = '', name = '' } = {}) {
  return html`
    <div class="pill-group" ${name ? html`data-group="${name}"` : ''}>
      ${label ? html`<span class="pill-group-label">${label}</span>` : ''}
      ${options.map((o) => {
        const inner = html`${o.label}${o.count !== undefined ? html`<span class="pill-count">${o.count}</span>` : ''}`;
        return o.href
          ? html`<a class="${o.key === active ? 'active' : ''}" href="${o.href}">${inner}</a>`
          : html`<button type="button" class="${o.key === active ? 'active' : ''}" data-value="${o.key}">${inner}</button>`;
      })}
    </div>`;
}

/** Grid / list switch, top-right of a page. The choice is remembered per browser. */
export function viewToggle(view) {
  return html`
    <div class="view-toggle" role="group" aria-label="View">
      <button type="button" class="${view === 'grid' ? 'active' : ''}" data-view="grid" aria-label="Grid view" aria-pressed="${view === 'grid'}">${icon('grid')}</button>
      <button type="button" class="${view === 'list' ? 'active' : ''}" data-view="list" aria-label="List view" aria-pressed="${view === 'list'}">${icon('list')}</button>
    </div>`;
}

const VIEW_KEY = 'gameshelf-view';
export function savedView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}
export function saveView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Not remembering the choice is fine.
  }
}

/**
 * A poster card for games without official poster art: the full wide image
 * over a blurred copy of itself, with the title underneath. Never a bad crop.
 */
function composedPoster(game) {
  return html`
    <div class="poster-composed">
      ${game.image ? html`<span class="poster-blur" data-bg="${game.image}"></span><img class="poster-shot" src="${game.image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <span class="poster-title">${game.name}</span>
      ${game.released ? html`<span class="poster-year">${year(game.released)}</span>` : ''}
    </div>`;
}

/** Tall poster with a big rank number, for the Top 10 row. */
export function rankTile(game, rank) {
  return html`
    <a class="rank-tile" href="${gameHref(game.id)}" title="${game.name}">
      <span class="rank" aria-hidden="true">${rank}</span>
      <div class="poster" data-name="${game.name}" data-image="${game.image || ''}" data-year="${game.released || ''}">
        ${game.poster
          ? html`<img class="poster-art" src="${game.poster}" alt="" loading="lazy" referrerpolicy="no-referrer">`
          : composedPoster(game)}
      </div>
    </a>`;
}

export const statusBadge = (status) => html`<span class="status status-${status}">${STATUS_LABELS[status]}</span>`;

export const ratingBadge = (rating) => (rating ? html`<span class="rating-pill">${icon('star')}${starValue(rating)}</span>` : '');

export function formatHours(minutes) {
  if (!minutes) return '';
  const hours = minutes / 60;
  return hours < 1 ? '<1 h' : `${hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours).toLocaleString()} h`;
}

/** A library entry card: status tag top-left, rating and hours bottom-right. */
export function libraryTile(entry) {
  return gameTile(
    { id: entry.gameId, name: entry.name, image: entry.image },
    {
      tag: STATUS_LABELS[entry.status],
      corner: html`${entry.playtime ? html`<span class="corner-chip">${formatHours(entry.playtime)}</span>` : ''}${ratingBadge(entry.rating)}`,
    },
  );
}

/** Horizontally scrolling row with arrow buttons, like a streaming app. */
export function row({ title, href, items, id = '', cls = '' }) {
  return html`
    <section class="row ${cls}" ${raw(id ? `id="${id}"` : '')}>
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
  html`<div class="empty"><h3>${title}</h3>${body ? html`<p>${body}</p>` : ''}${action}</div>`;

// ---- Loading skeletons ------------------------------------------------------------

const skeletonTiles = (n) => html`${Array.from({ length: n }, () => html`<div class="sk-tile"><div class="sk sk-frame"></div></div>`)}`;

export function skeleton(kind) {
  if (kind === 'home') {
    return html`<div class="skeleton sk-page"><div class="sk sk-title"></div><div class="sk-feature"><div class="sk"></div><div class="sk"></div></div>
      ${[1, 2].map(() => html`<div class="sk-row"><div class="sk sk-heading"></div><div class="sk-track">${skeletonTiles(5)}</div></div>`)}</div>`;
  }
  if (kind === 'game') {
    return html`<div class="skeleton"><div class="sk sk-hero short"></div><div class="sk-page"><div class="sk sk-heading"></div><div class="sk sk-line wide"></div><div class="sk sk-line wide"></div></div></div>`;
  }
  return html`<div class="skeleton sk-page"><div class="sk sk-title"></div><div class="sk-grid">${skeletonTiles(10)}</div></div>`;
}

// ---- Broken images -------------------------------------------------------------------

// Image errors don't bubble, so this listens in the capture phase.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;

  // Missing logo: show the game's name as text instead.
  if (img.classList.contains('logo-art')) {
    const heading = img.parentElement;
    heading.classList.remove('has-logo');
    img.replaceWith(document.createTextNode(img.alt));
    return;
  }

  // Missing official poster: build a poster card from the game's wide image.
  if (img.classList.contains('poster-art')) {
    const poster = img.parentElement;
    const { name, image, year: released } = poster.dataset;
    mount(poster, composedPoster({ name, image: image || null, released: released || null }));
    return;
  }

  // Steam banner missing: use the game's other image, with the title laid over it.
  if (img.dataset.fallback) {
    img.src = img.dataset.fallback;
    delete img.dataset.fallback;
    img.closest('.tile-frame')?.classList.add('needs-title');
    img.closest('.tile')?.querySelector('.tile-overlay-title')?.classList.remove('visually-hidden');
    return;
  }

  // Missing cover: show a colored title card.
  if (img.classList.contains('tile-art')) {
    const name = img.closest('[title]')?.getAttribute('title') || '';
    const div = document.createElement('div');
    div.className = 'tile-art art-fallback';
    div.dataset.hue = hueFor(name);
    div.innerHTML = html`<span>${name}</span>`.value;
    const parent = img.parentElement;
    img.replaceWith(div);
    applyStyles(parent);
  }
}, true);
