// "Most requested games" (#/arabic): the games players most want Arabic
// subtitles for, still without them, with an upvote for each (one per
// player, and it can be taken back). Admins see the same list, with why each
// can't be made yet, in Admin Panel, Requests.
import { html, bdi, mount, state, api, toast } from '../lib.js';
import { emptyState } from '../components.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

const cover = (steamAppId) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamAppId}/capsule_184x69.jpg`;

function row(game) {
  const votes = game.votes === 1 ? t('1 vote') : t('{count} votes', { count: game.votes.toLocaleString() });
  const notes = [
    game.pending ? t('Waiting for an admin\'s approval') : '',
    game.progress ? t('{percent}% translated so far', { percent: game.progress }) : '',
    game.recipe ? t('Engine recipe attached') : '',
  ].filter(Boolean);
  return html`
    <li class="board-row" data-game="${game.game}">
      <span class="board-rank">${game.rank}</span>
      ${game.steamAppId ? html`<img class="board-cover" src="${cover(game.steamAppId)}" alt="" loading="lazy">` : html`<span class="board-cover"></span>`}
      <div class="board-name">
        <strong>${bdi(game.name)}</strong>
        <span class="muted small"><span class="board-votes">${votes}</span>${notes.length ? ` · ${notes.join(' · ')}` : ''}</span>
      </div>
      <button class="pill-btn ${game.voted ? 'pill-light is-voted' : ''}" type="button" data-vote="${game.game}" data-name="${game.name}" aria-pressed="${game.voted}">
        ${game.voted ? html`${icon('check')} ${t('Upvoted')}` : html`${icon('up')} ${t('Upvote request (+1)')}`}
      </button>
    </li>`;
}

export async function arabicRequestsView(app) {
  document.title = `${t('Most requested games')} · ${t('GameShelf')}`;
  const { games } = await api('/arabic/leaderboard?limit=100');
  mount(app, html`
    <div class="page arabic-board">
      <div class="page-head">
        <h1>${icon('star')} ${t('Most requested games')}</h1>
        <p class="muted">${t('Games players want Arabic subtitles for, most votes first. Upvote the ones you want: GameShelf\'s team works down this list.')}</p>
      </div>
      ${games.length
        ? html`<ol class="board-list">${games.map(row)}</ol>`
        : emptyState(t('No requests yet'), t('Ask for Arabic on a game\'s page in GameShelf for Windows, and it shows up here.'))}
    </div>`);
  // Covers Steam doesn't have just go.
  app.querySelectorAll('.board-cover').forEach((img) => img.addEventListener?.('error', () => img.remove(), { once: true }));
  app.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-vote]');
    if (!button || button.disabled) return;
    if (!state.user) {
      location.hash = '#/login';
      return;
    }
    const game = games.find((g) => g.game === button.dataset.vote);
    button.disabled = true;
    try {
      if (game.voted) {
        await api(`/arabic/requests/${encodeURIComponent(game.game)}`, { method: 'DELETE' });
        game.voted = false;
        game.votes = Math.max(0, game.votes - 1);
      } else {
        await api('/arabic/requests', { method: 'POST', body: { game: game.game, name: game.name } });
        game.voted = true;
        game.votes += 1;
        toast(t('Thanks! Your vote for {name} is counted.', { name: game.name }));
      }
      const fresh = document.createElement('ol');
      mount(fresh, row(game));
      button.closest('.board-row').replaceWith(fresh.firstElementChild);
    } catch (err) {
      toast(err.message, { error: true });
      button.disabled = false;
    }
  });
}
