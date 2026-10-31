// Desktop app only: Play and Stop buttons for games installed on this PC, and
// adding a game by picking its program file. `desktop` is the bridge from
// desktop/preload.js; it's undefined on the website.
import { html, bdi, api, mount, toast, year, state, refreshLibrary } from './lib.js';
import { gameTile, art } from './components.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

export const desktop = window.gameshelfDesktop;

// { key: 'starting' | 'running' } for every game that is starting or running.
let states = {};
desktop?.onGameStates((next) => {
  states = next;
  paintAll();
});

// Errors thrown in the app arrive wrapped; keep just the message.
const errorText = (err) => t(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));

/** The big Play button on a game page, with an arrow for the game's options. */
export function playButton({ key, launcher }, name) {
  return html`
    <div class="play-btn">
      <button type="button" class="play-main" data-launch="${key}" data-name="${name}" data-launcher="${t(launcher)}"></button>
      <button type="button" class="play-more" data-options="${key}" data-name="${name}" aria-label="${t('Game options')}" title="${t('Game options')}" aria-haspopup="menu" aria-expanded="false">${icon('down')}</button>
      <div class="dropdown-menu play-menu" role="menu" hidden></div>
    </div>`;
}

/**
 * The "Arabic subtitles" switch beside Play. Its note says how Arabic would
 * come: a patch the game loads (Native patch), subtitles drawn over the game
 * (Accessibility overlay), or not at all (Unavailable, with the reason on hover).
 */
export function arabicToggle({ key }) {
  return html`
    <button type="button" class="arabic-toggle is-checking" data-arabic="${key}" role="switch" aria-checked="false" disabled>
      <span class="arabic-mark" aria-hidden="true">ع</span>
      <span class="arabic-label"><strong>${t('Arabic subtitles')}</strong><small>${t('Checking…')}</small></span>
      <span class="switch" aria-hidden="true"><span></span></span>
    </button>`;
}

const MODE_LABELS = { native: 'Native patch', overlay: 'Accessibility overlay', unavailable: 'Unavailable' };
const explain = (message) => (message ? t(message.text, message.vars) : '');
const percent = (part, whole) => (whole ? Math.min(100, Math.floor((part / whole) * 100)) : 0);

function setLabel(button, strong, small) {
  mount(button.querySelector('strong'), html`${strong}`);
  mount(button.querySelector('small'), html`${small}`);
}

function paintArabic(button, info) {
  const mode = info?.mode || 'unavailable';
  button.classList.remove('is-checking', 'is-request', 'is-busy', 'mode-native', 'mode-overlay', 'mode-unavailable', 'mode-available');
  button.classList.add(`mode-${mode}`);
  button.classList.toggle('is-on', Boolean(info?.enabled));
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', String(Boolean(info?.enabled)));
  button.style.removeProperty('--progress');
  delete button.dataset.action;
  button.disabled = mode === 'unavailable';
  setLabel(button, t('Arabic subtitles'), t(MODE_LABELS[mode]));
  const notes = mode === 'unavailable'
    ? [explain(info?.why)]
    : [t(mode === 'native' ? 'Adds an Arabic patch the game loads. Turning it off takes it out.' : 'Shows Arabic over the game, read from its English subtitles. The game isn\'t changed.'), explain(info?.detail)];
  // In GameShelf's catalog, not on this PC yet: it downloads when the switch goes on, for signed-in players.
  if (info?.cloud) {
    notes.push(t('GameShelf downloads the Arabic pack when you turn this on.'));
    if (!state.user) {
      button.dataset.action = 'login';
      mount(button.querySelector('small'), html`${t('Log in to turn on')}`);
    }
  }
  button.title = notes.filter(Boolean).join('\n');
  // No pack on this PC yet: GameShelf's server may have the Arabic, or it can be asked for.
  if (mode === 'unavailable' && info?.missing) checkOnline(button);
}

/**
 * A game with no Arabic on this PC:
 * - its Arabic is ready on GameShelf's server: the switch, which gets it;
 * - this PC can make it: "Request Arabic subtitles", which has the server translate it (once, for everyone);
 * - otherwise: "Request Arabic subtitles", which counts the request.
 */
