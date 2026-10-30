// A game installed on this PC that GameShelf has no page for (a demo, or a game
// the game database doesn't know): its name, Play, and the Arabic subtitles switch.
import { html, bdi, mount } from '../lib.js';
import { desktop, playButton, arabicToggle, wireLaunchButtons } from '../desktop.js';
import { t } from '../i18n.js';

export async function installedView(app, key) {
  const game = desktop && (await desktop.installedGames()).find((g) => g.key === key);
  if (!game) throw Object.assign(new Error(t('That game is no longer installed.')), { status: 404 });
  const name = game.game.name;
  document.title = `${name} · ${t('GameShelf')}`;
  mount(app, html`
    <div class="page installed-page">
      <div class="page-head">
        <h1>${bdi(name)}</h1>
        <p class="muted">${t(game.launcher)}${game.steamAppId ? html` · ${t('Steam app {id}', { id: game.steamAppId })}` : ''}</p>
      </div>
      <div class="installed-actions">${playButton(game, name)}${arabicToggle(game)}</div>
      <p class="muted small">${t('GameShelf has no page for this game, but you can start it here and turn on Arabic subtitles.')}</p>
    </div>`);
  wireLaunchButtons(app);
}
