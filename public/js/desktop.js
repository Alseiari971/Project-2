// Desktop app only: Play and Stop buttons for games installed on this PC, and
// adding a game by picking its program file. `desktop` is the bridge from
// desktop/preload.js; it's undefined on the website.
import { html, api, mount, toast, year } from './lib.js';
import { gameTile, art } from './components.js';
import { icon } from './icons.js';

export const desktop = window.gameshelfDesktop;

// { key: 'starting' | 'running' } for every game that is starting or running.
let states = {};
desktop?.onGameStates((next) => {
  states = next;
  paintAll();
});

// Errors thrown in the app arrive wrapped; keep just the message.
const errorText = (err) => err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** The big Play button on a game page. */
export function playButton({ key, launcher }, name) {
  return html`<button type="button" class="pill-btn pill-lg play-btn" data-launch="${key}" data-name="${name}" data-launcher="${launcher}"></button>`;
}

/** A game on the Home row, with a round Play button on its art. */
export function installedTile({ key, launcher, game }) {
  const tile = game.id
    ? gameTile(game, { tag: launcher })
    : html`<div class="tile" title="${game.name}"><div class="tile-frame">${art(game)}<span class="card-tag">${launcher}</span></div></div>`;
  return html`
    <div class="tile-wrap">
      ${tile}
      <button type="button" class="tile-play" data-launch="${key}" data-name="${game.name}"></button>
    </div>`;
}

/** The last card on the Home row: add a game that GameShelf didn't find. */
export function addGameTile() {
  return html`
    <button type="button" class="add-tile" data-add-game>
      ${icon('plus')}
      <strong>Add a game</strong>
      <span>Pick its .exe file</span>
    </button>`;
}

// Play turns into a white Stop button while the game starts and runs.
function paint(button) {
  const state = states[button.dataset.launch];
  button.classList.toggle('is-active', Boolean(state));
  button.classList.toggle('is-starting', state === 'starting');
  button.setAttribute('aria-label', `${state ? 'Stop' : 'Play'} ${button.dataset.name}`);
  if (button.classList.contains('tile-play')) {
    mount(button, icon(state ? 'stop' : 'play'));
    return;
  }
  const note = { starting: 'Starting…', running: 'Running' }[state] || button.dataset.launcher;
  mount(button, html`${icon(state ? 'stop' : 'play')} ${state ? 'Stop' : 'Play'}<small>${note}</small>`);
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
          toast(`Closed ${button.dataset.name}`);
        } else {
          await desktop.launch(key);
          toast(`Starting ${button.dataset.name}…`);
        }
      } catch (err) {
        toast(errorText(err), { error: true });
      } finally {
        delete button.dataset.busy;
      }
    });
  });
  root.querySelectorAll('[data-add-game]').forEach((button) => button.addEventListener('click', () => addGame({ onAdded })));
  // Catches games started outside GameShelf, from Steam or a shortcut.
  desktop.gameStates().then((next) => {
    states = next;
    paintAll();
  }).catch(() => {});
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
          <h2 id="add-title">Add a game</h2>
          <p class="muted small">${file.file}</p>
        </div>
        <label class="add-search">Which game is it?
          <input class="input" name="q" value="${file.name}" autocomplete="off" spellcheck="false" required maxlength="100">
        </label>
        <div class="add-results" id="add-results" role="radiogroup" aria-label="Matching games"></div>
        <p class="form-error" id="add-error" role="alert"></p>
        <div class="add-actions">
          <button type="button" class="btn btn-quiet" id="add-cancel">Cancel</button>
          <button type="submit" class="btn btn-light">Add game</button>
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
          <span class="add-option-name">${g.name}</span>
          <span class="muted small">${year(g.released) || ''}</span>
        </label>`)}
      <label class="add-option">
        <input type="radio" name="match" value="none" ${list.length ? '' : 'checked'}>
        <span class="pal-thumb add-none">${icon('minus')}</span>
        <span class="add-option-name">Not listed: just call it “${q || 'this game'}”</span>
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
      toast(`Added ${game?.name || input.value.trim()}`);
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