async function checkOnline(button) {
  let online;
  try {
    online = await desktop.arabicOnline(button.dataset.arabic);
  } catch {
    return;
  }
  if (online.building) return paintProgress(button, online.building);
  if (online.configured && !online.signedIn) {
    // Asking GameShelf for Arabic needs an account.
    button.disabled = false;
    button.classList.remove('mode-unavailable');
    button.classList.add('is-request');
    button.setAttribute('role', 'button');
    button.removeAttribute('aria-checked');
    button.dataset.action = 'login';
    setLabel(button, t('Request Arabic subtitles'), t('Log in to ask for Arabic'));
    return;
  }
  if (!online.configured || !online.server) return;
  const server = online.server;
  button.disabled = false;
  button.classList.remove('mode-unavailable');
  button.classList.add('is-request');
  button.setAttribute('role', 'button');
  button.removeAttribute('aria-checked');
  if (online.canBuild) {
    button.dataset.action = 'get';
    setLabel(button, t('Request Arabic subtitles'), server.pending
      ? t('Waiting for an admin\'s approval')
      : server.status === 'partial' && server.total
        ? t('{percent}% translated so far', { percent: percent(server.translated, server.total) })
        : t('Made from your copy of the game'));
    button.title = online.overlayOnly
      ? t('This game\'s files can\'t be changed, so the Arabic shows over the game (Accessibility overlay). With your OK, GameShelf reads the game\'s text on your PC and translates it into Arabic. It can take a few minutes.')
      : t('With your OK, GameShelf reads this game\'s text on your PC, translates it into Arabic and makes the Arabic patch here, so you can play in Arabic right away. It can take a few minutes.');
  } else {
    button.dataset.action = 'request';
    button.dataset.why = online.cantBuild ? explain(online.cantBuild) : '';
    paintRequested(button, server);
  }
}

function paintRequested(button, server) {
  setLabel(button, server.asked ? t('Arabic requested') : t('Request Arabic subtitles'),
    server.requests === 1 ? t('1 player asked') : t('{count} players asked', { count: server.requests || 0 }));
  // Still clickable once asked: it says why this PC can't make the Arabic.
  button.disabled = false;
  button.classList.toggle('is-asked', Boolean(server.asked));
  button.title = [button.dataset.why, t('Your request is counted: GameShelf\'s team sees which games players want most.')].filter(Boolean).join('\n');
}

const PHASES = {
  starting: 'Getting ready…',
  checking: 'Checking the pack…',
  reading: 'Reading the game\'s text…',
  packing: 'Making the Arabic patch…',
  done: 'Making the Arabic patch…',
};

// "Request Arabic subtitles" in three steps: which step each phase is, and its words.
const REQUEST_STEPS = {
  starting: [1, 'Reading game text…'],
  reading: [1, 'Reading game text…'],
  translating: [2, 'Translating to Arabic…'],
  packing: [3, 'Building pack…'],
  done: [3, 'Building pack…'],
  checking: [3, 'Building pack…'],
  submitting: [3, 'Building pack & submitting for review…'],
};

function paintProgress(button, progress) {
  button.classList.add('is-busy');
  button.disabled = true;
  let small;
  let share = 0;
  if (button.classList.contains('is-request') && REQUEST_STEPS[progress.phase]) {
    const [step, words] = REQUEST_STEPS[progress.phase];
    const inner = progress.phase === 'translating' && progress.asking ? progress.asked / progress.asking : progress.phase === 'submitting' ? 1 : 0.5;
    share = (step - 1 + inner) / 3;
    small = progress.phase === 'translating' && progress.asking
      ? t('Step {step} of 3 · Translating to Arabic… {done} of {total} lines', { step, done: progress.asked.toLocaleString(), total: progress.asking.toLocaleString() })
      : t('Step {step} of 3 · {words}', { step, words: t(words) });
  } else if (progress.phase === 'downloading') {
    share = progress.total ? progress.done / progress.total : 0;
    small = progress.total ? t('Downloading Arabic pack… {percent}%', { percent: percent(progress.done, progress.total) }) : t('Downloading Arabic pack…');
  } else if (progress.phase === 'translating' && progress.asking) {
    small = t('Translating… {done} of {total} lines', { done: progress.asked.toLocaleString(), total: progress.asking.toLocaleString() });
    share = progress.asked / progress.asking;
  } else if (progress.phase === 'translating') {
    small = t('Getting the Arabic from GameShelf…');
  } else {
    small = t(PHASES[progress.phase] || PHASES.starting);
    share = progress.phase === 'packing' || progress.phase === 'done' ? 1 : 0;
  }
  button.style.setProperty('--progress', `${Math.round(share * 100)}%`);
  setLabel(button, button.classList.contains('is-request') ? t('Request Arabic subtitles') : t('Arabic subtitles'), small);
}

