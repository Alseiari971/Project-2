// The home page. It changes with the seasons (see ../seasons.js): a big
// spotlight with moving trailer footage up top, then the season's own
// sections between the regular rows.
import { html, api, mount, state, year, gameHref, onLeave } from '../lib.js';
import { gameTile, libraryTile, rankTile, posterTile, row, enableRows, titleArt, formatHours } from '../components.js';
import { desktop, installedTile, addGameTile, wireLaunchButtons, playButton } from '../desktop.js';
import { icon } from '../icons.js';
import { SEASONS, currentSeason, seasonNote, seasonPreference, setSeasonPreference, applySeason } from '../seasons.js';
import { startSeasonFx } from '../season-fx.js';
import { artColor } from '../art-color.js';
import { enablePreviews, microtrailer } from '../preview.js';
import { openDiscovery } from '../discover.js';

const DAY = 24 * 60 * 60 * 1000;
const stillMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const genresLine = (g) => [year(g.released), ...g.genres.slice(0, 2)].filter(Boolean).join(' · ');

// ---- Spotlight -------------------------------------------------------------------

function spotlight(games, season) {
  return html`
    <section class="spotlight" id="spotlight" aria-roledescription="carousel" aria-label="Spotlight">
      <div class="sp-media" aria-hidden="true">
        ${games.map((g, i) => html`<span class="sp-art ${i === 0 ? 'active' : ''}" data-bg="${g.backdrop}"></span>`)}
        <video class="sp-video" muted loop playsinline preload="none"></video>
        <span class="sp-emblem">${season ? icon(season.ornament) : ''}</span>
        <span class="sp-fog"></span>
        <canvas class="sp-fx"></canvas>
        <span class="sp-shade"></span>
      </div>
      <div class="sp-body" id="sp-body" aria-live="polite">${spotlightBody(games[0], season)}</div>
      <div class="sp-rail" role="tablist" aria-label="Spotlight games">
        ${games.map((g, i) => html`
          <button type="button" class="sp-thumb ${i === 0 ? 'active' : ''}" role="tab" aria-selected="${i === 0}" data-index="${i}" title="${g.name}">
            <span class="sp-thumb-art" data-bg="${g.image || g.backdrop}"></span>
            <span class="sp-thumb-name">${g.name}</span>
            <span class="sp-progress"></span>
          </button>`)}
      </div>
      <button type="button" class="sp-pause round-btn small" id="sp-pause" aria-label="Pause">${icon('pause')}</button>
    </section>`;
}

function spotlightBody(g, season) {
  return html`
    <div class="sp-eyebrow">
      ${season
        ? html`<span class="sp-season">${icon(season.ornament)}${season.name}</span><span class="sp-note">${seasonNote(season)}</span>`
        : html`<span class="sp-season plain">Spotlight</span>`}
    </div>
    ${titleArt({ name: g.name, logo: g.heroLogo }, 'h1')}
    ${g.pitch ? html`<p class="sp-pitch">${g.pitch}</p>` : ''}
    <p class="sp-meta">${genresLine(g)}</p>
    <div class="sp-actions">
      <a class="pill-btn pill-light pill-lg" href="${gameHref(g.id)}">View game</a>
      <span class="play-slot" id="sp-play"></span>
      <a class="pill-btn pill-lg sp-secondary" href="${gameHref(g.id)}?section=buy">Where to buy</a>
    </div>`;
}

// The page around the spotlight takes on the color of the game in it.
function tintPage(g, isCurrent) {
  const content = document.querySelector('.content');
  artColor(g.backdrop).then((rgb) => {
    if (rgb && isCurrent()) content.style.setProperty('--art', `rgb(${rgb.join(' ')})`);
  });
}

