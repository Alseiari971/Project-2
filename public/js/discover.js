// The discovery queue: ten well-liked games shown one at a time, full screen,
// each with its silent Steam preview loop. Decide on each with one click, a
// key or a swipe: "Want to play" adds it to your list, "Not for me" skips it
// and keeps it out of later queues on this device.
import { html, api, mount, state, year, gameHref, toast, refreshLibrary } from './lib.js';
import { icon } from './icons.js';
import { titleArt } from './components.js';
import { microtrailer } from './preview.js';

const SKIPPED_KEY = 'gs-skipped';
const MAX_SKIPPED = 200;
const stillMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function skipped() {
  try {
    return JSON.parse(localStorage.getItem(SKIPPED_KEY) || '[]');
  } catch {
    return [];
  }
}

function remember(id) {
  try {
    const list = [id, ...skipped().filter((x) => x !== id)].slice(0, MAX_SKIPPED);
    localStorage.setItem(SKIPPED_KEY, JSON.stringify(list));
  } catch {}
}

export async function openDiscovery() {
  if (document.querySelector('.dq')) return;
  const root = document.createElement('div');
  root.className = 'dq';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Discovery queue');
  document.body.append(root);
  document.documentElement.classList.add('dq-open');
  const lastFocus = document.activeElement;

  let queue = [];
  let index = 0;
  let added = 0;

  const close = () => {
    root.remove();
    document.documentElement.classList.remove('dq-open');
    document.removeEventListener('keydown', onKey);
    lastFocus?.focus?.();
  };

  const frame = (inner, bg = '') => html`
    <div class="dq-bg" data-bg="${bg}"></div>
    <button type="button" class="round-btn dq-close" id="dq-close" aria-label="Close">${icon('x')}</button>
    <div class="dq-panel">${inner}</div>`;

  const load = async () => {
    mount(root, frame(html`<p class="dq-loading">Picking games for you…</p>`));
    root.querySelector('#dq-close').addEventListener('click', close);
    try {
      queue = (await api(`/discover?skip=${encodeURIComponent(skipped().slice(0, 150).join(','))}`)).games;
    } catch (err) {
      toast(err.message, { error: true });
      close();
      return;
    }
    index = 0;
    added = 0;
    if (!queue.length) {
      mount(root.querySelector('.dq-panel'), html`<p class="dq-loading">You've seen everything we had for now. Come back later!</p>`);
      return;
    }
    show();
  };

  const show = () => {
    if (index >= queue.length) return finish();
    const g = queue[index];
    mount(root, frame(html`
      <div class="dq-media">
        <span class="dq-art" data-bg="${g.backdrop}"></span>
        <video muted loop playsinline preload="none"></video>
        <span class="dq-shade"></span>
        <div class="dq-title">
          ${titleArt({ name: g.name, logo: g.heroLogo }, 'h2')}
          <p class="dq-meta">${[year(g.released), ...g.genres.slice(0, 3)].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <div class="dq-info">
        <div class="dq-progress" aria-label="Game ${index + 1} of ${queue.length}">
          ${queue.map((_, i) => html`<span class="${i < index ? 'done' : i === index ? 'now' : ''}"></span>`)}
        </div>
        ${g.pitch ? html`<p class="dq-pitch">${g.pitch}</p>` : ''}
        <div class="dq-actions">
          ${state.user
            ? html`<button type="button" class="pill-btn pill-accent pill-lg" id="dq-want">${icon('plus')} Want to play <kbd>W</kbd></button>`
            : html`<a class="pill-btn pill-accent pill-lg" href="#/register" id="dq-join">Join to save games</a>`}
          <button type="button" class="pill-btn pill-lg" id="dq-skip">Not for me <kbd>→</kbd></button>
          <a class="dq-link" href="${gameHref(g.id)}" id="dq-view">View game ${icon('right')}</a>
        </div>
      </div>`, g.backdrop));
    root.querySelector('#dq-close').addEventListener('click', close);
    root.querySelector('#dq-want')?.addEventListener('click', want);
    root.querySelector('#dq-skip').addEventListener('click', skip);
    root.querySelector('#dq-view').addEventListener('click', close);
    root.querySelector('#dq-join')?.addEventListener('click', close);
    root.querySelector('#dq-want, #dq-skip')?.focus();

    const media = root.querySelector('.dq-media');
    // Touch screens: swipe the picture left for "not for me", right for "want to play".
    let startX = null;
    media.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
    media.addEventListener('touchend', (e) => {
      const dx = startX === null ? 0 : e.changedTouches[0].clientX - startX;
      startX = null;
      if (dx < -70) skip();
      else if (dx > 70 && state.user) want();
    });
    if (!stillMotion() && g.steamAppId) {
      microtrailer(g.steamAppId).then((url) => {
        if (!url || queue[index] !== g || !document.contains(media)) return;
        const video = media.querySelector('video');
        video.addEventListener('playing', () => media.classList.add('has-video'), { once: true });
        video.src = url;
        video.play().catch(() => {});
      });
    }
  };

  const want = async () => {
    const g = queue[index];
    const button = root.querySelector('#dq-want');
    if (!g || !button || button.disabled) return;
    button.disabled = true;
    try {
      await api(`/me/library/${encodeURIComponent(g.id)}`, { method: 'PUT', body: { status: 'want' } });
      added++;
      refreshLibrary().then(() => document.dispatchEvent(new Event('library-changed')));
      index++;
      show();
    } catch (err) {
      button.disabled = false;
      toast(err.message, { error: true });
    }
  };

  const skip = () => {
    if (!queue[index]) return;
    remember(queue[index].id);
    index++;
    show();
  };

  const finish = () => {
    mount(root, frame(html`
      <div class="dq-done">
        <span class="dq-done-mark">${icon('check')}</span>
        <h2>Queue finished</h2>
        <p class="muted">${added
          ? `You added ${added} ${added === 1 ? 'game' : 'games'} to Want to play.`
          : 'Nothing caught your eye this time. The next queue is different.'}</p>
        <div class="dq-actions">
          <button type="button" class="pill-btn pill-accent pill-lg" id="dq-again">Another 10</button>
          ${added ? html`<a class="pill-btn pill-lg" href="#/library?status=want" id="dq-library">See my list</a>` : ''}
        </div>
      </div>`));
    root.querySelector('#dq-close').addEventListener('click', close);
    root.querySelector('#dq-again').addEventListener('click', load);
    root.querySelector('#dq-library')?.addEventListener('click', close);
    root.querySelector('#dq-again').focus();
  };

  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.target.closest?.('input, textarea, select')) return;
    else if (e.key === 'ArrowRight') skip();
    else if (e.key.toLowerCase() === 'w' && state.user) want();
  };
  document.addEventListener('keydown', onKey);
  load();
}
