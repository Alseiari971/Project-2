// Desktop app only: language, Discord, games added by hand, Arabic packs and,
// when the app runs the website itself (no GameShelf server), its API keys.
// The desktop app passes them through window.gameshelfDesktop (see desktop/preload.js).
import { html, bdi, th, mount, toast, state } from '../lib.js';
import { addGame } from '../desktop.js';
import { t, lang, LANGUAGES, setLang } from '../i18n.js';

// The overlay's two looks (desktop/overlay/overlay.css). Names and notes go through t().
const OVERLAY_STYLES = [
  { id: 'floating', name: 'Floating text (no box)', note: 'Outlined Arabic just above the game\'s subtitles, with nothing around it, so the game stays in view. The game\'s English stays under it.' },
  { id: 'box', name: 'Dark background box', note: 'Arabic on a dark box that covers the game\'s English subtitles.' },
];

const link = (href, text) => html`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
const SOURCES = {
  igdb: t('Connected to IGDB: every game on every platform.'),
  rawg: t('Using RAWG.'),
  local: t('Using the built-in sample of 35 games. Add IGDB keys to get every game.'),
};

export async function appSettingsView(app, params) {
  document.title = `${t('App settings')} · ${t('GameShelf')}`;
  const desktop = window.gameshelfDesktop;
  const { values, source, dataDir, discord, cloud } = await desktop.getSettings();
  const field = (name, label, type = 'text') => html`
    <label>${label}<input class="input" name="${name}" type="${type}" value="${values[name]}" autocomplete="off" spellcheck="false"></label>`;

  mount(app, html`
    <div class="page app-settings">
      <div class="page-head"><h1>${params.get('welcome') ? t('Welcome to GameShelf') : t('App settings')}</h1></div>
      ${params.get('welcome')
        ? html`<p class="muted lead">${t('Add your free IGDB keys to look up every game in the world. You can skip this for now and try the 35-game sample.')}</p>`
        : ''}
      <form class="panel" id="settings-form">
        <h2>${t('Language')}</h2>
        <div class="lang-choices" role="radiogroup" aria-label="${t('Language')}">
          ${LANGUAGES.map((l) => html`<button type="button" class="mood-chip ${l.id === lang ? 'active' : ''}" role="radio" aria-checked="${l.id === lang}" lang="${l.id}" data-lang="${l.id}">${l.name}</button>`)}
        </div>

        ${cloud ? '' : html`
        <h2>${t('Game database')}</h2>
        <p class="settings-status ${source}" id="settings-status">${SOURCES[source]}</p>
        <div class="form-grid">
          ${field('IGDB_CLIENT_ID', t('IGDB Client ID'))}
          ${field('IGDB_CLIENT_SECRET', t('IGDB Client Secret'), 'password')}
        </div>
        <p class="muted small">${th('Free from the {console}: register an application (Confidential, redirect URL https://localhost), then copy its Client ID and make a New Secret.', { console: link('https://dev.twitch.tv/console/apps', t('Twitch developer console')) })}</p>

        <h2>${t('Steam import')}</h2>
        <div class="form-grid">${field('STEAM_API_KEY', t('Steam Web API key'), 'password')}</div>
        <p class="muted small">${th('Optional. Free from {link} (any domain name works).', { link: link('https://steamcommunity.com/dev/apikey', 'steamcommunity.com/dev/apikey') })}</p>`}

        <h2>Discord</h2>
        <label class="check-row">
          <input type="checkbox" name="discordOn" ${values.DISCORD_ACTIVITY === 'off' ? '' : 'checked'} ${discord ? '' : 'disabled'}>
          ${t("Show the game I'm playing on my Discord profile")}
        </label>
        <p class="muted small">${discord
          ? t('Shows the game, its cover and how long you’ve played while it runs. Discord needs to be open on this PC, with “Share your detected activities with others” turned on under Activity Privacy.')
          : t('Not available in this copy of GameShelf yet.')}</p>

        <p class="form-error" id="settings-error" role="alert"></p>
        <div class="settings-actions">
          <button class="btn btn-light" type="submit">${t('Save')}</button>
          ${params.get('welcome') ? html`<a class="btn btn-quiet" href="#/">${t('Skip for now')}</a>` : ''}
        </div>
      </form>

      <section class="panel">
        <h2>${t('Games you added')}</h2>
        <div id="added-games"></div>
        <button class="btn btn-quiet" type="button" id="add-game">${t('Add a game')}</button>
      </section>

      <section class="panel">
        <h2>${t('Arabic subtitle packs')}</h2>
        <div id="arabic-packs"></div>
        <button class="btn btn-quiet" type="button" id="add-pack">${t('Add a pack')}</button>
        <div class="overlay-style" id="overlay-style" hidden>
          <h3>${t('Overlay subtitles')}</h3>
          <div class="lang-choices" role="radiogroup" aria-label="${t('Overlay subtitles')}">
            ${OVERLAY_STYLES.map((s) => html`<button type="button" class="mood-chip" role="radio" aria-checked="false" data-overlay-style="${s.id}">${t(s.name)}</button>`)}
          </div>
          <p class="muted small" id="overlay-style-note"></p>
        </div>
      </section>

      <section class="panel">
        <h2>${t('Your data')}</h2>
        <p class="muted">${cloud
          ? t('Your account, game lists and profile are saved on GameShelf, the same as on the website. This PC keeps your settings and Arabic packs.')
          : t('Accounts, game lists and profiles you make in the app are saved on this computer only. Your keys stay here too and are only sent to IGDB and Steam.')}</p>
        ${dataDir ? html`<p class="muted small">${t('Folder:')} <code dir="ltr">${dataDir}</code></p>` : ''}
        <button class="btn btn-quiet" type="button" id="open-data">${t('Open data folder')}</button>
      </section>
    </div>
  `);

  document.getElementById('open-data').addEventListener('click', () => desktop.openDataFolder());
  app.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.lang !== lang) setLang(b.dataset.lang);
  }));

  const showAdded = async () => {
    const added = await desktop.addedGames();
    const el = document.getElementById('added-games');
    if (!el) return;
    mount(el, added.length
      ? html`<div class="added-list">${added.map((g) => html`
          <div class="added-row">
            <div><strong>${bdi(g.name)}</strong><span class="muted small">${g.file}</span></div>
            <button class="btn btn-sm btn-quiet" type="button" data-remove="${g.key}">${t('Remove')}</button>
          </div>`)}</div>`
      : html`<p class="muted">${t("Games that GameShelf doesn't find in Steam, Epic or GOG can be added by picking their .exe file. They get a Play button like the rest.")}</p>`);
    el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      await desktop.removeAddedGame(b.dataset.remove);
      showAdded();
    }));
  };
  document.getElementById('add-game').addEventListener('click', () => addGame({ onAdded: showAdded }));
  showAdded();

  // How the overlay draws Arabic, for games that get the overlay. Saved at once.
  const showOverlayStyle = (style) => {
    document.querySelectorAll('[data-overlay-style]').forEach((b) => {
      const on = b.dataset.overlayStyle === style;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    document.getElementById('overlay-style-note').textContent = t(OVERLAY_STYLES.find((s) => s.id === style)?.note || '');
  };
  document.querySelectorAll('[data-overlay-style]').forEach((b) => b.addEventListener('click', async () => {
    showOverlayStyle(await desktop.setArabicOverlayStyle(b.dataset.overlayStyle));
  }));

  // Signed packs that give games Arabic: a patch the game loads, or the overlay.
  const KINDS = {
    unreal: 'Native patch (Unreal)',
    unity: 'Native patch (Unity)',
    reengine: 'Native patch (RE Engine)',
    renpy: 'Native patch (Ren\'Py)',
    godot: 'Native patch (Godot)',
    overlay: 'Accessibility overlay',
  };
  const showPacks = async () => {
    const { ready, packs } = await desktop.arabicPacks();
    const el = document.getElementById('arabic-packs');
    if (!el) return;
    // Players get packs from GameShelf's catalog by switching Arabic on; adding one by hand is for admins.
    document.getElementById('add-pack').hidden = !ready || (cloud && state.user?.role !== 'admin');
    document.getElementById('overlay-style').hidden = !ready;
    if (ready) showOverlayStyle(await desktop.arabicOverlayStyle());
    mount(el, !ready
      ? html`<p class="muted">${t("Arabic packs aren't set up in this copy of GameShelf.")}</p>`
      : packs.length
        ? html`<div class="added-list">${packs.map((p) => html`
            <div class="added-row">
              <div><strong>${bdi(p.title || p.id)}</strong><span class="muted small">${t(KINDS[p.engine])} · ${t('version {version}', { version: p.version })}</span></div>
              <button class="btn btn-sm btn-quiet" type="button" data-remove-pack="${p.id}">${t('Remove')}</button>
            </div>`)}</div>`
        : html`<p class="muted">${t('A pack gives a game Arabic subtitles. Packs are checked before they\'re added, and only packs signed for GameShelf are accepted.')}</p>`);
    el.querySelectorAll('[data-remove-pack]').forEach((b) => b.addEventListener('click', async () => {
      await desktop.removeArabicPack(b.dataset.removePack);
      showPacks();
    }));
  };
  document.getElementById('add-pack').addEventListener('click', async () => {
    try {
      const added = await desktop.addArabicPack();
      if (added) toast(t('Added {name}', { name: added.title || added.id }));
    } catch (err) {
      toast(t(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), { error: true });
    }
    showPacks();
  });
  showPacks();
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
      if (status) {
        status.className = `settings-status ${result.source}`;
        status.textContent = SOURCES[result.source];
      }
      if (result.problem) {
        error.textContent = t("Saved, but IGDB didn't accept the keys: {problem}", { problem: result.problem });
      } else {
        toast(t('Settings saved'));
        if (params.get('welcome')) location.hash = '#/';
      }
    } catch (err) {
      // Errors thrown in the app's main process arrive wrapped; keep just the message.
      error.textContent = t(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      button.disabled = false;
    }
  });
}