desktop?.onArabicProgress?.((progress) => {
  document.querySelectorAll(`[data-arabic="${CSS.escape(progress.key)}"]`).forEach((button) => paintProgress(button, progress));
});

/**
 * Asks the player before GameShelf reads anything of the game's: resolves to true for "Approve & Generate".
 */
function askConsent(name) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'consent-dialog';
    dialog.setAttribute('aria-labelledby', 'consent-title');
    mount(dialog, html`
      <form method="dialog">
        <span class="arabic-mark" aria-hidden="true">ع</span>
        <h2 id="consent-title">${t('Allow GameShelf to scan this game\'s text files on your PC to generate the Arabic subtitles?')}</h2>
        <p class="muted">${bdi(name)}</p>
        <ul>
          <li>${t('GameShelf reads the game\'s English text on this PC and sends it to GameShelf\'s server, which translates it into Arabic. You don\'t need an API key.')}</li>
          <li>${t('The Arabic patch is made on your PC, so you can play in Arabic right away. The game\'s files aren\'t uploaded.')}</li>
          <li>${t('The English lines and their Arabic go to GameShelf\'s team for review. Once approved, every player with this game can turn Arabic on.')}</li>
        </ul>
        <div class="consent-actions">
          <button class="btn btn-quiet" value="cancel">${t('Cancel')}</button>
          <button class="btn btn-light" value="approve" autofocus>${t('Approve & Generate')}</button>
        </div>
      </form>`);
    document.body.append(dialog);
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'approve');
      dialog.remove();
    });
    dialog.showModal();
  });
}

async function getArabic(button) {
  const key = button.dataset.arabic;
  const request = button.classList.contains('is-request');
  if (request && !(await askConsent(button.closest('.page')?.querySelector('h1')?.textContent?.trim() || ''))) return;
  paintProgress(button, { phase: 'starting' });
  const { done, result, info, error, submitted, requested, reason } = await desktop.getArabic(key, { consent: true });
  paintArabic(button, info);
  if (done) {
    if (error) toast(explain(error), { error: !info.enabled });
    else if (submitted?.id) toast(t('Arabic subtitles on. Your Arabic was sent to GameShelf for review: once it\'s approved, every player with this game gets it.'));
    else if (submitted?.error) toast(t('Arabic subtitles on. It couldn\'t be sent for review just now: {reason}', { reason: t(submitted.error) }));
    else toast(t('Arabic subtitles on. Press Play to start the game in Arabic.'));
  } else if (requested) {
    toast(t('GameShelf couldn\'t make Arabic for this game on your PC ({reason}). Your request was sent to the GameShelf team.', { reason: t(reason) }), { error: true });
  } else if (error) {
    toast(explain(error), { error: true });
  } else if (result?.limited) {
    toast(t('{done} of {total} lines are in Arabic so far. GameShelf\'s translation limit for today is reached: press the button again tomorrow to carry on.', { done: (result.translated || result.total - result.missing).toLocaleString(), total: (result.lines || result.total).toLocaleString() }), { error: true });
  } else {
    toast(t('Only {percent}% of this game\'s lines could be translated, so Arabic isn\'t on yet. Please try again later.', { percent: percent(result.total - result.missing, result.total) }), { error: true });
  }
}

function wireArabic(button) {
  const key = button.dataset.arabic;
  desktop.arabicInfo(key).then((info) => paintArabic(button, info)).catch(() => paintArabic(button, null));
  button.addEventListener('click', async () => {
    if (button.dataset.busy || button.disabled) return;
    button.dataset.busy = '1';
    try {
      if (button.dataset.action === 'get') {
        await getArabic(button);
      } else if (button.dataset.action === 'login') {
        location.hash = '#/login';
      } else if (button.dataset.action === 'request') {
        const already = button.classList.contains('is-asked');
        paintRequested(button, await desktop.requestArabic(key));
        const why = button.dataset.why;
        toast(already
          ? t('Already requested. {why}', { why: why || t('GameShelf\'s team can see it.') })
          : why ? t('Request sent. GameShelf can\'t make it on this PC itself: {why}', { why }) : t('Thanks! Your request for Arabic subtitles is counted.'));
      } else {
        const on = button.getAttribute('aria-checked') !== 'true';
        const { info, error } = await desktop.setArabic(key, on);
        paintArabic(button, info);
        if (error) toast(explain(error), { error: info.enabled !== on }); // red only when it didn't switch
        else toast(t(on ? 'Arabic subtitles on' : 'Arabic subtitles off'));
      }
    } catch (err) {
      toast(errorText(err), { error: true });
    } finally {
      delete button.dataset.busy;
    }
  });
}

