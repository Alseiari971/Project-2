// Search palette: a centered pop-up that searches as you type, opened from the
// top bar's search pill, Ctrl/Cmd+K or "/". Arrow keys move, Enter opens.
import { html, bdi, th, api, mount, state, recentGames, gameHref, year } from './lib.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

const DEBOUNCE_MS = 220;
const MAX_RESULTS = 8;

let open = false;
let lastFocus = null;

function item(game, meta = '') {
  return html`
    <a class="pal-item" href="${gameHref(game.id || game.gameId)}" role="option">
      ${game.image
        ? html`<img class="pal-thumb" src="${game.image}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : html`<span class="pal-thumb"></span>`}
      <span class="pal-name">${bdi(game.name)}</span>
      ${meta ? html`<span class="pal-meta">${meta}</span>` : ''}
    </a>`;
}

function section(title, games, metaFor = () => '') {
  if (!games.length) return '';
  return html`<div class="pal-section"><div class="pal-label">${title}</div>${games.map((g) => item(g, metaFor(g)))}</div>`;
}

function startView() {
  const recent = recentGames();
  const mine = state.library.filter((e) => !recent.some((r) => r.id === e.gameId)).slice(0, 5);
  if (!recent.length && !mine.length) {
    return html`<p class="pal-empty">${t('Search more than 500,000 games by name.')}</p>`;
  }
  return html`
    ${section(t('Recently viewed'), recent)}
    ${section(t('Your games'), mine.map((e) => ({ ...e, id: e.gameId })))}`;
}

export function openPalette(initial = '') {
  if (open) return;
  open = true;
  lastFocus = document.activeElement;
  const root = document.getElementById('palette-root');
  mount(root, html`
    <div class="pal-backdrop" id="pal-backdrop">
      <div class="palette" role="dialog" aria-modal="true" aria-label="${t('Search games')}">
        <div class="pal-input-row">
          ${icon('search')}
          <input id="pal-input" type="search" placeholder="${t('Search')}" autocomplete="off" spellcheck="false" aria-controls="pal-results">
          <span class="pal-hint">${th('Use {up} {down} to navigate', { up: html`<kbd>↑</kbd>`, down: html`<kbd>↓</kbd>` })}</span>
        </div>
        <div class="pal-results" id="pal-results" role="listbox">${startView()}</div>
      </div>
    </div>`);

  const input = document.getElementById('pal-input');
  const results = document.getElementById('pal-results');
  let timer = null;
  let seq = 0;
  let active = -1;

  const items = () => [...results.querySelectorAll('.pal-item')];
  const highlight = (i) => {
    const list = items();
    active = list.length ? (i + list.length) % list.length : -1;
    list.forEach((el, n) => el.classList.toggle('active', n === active));
    list[active]?.scrollIntoView({ block: 'nearest' });
  };

  const search = async (q) => {
    const mySeq = ++seq;
    if (!q) {
      mount(results, startView());
      active = -1;
      return;
    }
    try {
      const data = await api(`/games?search=${encodeURIComponent(q)}`);
      if (mySeq !== seq) return; // a newer search started
      const games = data.results.slice(0, MAX_RESULTS);
      mount(results, games.length
        ? html`${section(t('Games'), games, (g) => (g.released ? year(g.released) : ''))}
            <a class="pal-all" href="#/browse?q=${encodeURIComponent(q)}">${t('See all results for “{q}”', { q })}</a>`
        : html`<p class="pal-empty">${t('No games found for “{q}”.', { q })}</p>`);
      highlight(0);
    } catch {
      if (mySeq === seq) mount(results, html`<p class="pal-empty">${t("Search isn't working right now. Try again in a moment.")}</p>`);
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => search(input.value.trim()), DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const target = items()[active];
      if (target) location.hash = target.getAttribute('href');
      else if (input.value.trim()) location.hash = `#/browse?q=${encodeURIComponent(input.value.trim())}`;
      closePalette();
    }
  });
  document.getElementById('pal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'pal-backdrop' || e.target.closest('.pal-item, .pal-all')) closePalette();
  });

  input.value = initial;
  input.focus();
  if (initial) search(initial);
}

export function closePalette() {
  if (!open) return;
  open = false;
  document.getElementById('palette-root').innerHTML = '';
  lastFocus?.focus?.();
}

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
    e.preventDefault();
    if (open) closePalette();
    else openPalette();
  } else if (e.key === 'Escape' && open) {
    closePalette();
  }
});
