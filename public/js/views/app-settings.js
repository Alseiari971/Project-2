// Desktop app only: the API keys the built-in server uses. The desktop app
// passes them through window.gameshelfDesktop (see desktop/preload.js).
import { html, mount, toast } from '../lib.js';
import { addGame } from '../desktop.js';

const link = (href, text) => html`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
const SOURCES = {
  igdb: 'Connected to IGDB: every game on every platform.',
  rawg: 'Using RAWG.',
  local: 'Using the built-in sample of 35 games. Add IGDB keys to get every game.',
};

export async function appSettingsView(app, params) {
  document.title = 'App settings · GameShelf';
  const desktop = window.gameshelfDesktop;
  const { values, source, dataDir } = await desktop.getSettings();
  const field = (name, label, type = 'text') => html`
    <label>${label}<input class="input" name="${name}" type="${type}" value="${values[name]}" autocomplete="off" spellcheck="false"></label>`;

  mount(app, html`
    <div class="page app-settings">
      <div class="page-head"><h1>${params.get('welcome') ? 'Welcome to GameShelf' : 'App settings'}</h1></div>
      ${params.get('welcome')
        ? html`<p class="muted lead">Add your free IGDB keys to look up every game in the world. You can skip this for now and try the 35-game sample.</p>`
        : ''}
      <form class="panel" id="settings-form">
        <h2>Game database</h2>
        <p class="settings-status ${source}" id="settings-status">${SOURCES[source]}</p>
        <div class="form-grid">
          ${field('IGDB_CLIENT_ID', 'IGDB Client ID')}
          ${field('IGDB_CLIENT_SECRET', 'IGDB Client Secret', 'password')}
        </div>
        <p class="muted small">Free from the ${link('https://dev.twitch.tv/console/apps', 'Twitch developer console')}: register an application (Confidential, redirect URL https://localhost), then copy its Client ID and make a New Secret.</p>

        <h2>Steam import</h2>
        <div class="form-grid">${field('STEAM_API_KEY', 'Steam Web API key', 'password')}</div>
        <p class="muted small">Optional. Free from ${link('https://steamcommunity.com/dev/apikey', 'steamcommunity.com/dev/apikey')} (any domain name works).</p>

        <h2>Discord</h2>
        <label class="check-row">
          <input type="checkbox" name="discordOn" ${values.DISCORD_ACTIVITY === 'off' ? '' : 'checked'}>
          Show the game I'm playing on my Discord profile
        </label>
        <div class="form-grid">${field('DISCORD_CLIENT_ID', 'Discord Application ID')}</div>
        <p class="muted small">Make a free application named GameShelf in the ${link('https://discord.com/developers/applications', 'Discord Developer Portal')} and paste its Application ID here. The Discord app needs to be open on this PC, with "Share your detected activities" turned on under Activity Privacy.</p>

        <p class="form-error" id="settings-error" role="alert"></p>
        <div class="settings-actions">
          <button class="btn btn-light" type="submit">Save</button>
          ${params.get('welcome') ? html`<a class="btn btn-quiet" href="#/">Skip for now</a>` : ''}
        </div>
      </form>

      <section class="panel">
        <h2>Games you added</h2>
        <div id="added-games"></div>
        <button class="btn btn-quiet" type="button" id="add-game">Add a game</button>
      </section>

      <section class="panel">
        <h2>Your data</h2>
        <p class="muted">Accounts, game lists and profiles you make in the app are saved on this computer only. Your keys stay here too and are only sent to IGDB and Steam.</p>
        ${dataDir ? html`<p class="muted small">Folder: <code>${dataDir}</code></p>` : ''}
        <button class="btn btn-quiet" type="button" id="open-data">Open data folder</button>
      </section>
    </div>
  `);

  document.getElementById('open-data').addEventListener('click', () => desktop.openDataFolder());

  const showAdded = async () => {
    const added = await desktop.addedGames();
    const el = document.getElementById('added-games');
    if (!el) return;
    mount(el, added.length
      ? html`<div class="added-list">${added.map((g) => html`
          <div class="added-row">
            <div><strong>${g.name}</strong><span class="muted small">${g.file}</span></div>
            <button class="btn btn-sm btn-quiet" type="button" data-remove="${g.key}">Remove</button>
          </div>`)}</div>`
      : html`<p class="muted">Games that GameShelf doesn't find in Steam, Epic or GOG can be added by picking their .exe file. They get a Play button like the rest.</p>`);
    el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      await desktop.removeAddedGame(b.dataset.remove);
      showAdded();
    }));
  };
  document.getElementById('add-game').addEventListener('click', () => addGame({ onAdded: showAdded }));
  showAdded();
  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.submitter;
    const error = document.getElementById('settings-error');
    error.textContent = '';
    button.disabled = true;
    try {
      const { discordOn, ...values } = Object.fromEntries(new FormData(e.target));
      const result = await desktop.saveSettings({ ...values, DISCORD_ACTIVITY: discordOn ? '' : 'off' });
      const status = document.getElementById('settings-status');
      status.className = `settings-status ${result.source}`;
      status.textContent = SOURCES[result.source];
      if (result.problem) {
        error.textContent = `Saved, but IGDB didn't accept the keys: ${result.problem}`;
      } else {
        toast('Settings saved');
        if (params.get('welcome')) location.hash = '#/';
      }
    } catch (err) {
      // Errors thrown in the app's main process arrive wrapped; keep just the message.
      error.textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally {
      button.disabled = false;
    }
  });
}
