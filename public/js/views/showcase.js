// The public showcase (#/welcome, and #/ for visitors who aren't signed in):
// what GameShelf does for a player, in a player's words. It never names the
// tools or file formats behind it; those stay GameShelf's own.
import { html, bdi, api, mount, state, onLeave } from '../lib.js';
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

// The demo plays in three steps, like the real app: a game's page with the
// Arabic switch, a zoom into the game, then its English subtitle scrambling
// into Arabic. The subtitle controls open once the game is on screen.
const GAME = { title: 'Ashen Crossing', genre: 'Adventure', year: '2026' };
const STEPS_ON = ['Checking the game…', 'Installing Arabic…', 'Backup ready'];
// What the line looks like mid-change: hex like a hash, with Arabic letters.
const NOISE = '0123456789abcdef#%&$@ابتثجحخدذرزسشصضطظعغفقكلمنهوي';
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, reducedMotion() ? Math.min(ms, 120) : ms));

function sceneArt() {
  return html`<span class="scene-sun"></span><span class="scene-far"></span><span class="scene-near"></span><span class="scene-bridge"></span>`;
}

function gamePage() {
  return html`
    <div class="mock-page" id="mock-page">
      <div class="mock-hero">${sceneArt()}<span class="mock-hero-shade"></span></div>
      <div class="mock-page-body">
        <span class="mock-cover" aria-hidden="true">${sceneArt()}</span>
        <div class="mock-info">
          <span class="mock-example">${t('Example game')}</span>
          <h3 class="mock-title" dir="ltr">${GAME.title}</h3>
          <p class="mock-meta">${t(GAME.genre)} · <span dir="ltr">${GAME.year}</span></p>
          <div class="mock-actions">
            <button type="button" class="mock-play" id="mock-play" tabindex="-1">${icon('play')}<span>${t('Play')}</span></button>
            <button type="button" class="arabic-toggle mode-native" id="mock-toggle" role="switch" aria-checked="false">
              <span class="arabic-mark" aria-hidden="true">ع</span>
              <span class="arabic-label"><strong>${t('Arabic subtitles')}</strong><small id="mock-toggle-note">${t('Ready on GameShelf')}</small></span>
              <span class="switch" aria-hidden="true"><span></span></span>
            </button>
          </div>
          <p class="mock-hint" id="mock-hint">${icon('up')}<span>${t('Try it: turn Arabic on')}</span></p>
        </div>
      </div>
    </div>`;
}

