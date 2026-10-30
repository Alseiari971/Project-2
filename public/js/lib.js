// Shared helpers: safe HTML templating, API calls, app state, small utilities.
import { t, locale } from './i18n.js';

export const STATUS_LABELS = {
  playing: t('Playing'),
  completed: t('Completed'),
  played: t('Played'),
  want: t('Want to play'),
  dropped: t('Dropped'),
};

// The logged-in user (or null), their editable profile settings, and their
// game list (shown in the sidebar and the search palette).
export const state = { user: null, showcases: [], options: null, library: [] };

// ---- Safe HTML ----------------------------------------------------------------

// Marks a string as already-safe HTML so `html` won't escape it.
class Raw { constructor(value) { this.value = value; } }
export const raw = (value) => new Raw(value);

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Tagged template that escapes every interpolated value unless wrapped in raw().
// Arrays are joined, so `${items.map((i) => html`...`)}` just works.
export function html(strings, ...values) {
  const render = (v) => (v instanceof Raw ? v.value : Array.isArray(v) ? v.map(render).join('') : v === false || v == null ? '' : escapeHtml(v));
  return raw(strings.reduce((out, str, i) => out + str + (i < values.length ? render(values[i]) : ''), ''));
}

/**
 * Text from the game data or from users (names, pitches), set apart so it keeps
 * its own direction: "7 Days to Die" or "Free to play." inside an Arabic page,
 * or an Arabic name inside an English one, without its digits or full stop
 * jumping to the other end.
 */
export const bdi = (text) => html`<bdi>${text}</bdi>`;
// The same for plain text (toasts, translated sentences): prices and
// percentages always read left to right, "$29.95" and "−12%".
export const ltr = (text) => `\u2066${text}\u2069`;

/**
 * A translated sentence with pieces of HTML (links, bold words) placed into
 * its {placeholders}, such as a link given as { store: html`<a ...>` }.
 * The translation itself is escaped; only the pieces are HTML.
 */
export function th(text, parts) {
  return raw(escapeHtml(t(text)).replace(/\{(\w+)\}/g, (m, k) => (k in parts ? html`${parts[k]}`.value : m)));
}

/** Renders a template into an element and applies dynamic styles. */
export function mount(el, content) {
  el.innerHTML = content.value;
  applyStyles(el);
  return el;
}

// The Content-Security-Policy blocks inline style attributes, so dynamic
// colors and background images are applied from data attributes instead.
export function applyStyles(root) {
  root.querySelectorAll('[data-hue]').forEach((el) => {
    const h = Number(el.dataset.hue);
    el.style.backgroundColor = `hsl(${h} 28% 24%)`;
  });
  root.querySelectorAll('[data-bg]').forEach((el) => {
    if (!el.dataset.bg) return;
    el.style.backgroundImage = `url("${el.dataset.bg.replace(/["\\\n]/g, '\\$&')}")`;
  });
  root.querySelectorAll('[data-accent]').forEach((el) => {
    el.style.setProperty('--accent', el.dataset.accent);
    el.style.setProperty('--on-accent', textColorOn(el.dataset.accent));
  });
  root.querySelectorAll('[data-progress]').forEach((el) => {
    el.style.setProperty('--progress', el.dataset.progress);
  });
}

/** Black or white, whichever reads better on the given #rrggbb color (WCAG contrast). */
export function textColorOn(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return (lum + 0.05) / 0.05 >= 1.05 / (lum + 0.05) ? '#000' : '#fff';
}

// ---- API ----------------------------------------------------------------------

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The server answers in English; t() turns its messages into Arabic.
    const err = new Error(data.error ? t(data.error) : t('Request failed ({status})', { status: res.status }));
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function refreshMe() {
  const data = await api('/me');
  state.user = data.user;
  state.showcases = data.showcases || [];
  state.options = data.options || null;
  return data;
}

/** Reloads the logged-in user's game list and tells the sidebar. */
export async function refreshLibrary() {
  state.library = state.user
    ? (await api(`/users/${encodeURIComponent(state.user.username)}`).catch(() => ({ library: [] }))).library
    : [];
  document.dispatchEvent(new Event('library-changed'));
  return state.library;
}

// ---- Recently viewed games (this browser only) -----------------------------------

const RECENT_KEY = 'gameshelf-recent';
const RECENT_MAX = 6;

export function recentGames() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
}

export function rememberGame(game) {
  const entry = { id: game.id, name: game.name, image: game.image || null };
  const list = [entry, ...recentGames().filter((g) => g.id !== game.id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Storage can be unavailable (private mode); recents are just a convenience.
  }
}

// ---- Small utilities ------------------------------------------------------------

// Stable color per name, used for avatars and image-less game tiles.
export function hueFor(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

export const year = (date) => (date ? date.slice(0, 4) : t('TBA'));

export function formatDate(date) {
  if (!date) return t('TBA');
  return new Date(date + 'T00:00:00').toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
}

// SQLite timestamps are UTC without a zone marker.
export const parseDbTime = (value) => new Date(value.replace(' ', 'T') + 'Z');

export function timeAgo(value) {
  const seconds = (parseDbTime(value).getTime() - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return t('just now');
}

export const gameHref = (id) => `#/game/${encodeURIComponent(id)}`;
export const profileHref = (username) => `#/u/${encodeURIComponent(username)}`;

// Functions to run when the user navigates away (timers, listeners).
const cleanups = [];
export const onLeave = (fn) => cleanups.push(fn);
export function runCleanups() {
  while (cleanups.length) cleanups.pop()();
}

// Sideways scrolling rows. Their start is on the left in English and on the
// right in Arabic, where scrollLeft counts down from 0 instead of up.
export function scrollEdges(el, slack = 8) {
  const x = Math.abs(el.scrollLeft);
  return { atStart: x < slack, atEnd: x + el.clientWidth > el.scrollWidth - slack };
}
export function scrollRow(el, forward, share = 0.85) {
  const sign = (forward ? 1 : -1) * (getComputedStyle(el).direction === 'rtl' ? -1 : 1);
  el.scrollBy({ left: sign * el.clientWidth * share, behavior: 'smooth' });
}

export function toast(message, { error = false } = {}) {
  // One toast at a time: a new message replaces the current one.
  document.querySelectorAll('.toast').forEach((old) => old.remove());
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2600);
}