function wireSpotlight(root, games, season) {
  const el = root.querySelector('#spotlight');
  if (!el) return;
  const arts = [...el.querySelectorAll('.sp-art')];
  const thumbs = [...el.querySelectorAll('.sp-thumb')];
  const video = el.querySelector('.sp-video');
  const body = el.querySelector('#sp-body');
  const pause = el.querySelector('#sp-pause');
  const still = stillMotion();
  // Moving footage only when motion is welcome and data isn't being saved.
  const allowVideo = !still && !navigator.connection?.saveData;
  let index = 0;
  let paused = still;
  let onScreen = true;

  const syncVideo = () => {
    if (!video.src) return;
    if (paused || !onScreen || document.hidden) video.pause();
    else video.play().catch(() => {});
  };

  const show = async (i) => {
    index = (i + games.length) % games.length;
    const g = games[index];
    arts.forEach((a, n) => a.classList.toggle('active', n === index));
    thumbs.forEach((t, n) => {
      t.classList.toggle('active', n === index);
      t.setAttribute('aria-selected', String(n === index));
    });
    mount(body, spotlightBody(g, season));
    tintPage(g, () => games[index] === g);
    body.classList.remove('enter');
    void body.offsetWidth;
    body.classList.add('enter');
    showPlay(g);

    el.classList.remove('has-video');
    video.removeAttribute('src');
    video.load();
    if (!allowVideo || !g.steamAppId) return;
    const url = await microtrailer(g.steamAppId);
    if (!url || index !== games.indexOf(g)) return;
    video.src = url;
    syncVideo();
  };

  // Desktop app: a Play button when the spotlight game is installed.
  const showPlay = (g) => {
    desktop?.findInstalled({ id: g.id, steamAppId: g.steamAppId, name: g.name }).then((found) => {
      const slot = body.querySelector('#sp-play');
      if (!found || !slot || games[index] !== g) return;
      mount(slot, playButton(found, g.name));
      wireLaunchButtons(slot);
    }).catch(() => {});
  };

  video.addEventListener('playing', () => el.classList.add('has-video'));
  thumbs.forEach((t) => t.addEventListener('click', () => show(Number(t.dataset.index))));
  // The progress bar on the current thumbnail is the timer: when it fills, move on.
  // Hovering the spotlight pauses it (in the stylesheet), and so does the pause button.
  if (!still) {
    el.addEventListener('animationend', (e) => {
      if (e.target.classList.contains('sp-progress') && e.target.closest('.sp-thumb.active')) show(index + 1);
    });
  }
  const setPaused = (value) => {
    paused = value;
    el.classList.toggle('paused', paused);
    mount(pause, icon(paused ? 'play' : 'pause'));
    pause.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    syncVideo();
  };
  pause.addEventListener('click', () => setPaused(!paused));
  if (still) setPaused(true);

  const watcher = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    syncVideo();
  }, { threshold: 0.25 });
  watcher.observe(el);
  document.addEventListener('visibilitychange', syncVideo);
  const stopFx = season ? startSeasonFx(el.querySelector('.sp-fx'), season.fx) : () => {};
  onLeave(() => {
    watcher.disconnect();
    document.removeEventListener('visibilitychange', syncVideo);
    stopFx();
    video.removeAttribute('src');
  });

  show(0);
}

// ---- Seasonal sections -------------------------------------------------------------

function sectionHead(section, season) {
  return html`
    <div class="row-head season-head">
      <div>
        <span class="kicker">${season ? icon(season.ornament) : ''}${section.kicker}</span>
        <h2>${section.title}</h2>
      </div>
    </div>`;
}

const pitchOf = (text, max = 150) => {
  if (!text) return '';
  const first = String(text).split(/(?<=[.!?])\s/)[0];
  return first.length > max ? `${first.slice(0, max).replace(/\s+\S*$/, '')}…` : first;
};

function bento(section, season) {
  const [lead, ...rest] = section.games;
  const card = (g, big = false) => html`
    <a class="bento-card ${big ? 'big' : ''}" href="${gameHref(g.id)}" title="${g.name}">
      <span class="bento-art" data-bg="${g.backdrop || g.image || ''}"></span>
      <span class="bento-info">
        <strong>${g.name}</strong>
        ${big && g.description ? html`<span class="bento-pitch">${pitchOf(g.description)}</span>` : ''}
        <span class="bento-meta">${genresLine(g)}</span>
      </span>
    </a>`;
  return html`
    <section class="row season-section">
      ${sectionHead(section, season)}
      <div class="bento">${card(lead, true)}${rest.slice(0, 4).map((g) => card(g))}</div>
    </section>`;
}

