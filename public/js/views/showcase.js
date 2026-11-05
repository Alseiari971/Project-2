// The public showcase (#/welcome, and #/ for visitors who aren't signed in):
// what GameShelf does for a player, in a player's words. It never names the
// tools or file formats behind it; those stay GameShelf's own.
import { html, bdi, api, mount, state } from '../lib.js';
import { icon } from '../icons.js';
import { t, locale, isArabic } from '../i18n.js';

// The demo scene: a line from a made-up game, in each mode.
const LINE = {
  speaker: { en: 'Rayan', ar: 'ريان' },
  en: 'The bridge won\'t hold forever. Cross before the storm reaches us.',
  ar: 'الجسر لن يصمد إلى الأبد. اعبر قبل أن تصلنا العاصفة.',
};
const FONTS = [
  { id: 'cairo', name: 'Cairo' },
  { id: 'tajawal', name: 'Tajawal' },
  { id: 'amiri', name: 'Amiri' },
];
const SIZES = [100, 125, 150];
const n = (v) => Number(v || 0).toLocaleString(locale);

function subtitle({ mode, font, size }) {
  const ar = html`<p class="demo-line ar" lang="ar" dir="rtl" data-font="${font}">${LINE.ar}</p>`;
  const en = html`<p class="demo-line en" lang="en" dir="ltr">${LINE.en}</p>`;
  return html`<div class="demo-sub mode-${mode}" data-scale="${size}">
    <span class="demo-speaker" dir="${mode === 'en' ? 'ltr' : 'rtl'}">${mode === 'en' ? LINE.speaker.en : LINE.speaker.ar}</span>
    ${mode === 'en' ? en : mode === 'ar' ? ar : html`${ar}${en}`}
  </div>`;
}

function segmented(name, options, value, label) {
  return html`<div class="seg" role="radiogroup" aria-label="${label}">${options.map((o) => html`
    <button type="button" role="radio" aria-checked="${o.id === value}" class="${o.id === value ? 'on' : ''}" data-${name}="${o.id}">${o.label}</button>`)}</div>`;
}

function appWindow(demo) {
  const controls = html`<div class="win-ctl" aria-hidden="true"><span>—</span><span>▢</span><span>✕</span></div>`;
  return html`
    <figure class="mock" aria-label="${t('The GameShelf app for Windows, with Arabic subtitles on in a game')}">
      <div class="mock-bar">
        <span class="mock-brand"><span class="mock-badge"></span>${isArabic ? 'قيم شلف' : 'GameShelf'}</span>
        ${controls}
      </div>
      <div class="mock-body">
        <nav class="mock-side" aria-hidden="true">
          <span class="on">${icon('solid-home')}${t('Home')}</span>
          <span>${icon('solid-library')}${t('Library')}</span>
          <span>${icon('star')}${t('Arabic requests')}</span>
          <span>${icon('solid-users')}${t('Friends')}</span>
        </nav>
        <div class="mock-main">
          <div class="scene" role="img" aria-label="${t('A scene from a game, with its subtitle at the bottom')}">
            <span class="scene-sun"></span><span class="scene-far"></span><span class="scene-near"></span><span class="scene-bridge"></span>
            <div class="scene-hud"><span class="arabic-pill ${demo.mode === 'en' ? '' : 'on'}"><span class="arabic-mark sm">ع</span>${demo.mode === 'en' ? t('Arabic off') : t('Arabic on')}</span></div>
            <div id="demo-sub">${subtitle(demo)}</div>
          </div>
        </div>
      </div>
    </figure>
    <div class="demo-controls">
      ${segmented('mode', [{ id: 'en', label: t('English') }, { id: 'ar', label: 'العربية' }, { id: 'dual', label: t('Dual (EN + AR)') }], demo.mode, t('Subtitles'))}
      ${segmented('font', FONTS.map((f) => ({ id: f.id, label: f.name })), demo.font, t('Font'))}
      ${segmented('size', SIZES.map((s) => ({ id: String(s), label: `${s}%` })), String(demo.size), t('Size'))}
    </div>`;
}

