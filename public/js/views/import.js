// Import a Steam library: paste a profile link, review the matches, import.
import { html, bdi, th, api, mount, state, toast, STATUS_LABELS, profileHref } from '../lib.js';
import { formatHours } from '../components.js';
import { t, tn, locale } from '../i18n.js';

function setupHelp() {
  return html`
    <div class="panel">
      <h2>${t("Steam import isn't switched on yet")}</h2>
      <p class="muted">${t('Whoever runs this GameShelf server needs to add a free Steam Web API key:')}</p>
      <ol class="steps">
        <li>${th('Sign in at {link} and register a key (any domain name works, e.g. {example}).', { link: html`<a class="text-link" href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener noreferrer">steamcommunity.com/dev/apikey</a>`, example: html`<code>localhost</code>` })}</li>
        <li>${th('Add {setting} to the {file} file in the project folder.', { setting: html`<code>STEAM_API_KEY=your-key</code>`, file: html`<code>.env</code>` })}</li>
        <li>${th('Restart the site with {command}.', { command: html`<code>npm start</code>` })}</li>
      </ol>
    </div>`;
}

export async function importView(app) {
  if (!state.user) {
    location.hash = '#/login';
    return;
  }
  const info = await api('/info');

  mount(app, html`
    <div class="page import">
      <div class="import-intro">
        <h1>${t('Import from Steam')}</h1>
        <p class="muted">${t("Bring in every game you own, with your hours played. You choose what gets added, and nothing you've already rated or sorted gets changed.")}</p>
      </div>
      ${info.steamImport ? html`
        <form class="import-form" id="import-form">
          <input class="input" name="profile" required placeholder="steamcommunity.com/id/yourname" aria-label="${t('Steam profile link')}" autocomplete="off" dir="ltr">
          <button class="btn btn-light" type="submit">${t('Load my games')}</button>
        </form>
        <p class="muted small">${th("Your Steam profile's {details} must be set to Public (Steam → Edit Profile → Privacy Settings).", { details: html`<strong>${t('Game details')}</strong>` })}</p>
        <div id="import-results"></div>` : setupHelp()}
    </div>
  `);

  const form = document.getElementById('import-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    const results = document.getElementById('import-results');
    button.disabled = true;
    button.textContent = t('Loading…');
    mount(results, html`<p class="muted">${t('Reading your library and matching games. Big libraries can take up to a minute.')}</p>`);
    try {
      const preview = await api('/me/import/steam/preview', { method: 'POST', body: { profile: new FormData(form).get('profile') } });
      renderPreview(results, preview);
    } catch (err) {
      mount(results, html`<p class="form-error">${err.message}</p>`);
    } finally {
      button.disabled = false;
      button.textContent = t('Load my games');
    }
  });
}

function renderPreview(el, preview) {
  const matched = preview.items.filter((i) => i.match);
  const unmatched = preview.items.filter((i) => !i.match);
  const statusOptions = (selected) =>
    Object.entries(STATUS_LABELS).map(([v, label]) => html`<option value="${v}" ${v === selected ? html`selected` : ''}>${label}</option>`);

  const rowFor = (item) => {
    if (!item.match) {
      return html`
        <div class="import-row unmatched">
          <input type="checkbox" disabled aria-label="${t('Not available')}">
          <div class="import-thumb"></div>
          <div class="import-name">${bdi(item.name)}<small>${t('Not found in the game database')}</small></div>
          <span class="import-hours">${formatHours(item.playtime)}</span>
          <span></span>
        </div>`;
    }
    const existing = item.existingStatus;
    return html`
      <label class="import-row">
        <input type="checkbox" data-appid="${item.appid}" checked aria-label="${t('Import {name}', { name: item.name })}">
        ${item.match.image ? html`<img src="${item.match.image}" alt="" loading="lazy">` : html`<div class="import-thumb"></div>`}
        <div class="import-name">${bdi(item.match.name)}<small>${existing ? t("Already on your list as {status}. We'll only update hours.", { status: STATUS_LABELS[existing] }) : item.match.genres.slice(0, 2).map((g) => t(g)).join(t(', '))}</small></div>
        <span class="import-hours">${formatHours(item.playtime) || t('Unplayed')}</span>
        <select class="input" data-status-for="${item.appid}" aria-label="${t('Status for {name}', { name: item.name })}" ${existing ? html`disabled` : ''}>
          ${statusOptions(existing || item.suggestedStatus)}
        </select>
      </label>`;
  };

  mount(el, html`
    <div class="import-summary">
      <div>
        <h2>${t('{n} of {total} games matched', { n: matched.length, total: preview.considered })}</h2>
        <p class="muted small">
          ${preview.total > preview.considered ? `${t('You own {total} games; we checked your {n} most-played.', { total: preview.total.toLocaleString(locale), n: preview.considered })} ` : ''}
          ${t('Statuses are guessed from your hours. Change any you like.')}
        </p>
      </div>
      <div class="segmented"><button type="button" id="select-all">${t('Select all')}</button><button type="button" id="select-none">${t('Select none')}</button></div>
    </div>
    <div class="import-list">${matched.map(rowFor)}${unmatched.map(rowFor)}</div>
    <div class="import-bar">
      <span id="import-count"></span>
      <button class="btn btn-accent" type="button" id="import-go">${t('Import')}</button>
    </div>
  `);

  const boxes = [...el.querySelectorAll('input[data-appid]')];
  const update = () => {
    const n = boxes.filter((b) => b.checked).length;
    el.querySelector('#import-count').textContent = t('{games} selected', { games: tn(n, 'game') });
    el.querySelector('#import-go').disabled = n === 0;
  };
  el.addEventListener('change', update);
  el.querySelector('#select-all').addEventListener('click', () => { boxes.forEach((b) => { b.checked = true; }); update(); });
  el.querySelector('#select-none').addEventListener('click', () => { boxes.forEach((b) => { b.checked = false; }); update(); });
  update();

  el.querySelector('#import-go').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    const items = boxes.filter((b) => b.checked).map((b) => {
      const select = el.querySelector(`[data-status-for="${b.dataset.appid}"]`);
      return { appid: Number(b.dataset.appid), status: select.value };
    });
    try {
      const { added, updated } = await api('/me/import/steam/commit', { method: 'POST', body: { previewId: preview.previewId, items } });
      toast(updated
        ? t('Added {games}, updated hours on {updated}', { games: tn(added, 'game'), updated })
        : t('Added {games}', { games: tn(added, 'game') }));
      location.hash = profileHref(state.user.username);
    } catch (err) {
      toast(err.message, { error: true });
      button.disabled = false;
    }
  });
}