function countdownCard(g) {
  const date = new Date(`${g.released}T00:00:00`);
  const days = Math.max(0, Math.ceil((date - Date.now()) / DAY));
  const when = days === 0 ? 'Out today' : days === 1 ? 'Out tomorrow' : `In ${days} days`;
  return html`
    <a class="cd-card" href="${gameHref(g.id)}" title="${g.name}">
      <span class="cd-art" data-bg="${g.backdrop || g.image || ''}"></span>
      <span class="cd-date"><strong>${date.getDate()}</strong>${date.toLocaleString('en', { month: 'short' })}</span>
      <span class="cd-info"><strong>${g.name}</strong><span>${when}</span></span>
    </a>`;
}

// Winter: the year in review, from the visitor's own list.
function recap(section, season) {
  const yearNow = section.title.match(/\d{4}/)?.[0];
  const entries = state.library;
  if (!entries.length) return '';
  const thisYear = entries.filter((e) => e.updatedAt?.startsWith(yearNow));
  const completed = thisYear.filter((e) => e.status === 'completed').length;
  const minutes = entries.reduce((sum, e) => sum + (e.playtime || 0), 0);
  const favorite = [...entries].filter((e) => e.rating).sort((a, b) => b.rating - a.rating)[0];
  const stat = (value, label) => html`<div class="recap-stat"><strong>${value}</strong><span>${label}</span></div>`;
  return html`
    <section class="row season-section">
      ${sectionHead(section, season)}
      <div class="recap">
        ${favorite?.backdrop || favorite?.image ? html`<span class="recap-art" data-bg="${favorite.backdrop || favorite.image}"></span>` : ''}
        <div class="recap-stats">
          ${stat(thisYear.length, 'games on your list this year')}
          ${stat(completed, 'completed')}
          ${stat(minutes ? formatHours(minutes) : '0h', 'played, all time')}
          ${favorite ? stat(favorite.name, 'your top rated') : ''}
        </div>
      </div>
    </section>`;
}

const MIN_GAMES = { bento: 5, row: 6, posters: 6, countdown: 4 };

function seasonalSection(section, season) {
  if (section.layout === 'recap') return recap(section, season);
  if (section.games.length < (MIN_GAMES[section.layout] || 6)) return '';
  if (section.layout === 'bento') return bento(section, season);
  const head = sectionHead(section, season);
  if (section.layout === 'countdown') {
    const soonest = [...section.games].sort((a, b) => (a.released || '').localeCompare(b.released || ''));
    return row({ head, cls: 'season-section row-countdown', items: soonest.map(countdownCard) });
  }
  if (section.layout === 'posters') return row({ head, cls: 'season-section row-posters', items: section.games.map(posterTile) });
  return row({ head, cls: 'season-section', items: section.games.map((g) => gameTile(g)) });
}

// ---- Discovery queue and moods ---------------------------------------------------------

function discoveryCard(posters) {
  return html`
    <section class="dq-card">
      <div class="dq-card-text">
        <span class="kicker">Discovery queue</span>
        <h2>Ten games picked for you</h2>
        <p>See each one in motion and decide in a click: <strong>want to play</strong> or <strong>not for me</strong>. Every queue is new.</p>
        <button type="button" class="pill-btn pill-light pill-lg" id="dq-start">Start your queue ${icon('right')}</button>
      </div>
      <div class="dq-card-stack" aria-hidden="true">
        ${posters.slice(0, 4).map((p, i) => html`<span class="dq-card-poster p${i}" data-bg="${p}"></span>`)}
      </div>
    </section>`;
}