const FEATURES = [
  { icon: 'refresh', title: 'Auto-heal on game updates', body: 'When a game gets an update on Steam, GameShelf notices and keeps its Arabic working, without waiting days for someone to re-upload a patch.' },
  { icon: 'solid-import', title: 'Steam library sync', body: 'Link your Steam account and see every game you own that has Arabic today, and the ones you can ask for.' },
  { icon: 'sliders', title: 'Subtitle & font studio', body: 'Pick your Arabic font, make subtitles bigger for a 4K monitor or a TV, or show English and Arabic together. (Fonts and sizes come with GameShelf Supporter.)' },
  { icon: 'search', title: 'Live screen translator', body: 'A game GameShelf can\'t change? It reads the game\'s subtitles off the screen and shows them in Arabic, right over the game.' },
];
const STEPS = [
  { title: 'Get the app and link your account', body: 'Install GameShelf for Windows and sign in. It finds your Steam, Epic and GOG games by itself.' },
  { title: 'Pick a game and turn Arabic on', body: 'One switch next to Play. GameShelf sets everything up and keeps a copy of the game as it was.' },
  { title: 'Play, and stay up to date', body: 'Play in Arabic. When the game updates, GameShelf brings its Arabic back automatically.' },
];
const FAQ = [
  { q: 'Is it safe for my games?', a: 'Yes. GameShelf keeps a copy of everything it changes, and turning Arabic off puts the game back exactly as it was, in one click. It checks every pack before it goes in.' },
  { q: 'What about online games and anti-cheat?', a: 'GameShelf leaves games with anti-cheat, and games played only online, alone. It won\'t add Arabic to them, so your account stays safe.' },
  { q: 'Does it cost anything?', a: 'Arabic packs are free for everyone, always. An optional GameShelf Supporter membership pays for the servers and adds extras like the font studio.' },
  { q: 'My game isn\'t there yet. What can I do?', a: 'Ask for it on Arabic requests, or vote for it if someone already did. The most requested games come first, and you\'re told the moment its Arabic is ready.' },
  { q: 'What happens when my game updates?', a: 'GameShelf notices the update when you press Play and makes the Arabic again for the new version. If it needs a moment, it tells you.' },
];

function catalogCards(data) {
  const games = data?.games || [];
  if (!games.length) {
    return html`<p class="sc-empty muted">${t('The first Arabic packs are on their way. Ask for the game you want and vote for others: the most requested come first.')} <a href="#/arabic">${t('Arabic requests')}</a></p>`;
  }
  return html`<ul class="sc-games">${games.map((g) => html`
    <li><a href="#/game/${encodeURIComponent(g.id)}" class="sc-game">
      ${g.poster || g.image ? html`<img src="${g.poster || g.image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="sc-game-blank"></span>`}
      <span class="sc-game-name">${bdi(g.name)}</span>
      <span class="sc-game-stats">
        ${g.strings ? html`<span><strong dir="ltr">${n(g.strings)}</strong> ${t('lines')}</span>` : ''}
        ${g.downloads ? html`<span><strong dir="ltr">${n(g.downloads)}</strong> ${t('downloads')}</span>` : ''}
        ${g.rating ? html`<span class="star"><strong dir="ltr">★ ${g.rating.toFixed(1)}</strong></span>` : ''}
      </span>
    </a></li>`)}</ul>`;
}

