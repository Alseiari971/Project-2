// The Admin Panel (#/admin), for accounts with the admin role: the site at a
// glance, users and their roles, the cloud catalog of Arabic packs (drop a
// signed pack's .zip to publish it), what players ask for, the Windows
// installer the website hands out and, in the desktop app, the Pack Studio.
// The server checks the role on every request; hiding the page is only a nicety.
import { html, bdi, mount, state, api, toast, onLeave } from '../lib.js';
import { pillGroup, emptyState } from '../components.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';
import { flagBadge } from '../country-picker.js';
import { CATEGORY_LABELS, TICKET_STATUS, statusChip, threadHtml, when } from './support.js';
import { keysTab } from './admin-keys.js';

const desktop = window.gameshelfDesktop;
const TABS = ['overview', 'support', 'approvals', 'requests', 'keys', 'fixes', 'packs', 'users', 'supporters', 'installer', ...(desktop?.studio ? ['studio'] : [])];
const TAB_LABELS = {
  overview: 'Overview', support: 'Support', approvals: 'Pending approvals', users: 'Users', packs: 'Arabic packs', requests: 'Requests', fixes: 'Translation fixes',
  keys: 'AES Keys & Recipes', supporters: 'Supporters & codes', installer: 'Windows app', studio: 'Pack Studio',
};
const ENGINE_LABELS = {
  auto: 'Detect it', unreal: 'Unreal Engine', unity: 'Unity', reengine: 'Capcom RE Engine', godot: 'Godot', renpy: "Ren'Py",
  bethesda: 'Bethesda Creation Engine', loose: 'Readable text files', custom: 'Custom engine (recipe)', overlay: 'Accessibility overlay',
};

const formatSize = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
  : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const errorText = (err) => t(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));

/** Sends a file as the request body, reporting upload progress (0 to 1). */
function upload(url, file, { method = 'POST', type = 'application/octet-stream', onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('Content-Type', type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error ? t(data.error) : t('Request failed ({status})', { status: xhr.status })));
    };
    xhr.onerror = () => reject(new Error(t('The upload stopped. Check your internet connection.')));
    xhr.send(file);
  });
}

/** A drop zone that takes one file (or a click to pick one). */
function dropZone(el, { accept, onFile }) {
  const input = el.querySelector('input[type=file]');
  el.addEventListener('click', (e) => {
    if (e.target !== input) input.click();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
  for (const type of ['dragenter', 'dragover']) {
    el.addEventListener(type, (e) => {
      e.preventDefault();
      el.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) el.addEventListener(type, () => el.classList.remove('is-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (accept && !accept.test(file.name)) return toast(t('That isn\'t the right kind of file.'), { error: true });
    onFile(file);
  });
}

export async function adminView(app, params) {
  if (!state.user) {
    location.hash = '#/login';
    return;
  }
  if (state.user.role !== 'admin') {
    mount(app, html`<div class="page">${emptyState(t('Admins only'), t('This part of GameShelf is for the people who run it.'), html`<a class="pill-btn pill-light" href="#/">${t('Go home')}</a>`)}</div>`);
    return;
  }
  document.title = `${t('Admin Panel')} · ${t('GameShelf')}`;
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'overview';
  mount(app, html`
    <div class="page admin">
      <div class="page-head"><h1>${icon('shield')} ${t('Admin Panel')}</h1></div>
      ${pillGroup(TABS.map((key) => ({ key, label: t(TAB_LABELS[key]), href: `#/admin?tab=${key}` })), tab)}
      <div id="admin-body" class="admin-body"></div>
    </div>`);
  const body = document.getElementById('admin-body');
  await { overview, support, approvals, users, packs, requests, keys: keysTab, fixes, supporters, installer, studio }[tab](body, params);
}

// ---- Overview ------------------------------------------------------------------

async function overview(body) {
  const s = await api('/admin/stats');
  const tile = (value, label) => html`<div class="stat-tile"><strong>${value.toLocaleString()}</strong><span>${label}</span></div>`;
  mount(body, html`
    <div class="stat-grid">
      ${tile(s.users, t('Accounts'))}
      ${tile(s.newUsersThisWeek, t('New this week'))}
      ${tile(s.admins, t('Admins'))}
      ${tile(s.packs.packs, t('Arabic packs in the catalog'))}
      ${tile(s.packs.downloads, t('Pack downloads'))}
      ${tile(s.packs.players, t('Players who downloaded a pack'))}
      ${tile(s.translatedLines, t('Lines in the shared Arabic memory'))}
      ${tile(s.requests, t('Arabic requests'))}
    </div>
    ${s.packKey ? '' : html`<p class="form-error">${t('The server has no pack signing key, so it can\'t take packs. Put the public key in desktop/config.json (localizationPackKey) or PACK_PUBLIC_KEY.')}</p>`}`);
}

// ---- Support ---------------------------------------------------------------------

const SUPPORT_POLL_MS = 10 * 1000;

/** Who sent a ticket: their flag, Steam link, Guard and email at a glance. */
function senderCard(from) {
  if (!from) return '';
  const yes = (ok, good, bad) => html`<span class="chip ${ok ? 'chip-good' : 'chip-warn'}">${ok ? good : bad}</span>`;
  return html`
    <div class="sender-card">
      <div><strong>${bdi(from.displayName)}</strong> <a class="muted small" href="#/u/${encodeURIComponent(from.username)}">${bdi(`@${from.username}`)}</a> ${flagBadge(from.nationality, { withName: true })}</div>
      <div class="chip-row">
        ${yes(from.steamLinked, t('Steam linked'), t('No Steam link'))}
        ${yes(Boolean(from.guard), t('Guard: {method}', { method: from.guard === 'totp' ? t('Authenticator app') : t('Email codes') }), t('Guard off'))}
        ${yes(from.emailVerified, t('Email confirmed'), t('Email not confirmed'))}
      </div>
    </div>`;
}

async function support(body, params) {
  const filter = { status: params.get('status') || '', category: params.get('category') || '' };
  const href = (changes) => `#/admin?${new URLSearchParams({ tab: 'support', ...filter, ...changes, ...(changes.id ? {} : { id: '' }) })}`.replace(/&?\w+=(?=&|$)/g, '');
  const openId = params.get('id');

  const drawQueue = async (polling = false) => {
    const q = await api(`/admin/support?${new URLSearchParams(filter)}`);
    mount(body, html`
      <div class="support-admin">
        <div class="support-filters">
          ${pillGroup([{ key: '', label: t('All'), href: href({ status: '' }) }, ...q.statuses.map((s) => ({ key: s, label: t(TICKET_STATUS[s]), count: q.counts[s], href: href({ status: s }) }))], filter.status)}
          <select class="input input-sm" id="support-category" aria-label="${t('Category')}">
            <option value="">${t('Every category')}</option>
            ${q.categories.map((c) => html`<option value="${c}" ${c === filter.category ? html`selected` : ''}>${t(CATEGORY_LABELS[c])}</option>`)}
          </select>
        </div>
        <div class="support-split ${openId ? 'has-open' : ''}">
          <div class="ticket-list" id="support-queue">${q.tickets.length ? q.tickets.map((tk) => html`
            <a class="ticket-row ${String(tk.id) === openId ? 'active' : ''}" href="${href({ id: tk.id })}">
              <div class="ticket-row-main">
                <strong>${bdi(tk.subject)}</strong>
                <span class="muted small">${flagBadge(tk.from.nationality)} ${bdi(`@${tk.from.username}`)} · ${t(CATEGORY_LABELS[tk.category])} · ${when(tk.updatedAt)} · ${t('{n} messages', { n: tk.messages })}${tk.userTickets > 1 ? html` · ${t('{n} tickets from them', { n: tk.userTickets })}` : ''}</span>
              </div>
              <span class="row-tail">${tk.from.steamLinked ? html`<span class="chip chip-good" title="${t('Steam linked')}">${icon('link')}</span>` : ''}${statusChip(tk.status)}</span>
            </a>`) : html`<p class="muted">${t('No tickets here.')}</p>`}</div>
          <div id="support-open"></div>
        </div>
      </div>`);
    document.getElementById('support-category').addEventListener('change', (e) => {
      location.hash = href({ category: e.target.value });
    });
    if (openId) await drawTicket(document.getElementById('support-open'), openId, polling);
  };

  let data = null;
  let draft = '';
  const drawTicket = async (el, id, polling) => {
    data = await api(`/admin/support/${encodeURIComponent(id)}`);
    const draw = () => {
      const { ticket, messages, from, history } = data;
      mount(el, html`
        <section class="panel ticket-admin">
          <header class="ticket-head">
            <div><h2>${bdi(ticket.subject)}</h2>
              <p class="muted small">${t('Ticket #{id}', { id: ticket.id })} · ${t(CATEGORY_LABELS[ticket.category])}${ticket.game ? html` · ${bdi(ticket.game.name)}` : ''} · ${t('Opened {when}', { when: when(ticket.createdAt) })}</p></div>
            ${statusChip(ticket.status)}
          </header>
          ${senderCard(from)}
          ${history.length ? html`<details class="settings-more"><summary>${t('Their other tickets ({n})', { n: history.length })}</summary>
            <ul class="history-list">${history.map((h) => html`<li><a href="${href({ id: h.id })}">${bdi(h.subject)}</a> ${statusChip(h.status)}</li>`)}</ul></details>` : ''}
          ${threadHtml(messages, { viewer: 'admin' })}
          <form class="ticket-reply" id="admin-reply">
            <label>${t('Reply as GameShelf Support')}<textarea class="input" name="body" rows="4" maxlength="5000"></textarea></label>
            <div class="row-actions">
              <button class="btn btn-light" type="submit" data-status="">${t('Send reply')}</button>
              <button class="btn" type="submit" data-status="resolved">${t('Reply & resolve')}</button>
              <span class="spacer"></span>
              ${ticket.status !== 'resolved' ? html`<button class="btn btn-sm" type="button" data-set="resolved">${t('Mark resolved')}</button>` : ''}
              ${ticket.status !== 'closed' ? html`<button class="btn btn-sm" type="button" data-set="closed">${t('Close')}</button>` : html`<button class="btn btn-sm" type="button" data-set="open">${t('Reopen')}</button>`}
            </div>
          </form>
        </section>`);
      const form = document.getElementById('admin-reply');
      form.body.value = draft;
      form.body.addEventListener('input', () => { draft = form.body.value; });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = e.submitter?.dataset.status || null;
        if (!form.body.value.trim()) return toast(t('Write a message first.'), { error: true });
        try {
          data = await api(`/admin/support/${ticket.id}/messages`, { method: 'POST', body: { body: form.body.value, status } });
          draft = '';
          toast(t('Reply sent.'));
          drawQueue();
        } catch (err) {
          toast(err.message, { error: true });
        }
      });
      form.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', async () => {
        try {
          data = await api(`/admin/support/${ticket.id}`, { method: 'PATCH', body: { status: b.dataset.set } });
          drawQueue();
        } catch (err) {
          toast(err.message, { error: true });
        }
      }));
    };
    draw();
    if (!polling) el.scrollIntoView({ block: 'nearest' });
  };

  await drawQueue();
  // New tickets and replies show up by themselves, unless a reply is being typed.
  const timer = setInterval(() => {
    if (document.hidden || document.activeElement?.name === 'body') return;
    drawQueue(true).catch(() => {});
  }, SUPPORT_POLL_MS);
  onLeave(() => clearInterval(timer));
}