function moodSection(moods) {
  return html`
    <section class="row mood-section">
      <div class="row-head season-head">
        <div><span class="kicker">Pick a vibe</span><h2>What are you in the mood for?</h2></div>
      </div>
      <div class="mood-chips" role="tablist" aria-label="Moods">
        ${moods.map((m, i) => html`<button type="button" class="mood-chip ${i === 0 ? 'active' : ''}" role="tab" aria-selected="${i === 0}" data-mood="${m.id}">${m.label}</button>`)}
      </div>
      <div id="mood-row" class="mood-row"></div>
    </section>`;
}

const moodCache = new Map();

function wireMoods(root) {
  const section = root.querySelector('.mood-section');
  if (!section) return;
  const slot = section.querySelector('#mood-row');
  const chips = [...section.querySelectorAll('.mood-chip')];
  let asked = null;
  const pick = async (id) => {
    asked = id;
    chips.forEach((c) => {
      c.classList.toggle('active', c.dataset.mood === id);
      c.setAttribute('aria-selected', String(c.dataset.mood === id));
    });
    slot.classList.add('loading');
    if (!moodCache.has(id)) moodCache.set(id, api(`/moods/${id}`).then((d) => d.games).catch(() => null));
    const list = await moodCache.get(id);
    if (asked !== id) return;
    slot.classList.remove('loading');
    mount(slot, list?.length
      ? row({ head: html``, items: list.map((g) => gameTile(g)) })
      : html`<p class="muted mood-empty">Nothing here right now. Try another mood.</p>`);
    enableRows(slot);
  };
  chips.forEach((c) => c.addEventListener('click', () => pick(c.dataset.mood)));
  // The first mood loads once the section scrolls near the screen.
  const watcher = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    watcher.disconnect();
    pick(chips[0].dataset.mood);
  }, { rootMargin: '400px' });
  watcher.observe(section);
  onLeave(() => watcher.disconnect());
}

// ---- Regular rows, tips and the season picker ----------------------------------------

function standardRow(r) {
  if (r.id === 'top10') {
    return row({ title: r.title, cls: 'row-top10', items: r.games.map((g, i) => rankTile(g, i + 1)) });
  }
  return row({
    title: r.title,
    href: r.genre ? `#/browse?genre=${encodeURIComponent(r.genre)}` : r.id === 'community' ? null : `#/browse?sort=${r.id === 'new' ? 'new' : 'popular'}`,
    items: r.games.map((g) => gameTile(g, { tag: g.players > 1 ? `${g.players} players` : '' })),
  });
}

// Tips about GameShelf, in the spirit of a launcher's "what's new" cards.
function tips(backdrops) {
  const signedIn = Boolean(state.user);
  const cards = [
    signedIn
      ? { title: 'Bring your Steam library', body: 'Every game you own, with your hours played, in one go.', link: '#/import', cta: 'Import now' }
      : { title: 'Track every game', body: 'Mark what you are playing, finished or saving for later, and rate it.', link: '#/register', cta: 'Join free' },
    { title: 'Never overpay', body: 'Every game page shows live PC prices across stores and the all-time low.', link: '#/browse', cta: 'Find a game' },
    signedIn
      ? { title: 'Make your profile yours', body: 'Pick a background, an avatar frame and showcases for your favorites.', link: '#/customize', cta: 'Customize' }
      : { title: 'Show off your taste', body: 'Profiles with showcases, badges and levels earned from your list.', link: '#/register', cta: 'Get started' },
    { title: 'Find your people', body: 'See what others are playing and leave a comment on their profile.', link: '#/community', cta: 'Browse players' },
  ];
  return html`
    <section class="row">
      <div class="row-head"><h2>Get more from GameShelf</h2></div>
      <div class="tip-grid">
        ${cards.map((c, i) => html`
          <a class="tip-card" href="${c.link}">
            ${backdrops[i] ? html`<span class="tip-art" data-bg="${backdrops[i]}"></span>` : ''}
            <span class="tip-text">
              <strong>${c.title}</strong>
              <span>${c.body} <em>${c.cta} →</em></span>
            </span>
          </a>`)}
      </div>
    </section>`;
}

