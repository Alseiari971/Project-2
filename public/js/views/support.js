// Support (#/support): a new ticket, my tickets, and each ticket's thread,
// which updates by itself while open. The Admin Panel's Support tab
// (admin.js) uses the same thread and labels.
import { html, bdi, api, mount, state, toast, onLeave, parseDbTime, gameHref } from '../lib.js';
import { t, locale } from '../i18n.js';
import { icon } from '../icons.js';
import { emptyState } from '../components.js';

export const CATEGORY_LABELS = {
  account: 'Account & 2FA', steam: 'Steam linking', arabic: 'Broken Arabic patch', request: 'Game request', other: 'Other',
};
export const TICKET_STATUS = { open: 'Open', replied: 'Admin replied', resolved: 'Resolved', closed: 'Closed' };
const POLL_MS = 10 * 1000;

export const statusChip = (status) => html`<span class="ticket-status ticket-${status}">${t(TICKET_STATUS[status] || status)}</span>`;

export const when = (value) => (value ? parseDbTime(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** The conversation: the player on one side, GameShelf's answers on the other. */
export function threadHtml(messages, { viewer = 'user' } = {}) {
  return html`<ol class="ticket-thread">${messages.map((m) => {
    const mine = viewer === 'admin' ? m.fromAdmin : !m.fromAdmin;
    return html`
      <li class="ticket-msg ${m.fromAdmin ? 'from-admin' : 'from-user'} ${mine ? 'mine' : ''}">
        <div class="ticket-msg-head"><strong>${m.fromAdmin ? html`${icon('shield')} ${t('GameShelf Support')}` : bdi(m.authorName || m.author || '')}</strong><time class="muted small">${when(m.createdAt)}</time></div>
        <div class="ticket-msg-body">${bdi(m.body)}</div>
      </li>`;
  })}</ol>`;
}

/** A game picker for the ticket form: type, pick one from the catalog (or none). */
function wireGamePicker(root) {
  const input = root.querySelector('.game-search');
  const hidden = root.querySelector('input[name="gameId"]');
  const list = root.querySelector('.game-results');
  let timer = null;
  let asked = '';
  onLeave(() => clearTimeout(timer));
  const clearPick = () => {
    hidden.value = '';
    root.classList.remove('picked');
  };
  input.addEventListener('input', () => {
    clearPick();
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return mount(list, html``);
    timer = setTimeout(async () => {
      asked = q;
      const data = await api(`/games?search=${encodeURIComponent(q)}`).catch(() => ({ results: [] }));
      if (asked !== input.value.trim()) return;
      mount(list, html`${data.results.slice(0, 6).map((g) => html`
        <li><button type="button" data-id="${g.id}" data-name="${g.name}">${g.image ? html`<img src="${g.image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="game-blank"></span>`}<span>${bdi(g.name)}</span></button></li>`)}`);
    }, 250);
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    hidden.value = b.dataset.id;
    input.value = b.dataset.name;
    root.classList.add('picked');
    mount(list, html``);
  });
}

function newTicketForm(categories) {
  return html`
    <form class="panel ticket-form" id="ticket-form">
      <h2>${t('New support ticket')}</h2>
      <label>${t('What is it about?')}
        <select class="input" name="category" required>
          <option value="">${t('Choose a category')}</option>
          ${categories.map((c) => html`<option value="${c}">${t(CATEGORY_LABELS[c])}</option>`)}
        </select>
      </label>
      <label>${t('Subject')}<input class="input" name="subject" required minlength="4" maxlength="120"></label>
      <div class="label-like game-picker">${t('Game (optional)')}
        <input type="hidden" name="gameId" value="">
        <input class="input game-search" type="search" placeholder="${t('Search the catalog')}" autocomplete="off" aria-label="${t('Game (optional)')}">
        <ul class="game-results"></ul>
      </div>
      <label>${t('Message')}<textarea class="input" name="message" required minlength="10" maxlength="5000" rows="6" placeholder="${t('What happened, and what did you expect? For Arabic patches, say which screen looks wrong.')}"></textarea></label>
      <p class="form-error" id="ticket-error" role="alert"></p>
      <button class="btn btn-light" type="submit">${t('Send ticket')}</button>
    </form>`;
}

function ticketRow(ticket, href) {
  return html`
    <a class="ticket-row" href="${href}">
      <div class="ticket-row-main"><strong>${bdi(ticket.subject)}</strong>
        <span class="muted small">${t(CATEGORY_LABELS[ticket.category])}${ticket.game ? html` · ${bdi(ticket.game.name)}` : ''} · ${when(ticket.updatedAt)}</span></div>
      ${statusChip(ticket.status)}
    </a>`;
}

async function listPage(app) {
  const { tickets, categories } = await api('/support/tickets');
  mount(app, html`
    <div class="page support-page">
      <header class="settings-head">
        <h1>${t('Support')}</h1>
        <p class="muted">${t('Trouble with your account, Steam linking or an Arabic patch? Tell us here and GameShelf\'s team answers in the ticket.')}</p>
      </header>
      <div class="support-grid">
        ${newTicketForm(categories)}
        <section class="panel">
          <h2>${t('My tickets')}</h2>
          ${tickets.length ? html`<div class="ticket-list">${tickets.map((tk) => ticketRow(tk, `#/support/${tk.id}`))}</div>` : html`<p class="muted">${t('No tickets yet.')}</p>`}
        </section>
      </div>
    </div>`);
  const form = document.getElementById('ticket-form');
  wireGamePicker(form.querySelector('.game-picker'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const made = await api('/support/tickets', {
        method: 'POST',
        body: { category: fd.get('category'), subject: fd.get('subject'), gameId: fd.get('gameId') || undefined, message: fd.get('message') },
      });
      toast(t('Ticket sent. We\'ll answer here.'));
      location.hash = `#/support/${made.ticket.id}`;
    } catch (err) {
      document.getElementById('ticket-error').textContent = err.message;
      button.disabled = false;
    }
  });
}

async function ticketPage(app, id) {
  let data = await api(`/support/tickets/${encodeURIComponent(id)}`);
  let draft = '';
  const draw = () => {
    const { ticket, messages } = data;
    const closed = ticket.status === 'closed';
    mount(app, html`
      <div class="page support-page">
        <a class="text-link" href="#/support">${icon('back', 'flip')} ${t('All tickets')}</a>
        <header class="ticket-head">
          <div>
            <h1>${bdi(ticket.subject)}</h1>
            <p class="muted small">${t('Ticket #{id}', { id: ticket.id })} · ${t(CATEGORY_LABELS[ticket.category])}${ticket.game ? html` · ${ticket.game.id ? html`<a href="${gameHref(ticket.game.id)}">${bdi(ticket.game.name)}</a>` : bdi(ticket.game.name)}` : ''} · ${t('Opened {when}', { when: when(ticket.createdAt) })}</p>
          </div>
          ${statusChip(ticket.status)}
        </header>
        <section class="panel">${threadHtml(messages)}</section>
        ${closed ? html`<p class="muted center">${t('This ticket is closed. Open a new one if you still need help.')}</p>` : html`
          <form class="panel ticket-reply" id="reply-form">
            <label>${t('Reply')}<textarea class="input" name="body" rows="4" maxlength="5000" required></textarea></label>
            <div class="row-actions">
              <button class="btn btn-light" type="submit">${t('Send reply')}</button>
              <button class="btn" type="button" id="close-ticket">${t('Close ticket')}</button>
            </div>
          </form>`}
      </div>`);
    const form = document.getElementById('reply-form');
    if (!form) return;
    form.body.value = draft;
    form.body.addEventListener('input', () => { draft = form.body.value; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        data = await api(`/support/tickets/${ticket.id}/messages`, { method: 'POST', body: { body: form.body.value } });
        draft = '';
        draw();
      } catch (err) {
        toast(err.message, { error: true });
        button.disabled = false;
      }
    });
    document.getElementById('close-ticket').addEventListener('click', async () => {
      if (!confirm(t('Close this ticket? You can open a new one later.'))) return;
      data = await api(`/support/tickets/${ticket.id}/close`, { method: 'POST' });
      draw();
    });
  };
  draw();
  // New answers show up while the page is open (and the reply being typed stays).
  const timer = setInterval(async () => {
    if (document.hidden) return;
    const next = await api(`/support/tickets/${encodeURIComponent(id)}`).catch(() => null);
    if (next && (next.messages.length !== data.messages.length || next.ticket.status !== data.ticket.status)) {
      data = next;
      const typing = document.activeElement?.name === 'body';
      draw();
      if (typing) document.querySelector('#reply-form textarea')?.focus();
    }
  }, POLL_MS);
  onLeave(() => clearInterval(timer));
}

export async function supportView(app, id) {
  if (!state.user) {
    location.hash = '#/login?next=' + encodeURIComponent('#/support');
    return;
  }
  document.title = `${t('Support')} · ${t('GameShelf')}`;
  try {
    if (id) await ticketPage(app, id);
    else await listPage(app);
  } catch (err) {
    if (err.status !== 404) throw err;
    mount(app, html`<div class="page">${emptyState(t('That ticket isn\'t there.'), '', html`<a class="pill-btn pill-light" href="#/support">${t('All tickets')}</a>`)}</div>`);
  }
}
