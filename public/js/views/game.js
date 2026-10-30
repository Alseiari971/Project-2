import { html, bdi, ltr, th, api, mount, state, year, formatDate, STATUS_LABELS, toast, hueFor, onLeave, rememberGame, refreshLibrary, gameHref, scrollEdges, scrollRow } from '../lib.js';
import { gameTile, row, enableRows, userChip, statusBadge, starInput, wireStarInput, starValue, formatHours } from '../components.js';
import { desktop, playButton, wireLaunchButtons } from '../desktop.js';
import { icon } from '../icons.js';
import { t, tn, locale, isArabic } from '../i18n.js';

function listActions(game) {
  if (!state.user) {
    return html`<div class="list-actions"><a class="pill-btn pill-lg" href="#/login">${icon('plus')} ${t('Add to list')}</a></div>`;
  }
  const entry = game.myEntry;
  return html`
    <div class="list-actions" id="list-actions">
      <div class="dropdown">
        <button type="button" class="pill-btn pill-lg" id="list-button" aria-haspopup="menu" aria-expanded="false">
          ${entry ? html`${icon('check')} ${STATUS_LABELS[entry.status]}` : html`${icon('plus')} ${t('Add to list')}`}
          ${icon('down', 'chevron')}
        </button>
        <div class="dropdown-menu" id="list-menu" role="menu" hidden>
          ${Object.entries(STATUS_LABELS).map(([value, label]) => html`
            <button type="button" role="menuitemradio" aria-checked="${entry?.status === value}" data-status="${value}">
              <span class="check">${entry?.status === value ? icon('check') : ''}</span>${label}
            </button>`)}
          ${entry ? html`<div class="menu-sep"></div><button type="button" role="menuitem" class="danger" id="remove-entry">${t('Remove from list')}</button>` : ''}
        </div>
      </div>
      <div class="rate">
        ${starInput(entry?.rating)}
        <span class="rate-label">${entry?.rating ? `${starValue(entry.rating)} / 5` : t('Rate it')}</span>
      </div>
      ${entry?.playtime ? html`<span class="playtime">${t('{hours} played', { hours: formatHours(entry.playtime) })}</span>` : ''}
    </div>`;
}

function priceSection(prices) {
  if (!prices || !prices.deals.length) return '';
  const best = prices.deals[0];
  const money = (n) => ltr(`$${n.toFixed(2)}`);
  return html`
    <div class="best-price">
      <div class="best-label">${t('Best price right now')}</div>
      <div class="best-row">
        <span class="best-amount">${best.price === 0 ? t('Free') : money(best.price)}</span>
        ${best.savings >= 1 ? html`<span class="discount">${ltr(`−${Math.round(best.savings)}%`)}</span>` : ''}
      </div>
      <a class="pill-btn pill-accent pill-block" href="${best.url}" target="_blank" rel="noopener noreferrer">${t('Buy on {store}', { store: best.store })} ${icon('external')}</a>
      ${prices.lowestEver ? html`<div class="muted small">${t('Lowest ever: {price}, {date}', { price: money(prices.lowestEver.price), date: new Date(prices.lowestEver.date).toLocaleDateString(locale, { month: 'short', year: 'numeric' }) })}</div>` : ''}
    </div>
    ${prices.deals.length > 1 ? html`
      <h3 class="buy-subhead">${t('All PC prices')}</h3>
      <div class="deal-list" id="deal-list">
        ${prices.deals.map((d, i) => html`
          <a class="deal ${i >= 5 ? 'deal-extra' : ''}" href="${d.url}" target="_blank" rel="noopener noreferrer">
            <span class="deal-store">${d.store}</span>
            <span class="deal-price">
              ${d.savings >= 1 ? html`<s>${money(d.retailPrice)}</s>` : ''}
              <strong>${d.price === 0 ? t('Free') : money(d.price)}</strong>
            </span>
          </a>`)}
      </div>
      ${prices.deals.length > 5 ? html`<button type="button" class="link-btn" data-more-deals>${t('Show all {prices}', { prices: tn(prices.deals.length, 'price') })}</button>` : ''}` : ''}
    <p class="fine-print">${t('PC prices in US dollars from CheapShark, updated hourly.')}</p>`;
}