/** A game on the Home row, with a round Play button on its art. */
export function installedTile({ key, launcher, game }, { badge = false } = {}) {
  // Games without a GameShelf page open a page of their own, with Play and the Arabic switch.
  const tile = game.id
    ? gameTile(game, { tag: t(launcher) })
    : html`<a class="tile" href="#/installed/${encodeURIComponent(key)}" title="${game.name}"><div class="tile-frame">${art(game)}<span class="card-tag">${t(launcher)}</span></div></a>`;
  return html`
    <div class="tile-wrap">
      ${tile}
      ${badge ? html`<span class="arabic-badge" data-badge-for="${key}" hidden></span>` : ''}
      <button type="button" class="tile-play" data-launch="${key}" data-name="${game.name}"></button>
    </div>`;
}

// What each installed game's Arabic badge says (see arabicBadges in desktop/main.js).
const BADGES = {
  on: { text: 'Arabic on', title: 'Arabic subtitles are on for this game.' },
  ready: { text: 'Arabic ready', title: 'Arabic subtitles are ready: turn them on beside Play.' },
  request: { text: 'Arabic on request', title: 'GameShelf can make Arabic subtitles for this game: ask for them beside Play.' },
};

function paintBadge(el, badge) {
  const shown = BADGES[badge];
  el.hidden = !shown;
  if (!shown) return;
  el.className = `arabic-badge badge-${badge}`;
  mount(el, html`<span aria-hidden="true">ع</span>${t(shown.text)}`);
  el.title = t(shown.title);
}

/** Fills in the Arabic badges on installed games' tiles, and keeps them up to date until the page changes. */
export function wireArabicBadges(root) {
  if (!desktop?.arabicBadges) return () => {};
  const paintKey = (key, badge) => root.querySelectorAll(`[data-badge-for="${CSS.escape(key)}"]`).forEach((el) => paintBadge(el, badge));
  desktop.arabicBadges().then((known) => Object.entries(known).forEach(([key, badge]) => paintKey(key, badge))).catch(() => {});
  return desktop.onArabicBadge(({ key, badge }) => paintKey(key, badge));
}

/** Puts the games on this PC on My games (the ones GameShelf knows, not already there). */
export async function syncPcGames({ quiet = false } = {}) {
  const { added, matched } = await desktop.syncLibrary();
  await refreshLibrary();
  if (quiet) return added;
  if (added) toast(t('Added to My games: {count}', { count: added }));
  else if (!matched) toast(t('GameShelf couldn\'t find the games on this PC in its game database.'));
  else toast(t('My games already has every game on this PC that GameShelf knows ({count}).', { count: matched }));
  return added;
}

/** The last card on the Home row: add a game that GameShelf didn't find. */
export function addGameTile() {
  return html`
    <button type="button" class="add-tile" data-add-game>
      ${icon('plus')}
      <strong>${t('Add a game')}</strong>
      <span>${t('Pick its .exe file')}</span>
    </button>`;
}

// Play turns into a white Stop button while the game starts and runs.
function paint(button) {
  const state = states[button.dataset.launch];
  // The capsule around a split button carries the colors and glow.
  const shell = button.closest('.play-btn') || button;
  shell.classList.toggle('is-active', Boolean(state));
  shell.classList.toggle('is-starting', state === 'starting');
  button.setAttribute('aria-label', t(state ? 'Stop {name}' : 'Play {name}', { name: button.dataset.name }));
  if (button.classList.contains('tile-play')) {
    mount(button, icon(state ? 'stop' : 'play'));
    return;
  }
  const note = { starting: t('Starting…'), running: t('Running') }[state] || button.dataset.launcher;
  mount(button, html`${icon(state ? 'stop' : 'play')} ${state ? t('Stop') : t('Play')}<small>${note}</small>`);
}