// ---- Users -----------------------------------------------------------------------

async function users(body) {
  mount(body, html`
    <form class="search-bar" id="user-search" role="search">
      <label class="search-field">${icon('search')}<input type="search" name="q" placeholder="${t('Find a user')}" aria-label="${t('Find a user')}" autocomplete="off"></label>
    </form>
    <div id="user-list"></div>`);
  const list = document.getElementById('user-list');
  const show = async (q = '') => {
    const { users: rows } = await api(`/admin/users?q=${encodeURIComponent(q)}`);
    mount(list, rows.length
      ? html`<div class="admin-table">${rows.map((u) => html`
          <div class="admin-row">
            <div><strong>${bdi(u.displayName)}</strong> <span class="muted small">${bdi(`@${u.username}`)}</span></div>
            <span class="muted small">${t('{n} games', { n: u.games })}</span>
            <span class="role-tag ${u.role}">${t(u.role === 'admin' ? 'Admin' : 'User')}</span>
            <button class="btn btn-sm btn-quiet" type="button" data-role="${u.role === 'admin' ? 'user' : 'admin'}" data-user="${u.username}">${t(u.role === 'admin' ? 'Make user' : 'Make admin')}</button>
          </div>`)}</div>`
      : html`<p class="muted">${t('No users match.')}</p>`);
  };
  list.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-role]');
    if (!button) return;
    button.disabled = true;
    try {
      await api(`/admin/users/${encodeURIComponent(button.dataset.user)}`, { method: 'PATCH', body: { role: button.dataset.role } });
      toast(t('{name} is now {role}', { name: button.dataset.user, role: t(button.dataset.role === 'admin' ? 'an admin' : 'a user') }));
      await show(document.querySelector('#user-search input').value);
    } catch (err) {
      toast(errorText(err), { error: true });
      button.disabled = false;
    }
  });
  const form = document.getElementById('user-search');
  form.addEventListener('submit', (e) => e.preventDefault());
  form.querySelector('input').addEventListener('input', (e) => show(e.target.value.trim()));
  await show();
}

// ---- Arabic packs ----------------------------------------------------------------