// ---- Sections built from IGDB and Steam store data ------------------------------

const compact = (n) => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

function mediaSection(media) {
  const first = media[0];
  return html`
    <section class="panel media" id="media" aria-label="${t('Trailers and screenshots')}">
      <div class="media-stage" id="media-stage">${stage(first)}</div>
      <div class="media-strip-wrap at-start">
        <button type="button" class="strip-arrow prev" aria-label="${t('Earlier')}">${icon('left', 'flip')}</button>
        <div class="media-strip" role="list">
        ${media.map((m, i) => html`
          <button type="button" class="media-thumb ${i === 0 ? 'active' : ''}" data-media="${i}" aria-label="${m.type === 'video' ? t('Play {name}', { name: m.name }) : t('Screenshot {n}', { n: i + 1 })}">
            <img src="${m.thumb}" alt="" loading="lazy" referrerpolicy="no-referrer">
            ${m.type === 'video' ? html`<span class="media-play">${icon('play')}</span>` : ''}
          </button>`)}
        </div>
        <button type="button" class="strip-arrow next" aria-label="${t('Later')}">${icon('right', 'flip')}</button>
      </div>
    </section>`;
}

// A video starts as its thumbnail with a play button, so nothing loads from
// YouTube until someone chooses to watch.
function stage(m, play = false) {
  if (m.type === 'video' && play) {
    return html`<iframe src="https://www.youtube-nocookie.com/embed/${m.youtubeId}?autoplay=1&rel=0" title="${m.name}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  }
  if (m.type === 'video') {
    return html`<button type="button" class="stage-video" data-play="1" aria-label="${t('Play {name}', { name: m.name })}">
      <img src="${m.thumb}" alt="" referrerpolicy="no-referrer">
      <span class="stage-play">${icon('play')}</span><span class="stage-caption">${bdi(m.name)}</span>
    </button>`;
  }
  return html`<a href="${m.full}" target="_blank" rel="noopener noreferrer" aria-label="${t('Open full-size screenshot')}"><img src="${m.full}" alt="" referrerpolicy="no-referrer"></a>`;
}

function wireMedia(root) {
  const strip = root.querySelector('.media-strip');
  if (!strip) return;
  const media = [...strip.querySelectorAll('[data-media]')];
  const stageEl = root.querySelector('#media-stage');
  let current = 0;
  const show = (i, play = false) => {
    current = i;
    media.forEach((b, n) => b.classList.toggle('active', n === i));
    // Keep the chosen thumbnail in view without moving the page.
    const thumb = media[i].getBoundingClientRect();
    const box = strip.getBoundingClientRect();
    strip.scrollBy({ left: thumb.left + thumb.width / 2 - (box.left + box.width / 2), behavior: 'smooth' });
    mount(stageEl, stage(gameMedia[i], play));
  };

  // Arrow buttons and faded edges, like the rows on the home page.
  const wrap = strip.parentElement;
  const update = () => {
    const { atStart, atEnd } = scrollEdges(strip, 4);
    wrap.classList.toggle('at-start', atStart);
    wrap.classList.toggle('at-end', atEnd);
  };
  wrap.querySelector('.prev').addEventListener('click', () => scrollRow(strip, false, 0.8));
  wrap.querySelector('.next').addEventListener('click', () => scrollRow(strip, true, 0.8));
  strip.addEventListener('scroll', update, { passive: true });
  update();
  const gameMedia = root.__media;
  strip.addEventListener('click', (e) => {
    const b = e.target.closest('[data-media]');
    if (b) show(Number(b.dataset.media), gameMedia[Number(b.dataset.media)].type === 'video');
  });
  stageEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-play]')) show(current, true);
  });
}

function scoresSection(game, steam) {
  const cards = [];
  if (steam?.metacritic) {
    cards.push(html`<a class="score-card" href="${steam.metacritic.url || '#'}" target="_blank" rel="noopener noreferrer">
      <span class="score-box ${steam.metacritic.score >= 75 ? 'good' : steam.metacritic.score >= 50 ? 'mixed' : 'bad'}">${steam.metacritic.score}</span>
      <span><strong>Metacritic</strong><small>${t('Metascore')}</small></span></a>`);
  }
  if (game.scores?.critics) {
    cards.push(html`<div class="score-card"><span class="score-num">${game.scores.critics.score}</span>
      <span><strong>${t('Critics')}</strong><small>${t('{n} reviews', { n: game.scores.critics.count })}</small></span></div>`);
  }
  if (game.scores?.players) {
    cards.push(html`<div class="score-card"><span class="score-num">${game.scores.players.score}</span>
      <span><strong>${t('Players')}</strong><small>${t('{n} ratings', { n: compact(game.scores.players.count) })}</small></span></div>`);
  }
  if (steam?.recommendations) {
    cards.push(html`<a class="score-card" href="${steam.storeUrl}" target="_blank" rel="noopener noreferrer"><span class="score-num">${compact(steam.recommendations)}</span>
      <span><strong>${t('Steam reviews')}</strong><small>${t('Recommend it')}</small></span></a>`);
  }
  if (steam?.achievements) {
    cards.push(html`<div class="score-card"><span class="score-num">${steam.achievements}</span>
      <span><strong>${t('Achievements')}</strong><small>${t('On Steam')}</small></span></div>`);
  }
  return cards.length ? html`<section class="score-row" aria-label="${t('Scores')}">${cards}</section>` : '';
}

function aboutBlocks(blocks) {
  return html`<div class="rich">${blocks.map((b) => {
    // dir="auto": English descriptions read left to right even on the Arabic page.
    if (b.type === 'heading') return html`<h3 dir="auto">${b.text}</h3>`;
    if (b.type === 'paragraph') return html`<p dir="auto">${b.text}</p>`;
    if (b.type === 'list') return html`<ul dir="auto">${b.items.map((i) => html`<li>${i}</li>`)}</ul>`;
    if (b.type === 'image') return html`<img src="${b.src}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    if (b.type === 'video') return html`<video src="${b.src}" ${b.poster ? html`poster="${b.poster}"` : ''} autoplay muted loop playsinline></video>`;
    return '';
  })}</div>`;
}

function requirementsSection(steam) {
  const { minimum, recommended } = steam.requirements;
  if (!minimum.length && !recommended.length) return '';
  const column = (title, rows) => (rows.length ? html`
    <div>
      <h3 class="buy-subhead">${title}</h3>
      <dl class="req-list">${rows.map((r) => (r.label
        ? html`<div><dt>${r.label}</dt><dd>${r.value}</dd></div>`
        : html`<div class="req-note"><dd>${r.value}</dd></div>`))}</dl>
    </div>` : '');
  return html`
    <section class="panel">
      <h2>${t('System requirements')} <span class="muted small">PC</span></h2>
      <div class="req-columns">${column(t('Minimum'), minimum)}${column(t('Recommended'), recommended)}</div>
      <p class="source-note">${th("From the game's {store}.", { store: html`<a href="${steam.storeUrl}" target="_blank" rel="noopener noreferrer">${t('Steam store page')}</a>` })}</p>
    </section>`;
}

function sideSections(game, steam) {
  // "Single player" (IGDB) and "Single-player" (Steam) are the same feature.
  const seen = new Set();
  const SAME = { coop: 'cooperative' };
  const key = (f) => {
    const k = f.toLowerCase().replace(/[^a-z]/g, '');
    return SAME[k] || k;
  };
  const features = [...(steam?.features || []), ...(game.features || [])]
    .filter((f) => !seen.has(key(f)) && seen.add(key(f)))
    .slice(0, 12);

  // IGDB knows interface, audio and subtitles; Steam knows which have full audio.
  const languages = game.languages?.length
    ? game.languages
    : (steam?.languages || []).map((l) => ({ name: l.name, interface: true, audio: l.audio, subtitles: null }));
  const yes = (v) => (v === null ? html`<span class="muted">?</span>` : v ? icon('check', 'lang-yes') : icon('minus', 'lang-no'));
  const LANG_ROWS = 8;

  return html`
    ${features.length ? html`
      <section class="panel">
        <h2>${t('Features')}</h2>
        <div class="feature-chips">${features.map((f) => html`<span class="chip-flat">${t(f)}</span>`)}</div>
      </section>` : ''}
    ${languages.length ? html`
      <section class="panel">
        <h2>${t('Languages')} <span class="muted small">${languages.length}</span></h2>
        <table class="lang-table">
          <thead><tr><th></th><th>${t('Interface')}</th><th>${t('Audio')}</th><th>${t('Subtitles')}</th></tr></thead>
          <tbody>${languages.map((l, i) => html`
            <tr class="${i >= LANG_ROWS ? 'lang-extra' : ''}"><th scope="row">${t(l.name)}</th><td>${yes(l.interface)}</td><td>${yes(l.audio)}</td><td>${yes(l.subtitles)}</td></tr>`)}</tbody>
        </table>
        ${languages.length > LANG_ROWS ? html`<button type="button" class="link-btn" data-more-langs>${t('Show all {languages}', { languages: tn(languages.length, 'language') })}</button>` : ''}
      </section>` : ''}
    ${game.links?.length ? html`
      <section class="panel">
        <h2>${t('Links')}</h2>
        <div class="store-list">${game.links.map((l) => html`
          <a class="store" href="${l.url}" target="_blank" rel="noopener noreferrer"><span>${t(l.label)}</span>${icon('external')}</a>`)}</div>
      </section>` : ''}`;
}

export async function gameView(app, id, params) {
  const game = await api(`/games/${encodeURIComponent(id)}`);
  document.title = `${game.name} · ${t('GameShelf')}`;
  rememberGame(game);

  const details = [
    [t('Released'), formatDate(game.released)],
    [t('Platforms'), game.platforms.join(t(', '))],
    game.developers.length && [t('Developer'), game.developers.join(t(', '))],
    game.publishers.length && [t('Publisher'), game.publishers.join(t(', '))],
    [t('Genres'), game.genres.map((g) => t(g)).join(t(', '))],
  ].filter((f) => f && f[1]);

  // One short line of key facts under the title.
  const facts = [
    game.released ? year(game.released) : t('TBA'),
    game.developers[0],
    game.platforms.join(t(', ')),
    game.myEntry?.playtime ? t('{hours} played', { hours: formatHours(game.myEntry.playtime) }) : null,
    game.community.count ? t('{players} here', { players: tn(game.community.count, 'player') }) : null,
  ].filter(Boolean);
  const cover = game.poster || game.image;

  const addons = [...(game.editions || []), ...(game.addons || [])];
  const tabs = [
    ['overview', t('Overview')],
    ['buy', t('Where to buy')],
    game.steamAppId && ['requirements', t('Requirements')],
    addons.length && ['addons', t('Editions & add-ons')],
    ['players', t('Players')],
    game.similar.length && ['similar', t('More like this')],
  ].filter(Boolean);

  mount(app, html`
    <div class="game-page">
      ${game.backdrop || game.image ? html`<div class="gp-backdrop" data-bg="${game.backdrop || game.image}"></div>` : ''}
      <div class="page gp">
        <header class="gp-head">
          ${cover
            ? html`<img class="gp-cover ${game.poster ? 'tall' : ''}" src="${cover}" alt="" referrerpolicy="no-referrer">`
            : html`<span class="gp-cover art-fallback" data-hue="${hueFor(game.name)}"></span>`}
          <div class="gp-main-head">
            <h1>${bdi(game.name)}</h1>
            <div class="gp-meta">
              <div class="tag-row">${game.genres.slice(0, 4).map((g) => html`<a class="tag" href="#/browse?genre=${encodeURIComponent(g)}">${t(g)}</a>`)}</div>
              <span class="gp-facts">${facts.join(' · ')}</span>
            </div>
            <div class="gp-actions">
              ${listActions(game)}
              <div class="gp-buy">
                ${game.website ? html`<a class="round-btn" href="${game.website}" target="_blank" rel="noopener noreferrer" aria-label="${t('Official website')}" title="${t('Official website')}">${icon('link')}</a>` : ''}
                <span class="play-slot" id="play-slot"></span>
                <a class="pill-btn pill-light pill-lg" id="buy-btn" href="#buy">${t('Where to buy')}</a>
              </div>
            </div>
          </div>
        </header>

        <nav class="gp-tabs pill-group" aria-label="${t('Sections')}">
          ${tabs.map(([key, label], i) => html`<a href="#${key}" data-jump="${key}" class="${i === 0 ? 'active' : ''}">${label}</a>`)}
        </nav>

        <div class="gp-layout" id="overview">
          <div class="gp-main">
            ${game.media?.length ? mediaSection(game.media) : ''}
            <div id="scores">${scoresSection(game, null)}</div>
            <section class="panel" id="about">
              <h2>${t('About this game')}</h2>
              <div id="about-body">${game.description ? html`<p class="prose" dir="auto">${game.description}</p>` : html`<p class="muted">${t('No description yet.')}</p>`}</div>
            </section>
            ${addons.length ? html`
              <section class="panel" id="addons">
                <h2>${t('Editions & add-ons')}</h2>
                <div class="addon-grid">${addons.map((a) => html`
                  <a class="addon" href="${gameHref(a.id)}">
                    ${a.image ? html`<img src="${a.image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="addon-blank"></span>`}
                    <span class="addon-text"><span class="tag">${t(a.kind)}</span><span class="addon-name">${bdi(a.name)}</span></span>
                  </a>`)}</div>
              </section>` : ''}
            <div id="requirements"></div>
            <section class="panel">
              <h2>${t('Details')}</h2>
              <dl class="detail-rows">${details.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
            </section>
            <section class="panel" id="players">
              <h2>${t('Players on GameShelf')}</h2>
              ${game.community.players.length
                ? html`<div class="chip-list">${game.community.players.map((p) => userChip(p, statusBadge(p.status)))}</div>`
                : html`<p class="muted">${t('No one has added this yet.')}</p>`}
            </section>
          </div>

          <aside class="gp-side">
            <section class="panel buy-card" id="buy">
              <h2>${t('Where to buy')}</h2>
              <div id="prices"><div class="sk sk-line wide"></div><div class="sk sk-line"></div></div>
              ${game.buy.links.length ? html`
                <h3 class="buy-subhead">${t('Stores')}</h3>
                <div class="store-list">${game.buy.links.map((l) => html`
                  <a class="store" href="${l.url}" target="_blank" rel="noopener noreferrer">
                    <span>${l.name}</span>
                    <span class="store-kind">${l.direct ? t('Store page') : t('Search')} ${icon('external')}</span>
                  </a>`)}</div>` : ''}
              <a class="text-link small" href="${game.buy.compareUrl}" target="_blank" rel="noopener noreferrer">${t('Compare on IsThereAnyDeal')} ${icon('external')}</a>
            </section>
            <div id="side-extras">${sideSections(game, null)}</div>
          </aside>
        </div>

        ${game.similar.length ? row({ title: t('More like this'), id: 'similar', items: game.similar.map((g) => gameTile(g)) }) : ''}
      </div>
    </div>
  `);
  enableRows(app);
  app.__media = game.media || [];
  wireMedia(app);
  // "Show all languages" lives inside a section that is redrawn when Steam data arrives.
  app.querySelector('.gp-side').addEventListener('click', (e) => {
    const deals = e.target.closest('[data-more-deals]');
    if (deals) {
      document.getElementById('deal-list').classList.add('show-all');
      deals.remove();
      return;
    }
    const more = e.target.closest('[data-more-langs]');
    if (!more) return;
    more.closest('.panel').classList.add('show-all-langs');
    more.remove();
  });

  // Steam's store page adds requirements, the full "About" section, Metacritic
  // and achievements. It's a separate, slower request, so it fills in afterwards.
  if (game.steamAppId) {
    api(`/games/${encodeURIComponent(game.id)}/steam${isArabic ? '?lang=ar' : ''}`).catch(() => null).then((data) => {
      const steam = data?.steam;
      if (!steam || !document.getElementById('scores')) return;
      mount(document.getElementById('scores'), scoresSection(game, steam));
      mount(document.getElementById('side-extras'), sideSections(game, steam));
      if (steam.about.length) {
        // Long descriptions open folded, with a "Read more" button, like Steam's.
        const body = document.getElementById('about-body');
        mount(body, html`<div class="fold" id="about-fold">${aboutBlocks(steam.about)}</div>
          <button type="button" class="pill-btn fold-btn" id="about-more" hidden>${t('Read more')}</button>
          <p class="source-note">${th("From the game's {store}, provided by the publisher.", { store: html`<a href="${steam.storeUrl}" target="_blank" rel="noopener noreferrer">${t('Steam store page')}</a>` })}</p>`);
        const fold = document.getElementById('about-fold');
        const more = document.getElementById('about-more');
        const check = () => {
          if (fold.scrollHeight > fold.clientHeight + 40) more.hidden = false;
          else if (!fold.classList.contains('open')) fold.classList.add('open', 'short');
        };
        // Images change the height as they load.
        fold.querySelectorAll('img, video').forEach((m) => m.addEventListener('load', check, { once: true }));
        check();
        more.addEventListener('click', () => {
          const open = fold.classList.toggle('open');
          more.textContent = open ? t('Show less') : t('Read more');
          if (!open) document.getElementById('about').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
      mount(document.getElementById('requirements'), requirementsSection(steam));
    });
  }

  // Section links scroll within the page instead of changing the route.
  app.querySelectorAll('[data-jump]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    app.querySelectorAll('.gp-tabs a').forEach((t) => t.classList.toggle('active', t === a));
    document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  document.getElementById('buy-btn').addEventListener('click', (e) => {
    if (e.currentTarget.getAttribute('href') === '#buy') {
      e.preventDefault();
      document.getElementById('buy').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  if (params.get('section') === 'buy') document.getElementById('buy').scrollIntoView({ block: 'start' });

  // Desktop app: a game installed on this PC gets a Play button in place of Buy.
  desktop?.findInstalled({ id: game.id, steamAppId: game.steamAppId, name: game.name })
    .then((found) => {
      const slot = document.getElementById('play-slot');
      if (!found || !slot) return;
      mount(slot, playButton(found, game.name));
      wireLaunchButtons(slot);
      document.getElementById('buy-btn')?.remove();
    })
    .catch(() => {});

  // Prices come from a separate, slower service, so they load after the page.
  api(`/games/${encodeURIComponent(game.id)}/prices`)
    .catch(() => null)
    .then((prices) => {
      const el = document.getElementById('prices');
      if (!el) return;
      mount(el, priceSection(prices));
      const best = prices?.deals[0];
      const button = document.getElementById('buy-btn');
      if (best && button) {
        button.href = best.url;
        button.target = '_blank';
        button.rel = 'noopener noreferrer';
        mount(button, html`${best.price === 0 ? t('Get it free') : t('Buy {price}', { price: ltr(`$${best.price.toFixed(2)}`) })}<small>${t('on {store}', { store: best.store })}</small>`);
      }
    });

  if (!document.getElementById('list-actions')) return;

  // Clicking anywhere else closes the list menu.
  const closeMenus = () => document.querySelectorAll('#list-menu').forEach((m) => {
    m.hidden = true;
    document.getElementById('list-button')?.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', closeMenus);
  onLeave(() => document.removeEventListener('click', closeMenus));

  const save = async (body, message) => {
    try {
      const { entry } = await api(`/me/library/${encodeURIComponent(game.id)}`, { method: 'PUT', body });
      game.myEntry = entry;
      rerender();
      toast(message);
      refreshLibrary();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };

  function rerender() {
    const el = document.getElementById('list-actions');
    el.outerHTML = listActions(game).value;
    wire();
  }

  function wire() {
    const el = document.getElementById('list-actions');
    const button = el.querySelector('#list-button');
    const menu = el.querySelector('#list-menu');
    const close = closeMenus;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      button.setAttribute('aria-expanded', String(!menu.hidden));
    });

    menu.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => {
      close();
      save({ status: b.dataset.status, rating: game.myEntry?.rating ?? null }, t('Moved to {status}', { status: STATUS_LABELS[b.dataset.status] }));
    }));
    menu.querySelector('#remove-entry')?.addEventListener('click', async () => {
      close();
      await api(`/me/library/${encodeURIComponent(game.id)}`, { method: 'DELETE' });
      game.myEntry = null;
      rerender();
      toast(t('Removed from your list'));
      refreshLibrary();
    });

    wireStarInput(el.querySelector('.star-input'), (n) => {
      // Picking your current rating again clears it. Rating a game that isn't
      // on your list yet adds it as Played.
      const rating = game.myEntry?.rating === n ? null : n;
      save({ status: game.myEntry?.status || 'played', rating }, rating ? t('Rated {n} stars', { n: starValue(rating) }) : t('Rating cleared'));
    });
  }
  wire();
}