export async function showcaseView(app) {
  document.title = `${t('GameShelf')}: ${t('Your PC games in Arabic, in one click')}`;
  const demo = { mode: 'dual', font: 'cairo', size: 125 };
  const steamHref = state.user ? '#/settings/security' : `#/register?next=${encodeURIComponent('#/settings/security')}`;

  mount(app, html`
    <div class="welcome">
      <section class="sc-hero">
        <h1 class="sc-title">${t('Your PC games in Arabic, in one click')}</h1>
        <p class="sc-lead">${t('GameShelf connects to your game library, puts verified Arabic subtitles into your games with one click, and fixes them by itself whenever a game updates.')}</p>
        <div class="sc-ctas">
          <a class="pill-btn pill-accent pill-lg" href="/download/windows">${icon('download')}<span>${t('Download for Windows (.exe)')}</span></a>
          <a class="pill-btn pill-light pill-lg" href="#/catalog">${t('Open the web platform')}</a>
          <a class="pill-btn pill-lg" href="${steamHref}">${t('Link your Steam account')}</a>
        </div>
        <ul class="sc-trust">
          <li>${icon('check')}${t('One-click install')}</li>
          <li>${icon('check')}${t('Keeps working through Steam updates')}</li>
          <li>${icon('check')}${t('Safe, with an instant restore')}</li>
        </ul>
      </section>

      <section class="sc-demo" aria-labelledby="sc-demo-title">
        <h2 id="sc-demo-title" class="sc-h2">${t('See it in a game')}</h2>
        <p class="muted">${t('Switch the subtitles between English, Arabic, or both at once, and try the fonts and sizes.')}</p>
        <div id="sc-window">${appWindow(demo)}</div>
      </section>

      <section class="sc-features" aria-labelledby="sc-features-title">
        <h2 id="sc-features-title" class="sc-h2">${t('Made for players who want Arabic')}</h2>
        <div class="sc-feature-grid">${FEATURES.map((f) => html`
          <article class="sc-feature">
            <span class="sc-feature-icon">${icon(f.icon)}</span>
            <h3>${t(f.title)}</h3>
            <p>${t(f.body)}</p>
          </article>`)}</div>
      </section>

      <section class="sc-catalog" aria-labelledby="sc-catalog-title">
        <h2 id="sc-catalog-title" class="sc-h2">${t('Games with Arabic now')}</h2>
        <div id="sc-totals"></div>
        <div id="sc-games"><div class="sk sk-line wide"></div></div>
      </section>

      <section class="sc-steps" aria-labelledby="sc-steps-title">
        <h2 id="sc-steps-title" class="sc-h2">${t('How it works')}</h2>
        <ol class="sc-step-list">${STEPS.map((s) => html`<li><h3>${t(s.title)}</h3><p>${t(s.body)}</p></li>`)}</ol>
      </section>

      <section class="sc-faq" aria-labelledby="sc-faq-title">
        <h2 id="sc-faq-title" class="sc-h2">${t('Questions')}</h2>
        ${FAQ.map((f) => html`<details><summary>${t(f.q)}</summary><p>${t(f.a)}</p></details>`)}
      </section>

      <section class="sc-end">
        <h2 class="sc-h2">${t('Play your next game in Arabic')}</h2>
        <div class="sc-ctas">
          <a class="pill-btn pill-accent pill-lg" href="/download/windows">${icon('download')}<span>${t('Download for Windows (.exe)')}</span></a>
          <a class="pill-btn pill-light pill-lg" href="#/catalog">${t('Open the web platform')}</a>
        </div>
      </section>
    </div>`);

  // The demo: modes, fonts and sizes switch at once.
  const win = document.getElementById('sc-window');
  win.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode], [data-font], [data-size]');
    if (!b) return;
    if (b.dataset.mode) demo.mode = b.dataset.mode;
    if (b.dataset.font) demo.font = b.dataset.font;
    if (b.dataset.size) demo.size = Number(b.dataset.size);
    mount(win, appWindow(demo));
  });

  // The live catalog, from GameShelf's server.
  const data = await api('/showcase').catch(() => null);
  const totals = data?.totals;
  if (document.getElementById('sc-totals') && totals?.games) {
    mount(document.getElementById('sc-totals'), html`<p class="sc-totals">
      <span><strong dir="ltr">${n(totals.games)}</strong> ${t('games with Arabic')}</span>
      ${totals.strings ? html`<span><strong dir="ltr">${n(totals.strings)}</strong> ${t('lines in Arabic')}</span>` : ''}
      ${totals.downloads ? html`<span><strong dir="ltr">${n(totals.downloads)}</strong> ${t('downloads')}</span>` : ''}
    </p>`);
  }
  if (document.getElementById('sc-games')) mount(document.getElementById('sc-games'), catalogCards(data));
}