function seasonPicker(season) {
  const pref = seasonPreference();
  const auto = SEASONS.find((s) => s.active(new Date()));
  return html`
    <div class="season-picker">
      <label for="season-select">Seasonal look</label>
      <select id="season-select" class="input">
        <option value="auto" ${pref === 'auto' ? 'selected' : ''}>Automatic${auto ? ` (${auto.name})` : ''}</option>
        <option value="off" ${pref === 'off' ? 'selected' : ''}>Off</option>
        <optgroup label="Preview a season">
          ${SEASONS.map((s) => html`<option value="${s.id}" ${pref === s.id ? 'selected' : ''}>${s.name}</option>`)}
        </optgroup>
      </select>
      ${season ? html`<span class="muted small">Seasons change on their own through the year: Ramadan, Eid, Lunar New Year, Halloween, winter and summer.</span>` : ''}
    </div>`;
}

// ---- Page -----------------------------------------------------------------------------

export async function homeView(app) {
  const season = applySeason();
  const home = await api(`/home${season ? `?season=${season.id}` : ''}`);
  const sections = home.sections.map((s) => seasonalSection(s, season));
  const [first, ...more] = sections;
  const [top10, ...otherRows] = home.rows;
  const backdrops = home.sections.flatMap((s) => s.games).map((g) => g.backdrop).filter(Boolean).slice(0, 4);
  const posters = (top10?.games || []).map((g) => g.poster || g.image).filter(Boolean);

  mount(app, html`
    <div class="page home">
      ${home.spotlight.length ? spotlight(home.spotlight, season) : ''}
      <div id="installed-row"></div>
      ${state.library.length
        ? row({ title: 'My games', href: '#/library', cls: 'row-small', items: state.library.slice(0, 20).map(libraryTile) })
        : ''}
      ${first || ''}
      ${top10 ? standardRow(top10) : ''}
      ${discoveryCard(posters)}
      ${home.moods?.length ? moodSection(home.moods) : ''}
      ${more}
      ${otherRows.map(standardRow)}
      ${tips(backdrops)}
      <section class="row">
        <div class="row-head"><h2>Browse by genre</h2></div>
        <div class="genre-grid">
          ${home.genres.map((g) => html`
            <a class="genre-card" href="#/browse?genre=${encodeURIComponent(g.name)}">
              ${g.image ? html`<span class="genre-art" data-bg="${g.image}"></span>` : ''}
              <span class="genre-name">${g.name}</span>
            </a>`)}
        </div>
      </section>
      ${home.source === 'local' ? html`
        <p class="catalog-note">This is a 35-game sample catalog. Connect IGDB (free, see the README) to search every game on every platform${season ? ' and see this season’s collections' : ''}.</p>` : ''}
      ${seasonPicker(season)}
    </div>
  `);
  enableRows(app);
  enablePreviews(app);
  // The page tint (see tintPage) only belongs on the home page.
  const content = document.querySelector('.content');
  content.classList.add('tinted');
  onLeave(() => {
    content.classList.remove('tinted');
    content.style.removeProperty('--art');
  });
  if (home.spotlight.length) wireSpotlight(app, home.spotlight, season);
  wireMoods(app);
  app.querySelector('#dq-start').addEventListener('click', openDiscovery);
  showInstalled();
  app.querySelector('#season-select').addEventListener('change', (e) => {
    setSeasonPreference(e.target.value);
    // Load the page again, which also stops the old spotlight.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

// Desktop app: games installed through Steam, Epic or GOG, or added by hand,
// ready to start. Finding and matching them can take a moment, so the row
// appears when ready.
async function showInstalled() {
  if (!desktop) return;
  const installed = await desktop.installedGames().catch(() => []);
  const slot = document.getElementById('installed-row');
  if (!slot) return;
  mount(slot, row({ title: 'Installed on this PC', items: [...installed.map(installedTile), addGameTile()] }));
  enableRows(slot);
  wireLaunchButtons(slot, { onAdded: showInstalled });
}