function gameScene(demo) {
  return html`
    <div class="scene is-entering" id="mock-scene" role="img" aria-label="${t('A scene from a game, with its subtitle at the bottom')}">
      ${sceneArt()}
      <div class="scene-hud"><span class="arabic-pill on" id="mock-pill"><span class="arabic-mark sm">ع</span>${t('Arabic on')}</span></div>
      <button type="button" class="mock-replay" id="mock-replay" hidden>${icon('refresh')}<span>${t('Replay')}</span></button>
      <div id="demo-sub"><div class="demo-sub mode-en" data-scale="${demo.size}">
        <span class="demo-speaker" dir="ltr">${LINE.speaker.en}</span>
        <p class="demo-line en" lang="en" dir="ltr" id="morph-line">${LINE.en}</p>
      </div></div>
    </div>`;
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
          <span>${icon('solid-home')}${t('Home')}</span>
          <span class="on">${icon('solid-library')}${t('Library')}</span>
          <span>${icon('star')}${t('Arabic requests')}</span>
          <span>${icon('solid-users')}${t('Friends')}</span>
        </nav>
        <div class="mock-main" id="mock-main">${gamePage()}</div>
      </div>
    </figure>
    <p class="sr-only" aria-live="polite" id="mock-status"></p>
    <div class="demo-controls is-locked" id="demo-controls">${demoControls(demo)}</div>`;
}

function demoControls(demo) {
  return html`
    ${segmented('mode', [{ id: 'en', label: t('English') }, { id: 'ar', label: 'العربية' }, { id: 'dual', label: t('Dual (EN + AR)') }], demo.mode, t('Subtitles'))}
    ${segmented('font', FONTS.map((f) => ({ id: f.id, label: f.name })), demo.font, t('Font'))}
    ${segmented('size', SIZES.map((s) => ({ id: String(s), label: `${s}%` })), String(demo.size), t('Size'))}`;
}

/** Turns `from` into `to` a few letters at a time, through hash-like noise. */
function scramble(el, from, to, ms, alive) {
  return new Promise((resolve) => {
    if (reducedMotion()) {
      el.textContent = to;
      return resolve();
    }
    const t0 = performance.now();
    const noise = () => NOISE[Math.floor(Math.random() * NOISE.length)];
    let last = 0;
    const frame = (now) => {
      if (!alive()) return resolve();
      const p = Math.min(1, (now - t0) / ms);
      if (now - last > 45 || p === 1) {
        last = now;
        // First the English breaks up, then the Arabic settles in from the start of the line.
        const length = Math.round(from.length + (to.length - from.length) * Math.min(1, p * 1.6));
        const settled = Math.floor(Math.max(0, (p - 0.35) / 0.65) * to.length);
        let text = '';
        for (let i = 0; i < length; i++) {
          if (i < settled) text += to[i] ?? '';
          else if (p < 0.35 && i < from.length && Math.random() < 1 - p * 2.6) text += from[i];
          else text += (to[i] === ' ' && p > 0.35) ? ' ' : noise();
        }
        el.textContent = text;
        if (p > 0.35 && el.dir !== 'rtl') {
          el.dir = 'rtl';
          el.lang = 'ar';
          el.classList.add('is-morphing');
        }
      }
      if (p < 1) requestAnimationFrame(frame);
      else {
        el.textContent = to;
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
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
        <p class="muted">${t('Turn Arabic on for a game, the way you will in GameShelf, then switch the subtitles between English, Arabic or both, and try the fonts and sizes.')}</p>
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

  // The demo: flip Arabic on, watch it go into the game, then try modes, fonts and sizes.
  const win = document.getElementById('sc-window');
  let run = 0; // each play-through; a replay or leaving the page stops the one before
  onLeave(() => { run++; });
  const status = (text) => {
    const el = document.getElementById('mock-status');
    if (el) el.textContent = text;
  };
  const drawSubtitle = () => {
    const slot = document.getElementById('demo-sub');
    if (slot) mount(slot, subtitle(demo));
    mount(document.getElementById('demo-controls'), demoControls(demo));
  };

  async function turnOn() {
    const mine = ++run;
    const alive = () => mine === run && document.body.contains(win);
    const toggle = document.getElementById('mock-toggle');
    const note = document.getElementById('mock-toggle-note');
    document.getElementById('mock-hint')?.remove();
    toggle.disabled = true;
    toggle.classList.add('is-busy');
    toggle.setAttribute('aria-checked', 'true');
    for (const [i, step] of STEPS_ON.entries()) {
      note.textContent = t(step);
      status(t(step));
      toggle.style.setProperty('--progress', `${Math.round(((i + 1) / STEPS_ON.length) * 100)}%`);
      await wait(650);
      if (!alive()) return;
    }
    toggle.classList.remove('is-busy');
    toggle.classList.add('is-on');
    note.textContent = t('On');
    document.getElementById('mock-play').classList.add('is-ready');
    await wait(700);
    if (!alive()) return;

    // Into the game.
    document.getElementById('mock-page').classList.add('is-leaving');
    await wait(450);
    if (!alive()) return;
    mount(document.getElementById('mock-main'), gameScene(demo));
    status(t('In the game: the English subtitle turns into Arabic.'));
    await wait(1300);
    if (!alive()) return;
    const line = document.getElementById('morph-line');
    const speaker = document.querySelector('#demo-sub .demo-speaker');
    speaker.classList.add('is-fading');
    await scramble(line, LINE.en, LINE.ar, 1700, alive);
    if (!alive()) return;
    await wait(500);
    if (!alive()) return;
    demo.mode = 'dual';
    drawSubtitle();
    document.getElementById('mock-scene')?.classList.remove('is-entering');
    document.getElementById('demo-controls').classList.remove('is-locked');
    document.getElementById('mock-replay').hidden = false;
    status(t('Arabic is on. Try the subtitle modes, fonts and sizes below.'));
  }

  function replay() {
    run++;
    Object.assign(demo, { mode: 'dual', font: 'cairo', size: 125 });
    mount(win, appWindow(demo));
  }

  win.addEventListener('click', (e) => {
    if (e.target.closest('#mock-toggle')) return turnOn();
    if (e.target.closest('#mock-replay')) return replay();
    const b = e.target.closest('[data-mode], [data-font], [data-size]');
    if (!b || document.getElementById('demo-controls').classList.contains('is-locked')) return;
    if (b.dataset.mode) demo.mode = b.dataset.mode;
    if (b.dataset.font) demo.font = b.dataset.font;
    if (b.dataset.size) demo.size = Number(b.dataset.size);
    const pill = document.getElementById('mock-pill');
    if (pill) {
      pill.classList.toggle('on', demo.mode !== 'en');
      mount(pill, html`<span class="arabic-mark sm">ع</span>${demo.mode === 'en' ? t('Arabic off') : t('Arabic on')}`);
    }
    drawSubtitle();
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
