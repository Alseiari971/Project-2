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
  steam: t('Game data from Steam and Wikidata: no keys needed.'),
  rawg: t('Using RAWG.'),
  local: t('Using the built-in sample of 35 games.'),
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
        ? html`<p class="muted lead">${t('Game data comes from Steam and Wikidata, so there\'s nothing to set up. Add a Steam Web API key if you want to import your Steam library.')}</p>`
        : ''}
      <form class="panel" id="settings-form">
        <h2>${t('Language')}</h2>
        <div class="lang-choices" role="radiogroup" aria-label="${t('Language')}">
          ${LANGUAGES.map((l) => html`<button type="button" class="mood-chip ${l.id === lang ? 'active' : ''}" role="radio" aria-checked="${l.id === lang}" lang="${l.id}" data-lang="${l.id}">${l.name}</button>`)}
        </div>

        ${cloud ? '' : html`
        <h2>${t('Game database')}</h2>
        <p class="settings-status ${source}" id="settings-status">${SOURCES[source]}</p>

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
        <div class="studio" id="studio" hidden></div>
      </section>

      <section class="panel">
        <h2>${t('Your data')}</h2>
        <p class="muted">${cloud
          ? t('Your account, game lists and profile are saved on GameShelf, the same as on the website. This PC keeps your settings and Arabic packs.')
          : t('Accounts, game lists and profiles you make in the app are saved on this computer only. Your Steam key stays here too and is only sent to Steam.')}</p>
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
  showStudio(desktop);
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
        error.textContent = t("Saved, but the game data couldn't be reached: {problem}", { problem: result.problem });
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

// Subtitle Studio (a GameShelf Supporter perk): how the overlay's Arabic looks.
// The app checks the perk with GameShelf; the packs themselves are free either way.
async function showStudio(desktop) {
  const el = document.getElementById('studio');
  if (!el || !desktop.subtitleStudio) return;
  let studio;
  try {
    studio = await desktop.subtitleStudio();
  } catch {
    return;
  }
  const { settings, allowed, fonts, defaults } = studio;
  el.hidden = false;
  const lock = allowed ? '' : 'disabled';
  mount(el, html`
    <h3>${t('Subtitle Studio')} ${allowed ? '' : html`<span class="supporter-badge">${t('Supporter')}</span>`}</h3>
    ${allowed ? '' : html`<p class="muted small">${t('Pick the Arabic font, size, color and box of the overlay subtitles with GameShelf Supporter.')} <a href="#/pricing">${t('See membership')}</a></p>`}
    <form class="studio-form" id="studio-form">
      <label>${t('Font')}
        <select class="input" name="font" ${lock}>
          ${fonts.map((f) => html`<option value="${f.id}" ${f.id === settings.font ? 'selected' : ''}>${f.id === 'default' ? t('GameShelf default') : f.name}</option>`)}
        </select>
      </label>
      <label>${t('Size')} <span class="muted small" id="studio-size-out" dir="ltr">${settings.size}%</span>
        <input type="range" name="size" min="80" max="150" step="5" value="${settings.size}" ${lock}>
      </label>
      <label>${t('Text color')}
        <input class="studio-color" type="color" name="color" value="${settings.color}" ${lock}>
      </label>
      <label>${t('Box opacity')} <span class="muted small" id="studio-bg-out" dir="ltr">${settings.background}%</span>
        <input type="range" name="background" min="0" max="100" step="2" value="${settings.background}" ${lock}>
      </label>
      <p class="studio-preview" id="studio-preview" lang="ar" dir="rtl">مرحباً أيها المسافر، الطريق إلى القلعة طويل.</p>
      <div class="row-actions">
        <button class="btn btn-light" type="submit" ${lock}>${t('Save')}</button>
        <button class="btn btn-quiet" type="button" id="studio-reset">${t('Reset to default')}</button>
      </div>
    </form>`);
  const form = document.getElementById('studio-form');
  const preview = document.getElementById('studio-preview');
  const draw = () => {
    const font = fonts.find((f) => f.id === form.font.value);
    preview.dataset.font = form.font.value;
    preview.title = font?.name || '';
    preview.style.setProperty('--studio-scale', Number(form.size.value) / 100);
    preview.style.setProperty('--studio-color', form.color.value);
    preview.style.setProperty('--studio-bg', Number(form.background.value) / 100);
    document.getElementById('studio-size-out').textContent = `${form.size.value}%`;
    document.getElementById('studio-bg-out').textContent = `${form.background.value}%`;
  };
  form.addEventListener('input', draw);
  draw();
  const save = async (values) => {
    try {
      await desktop.setSubtitleStudio(values);
      toast(t('Subtitle Studio saved'));
    } catch (err) {
      toast(t(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), { error: true });
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save({ font: form.font.value, size: Number(form.size.value), color: form.color.value, background: Number(form.background.value) });
  });
  document.getElementById('studio-reset').addEventListener('click', async () => {
    await save(defaults);
    showStudio(desktop);
  });
}