async function packs(body) {
  mount(body, html`
    <section class="panel">
      <h2>${t('Publish a pack')}</h2>
      <div class="drop-zone" id="pack-drop" tabindex="0" role="button" aria-label="${t('Drop a signed pack (.zip) here, or click to choose one')}">
        ${icon('upload')}
        <strong>${t('Drop a signed pack (.zip) here, or click to choose one')}</strong>
        <span class="muted small">${t('A .zip of the pack folder (pack.json, its signature and its files). It\'s checked against GameShelf\'s pack key before it goes in the catalog.')}</span>
        <input type="file" accept=".zip,application/zip" hidden>
        <div class="upload-bar" hidden><span></span></div>
      </div>
    </section>
    <section class="panel">
      <h2>${t('The catalog')}</h2>
      <div id="pack-list"></div>
    </section>`);
  const list = document.getElementById('pack-list');
  const show = async () => {
    const { packs: rows } = await api('/admin/packs');
    mount(list, rows.length
      ? html`<div class="admin-table">${rows.map((p) => html`
          <div class="admin-row ${p.published ? '' : 'is-off'}">
            <div><strong>${bdi(p.title || p.id)}</strong>
              <span class="muted small">${p.id} · ${t('version {version}', { version: p.version })} · ${t(ENGINE_LABELS[p.engine] || p.engine)} · ${p.steamAppId ? t('Steam app {id}', { id: p.steamAppId }) : p.gameSlug} · ${formatSize(p.size)}</span></div>
            <span class="muted small">${t('{n} downloads', { n: p.downloads })}</span>
            <label class="check-row small"><input type="checkbox" data-publish="${p.id}" data-version="${p.version}" ${p.published ? 'checked' : ''}> ${t('Published')}</label>
            <button class="btn btn-sm btn-quiet" type="button" data-delete="${p.id}" data-version="${p.version}">${t('Delete')}</button>
          </div>`)}</div>`
      : html`<p class="muted">${t('No packs yet. Publish one from the Pack Studio in the desktop app, or drop its .zip above.')}</p>`);
  };
  list.addEventListener('change', async (e) => {
    const box = e.target.closest('[data-publish]');
    if (!box) return;
    try {
      await api(`/admin/packs/${encodeURIComponent(box.dataset.publish)}/${encodeURIComponent(box.dataset.version)}`, { method: 'PATCH', body: { published: box.checked } });
      toast(t(box.checked ? 'Published' : 'Taken out of the catalog'));
    } catch (err) {
      toast(errorText(err), { error: true });
    }
    show();
  });
  list.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-delete]');
    if (!button || !confirm(t('Delete version {version} of {id}? Players who have it keep it.', { version: button.dataset.version, id: button.dataset.delete }))) return;
    try {
      await api(`/admin/packs/${encodeURIComponent(button.dataset.delete)}/${encodeURIComponent(button.dataset.version)}`, { method: 'DELETE' });
    } catch (err) {
      toast(errorText(err), { error: true });
    }
    show();
  });
  const zone = document.getElementById('pack-drop');
  const bar = zone.querySelector('.upload-bar');
  dropZone(zone, {
    accept: /\.zip$/i,
    onFile: async (file) => {
      bar.hidden = false;
      try {
        const { pack } = await upload('/api/admin/packs', file, { type: 'application/zip', onProgress: (p) => bar.firstElementChild.style.setProperty('width', `${Math.round(p * 100)}%`) });
        toast(t('Published {name} {version}', { name: pack.title || pack.id, version: pack.version }));
        show();
      } catch (err) {
        toast(errorText(err), { error: true });
      } finally {
        bar.hidden = true;
      }
    },
  });
  await show();
}

// ---- Requests --------------------------------------------------------------------