function paintAll() {
  document.querySelectorAll('[data-launch]').forEach(paint);
}

/** Wires every Play button inside `root`, and the "Add a game" card if there is one. */
export function wireLaunchButtons(root, { onAdded } = {}) {
  root.querySelectorAll('[data-launch]').forEach((button) => {
    paint(button);
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      if (button.dataset.busy) return;
      button.dataset.busy = '1';
      const key = button.dataset.launch;
      try {
        if (states[key]) {
          await desktop.stop(key);
          toast(t('Closed {name}', { name: button.dataset.name }));
        } else {
          const started = await desktop.launch(key);
          const arabic = started?.arabic;
          // A catalog pack may have downloaded on the way: show the switch as it is now.
          document.querySelectorAll(`[data-arabic="${CSS.escape(key)}"]`).forEach((b) => desktop.arabicInfo(key).then((info) => paintArabic(b, info)).catch(() => {}));
          if (arabic && !arabic.ok && arabic.mode !== 'off') {
            toast(t('Starting {name} in English: {reason}', { name: button.dataset.name, reason: explain(arabic.error) }), { error: true });
          } else if (arabic?.mode === 'native' || arabic?.mode === 'overlay') {
            toast(t('Starting {name} with Arabic subtitles…', { name: button.dataset.name }));
          } else {
            toast(t('Starting {name}…', { name: button.dataset.name }));
          }
        }
      } catch (err) {
        toast(errorText(err), { error: true });
      } finally {
        delete button.dataset.busy;
      }
    });
  });
  root.querySelectorAll('[data-options]').forEach(wireOptions);
  root.querySelectorAll('[data-arabic]').forEach(wireArabic);
  root.querySelectorAll('[data-add-game]').forEach((button) => button.addEventListener('click', () => addGame({ onAdded })));
  // Catches games started outside GameShelf, from Steam or a shortcut.
  desktop.gameStates().then((next) => {
    states = next;
    paintAll();
  }).catch(() => {});
}

// ---- Game options (the arrow on the Play button) -------------------------------------

const GPU_CHOICES = [[0, t('Let Windows decide')], [2, t('High performance')], [1, t('Power saving')]];
const DONE = {
  verify: t('Steam is checking the game files'),
  uninstall: t('Follow the uninstaller to finish'),
  'graphics-settings': t('Opened Windows graphics settings'),
};

function closeOptionMenus() {
  document.querySelectorAll('.play-menu').forEach((menu) => { menu.hidden = true; });
  document.querySelectorAll('[data-options]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.play-btn')) closeOptionMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOptionMenus();
});

function optionItem(action, label, { value = '', checked, danger = false, external = false } = {}) {
  const radio = checked !== undefined;
  return html`
    <button type="button" role="${radio ? 'menuitemradio' : 'menuitem'}" ${radio ? html`aria-checked="${checked}"` : ''}
      class="${danger ? 'danger' : ''}" data-action="${action}" data-value="${value}">
      ${radio ? html`<span class="check">${checked ? icon('check') : ''}</span>` : ''}${label}${external ? icon('external', 'menu-ext') : ''}
    </button>`;
}

function optionsMenu(o) {
  return html`
    ${o.gpu ? html`
      <div class="menu-label">${t('Graphics card')}</div>
      ${o.gpu.known
        ? GPU_CHOICES.map(([value, label]) => optionItem('gpu', label, { value, checked: o.gpu.value === value }))
        : html`<p class="menu-note">${t('Play the game once so GameShelf can find its program, then pick a graphics card here.')}</p>`}
      ${optionItem('graphics-settings', t('Windows graphics settings'), { external: true })}
      <div class="menu-sep"></div>` : ''}
    ${o.folder ? optionItem('open-folder', t('Open game folder')) : ''}
    ${o.steam ? html`
      ${optionItem('steam-properties', t('Launch options & properties'), { external: true })}
      ${optionItem('verify', t('Verify game files'))}` : ''}
    ${o.uninstall || o.removable ? html`<div class="menu-sep"></div>` : ''}
    ${o.uninstall ? optionItem('uninstall', t('Uninstall with {launcher}', { launcher: o.launcher }), { danger: true }) : ''}
    ${o.removable ? optionItem('remove', t('Remove from GameShelf'), { danger: true }) : ''}`;
}

