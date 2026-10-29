// About, credits, terms and privacy, in plain language.
import { html, mount } from '../lib.js';

const link = (href, text) => html`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

export async function legalView(app) {
  document.title = 'About & legal · GameShelf';
  mount(app, html`
    <div class="page legal">
      <div class="page-head"><h1>About & legal</h1></div>
      <p class="muted lead">GameShelf helps you find games, see where to buy them and keep a list of what you play. It doesn't sell anything.</p>

      <section class="panel">
        <h2>Where the information comes from</h2>
        <ul class="plain-list">
          <li><strong>Game details, covers, screenshots and trailers:</strong> ${link('https://www.igdb.com', 'IGDB')}, the game database run by Twitch.</li>
          <li><strong>PC prices and deals:</strong> ${link('https://www.cheapshark.com', 'CheapShark')}. Buy buttons go through CheapShark to the store, and prices can change at any time. Always check the price on the store before you pay.</li>
          <li><strong>"About this game", system requirements, achievements and features:</strong> each game's public Steam store page, written by the publisher.</li>
          <li><strong>Metacritic scores</strong> come from Steam and link to ${link('https://www.metacritic.com', 'Metacritic')}.</li>
          <li><strong>Trailers</strong> play in YouTube's own player, in its privacy-enhanced mode, and only when you press play.</li>
          <li><strong>Steam library import</strong> uses the Steam Web API and only reads profiles whose game details are public.</li>
        </ul>
        <p class="muted small">GameShelf isn't affiliated with or endorsed by Valve, Twitch, IGDB, CheapShark, Metacritic, YouTube or any game publisher or store.</p>
      </section>

      <section class="panel">
        <h2>Trademarks and artwork</h2>
        <p>Game titles, logos, cover art, screenshots and descriptions belong to their publishers and developers. GameShelf shows them to identify the games and help you find where to buy them, and links back to the source. If you own content shown here and want it changed or removed, contact the people running this site.</p>
      </section>

      <section class="panel">
        <h2>Privacy</h2>
        <ul class="plain-list">
          <li><strong>What we store:</strong> your username, display name, a scrambled (hashed) version of your password, your game list, ratings, hours, profile settings, avatar and the comments you write.</li>
          <li><strong>Cookies:</strong> one cookie keeps you logged in. There are no ads, trackers or analytics.</li>
          <li><strong>What's public:</strong> your profile, game list and the comments you post can be seen by anyone.</li>
          <li><strong>Your device:</strong> recently viewed games and your grid or list choice are kept in your browser only.</li>
          <li><strong>Deleting your data:</strong> you can delete your account at any time from Edit profile. That removes your account, list, profile and comments.</li>
        </ul>
      </section>

      <section class="panel">
        <h2>Community rules</h2>
        <ul class="plain-list">
          <li>Be respectful. No harassment, hate, threats or sharing other people's personal information.</li>
          <li>No spam, scams or links to pirated games or cheats that break games' terms.</li>
          <li>Only upload avatars you have the right to use.</li>
          <li>You can delete any comment on your own profile. Accounts that break these rules can be removed.</li>
        </ul>
      </section>

      <section class="panel">
        <h2>Terms of use</h2>
        <p>GameShelf is provided as it is. We try to keep information accurate but can't guarantee prices, release dates or store details. Purchases happen on the stores' own sites under their terms. By creating an account you agree to these terms and the community rules.</p>
      </section>
    </div>
  `);
}
