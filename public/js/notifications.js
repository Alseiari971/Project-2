// The bell in the header: friend requests, Support's replies, and Arabic going
// live for games the player asked for. Checked every minute (and when the tab
// comes back); opening the list marks it read.
import { html, bdi, api, mount, state, timeAgo } from './lib.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

const POLL_MS = 60 * 1000;
let timer = null;
let items = [];

/** One notification as a sentence in the page's language. */
function sentence(n) {
  const d = n.data || {};
  switch (n.kind) {
    case 'friend-request': return t('{name} sent you a friend request', { name: d.name || d.username });
    case 'friend-accepted': return t('{name} accepted your friend request', { name: d.name || d.username });
    case 'support-reply': return t('Support replied to “{subject}”', { subject: d.subject || '' });
    case 'arabic-ready': return t('Arabic for {game} is ready', { game: d.game || '' });
    default: return t('Something new on GameShelf');
  }
}
const kindIcon = (kind) => ({ 'friend-request': 'users', 'friend-accepted': 'users', 'support-reply': 'info', 'arabic-ready': 'star' }[kind] || 'bell');

function paint(unread) {
  const count = document.querySelector('.bell-count');
  if (!count) return;
  count.hidden = !unread;
  count.textContent = unread > 9 ? '9+' : String(unread);
  document.getElementById('bell-btn')?.setAttribute('aria-label', unread ? t('Notifications ({n} new)', { n: unread }) : t('Notifications'));
}

function drawPanel() {
  const panel = document.getElementById('bell-panel');
  if (!panel) return;
  mount(panel, html`
    <div class="bell-head"><strong>${t('Notifications')}</strong></div>
    ${items.length
      ? html`<ul class="bell-list">${items.map((n) => html`
          <li class="${n.read ? '' : 'is-new'}"><a href="${n.link}">
            <span class="bell-icon">${icon(kindIcon(n.kind))}</span>
            <span class="bell-text"><span>${bdi(sentence(n))}</span><span class="muted small">${timeAgo(new Date(n.createdAt).toISOString().replace('T', ' ').slice(0, 19))}</span></span>
          </a></li>`)}</ul>`
      : html`<p class="muted small bell-empty">${t('Nothing new yet. Friend requests, replies from Support and Arabic for games you asked for show up here.')}</p>`}`);
}

async function check() {
  if (!state.user || document.hidden) return;
  try {
    const data = await api('/notifications');
    items = data.items;
    paint(data.unread);
    if (!document.getElementById('bell-panel')?.hidden) drawPanel();
  } catch {}
}

export function wireBell() {
  clearInterval(timer);
  const button = document.getElementById('bell-btn');
  const panel = document.getElementById('bell-panel');
  if (!button || !panel) return;
  check();
  timer = setInterval(check, POLL_MS);
  button.addEventListener('click', async (e) => {
    e.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (!open) return;
    drawPanel();
    // Seen: they're read now (the dots stay until the list is drawn again).
    if (items.some((n) => !n.read)) {
      const { unread } = await api('/notifications/read', { method: 'POST', body: {} }).catch(() => ({ unread: 0 }));
      paint(unread);
      items = items.map((n) => ({ ...n, read: true }));
    }
  });
  panel.addEventListener('click', (e) => {
    if (e.target.closest('a')) panel.hidden = true;
    e.stopPropagation();
  });
}

// A click anywhere else, or going to another page (Back too), closes the list
// (the header is drawn again often, so these are set once).
function closePanel() {
  const panel = document.getElementById('bell-panel');
  if (panel && !panel.hidden) {
    panel.hidden = true;
    document.getElementById('bell-btn')?.setAttribute('aria-expanded', 'false');
  }
}
document.addEventListener('click', closePanel);
window.addEventListener('hashchange', closePanel);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) check();
});