function wireOptions(button) {
  const menu = button.parentElement.querySelector('.play-menu');
  const key = button.dataset.options;
  const name = button.dataset.name;

  button.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!menu.hidden) {
      closeOptionMenus();
      return;
    }
    closeOptionMenus();
    try {
      // Read fresh each time, so the graphics card choice shows what Windows has now.
      mount(menu, optionsMenu(await desktop.gameOptions(key)));
    } catch (err) {
      toast(errorText(err), { error: true });
      return;
    }
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector('button')?.focus();
  });

  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    const { action, value } = item.dataset;
    closeOptionMenus();
    try {
      await desktop.gameAction(key, action, value === '' ? undefined : Number(value));
      if (action === 'gpu') {
        const label = GPU_CHOICES.find(([v]) => v === Number(value))[1];
        toast(t('{name}: {choice}. Takes effect next time it starts.', { name, choice: label }));
      } else if (action === 'remove') {
        toast(t('Removed {name} from GameShelf', { name }));
        // Show the page again without the Play button.
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } else if (DONE[action]) {
        toast(DONE[action]);
      }
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  });
}

// ---- Adding a game ----------------------------------------------------------------

const MAX_MATCHES = 6;

/** Asks for the game's program file, then which GameShelf game it is. */
export async function addGame({ onAdded } = {}) {
  let file;
  try {
    file = await desktop.pickGameFile();
  } catch (err) {
    toast(errorText(err), { error: true });
    return;
  }
  if (!file) return;

  const root = document.createElement('div');
  document.body.append(root);
  const lastFocus = document.activeElement;
  const close = () => {
    root.remove();
    document.removeEventListener('keydown', onKey);
    lastFocus?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  mount(root, html`
    <div class="pal-backdrop" id="add-backdrop">
      <form class="palette add-game" role="dialog" aria-modal="true" aria-labelledby="add-title" id="add-form">
        <div class="add-head">
          <h2 id="add-title">${t('Add a game')}</h2>
          <p class="muted small">${file.file}</p>
        </div>
        <label class="add-search">${t('Which game is it?')}
          <input class="input" name="q" value="${file.name}" autocomplete="off" spellcheck="false" required maxlength="100">
        </label>
        <div class="add-results" id="add-results" role="radiogroup" aria-label="${t('Matching games')}"></div>
        <p class="form-error" id="add-error" role="alert"></p>
        <div class="add-actions">
          <button type="button" class="btn btn-quiet" id="add-cancel">${t('Cancel')}</button>
          <button type="submit" class="btn btn-light">${t('Add game')}</button>
        </div>
      </form>
    </div>`);

  const form = root.querySelector('#add-form');
  const input = form.elements.q;
  const results = root.querySelector('#add-results');
  let found = [];
  let seq = 0;

  const showResults = async () => {
    const mine = ++seq;
    const q = input.value.trim();
    const list = q ? await api(`/games?search=${encodeURIComponent(q)}`).then((d) => d.results.slice(0, MAX_MATCHES)).catch(() => []) : [];
    if (mine !== seq) return;
    found = list;
    mount(results, html`
      ${list.map((g, i) => html`
        <label class="add-option">
          <input type="radio" name="match" value="${i}" ${i === 0 ? 'checked' : ''}>
          ${g.image ? html`<img class="pal-thumb" src="${g.image}" alt="" referrerpolicy="no-referrer">` : html`<span class="pal-thumb"></span>`}
          <span class="add-option-name">${bdi(g.name)}</span>
          <span class="muted small">${year(g.released) || ''}</span>
        </label>`)}
      <label class="add-option">
        <input type="radio" name="match" value="none" ${list.length ? '' : 'checked'}>
        <span class="pal-thumb add-none">${icon('minus')}</span>
        <span class="add-option-name">${t('Not listed: just call it “{name}”', { name: q || t('this game') })}</span>
      </label>`);
  };

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(showResults, 250);
  });
  root.querySelector('#add-cancel').addEventListener('click', close);
  root.querySelector('#add-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'add-backdrop') close();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const choice = form.elements.match?.value;
    const game = choice && choice !== 'none' ? found[Number(choice)] : null;
    try {
      await desktop.addGame({ token: file.token, name: input.value, game });
      toast(t('Added {name}', { name: game?.name || input.value.trim() }));
      close();
      onAdded?.();
    } catch (err) {
      root.querySelector('#add-error').textContent = errorText(err);
    }
  });

  input.focus();
  input.select();
  showResults();
}