async function requests(body) {
  const [{ requests: rows }, attached] = await Promise.all([
    api('/admin/requests'),
    api('/admin/recipes').then((r) => r.recipes).catch(() => []),
  ]);
  const STATUS = { ready: 'Arabic ready', partial: 'Partly translated', none: 'Not started' };
  const byGame = new Map(rows.map((r) => [r.game, r]));
  mount(body, html`
    <h2 class="admin-board-head">${icon('star')} ${t('Most requested games')}</h2>
    <p class="muted small">${t('Every game players asked Arabic for: community-boosted games first, then most votes. Players upvote the ones still without Arabic on the Arabic requests page.')}</p>
    ${rows.length
      ? html`<div class="admin-table">${rows.map((r, i) => html`
          <div class="admin-row admin-request">
            <div><strong><span class="admin-rank">#${i + 1}</span> ${bdi(r.name || r.game)}</strong> <span class="muted small">${r.game}${r.reason ? html` · ${t(r.reason)}` : ''}</span>
              ${r.fingerprint ? folderPrint(r.fingerprint) : ''}</div>
            <span>${r.requests === 1 ? t('1 vote') : t('{count} votes', { count: r.requests })}${r.boosts ? html` · <span class="boost-badge">${(r.boosts === 1 ? t('Community boosted (1 boost)') : t('Community boosted ({n} boosts)', { n: r.boosts }))}</span>` : ''}</span>
            <span class="muted small">${r.answered ? html`<span class="ready-tag">${icon('check')} ${t(r.answered === 'key' ? 'Ready · key attached' : 'Ready · recipe attached')}</span> ` : r.recipe ? html`<span class="recipe-tag">${t('Engine recipe attached')}</span> ` : ''}${r.pending ? t('Waiting for approval') : t(STATUS[r.status])}${r.total ? ` · ${r.translated}/${r.total}` : ''}</span>
            <span class="admin-row-actions">
              ${/encrypt/i.test(r.reason || '') ? html`<a class="btn btn-sm btn-quiet" href="#/admin?tab=keys&game=${encodeURIComponent(r.game)}&title=${encodeURIComponent(r.name || '')}">${icon('shield')} ${r.answered === 'key' ? t('Update AES key…') : t('Add AES key…')}</a>` : ''}
              <button class="btn btn-sm btn-quiet" type="button" data-recipe="${r.game}" data-family="${r.fingerprint?.engine?.id || ''}">${r.recipe ? t('Edit engine recipe…') : t('Attach engine recipe…')}</button>
              <button class="btn btn-sm btn-quiet" type="button" data-font-list="${r.game}">${t('Font list…')}</button>
            </span>
          </div>`)}</div>`
      : html`<p class="muted">${t('Nobody has asked for Arabic in a game yet.')}</p>`}
    <section class="panel" id="recipe-editor" hidden>
      <h2>${t('Engine recipe')} <span class="muted small" id="recipe-game" dir="ltr"></span></h2>
      <p class="muted small">${t('For a game whose text is packed in its own archives: which allowlisted tool takes the text out, which files hold the English, and how the Arabic goes back in. Paths start with {game}, {work}, {extracted}, {edited}, {script} or {font}. It\'s signed with GameShelf\'s pack key in the desktop app, and every player\'s app checks that signature before it runs it.')}</p>
      <textarea class="input recipe-text" id="recipe-text" dir="ltr" spellcheck="false" rows="22"></textarea>
      <div class="recipe-actions">
        ${desktop?.attachRecipe
          ? html`<button class="btn btn-primary" type="button" id="recipe-attach">${icon('check')} ${t('Sign & attach')}</button>`
          : html`<p class="muted small">${t('Open the Admin Panel in the GameShelf desktop app to sign and attach recipes.')}</p>`}
        <button class="btn btn-quiet" type="button" id="recipe-remove">${t('Remove recipe')}</button>
        <button class="btn btn-quiet" type="button" id="recipe-cancel">${t('Close')}</button>
      </div>
    </section>
    ${attached.filter((a) => !byGame.has(a.game)).length ? html`
      <section class="panel">
        <h2>${t('Engine recipes')}</h2>
        <div class="admin-table">${attached.filter((a) => !byGame.has(a.game)).map((a) => html`
          <div class="admin-row">
            <div><strong dir="ltr">${a.game}</strong> <span class="muted small">${a.engine}${a.tool ? ` · ${a.tool}` : ''}</span></div>
            <span class="muted small">${a.attachedBy || ''}</span>
            <span class="muted small">${a.updatedAt}</span>
            <button class="btn btn-sm btn-quiet" type="button" data-recipe="${a.game}" data-family="${a.engine}">${t('Edit engine recipe…')}</button>
          </div>`)}</div>
      </section>` : ''}
    <section class="panel">
      <h2>${t('RE Engine font list')}</h2>
      <p class="muted small">${t('Players\' apps find the usual RE Engine fonts by themselves. For a game whose fonts they miss, upload its file list (the .list from REE.PAK.Tool, free on GitHub): you don\'t need the game.')}</p>
      <form class="font-list-form" id="font-list-form">
        <input class="input" name="game" placeholder="steam:1173690" dir="ltr" required pattern="(steam:[0-9]+|game:[a-z0-9-]+)">
        <input type="file" name="list" accept=".list,.txt" required>
        <button class="btn btn-light" type="submit">${icon('upload')} ${t('Upload')}</button>
      </form>
    </section>`);
  const form = document.getElementById('font-list-form');
  const editor = document.getElementById('recipe-editor');
  const text = document.getElementById('recipe-text');
  let editing = null;

  async function openRecipe(game, family) {
    editing = game;
    document.getElementById('recipe-game').textContent = game;
    text.value = '';
    editor.hidden = false;
    try {
      const { recipe } = await api(`/arabic/recipes/${encodeURIComponent(game)}`);
      text.value = JSON.stringify(JSON.parse(recipe), null, 2);
    } catch (err) {
      if (err.status !== 404) toast(errorText(err), { error: true });
      text.value = desktop?.recipeTemplate ? await desktop.recipeTemplate(game, family || null) : '';
    }
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    text.focus();
  }

  body.addEventListener('click', async (e) => {
    const recipe = e.target.closest('[data-recipe]');
    if (recipe) {
      openRecipe(recipe.dataset.recipe, recipe.dataset.family);
      return;
    }
    const button = e.target.closest('[data-font-list]');
    if (!button) return;
    form.game.value = button.dataset.fontList;
    form.list.click();
  });
  document.getElementById('recipe-cancel').addEventListener('click', () => {
    editor.hidden = true;
    editing = null;
  });
  document.getElementById('recipe-attach')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      await desktop.attachRecipe(editing, text.value);
      toast(t('Engine recipe signed and attached. Players\' apps can now make this game\'s Arabic natively.'));
      await requests(body);
    } catch (err) {
      toast(errorText(err), { error: true });
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('recipe-remove').addEventListener('click', async () => {
    if (!editing || !window.confirm(t('Remove the engine recipe for {game}?', { game: editing }))) return;
    try {
      await api(`/admin/recipes/${encodeURIComponent(editing)}`, { method: 'DELETE' });
      toast(t('Engine recipe removed.'));
      await requests(body);
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = form.list.files[0];
    if (!file) return;
    try {
      const { fontTargets } = await upload(`/api/admin/games/${encodeURIComponent(form.game.value.trim())}/file-list`, file, { method: 'PUT', type: 'text/plain' });
      toast(t('Saved {count} font names for {game}.', { count: fontTargets.length, game: form.game.value.trim() }));
      form.reset();
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  });
}

/** What a player's app saw in the game's folder: engine, file kinds and sizes, folders (for writing its engine recipe). */
function folderPrint(print) {
  const files = print.files === 1 ? t('1 file') : t('{count} files', { count: print.files.toLocaleString() });
  return html`
    <details class="folder-print">
      <summary class="small">${t('Game folder')}: ${print.engine ? html`<strong>${bdi(print.engine.name)}</strong> · ` : ''}${files}, <span dir="ltr">${formatSize(print.bytes || 0)}${print.truncated ? ' +' : ''}</span></summary>
      <div class="folder-print-body" dir="ltr">
        <table class="folder-print-kinds">
          ${print.extensions.slice(0, 14).map((e) => html`<tr><td>${e.ext}</td><td>${e.count.toLocaleString()}</td><td>${formatSize(e.bytes)}</td></tr>`)}
        </table>
        <ul class="folder-print-tree">
          ${print.folders.slice(0, 40).map((f) => html`<li>${f}</li>`)}
          ${print.top.files.slice(0, 20).map((f) => html`<li class="muted">${f}</li>`)}
        </ul>
      </div>
    </details>`;
}

// ---- Translation fixes: players' better Arabic for a line --------------------------------

async function fixes(body) {
  const { fixes: list, published } = await api('/admin/fixes');
  const groups = new Map();
  for (const fix of list) groups.set(fix.game, [...(groups.get(fix.game) || []), fix]);
  const publish = (game) => html`
    <p class="muted small fix-publish" data-publish="${game}" ${published[game] ? '' : 'hidden'}>
      ${t('This game\'s approved Arabic is in the catalog: fixes you approve reach players once it\'s signed again.')}
      ${desktop?.republishArabic
        ? html`<button class="btn btn-sm btn-light" type="button" data-republish="${game}">${icon('shield')} ${t('Sign & publish fixes')}</button>`
        : t('Open the Admin Panel in the GameShelf desktop app to sign it.')}
    </p>`;
  mount(body, html`
    <p class="muted small">${t('Players\' suggestions for lines that read wrong. Approving one puts it in the shared translations as reviewed Arabic, so every new build has it.')}</p>
    ${groups.size ? [...groups].map(([game, items]) => html`
      <section class="panel fix-group">
        <h2>${bdi(items[0].name)} <span class="muted small" dir="ltr">${game}</span></h2>
        ${publish(game)}
        <div class="fix-list">${items.map((f) => html`
          <div class="fix-row" data-fix="${f.id}" data-game="${game}">
            <div class="fix-english" dir="ltr">${f.english}</div>
            <div class="fix-current" dir="rtl" lang="ar"><span class="muted small">${t('In the game now')}:</span> ${f.current || '—'}</div>
            <textarea class="input fix-suggestion" dir="rtl" lang="ar" rows="2" aria-label="${t('Better Arabic')}">${f.suggestion}</textarea>
            <div class="muted small">${f.reporter ? t('from {user}', { user: `@${f.reporter}` }) : ''}${f.reports > 1 ? ` · ${t('{count} players reported this line', { count: f.reports })}` : ''}${f.note ? html` · <bdi>${f.note}</bdi>` : ''}</div>
            <div class="fix-actions">
              <button class="btn btn-sm btn-light" type="button" data-approve="${f.id}">${icon('check')} ${t('Approve')}</button>
              <button class="btn btn-sm btn-quiet" type="button" data-reject="${f.id}">${t('Turn down')}</button>
            </div>
          </div>`)}</div>
      </section>`) : html`<p class="muted">${t('No translation issues reported right now.')}</p>`}`);

  body.addEventListener('click', async (e) => {
    const approve = e.target.closest('[data-approve]');
    const reject = e.target.closest('[data-reject]');
    const republish = e.target.closest('[data-republish]');
    try {
      if (approve || reject) {
        const row = (approve || reject).closest('.fix-row');
        const id = encodeURIComponent((approve || reject).dataset.approve || (approve || reject).dataset.reject);
        if (approve) {
          const { republish: needs } = await api(`/admin/fixes/${id}/approve`, { method: 'POST', body: { arabic: row.querySelector('.fix-suggestion').value } });
          if (needs) body.querySelector(`[data-publish="${CSS.escape(row.dataset.game)}"]`)?.removeAttribute('hidden');
          toast(needs ? t('Approved. Sign & publish the game\'s Arabic to send it to players.') : t('Approved: every new build of this game has it.'));
        } else {
          await api(`/admin/fixes/${id}/reject`, { method: 'POST', body: {} });
          toast(t('Turned down.'));
        }
        row.remove();
      } else if (republish) {
        republish.disabled = true;
        const pack = await desktop.republishArabic(republish.dataset.republish);
        toast(t('Published version {version}: every player gets the fixes the next time they play.', { version: pack.version }));
        republish.closest('[data-publish]')?.setAttribute('hidden', '');
      }
    } catch (err) {
      toast(errorText(err), { error: true });
      if (republish) republish.disabled = false;
    }
  });
}

// ---- Pending approvals: Arabic made on players' PCs ------------------------------------

async function approvals(body, params) {
  const id = params.get('id');
  if (id) return review(body, id);
  const { submissions } = await api('/admin/submissions');
  const STATUS = { pending: 'Waiting for approval', approved: 'Approved', rejected: 'Turned down' };
  mount(body, submissions.length
    ? html`<div class="admin-table">${submissions.map((s) => html`
        <div class="admin-row ${s.status === 'pending' ? '' : 'is-off'}">
          <div><strong>${bdi(s.name || s.game)}</strong>
            <span class="muted small">${s.game} · ${t(ENGINE_LABELS[s.engine] || s.engine)} · ${t('{n} lines', { n: s.total })}${s.fontTargets.length ? ` · ${t('{n} fonts', { n: s.fontTargets.length })}` : ''}</span></div>
          <span class="muted small">${s.submittedBy ? bdi(`@${s.submittedBy}`) : ''}</span>
          <span class="role-tag ${s.status === 'pending' ? 'admin' : ''}">${t(STATUS[s.status])}</span>
          <a class="btn btn-sm btn-quiet" href="#/admin?tab=approvals&id=${s.id}">${t(s.status === 'pending' ? 'Review' : 'Open')}</a>
        </div>`)}</div>`
    : html`<p class="muted">${t('Nothing is waiting. When a player makes Arabic for a game, it shows up here for you to check and approve.')}</p>`);
}

async function review(body, id) {
  const ui = { offset: 0, query: '', missing: false, edits: new Map() };
  const load = () => api(`/admin/submissions/${encodeURIComponent(id)}?offset=${ui.offset}&limit=100&q=${encodeURIComponent(ui.query)}${ui.missing ? '&missing=1' : ''}`);
  let page = await load();
  const s = page.submission;
  const pending = s.status === 'pending';

  const problems = new Map(); // hash → why the server refused that line's Arabic
  const rows = (lines) => lines.map((l) => html`
    <div class="review-row ${problems.has(l.hash) ? 'has-problem' : ''}" data-row="${l.hash}">
      <div class="review-en" dir="ltr">${l.english}</div>
      <textarea class="input review-ar" dir="rtl" lang="ar" data-hash="${l.hash}" rows="2" ${pending ? '' : 'readonly'} placeholder="${t('No Arabic yet')}">${ui.edits.get(l.hash) ?? l.arabic ?? ''}</textarea>
      <p class="review-problem" dir="ltr" ${problems.has(l.hash) ? '' : 'hidden'}>${problems.get(l.hash) || ''}</p>
    </div>`);
  // Marks the refused lines on the page (or clears the marks) and goes to the first one.
  const markProblems = (list = []) => {
    problems.clear();
    for (const p of list) problems.set(p.hash, `${t('Can\'t be used:')} ${p.problem}. ${t('Copy the tags and line breaks exactly as in the English.')}`);
    document.querySelectorAll('[data-row]').forEach((row) => {
      const why = problems.get(row.dataset.row);
      row.classList.toggle('has-problem', Boolean(why));
      const note = row.querySelector('.review-problem');
      note.hidden = !why;
      note.textContent = why || '';
    });
    document.querySelector('.review-row.has-problem')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  mount(body, html`
    <p><a href="#/admin?tab=approvals">${t('← Pending approvals')}</a></p>
    <section class="panel review-head">
      <div>
        <h2>${bdi(s.name || s.game)}</h2>
        <p class="muted small">${s.game} · ${t(ENGINE_LABELS[s.engine] || s.engine)} · ${s.submittedBy ? t('from {user}', { user: `@${s.submittedBy}` }) : ''}</p>
        <p>${t('{translated} of {total} lines have Arabic.', { translated: s.translated, total: s.total })}
          ${s.fontTargets.length ? t('{n} game fonts get the Arabic font.', { n: s.fontTargets.length }) : ''}</p>
        <label class="small review-font">${t('Arabic font for this game')}
          <select class="input" id="review-font">
            ${[['plex', 'IBM Plex Sans Arabic (clear, the default)'], ['cairo', 'Cairo (modern, for HUDs and menus)'], ['naskh', 'Noto Naskh Arabic (classic, for story games)']]
              .map(([value, label]) => html`<option value="${value}" ${(s.fontStyle || 'plex') === value ? 'selected' : ''}>${t(label)}</option>`)}
          </select>
        </label>
      </div>
      ${pending ? html`
        <div class="review-actions">
          ${desktop?.approveSubmission
            ? html`<button class="btn btn-light" type="button" id="approve">${icon('shield')} ${t('Approve, Sign & Publish')}</button>`
            : html`<p class="muted small">${t('Approving signs the Arabic with GameShelf\'s key, which stays on your PC: open this page in GameShelf for Windows.')}</p>`}
          <button class="btn btn-quiet" type="button" id="reject">${t('Turn down')}</button>
        </div>` : html`<span class="role-tag">${t(s.status === 'approved' ? 'Approved' : 'Turned down')}</span>`}
    </section>
    <section class="panel glossary-panel">
      <h3>${t('Glossary')}</h3>
      <p class="muted small">${t('Names and game terms every translation batch keeps the same, and how the game speaks to the player. GameShelf makes it before translating a game; what you fix here stays, and only new terms get added.')}</p>
      <label class="small">${t('The player character')}
        <select class="input" id="glossary-gender">
          <option value="unknown">${t('Not known (masculine, the usual default)')}</option>
          <option value="masculine">${t('Male (أنتَ)')}</option>
          <option value="feminine">${t('Female (أنتِ)')}</option>
        </select>
      </label>
      <label class="small">${t('Names and terms, one per line: English = Arabic')}
        <textarea class="input glossary-terms" id="glossary-terms" rows="8" dir="auto" placeholder="Kratos = كريتوس"></textarea>
      </label>
      <button class="btn btn-light" type="button" id="glossary-save">${t('Save glossary')}</button>
    </section>
    <form class="search-bar" id="review-search" role="search">
      <label class="search-field">${icon('search')}<input type="search" name="q" placeholder="${t('Find a line (English or Arabic)')}" aria-label="${t('Find a line (English or Arabic)')}"></label>
      <label class="check-row small"><input type="checkbox" name="missing"> ${t('Only lines without Arabic')}</label>
    </form>
    <div class="review-list" id="review-list"></div>
    <div class="settings-actions">
      <button class="btn btn-quiet" type="button" id="more" hidden>${t('Show more')}</button>
      ${pending ? html`<button class="btn btn-light" type="button" id="save" disabled>${t('Save changes')}</button>` : ''}
    </div>`);

  const gender = document.getElementById('glossary-gender');
  const terms = document.getElementById('glossary-terms');
  api(`/admin/glossaries/${encodeURIComponent(s.game)}`).then(({ glossary }) => {
    if (!glossary) return;
    gender.value = glossary.player?.gender || 'unknown';
    terms.value = Object.entries(glossary.terms || {}).map(([en, ar]) => `${en} = ${ar}`).join('\n');
  }).catch(() => {});
  document.getElementById('glossary-save').addEventListener('click', async () => {
    const entries = terms.value.split('\n').map((line) => line.split(' = ')).filter((parts) => parts.length >= 2 && parts[0].trim());
    try {
      const { glossary } = await api(`/admin/glossaries/${encodeURIComponent(s.game)}`, {
        method: 'PUT', body: { terms: Object.fromEntries(entries.map(([en, ...ar]) => [en.trim(), ar.join(' = ').trim()])), player: { gender: gender.value } },
      });
      toast(t('Glossary saved: {count} names and terms. New translations of this game follow it.', { count: Object.keys(glossary.terms).length }));
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  });
  document.getElementById('review-font').addEventListener('change', async (e) => {
    try {
      await api(`/admin/games/${encodeURIComponent(s.game)}/font-style`, { method: 'PUT', body: { fontStyle: e.target.value === 'plex' ? null : e.target.value } });
      toast(t('Saved. Players\' apps make this game\'s Arabic with that font, unless a player picks another.'));
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  });
  const list = document.getElementById('review-list');
  const more = document.getElementById('more');
  const save = document.getElementById('save');
  const show = (append) => {
    const box = document.createElement('div');
    mount(box, html`${rows(page.lines)}`);
    if (!append) list.replaceChildren();
    list.append(...box.children);
    more.hidden = ui.offset + page.lines.length >= page.matching;
  };
  show(false);

  list.addEventListener('input', (e) => {
    const area = e.target.closest('[data-hash]');
    if (!area) return;
    ui.edits.set(area.dataset.hash, area.value);
    if (save) save.disabled = false;
    // Edited again: its red mark goes until the next save checks it.
    const row = area.closest('[data-row]');
    if (row?.classList.contains('has-problem')) {
      row.classList.remove('has-problem');
      row.querySelector('.review-problem').hidden = true;
      problems.delete(row.dataset.row);
    }
  });
  more.addEventListener('click', async () => {
    ui.offset += 100;
    page = await load();
    show(true);
  });
  const search = document.getElementById('review-search');
  search.addEventListener('submit', (e) => e.preventDefault());
  search.addEventListener('input', async () => {
    ui.query = search.q.value.trim();
    ui.missing = search.missing.checked;
    ui.offset = 0;
    page = await load();
    show(false);
  });
  save?.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const edits = [...ui.edits].map(([hash, arabic]) => ({ hash, arabic }));
      const { saved } = await api(`/admin/submissions/${encodeURIComponent(id)}/lines`, { method: 'PATCH', body: { edits } });
      ui.edits.clear();
      markProblems([]);
      toast(t('Saved {count} lines. Every player gets them.', { count: saved }));
    } catch (err) {
      markProblems(err.data?.problems || []);
      toast(errorText(err), { error: true });
      save.disabled = false;
    }
  });
  document.getElementById('approve')?.addEventListener('click', async (e) => {
    if (ui.edits.size) return toast(t('Save your changes first.'), { error: true });
    const button = e.currentTarget;
    button.disabled = true;
    try {
      const pack = await desktop.approveSubmission(id);
      toast(t('Published {name} {version}: players get it the next time they turn Arabic on.', { name: pack.title || pack.id, version: pack.version }));
      location.hash = '#/admin?tab=approvals';
    } catch (err) {
      toast(errorText(err), { error: true });
      button.disabled = false;
    }
  });
  document.getElementById('reject')?.addEventListener('click', async () => {
    const note = prompt(t('Why? (the note stays in the Admin Panel)')) ?? null;
    if (note === null) return;
    try {
      await api(`/admin/submissions/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { note } });
      location.hash = '#/admin?tab=approvals';
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  });
}

// ---- Supporters & codes ------------------------------------------------------------

const shortDate = (ms) => new Date(ms).toLocaleDateString();

async function supporters(body) {
  mount(body, html`
    <p class="free-note">${icon('check')} ${t('Codes and memberships only pay for cloud AI translation, queue priority and extras. Arabic packs stay free for everyone.')}</p>
    <section class="panel">
      <h2>${t('Make prepaid / gift codes')}</h2>
      <p class="muted small">${t('Each code gives GameShelf Supporter for the days you choose and works once. Codes are shown only now: GameShelf keeps just a fingerprint of each. Sell them through Ziina, Tabby or Stripe payment links, or give them away.')}</p>
      <form class="inline-form" id="code-form">
        <label>${t('How many')} <input class="input" type="number" name="count" min="1" max="500" value="10" required></label>
        <label>${t('Days each')} <input class="input" type="number" name="days" min="1" max="3660" value="30" required></label>
        <label>${t('Note (only admins see it)')} <input class="input" name="note" maxlength="120" placeholder="${t('e.g. Ziina monthly, March')}"></label>
        <button class="btn btn-accent" type="submit">${t('Make codes')}</button>
      </form>
      <div id="new-codes"></div>
    </section>
    <section class="panel">
      <h2>${t('Give Supporter to a player')}</h2>
      <form class="inline-form" id="grant-form">
        <label>${t('Username')} <input class="input" name="username" required autocomplete="off" dir="ltr"></label>
        <label>${t('Days')} <input class="input" type="number" name="days" min="1" max="3660" value="30" required></label>
        <button class="btn" type="submit">${t('Give')}</button>
      </form>
    </section>
    <section class="panel"><h2>${t('Code batches')}</h2><div id="batch-list"></div></section>
    <section class="panel"><h2>${t('Supporters')}</h2><div id="supporter-list"></div></section>`);

  const show = async () => {
    const { batches, supporters: people } = await api('/admin/plans');
    mount(document.getElementById('batch-list'), batches.length
      ? html`<div class="admin-table">${batches.map((b) => html`
          <div class="admin-row">
            <div><strong>${b.note || t('No note')}</strong> <span class="muted small" dir="ltr">${b.batch}</span></div>
            <span class="muted small">${t('{days} days', { days: b.days })} · ${shortDate(b.createdAt)}</span>
            <span class="muted small">${t('{used} of {n} used', { used: b.redeemed, n: b.codes })}${b.revoked ? ` · ${t('{n} revoked', { n: b.revoked })}` : ''}</span>
            ${b.revoked < b.codes - b.redeemed ? html`<button class="btn btn-sm btn-quiet" type="button" data-revoke="${b.batch}">${t('Revoke unused')}</button>` : html`<span></span>`}
          </div>`)}</div>`
      : html`<p class="muted">${t('No codes yet.')}</p>`);
    mount(document.getElementById('supporter-list'), people.length
      ? html`<div class="admin-table">${people.map((p) => html`
          <div class="admin-row">
            <div><strong>${bdi(p.displayName)}</strong> <span class="muted small">${bdi(`@${p.username}`)}</span></div>
            <span class="muted small">${t('Until {date}', { date: shortDate(p.until) })}</span>
            <span class="muted small">${{ stripe: 'Stripe', lemonsqueezy: 'LemonSqueezy', code: t('Prepaid code'), admin: t('Given by an admin') }[p.source] || p.source || ''}</span>
            <span class="supporter-badge">${t('Supporter')}</span>
          </div>`)}</div>`
      : html`<p class="muted">${t('No supporters yet.')}</p>`);
  };

  document.getElementById('code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const button = f.querySelector('button');
    button.disabled = true;
    try {
      const made = await api('/admin/plans/codes', { method: 'POST', body: { count: Number(f.count.value), days: Number(f.days.value), note: f.note.value } });
      const text = made.codes.join('\n');
      const file = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
      onLeave(() => URL.revokeObjectURL(file));
      mount(document.getElementById('new-codes'), html`
        <div class="new-codes">
          <p class="form-error">${t('Copy or download these now. They won\'t be shown again.')}</p>
          <textarea class="input code-dump" readonly rows="${Math.min(12, made.codes.length)}" dir="ltr">${text}</textarea>
          <div class="row-actions">
            <button class="btn btn-sm" type="button" id="copy-codes">${icon('link')} ${t('Copy')}</button>
            <a class="btn btn-sm btn-quiet" href="${file}" download="gameshelf-codes-${made.batch}.txt">${icon('download')} ${t('Download .txt')}</a>
          </div>
        </div>`);
      document.getElementById('copy-codes').addEventListener('click', () => navigator.clipboard.writeText(text).then(() => toast(t('Copied'))));
      await show();
    } catch (err) {
      toast(errorText(err), { error: true });
    }
    button.disabled = false;
  });

  document.getElementById('grant-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/admin/plans/grant', { method: 'POST', body: { username: f.username.value, days: Number(f.days.value) } });
      toast(t('{name} is a GameShelf Supporter for {days} more days.', { name: f.username.value, days: f.days.value }));
      f.username.value = '';
      await show();
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  });

  body.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-revoke]');
    if (!button || !confirm(t('Revoke every unused code in this batch? Codes already redeemed keep working.'))) return;
    button.disabled = true;
    try {
      const done = await api(`/admin/plans/codes/${encodeURIComponent(button.dataset.revoke)}/revoke`, { method: 'POST' });
      toast(t('{n} codes revoked', { n: done.revoked }));
      await show();
    } catch (err) {
      toast(errorText(err), { error: true });
      button.disabled = false;
    }
  });
  await show();
}

// ---- Windows installer -------------------------------------------------------------

async function installer(body) {
  const info = await api('/download/info');
  mount(body, html`
    <section class="panel">
      <h2>${t('The Windows app')}</h2>
      <p class="muted">${info.available
        ? (info.size ? t('The website\'s download button hands out the installer below ({size}).', { size: formatSize(info.size) }) : t('The download button sends people to DOWNLOAD_URL.'))
        : t('There\'s no installer yet: the website\'s download button says it\'s coming soon.')}</p>
      ${info.available ? html`<p><a class="pill-btn" href="/download/windows">${icon('download')} ${t('Download it')}</a></p>` : ''}
      <div class="drop-zone" id="exe-drop" tabindex="0" role="button" aria-label="${t('Drop GameShelf-Setup.exe here, or click to choose it')}">
        ${icon('upload')}
        <strong>${t('Drop GameShelf-Setup.exe here, or click to choose it')}</strong>
        <span class="muted small">${t('Made with npm run dist:win (it\'s in the dist folder). It replaces the one the website hands out.')}</span>
        <input type="file" accept=".exe" hidden>
        <div class="upload-bar" hidden><span></span></div>
      </div>
    </section>`);
  const zone = document.getElementById('exe-drop');
  const bar = zone.querySelector('.upload-bar');
  dropZone(zone, {
    accept: /\.exe$/i,
    onFile: async (file) => {
      bar.hidden = false;
      try {
        await upload('/api/admin/installer', file, { method: 'PUT', onProgress: (p) => bar.firstElementChild.style.setProperty('width', `${Math.round(p * 100)}%`) });
        toast(t('The new installer is up.'));
        installer(body);
      } catch (err) {
        toast(errorText(err), { error: true });
        bar.hidden = true;
      }
    },
  });
}

// ---- Pack Studio (desktop app) ---------------------------------------------------------

async function studio(body) {
  const s = await desktop.studio.settings();
  const saved = JSON.parse(sessionStorage.getItem('gs-studio') || '{}');
  const form = { engine: 'auto', translate: 'shared', ...saved };
  const path = (name, value, kind, label) => html`
    <div class="path-field">
      <span class="path-value" id="${name}-value" dir="ltr">${value || t('Not chosen')}</span>
      <button class="btn btn-sm btn-quiet" type="button" data-pick="${kind}" data-into="${name}">${label}</button>
    </div>`;
  mount(body, html`
    <section class="panel studio">
      <h2>${t('1. The game')}</h2>
      <div class="studio-source">
        ${path('source', form.source, 'folder', t('Choose game folder'))}
        <button class="btn btn-sm btn-quiet" type="button" data-pick="file" data-into="source">${t('…or a file with its text')}</button>
      </div>
      <div class="form-grid">
        <label>${t('Engine')}<select class="input" name="engine">${s.engines.map((e) => html`<option value="${e}" ${form.engine === e ? 'selected' : ''}>${t(ENGINE_LABELS[e])}</option>`)}</select></label>
        <label>${t('Title')}<input class="input" name="title" value="${form.title || ''}" placeholder="Resident Evil 3 Demo"></label>
        <label>${t('Steam app ID')}<input class="input" name="steamAppId" inputmode="numeric" value="${form.steamAppId || ''}" placeholder="1173690"></label>
        <label>${t('…or GameShelf game ID')}<input class="input" name="gameId" value="${form.gameId || ''}"></label>
        <label>${t('Pack ID')}<input class="input" name="id" value="${form.id || ''}" placeholder="re3-demo-ar" dir="ltr"></label>
        <label>${t('Version')}<input class="input" name="version" value="${form.version || '1.0.0'}" dir="ltr"></label>
      </div>
      <p class="muted small">${t('RE Engine games: the game\'s file list (from REE.PAK.Tool) tells the Studio which fonts to give the Arabic font.')}</p>
      ${path('pakList', form.pakList, 'list', t('Choose file list'))}

      <h2>${t('2. The Arabic')}</h2>
      <div class="lang-choices" role="radiogroup" aria-label="${t('Translate with')}">
        ${[['shared', 'GameShelf\'s shared memory'], ['provider', 'My own API key'], ['none', 'My checked translations only']].map(([key, label]) => html`
          <button type="button" class="mood-chip ${form.translate === key ? 'active' : ''}" role="radio" aria-checked="${form.translate === key}" data-translate="${key}">${t(label)}</button>`)}
      </div>
      <div class="form-grid" id="provider-fields" ${form.translate === 'provider' ? '' : 'hidden'}>
        <label>${t('Provider')}<select class="input" name="provider">${['openai', 'gemini'].map((p) => html`<option value="${p}" ${s.provider === p ? 'selected' : ''}>${p === 'openai' ? 'OpenAI' : 'Google Gemini'}</option>`)}</select></label>
        <label>${t('Model')}<input class="input" name="model" value="${s.model}" placeholder="gpt-4.1-mini" dir="ltr"></label>
        <label class="full">${t('API key')}<input class="input" name="apiKey" type="password" autocomplete="off" placeholder="${s.hasKey[s.provider] ? t('Saved. Type a new one to replace it.') : 'sk-…'}" dir="ltr"></label>
        <p class="muted small full">${s.keysStoredSafely ? t('Saved on this PC, encrypted by Windows. It\'s only sent to the provider.') : t('Kept until you close GameShelf: this PC can\'t store it encrypted.')}</p>
      </div>
      ${path('reviewed', form.reviewed, 'csv', t('Use my checked translations.csv'))}

      <h2>${t('Unreal Engine 5 extras')}</h2>
      <div class="form-grid">
        <label>${t('Unreal Engine version')}<input class="input" name="ueVersion" value="${form.ueVersion || ''}" placeholder="UE5_7" dir="ltr"></label>
        <label>${t('Colour character names')}<select class="input" name="colorNames">
          ${[['', 'Leave names as they are'], ['auto', 'A colour per character'], ['Character_Yellow_Decorator2', 'Gold'], ['Blue', 'Blue'], ['Character_Red_Decorator2', 'Red'],
            ['Character_Green_Decorator2', 'Green'], ['Character_Purple_Decorator2', 'Purple']].map(([value, label]) => html`<option value="${value}" ${(form.colorNames || '') === value ? 'selected' : ''}>${t(label)}</option>`)}
        </select></label>
        <label>${t('Arabic text weight')}<select class="input" name="fontWeight">
          ${[['regular', 'Regular'], ['medium', 'Medium (for menus that look thin)'], ['semibold', 'SemiBold']]
            .map(([value, label]) => html`<option value="${value}" ${(form.fontWeight || 'regular') === value ? 'selected' : ''}>${t(label)}</option>`)}
        </select></label>
        <label class="check-row"><input type="checkbox" name="credit" ${form.credit ? 'checked' : ''}> ${t('Add «تعريب قيم شلف» under the game\'s copyright notice (main menu)')}</label>
        <label class="check-row"><input type="checkbox" name="colorSpeakers" ${form.colorSpeakers ? 'checked' : ''}> ${t('Also colour the speaker\'s name above subtitles (turn off if tags show as text)')}</label>
        <label class="check-row"><input type="checkbox" name="ltrLayout" ${form.ltrLayout ? 'checked' : ''}> ${t('Keep Arabic where the game puts English (for text that ends up against the far edge of the screen)')}</label>
        <label class="check-row"><input type="checkbox" name="arabicLanguage" ${form.arabicLanguage ? 'checked' : ''}> ${t('Add Arabic as its own language (an "ar" culture, and an Arabic style in every row of the game\'s style tables)')}</label>
      </div>
      <p class="muted small">${t('GameShelf takes the style tables out of the game\'s containers itself. Or give the folder you took them out to with retoc to-legacy:')}</p>
      ${path('uiAssets', form.uiAssets, 'ui-folder', t('Choose style tables folder'))}
      <p class="muted small">${t('Arabic title logo: a PNG with a transparent background. Where the game\'s logo is a video (the intro and main menu), GameShelf makes it again with your logo, at the game\'s size, place and timing.')}</p>
      ${path('logoImage', form.logoImage, 'logo-image', t('Choose title logo image'))}
      <p class="muted small">${t('Or a logo texture you cooked in the Unreal Editor for the game\'s engine version, at its path inside the game (<Project>/Content/...):')}</p>
      ${path('logoAssets', form.logoAssets, 'logo-folder', t('Choose title logo folder'))}

      <h2>${t('3. Sign and build')}</h2>
      <div class="studio-key ${s.keyMatchesApp ? 'ok' : 'warn'}">
        ${path('keyFile', s.keyFile, 'key', t('Choose pack-signing.key'))}
        <p class="small">${!s.keyFile
          ? t('Packs are signed with GameShelf\'s private key (pack-signing.key), kept only on admins\' PCs.')
          : !s.keyOk ? t('That file isn\'t a signing key.')
            : s.keyMatchesApp ? t('This is GameShelf\'s key: players\' apps will accept these packs.')
              : t('This key isn\'t the one players\' apps check with (localizationPackKey in desktop/config.json), so they won\'t accept its packs.')}</p>
        <button class="btn btn-sm btn-quiet" type="button" id="make-keys">${t('Make a new key pair')}</button>
      </div>
      <div class="settings-actions">
        <button class="btn btn-light" type="button" id="build" ${s.canBuild ? '' : 'disabled'}>${t('Build pack')}</button>
        <button class="btn btn-quiet" type="button" id="cancel" hidden>${t('Stop')}</button>
      </div>
      ${s.canBuild ? '' : html`<p class="form-error">${t('This copy of GameShelf has no pack builder.')}</p>`}
      <div class="studio-progress" id="studio-progress" hidden><span></span></div>
      <pre class="studio-log" id="studio-log" dir="ltr" aria-live="polite"></pre>
      <div class="studio-result" id="studio-result" hidden></div>
    </section>`);

  const read = () => {
    const values = Object.fromEntries([...body.querySelectorAll('input[name], select[name]')].map((el) => [el.name, el.value.trim()]));
    for (const name of ['source', 'pakList', 'reviewed', 'uiAssets', 'logoAssets', 'logoImage']) values[name] = form[name] || '';
    values.arabicLanguage = Boolean(body.querySelector('input[name="arabicLanguage"]')?.checked);
    values.ltrLayout = Boolean(body.querySelector('input[name="ltrLayout"]')?.checked);
    values.colorSpeakers = Boolean(body.querySelector('input[name="colorSpeakers"]')?.checked);
    values.credit = Boolean(body.querySelector('input[name="credit"]')?.checked);
    return { ...form, ...values };
  };
  const remember = () => {
    const { apiKey, ...rest } = read();
    sessionStorage.setItem('gs-studio', JSON.stringify(rest));
  };
  body.addEventListener('input', remember);

  body.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-pick]');
    const choice = e.target.closest('[data-translate]');
    if (choice) {
      form.translate = choice.dataset.translate;
      body.querySelectorAll('[data-translate]').forEach((b) => {
        b.classList.toggle('active', b === choice);
        b.setAttribute('aria-checked', String(b === choice));
      });
      document.getElementById('provider-fields').hidden = form.translate !== 'provider';
      remember();
    }
    if (!pick) return;
    try {
      const chosen = await desktop.studio.pick(pick.dataset.pick);
      if (!chosen) return;
      if (pick.dataset.into === 'keyFile') {
        await desktop.studio.saveSettings({ keyFile: chosen });
        return studio(body);
      }
      form[pick.dataset.into] = chosen;
      document.getElementById(`${pick.dataset.into}-value`).textContent = chosen;
      remember();
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  });

  document.getElementById('make-keys').addEventListener('click', async () => {
    try {
      const folder = await desktop.studio.pick('keys-folder');
      if (!folder) return;
      const made = await desktop.studio.makeKeys(folder);
      await navigator.clipboard?.writeText(made.publicKey).catch(() => {});
      toast(t('New key pair made. Its public key is on the clipboard: put it in desktop/config.json as localizationPackKey, then build the app again.'));
      studio(body);
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  });

  const log = document.getElementById('studio-log');
  const progress = document.getElementById('studio-progress');
  const result = document.getElementById('studio-result');
  const stopLog = desktop.studio.onLog(({ line, stream }) => {
    const row = document.createElement('div');
    row.textContent = line;
    if (stream === 'stderr') row.className = 'is-error';
    log.append(row);
    log.scrollTop = log.scrollHeight;
  });
  const stopProgress = desktop.studio.onProgress((p) => {
    const share = p.phase === 'translating' && p.asking ? p.asked / p.asking : { reading: 0.15, packing: 0.9, done: 1 }[p.phase] || 0.05;
    progress.firstElementChild.style.setProperty('width', `${Math.round(share * 100)}%`);
  });
  onLeave(stopLog);
  onLeave(stopProgress);

  const cancel = document.getElementById('cancel');
  cancel.addEventListener('click', () => desktop.studio.cancel());
  document.getElementById('build').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const options = read();
    try {
      if (options.translate === 'provider') {
        await desktop.studio.saveSettings({ provider: options.provider, model: options.model, ...(options.apiKey ? { apiKey: options.apiKey } : {}) });
        body.querySelector('input[name=apiKey]').value = '';
      }
    } catch (err) {
      return toast(errorText(err), { error: true });
    }
    delete options.apiKey;
    button.disabled = true;
    cancel.hidden = false;
    progress.hidden = false;
    result.hidden = true;
    log.textContent = '';
    try {
      const built = await desktop.studio.build(options);
      result.hidden = false;
      mount(result, html`
        <p><strong>${t('Pack ready:')}</strong> <span dir="ltr">${options.id} ${options.version}</span></p>
        <div class="settings-actions">
          <button class="btn btn-light" type="button" data-step="publish">${icon('upload')} ${t('Publish to Cloud Catalog')}</button>
          <button class="btn btn-quiet" type="button" data-step="add">${t('Add to this PC')}</button>
          <button class="btn btn-quiet" type="button" data-step="review">${t('Open translations.csv')}</button>
          <button class="btn btn-quiet" type="button" data-step="folder">${t('Open folder')}</button>
        </div>
        <p class="muted small">${t('Fix lines in translations.csv, save it, pick it under "Use my checked translations.csv", choose "My checked translations only" and build again with a new version.')}</p>`);
      result.onclick = async (ev) => {
        const step = ev.target.closest('[data-step]')?.dataset.step;
        if (!step) return;
        try {
          if (step === 'publish') {
            const pack = await desktop.studio.publish(built.packDir);
            toast(t('Published {name} {version}: players get it the next time they turn Arabic on.', { name: pack.title || pack.id, version: pack.version }));
          } else if (step === 'add') {
            const added = await desktop.studio.addLocal(built.packDir);
            toast(t('Added {name}', { name: added.title || added.id }));
          } else if (step === 'review') {
            await desktop.studio.open(built.review);
          } else {
            await desktop.studio.open(built.outDir);
          }
        } catch (err) {
          toast(errorText(err), { error: true });
        }
      };
    } catch (err) {
      toast(errorText(err), { error: true });
    } finally {
      button.disabled = false;
      cancel.hidden = true;
    }
  });
}
