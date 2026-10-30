// Hover previews: resting the mouse on a game card opens a bigger card over
// it that plays the game's silent Steam preview loop, with quick actions, the
// way streaming apps preview a title. Mouse and trackpad only; touch screens
// keep plain cards. With "reduce motion" the card opens without movement or video.
import { html, api, mount, state, year, gameHref, toast, refreshLibrary, STATUS_LABELS } from './lib.js';
import { icon } from './icons.js';
import { desktop, playButton, wireLaunchButtons } from './desktop.js';

const OPEN_DELAY_MS = 550;
const canHover = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
const stillMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const trailers = new Map();
/** Steam's silent 6-second preview loop for a Steam app ID (null if it has none). Asked once per game. */
export function microtrailer(appId) {
  if (!appId) return Promise.resolve(null);
  if (!trailers.has(appId)) {
    trailers.set(appId, api(`/steam/${appId}/microtrailer`).then((d) => d.url).catch(() => null));
  }
  return trailers.get(appId);
}

let card = null;
let timer = null;
let current = null;
// Containers with previews turned on, and where the mouse last was.
const roots = new Set();
let pointer = null;

function close() {
  clearTimeout(timer);
  timer = null;
  current = null;
  if (!card) return;
  const old = card;
  card = null;
  old.classList.remove('open');
  old.querySelector('video')?.removeAttribute('src');
  setTimeout(() => old.remove(), 160);
}

function cardHtml(d) {
  const entry = state.library.find((e) => e.gameId === d.id);
  return html`
    <a class="hc-media" href="${gameHref(d.id)}" tabindex="-1">
      <span class="hc-art" data-bg="${d.wide}"></span>
      <video muted loop playsinline preload="none"></video>
    </a>
    <div class="hc-body">
      <strong class="hc-name">${d.name}</strong>
      ${d.meta ? html`<span class="hc-meta">${d.meta}</span>` : ''}
      <div class="hc-actions">
        <a class="pill-btn pill-light btn-sm" href="${gameHref(d.id)}">View game</a>
        ${entry
          ? html`<span class="hc-status">${icon('check')}${STATUS_LABELS[entry.status]}</span>`
          : state.user
            ? html`<button type="button" class="pill-btn btn-sm hc-want">${icon('plus')}Want to play</button>`
            : ''}
        <span class="play-slot hc-play"></span>
      </div>
    </div>`;
}

function open(tile) {
  const d = {
    id: tile.dataset.preview,
    name: tile.getAttribute('title') || '',
    meta: tile.dataset.meta || '',
    wide: tile.dataset.wide || '',
    steam: Number(tile.dataset.steam) || null,
  };
  if (!d.id || !document.contains(tile)) return;
  close();
  current = tile;
  card = document.createElement('div');
  card.className = 'hover-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', d.name);
  mount(card, cardHtml(d));
  document.body.append(card);

  // Centered over the card underneath, a little bigger, and kept on screen.
  const rect = tile.getBoundingClientRect();
  const width = Math.max(rect.width * 1.3, 340);
  const height = card.offsetHeight;
  const top = Math.min(Math.max(rect.top + rect.height / 2 - (width * 9) / 32 - 24, 72), innerHeight - height - 12);
  const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 12), innerWidth - width - 12);
  card.style.width = `${width}px`;
  card.style.top = `${top}px`;
  card.style.left = `${left}px`;
  requestAnimationFrame(() => card?.classList.add('open'));

  card.addEventListener('mouseleave', close);
  card.querySelector('.hc-want')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      await api(`/me/library/${encodeURIComponent(d.id)}`, { method: 'PUT', body: { status: 'want' } });
      await refreshLibrary();
      document.dispatchEvent(new Event('library-changed'));
      mount(button, html`${icon('check')}On your list`);
      toast(`Added ${d.name} to Want to play`);
    } catch (err) {
      button.disabled = false;
      toast(err.message, { error: true });
    }
  });

  const shown = card;
  if (!stillMotion() && d.steam) {
    microtrailer(d.steam).then((url) => {
      if (!url || card !== shown) return;
      const video = shown.querySelector('video');
      video.addEventListener('playing', () => shown.classList.add('has-video'), { once: true });
      video.src = url;
      video.play().catch(() => {});
    });
  }
  desktop?.findInstalled({ id: d.id, steamAppId: d.steam, name: d.name }).then((found) => {
    const slot = shown.querySelector('.hc-play');
    if (!found || card !== shown || !slot) return;
    mount(slot, playButton(found, d.name));
    wireLaunchButtons(slot);
  }).catch(() => {});
}

/** Turns on hover previews for every game card inside `root` that carries data-preview. */
export function enablePreviews(root) {
  if (!canHover()) return;
  roots.add(root);
  root.addEventListener('mouseover', (e) => {
    const tile = e.target.closest('[data-preview]');
    if (!tile || tile === current) return;
    clearTimeout(timer);
    timer = setTimeout(() => open(tile), OPEN_DELAY_MS);
  });
  root.addEventListener('mouseout', (e) => {
    const tile = e.target.closest('[data-preview]');
    // Leaving a card before its preview opens cancels it; leaving onto the preview keeps it.
    if (tile && !tile.contains(e.relatedTarget) && !card?.contains(e.relatedTarget)) {
      clearTimeout(timer);
      if (tile === current && !card?.matches(':hover')) close();
    }
  });
}

// Scrolling the page or a row closes the preview. When scrolling stops with
// the mouse resting on a card, that card's preview opens as usual.
let scrollEnd = null;
addEventListener('mousemove', (e) => { pointer = [e.clientX, e.clientY]; }, { passive: true });
document.addEventListener('scroll', () => {
  close();
  clearTimeout(scrollEnd);
  scrollEnd = setTimeout(() => {
    if (!pointer) return;
    const tile = document.elementFromPoint(...pointer)?.closest('[data-preview]');
    if (tile && [...roots].some((r) => r.isConnected && r.contains(tile))) timer = setTimeout(() => open(tile), OPEN_DELAY_MS);
  }, 150);
}, { passive: true, capture: true });
// A new page or the keyboard closes it too.
addEventListener('hashchange', () => {
  close();
  for (const r of roots) if (!r.isConnected) roots.delete(r);
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') close();
});
