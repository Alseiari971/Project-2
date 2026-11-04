// About, credits, terms and privacy, in plain language.
import { html, th, mount } from '../lib.js';
import { t } from '../i18n.js';

const link = (href, text) => html`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
// A list item with a bold lead-in: "Cookies: one cookie keeps you logged in."
const item = (lead, text, parts = {}) => html`<li><strong>${t(lead)}</strong> ${th(text, parts)}</li>`;

export async function legalView(app) {
  document.title = `${t('About & legal')} · ${t('GameShelf')}`;
  mount(app, html`
    <div class="page legal">
      <div class="page-head"><h1>${t('About & legal')}</h1></div>
      <p class="muted lead">${t('GameShelf helps you find games, see where to buy them, keep a list of what you play and play them in Arabic. It never sells games, or the Arabic for them.')}</p>

      <section class="panel">
        <h2>${t('Where the information comes from')}</h2>
        <ul class="plain-list">
          ${item('Game details, artwork and screenshots:', "each game's public {steam} page, written by its publisher.", { steam: link('https://store.steampowered.com', 'Steam store') })}
          ${item('Arabic titles, game engines and other stores\' links:', '{wikidata}, the free knowledge base, whose data is public domain (CC0).', { wikidata: link('https://www.wikidata.org', 'Wikidata') })}
          ${item('PC prices and deals:', '{cheapshark}. Buy buttons go through CheapShark to the store, and prices can change at any time. Always check the price on the store before you pay.', { cheapshark: link('https://www.cheapshark.com', 'CheapShark') })}
          ${item('"About this game", system requirements, achievements and features:', "each game's public Steam store page, written by the publisher.")}
          ${item('Metacritic scores', 'come from Steam and link to {metacritic}.', { metacritic: link('https://www.metacritic.com', 'Metacritic') })}
          ${item('Trailers', "play in YouTube's own player, in its privacy-enhanced mode, and only when you press play.")}
          ${item('Steam library import', 'uses the Steam Web API and only reads profiles whose game details are public.')}
        </ul>
        <p class="muted small">${t("GameShelf isn't affiliated with or endorsed by Valve, the Wikimedia Foundation, CheapShark, Metacritic, YouTube or any game publisher or store.")}</p>
      </section>

      <section class="panel">
        <h2>${t('Membership and affiliate links')}</h2>
        <ul class="plain-list">
          ${item('Arabic packs:', 'every finished pack is free for every player to download, install and switch on or off. No plan, payment or code is ever needed for one.')}
          ${item('GameShelf Supporter', 'is an optional membership. It pays for the cloud AI that makes new translations and gives more of it, a place first in its queue, boost tokens, Subtitle Studio in the desktop app, a profile badge and priority support. See {pricing}.', { pricing: html`<a href="#/pricing">${t('Membership & support')}</a>` })}
          ${item('Payments', 'happen on the payment provider\'s own page. GameShelf never sees your card details; it only hears that a payment went through.')}
          ${item('Affiliate links:', 'some buy buttons are marked "Affiliate". GameShelf may earn a small commission when you buy through them, at no extra cost to you. The price is the store\'s own.')}
          ${item('Subtitle fonts:', 'Cairo, Tajawal, Amiri and IBM Plex Sans Arabic, used under the SIL Open Font License.')}
        </ul>
      </section>

      <section class="panel">
        <h2>${t('Trademarks and artwork')}</h2>
        <p>${t('Game titles, logos, cover art, screenshots and descriptions belong to their publishers and developers. GameShelf shows them to identify the games and help you find where to buy them, and links back to the source. If you own content shown here and want it changed or removed, contact the people running this site.')}</p>
      </section>

      <section class="panel">
        <h2>${t('Privacy')}</h2>
        <ul class="plain-list">
          ${item('What we store:', 'your username, display name, a scrambled (hashed) version of your password, your game list, ratings, hours, profile settings, avatar and the comments you write.')}
          ${item('Cookies:', 'one cookie keeps you logged in. There are no ads, trackers or analytics.')}
          ${item("What's public:", 'your profile, game list and the comments you post can be seen by anyone.')}
          ${item('Your device:', 'recently viewed games, your language and your grid or list choice are kept in your browser only.')}
          ${item('Deleting your data:', 'you can delete your account at any time from Edit profile. That removes your account, list, profile and comments.')}
        </ul>
      </section>

      <section class="panel">
        <h2>${t('Community rules')}</h2>
        <ul class="plain-list">
          <li>${t("Be respectful. No harassment, hate, threats or sharing other people's personal information.")}</li>
          <li>${t("No spam, scams or links to pirated games or cheats that break games' terms.")}</li>
          <li>${t('Only upload avatars you have the right to use.')}</li>
          <li>${t('You can delete any comment on your own profile. Accounts that break these rules can be removed.')}</li>
        </ul>
      </section>

      <section class="panel">
        <h2>${t('Terms of use')}</h2>
        <p>${t("GameShelf is provided as it is. We try to keep information accurate but can't guarantee prices, release dates or store details. Purchases happen on the stores' own sites under their terms. By creating an account you agree to these terms and the community rules.")}</p>
      </section>

      <section class="panel">
        <h2>${t('Fonts')}</h2>
        <p>${th('Manrope and Alexandria are used under the {ofl}. When the Thmanyah Sans font is installed on your computer, the Arabic text uses it instead; it is not part of GameShelf.', { ofl: link('https://openfontlicense.org', 'SIL Open Font License') })}</p>
        <p>${th('Flags are drawn with {flags} ({mit}), which uses flag art from Twitter\'s {twemoji}, licensed under {ccby}.', { flags: link('https://github.com/talkjs/country-flag-emoji-polyfill', 'Twemoji Country Flags'), mit: 'MIT', twemoji: link('https://twitter.github.io/twemoji', 'Twemoji'), ccby: link('https://creativecommons.org/licenses/by/4.0/', 'CC-BY 4.0') })}</p>
        <p>${th('QR codes are drawn with {qr} ({mit}).', { qr: link('https://github.com/kazuhikoarase/qrcode-generator', 'qrcode-generator'), mit: 'MIT' })}</p>
      </section>
    </div>
  `);
}
