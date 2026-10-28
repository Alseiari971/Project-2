// Import a Steam library: paste a profile link, review the matches, import.
import { html, api, mount, state, toast, STATUS_LABELS, profileHref } from '../lib.js';
import { formatHours } from '../components.js';

function setupHelp() {
  return html`
    <div class="panel">
      <h2>Steam import isn't switched on yet</h2>
      <p class="muted">Whoever runs this GameShelf server needs to add a free Steam Web API key:</p>
      <ol class="steps">
        <li>Sign in at <a class="text-link" href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener noreferrer">steamcommunity.com/dev/apikey</a> and register a key (any domain name works, e.g. <code>localhost</code>).</li>
        <li>Add <code>STEAM_API_KEY=your-key</code> to the <code>.env</code> file in the project folder.</li>
        <li>Restart the site with <code>npm start</code>.</li>
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
        <h1>Import from Steam</h1>
        <p class="muted">Bring in every game you own, with your hours played. You choose what gets added, and nothing you've already rated or sorted gets changed.</p>
      </div>
      ${info.steamImport ? html`
        <form class="import-form" id="import-form">
          <input class="input" name="profile" required placeholder="steamcommunity.com/id/yourname" aria-label="Steam profile link" autocomplete="off">
          <button class="btn btn-light" type="submit">Load my games</button>
        </form>
        <p class="muted small">Your Steam profile's <strong>Game details</strong> must be set to Public (Steam → Edit Profile → Privacy Settings).</p>
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
    button.textContent = 'Loading…';
    mount(results, html`<p class="muted">Reading your library and matching games. Big libraries can take up to a minute.</p>`);
    try {
      const preview = await api('/me/import/steam/preview', { method: 'POST', body: { profile: new FormData(form).get('profile') } });
      renderPreview(results, preview);
    } catch (err) {
      mount(results, html`<p class="form-error">${err.message}</p>`);
    } finally {
      button.disabled = false;
      button.textContent = 'Load my games';
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
          <input type="checkbox" disabled aria-label="Not available">
          <div class="import-thumb"></div>
          <div class="import-name">${item.name}<small>Not found in the game database</small></div>
          <span class="import-hours">${formatHours(item.playtime)}</span>
          <span></span>
        </div>`;
    }
    const existing = item.existingStatus;
    return html`
      <label class="import-row">
        <input type="checkbox" data-appid="${item.appid}" checked aria-label="Import ${item.name}">
        ${item.match.image ? html`<img src="${item.match.image}" alt="" loading="lazy">` : html`<div class="import-thumb"></div>`}
        <div class="import-name">${item.match.name}<small>${existing ? `Already on your list as ${STATUS_LABELS[existing]}. We'll only update hours.` : item.match.genres.slice(0, 2).join(', ')}</small></div>
        <span class="import-hours">${formatHours(item.playtime) || 'Unplayed'}</span>
        <select class="input" data-status-for="${item.appid}" aria-label="Status for ${item.name}" ${existing ? html`disabled` : ''}>
          ${statusOptions(existing || item.suggestedStatus)}
        </select>
      </label>`;
  };

  mount(el, html`
    <div class="import-summary">
      <div>
        <h2>${matched.length} of ${preview.considered} games matched</h2>
        <p class="muted small">
          ${preview.total > preview.considered ? `You own ${preview.total.toLocaleString()} games; we checked your ${preview.considered} most-played. ` : ''}
          Statuses are guessed from your hours. Change any you like.
        </p>
      </div>
      <div class="segmented"><button type="button" id="select-all">Select all</button><button type="button" id="select-none">Select none</button></div>
    </div>
    <div class="import-list">${matched.map(rowFor)}${unmatched.map(rowFor)}</div>
    <div class="import-bar">
      <span id="import-count"></span>
      <button class="btn btn-accent" type="button" id="import-go">Import</button>
    </div>
  `);

  const boxes = [...el.querySelectorAll('input[data-appid]')];
  const update = () => {
    const n = boxes.filter((b) => b.checked).length;
    el.querySelector('#import-count').textContent = `${n} ${n === 1 ? 'game' : 'games'} selected`;
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
      toast(`Added ${added} ${added === 1 ? 'game' : 'games'}${updated ? `, updated hours on ${updated}` : ''}`);
      location.hash = profileHref(state.user.username);
    } catch (err) {
      toast(err.message, { error: true });
      button.disabled = false;
    }
  });
}
