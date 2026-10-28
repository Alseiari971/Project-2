// "Edit profile" page, modeled on Steam's profile editor: general info, avatar
// and frame, background, theme color and showcases, with a live preview.
import { html, api, mount, state, refreshMe, toast, hueFor, profileHref, onLeave, runCleanups } from '../lib.js';
import { avatar } from '../components.js';
import { icon } from '../icons.js';

const BACKGROUND_NAMES = {
  midnight: 'Midnight', aurora: 'Aurora', sunset: 'Sunset', ocean: 'Ocean',
  ember: 'Ember', forest: 'Forest', nebula: 'Nebula', synthwave: 'Synthwave',
};
const FRAME_NAMES = { none: 'None', glow: 'Glow', gold: 'Gold', neon: 'Neon', fire: 'Fire', ice: 'Ice' };
const SHOWCASE_INFO = {
  favorite: { name: 'Favorite game', description: 'Spotlight one game with its full artwork.' },
  collection: { name: 'Game collection', description: 'Hand-pick up to 6 games under your own title.' },
  toprated: { name: 'Highest rated', description: 'Your 6 highest-rated games, updated automatically.' },
  completed: { name: 'Recently completed', description: 'Games you’ve completed most recently.' },
  stats: { name: 'By the numbers', description: 'Games, completions, hours, average rating and more.' },
  info: { name: 'Custom info box', description: 'Write anything: favorite genres, setup, gamer tags.' },
};
const AVATAR_SIZE = 256;

/** Crops an image file to a centered square and returns a JPEG data URL. */
function resizeAvatar(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image we can use.'));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = AVATAR_SIZE;
        canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
        resolve(canvas.toDataURL('image/jpeg', 0.88));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export async function customizeView(app) {
  if (!state.user) {
    location.hash = '#/login';
    return;
  }
  await refreshMe();
  const { library } = await api(`/users/${encodeURIComponent(state.user.username)}`);
  const options = state.options;
  const withArt = library.filter((e) => e.backdrop || e.image);
  const byId = new Map(library.map((e) => [e.gameId, e]));

  const initial = () => ({
    displayName: state.user.displayName,
    headline: state.user.headline,
    country: state.user.country,
    bio: state.user.bio,
    avatarFrame: state.user.avatarFrame,
    background: state.user.background,
    accent: state.user.accent,
    showcases: structuredClone(state.showcases),
  });
  let draft = initial();
  let saved = JSON.stringify(draft);
  const isDirty = () => JSON.stringify(draft) !== saved;

  const previewUser = () => ({ ...state.user, ...draft });

  function previewBg() {
    if (draft.background.startsWith('game:')) {
      const g = byId.get(draft.background.slice(5));
      if (g) return html`<div class="preview-bg" data-bg="${g.backdrop || g.image}"></div>`;
    }
    return html`<div class="preview-bg bg-${draft.background}"></div>`;
  }

  const preview = () => html`
    ${previewBg()}
    <div class="preview-content" data-accent="${draft.accent}">
      ${avatar(previewUser(), 'lg')}
      <div>
        <div class="preview-name">${draft.displayName || state.user.username}</div>
        <div class="preview-headline">${draft.headline || 'Your headline'}</div>
        <span class="preview-accent">Accent color</span>
      </div>
    </div>`;

  const swatch = (selected, attrs, inner, label) => html`
    <button type="button" class="swatch ${selected ? 'selected' : ''}" ${attrs} aria-pressed="${selected}">
      ${inner}<span class="swatch-label">${label}</span>
    </button>`;

  const gameOptions = (selectedId) => html`
    <option value="">Choose a game…</option>
    ${library.map((e) => html`<option value="${e.gameId}" ${e.gameId === selectedId ? html`selected` : ''}>${e.name}</option>`)}`;

  function showcaseEditor(s, i) {
    const info = SHOWCASE_INFO[s.type];
    let body = html`<p class="muted small">${info.description}</p>`;
    if (s.type === 'favorite') {
      body = library.length
        ? html`<select class="input" data-field="gameId" data-index="${i}">${gameOptions(s.gameId)}</select>`
        : html`<p class="muted small">Add games to your list first.</p>`;
    } else if (s.type === 'collection') {
      body = html`
        <input class="input" data-field="title" data-index="${i}" value="${s.title}" maxlength="40" placeholder="Collection title">
        <p class="muted small">Pick up to ${options.maxCollection} games (${s.gameIds.length} selected).</p>
        <div class="picker">
          ${library.length ? library.map((e) => {
            const pos = s.gameIds.indexOf(e.gameId);
            return html`
              <button type="button" class="pick ${pos >= 0 ? 'selected' : ''}" data-pick="${e.gameId}" data-index="${i}" title="${e.name}">
                ${e.image ? html`<img src="${e.image}" alt="" loading="lazy">` : html`<span class="pick-fallback" data-hue="${hueFor(e.name)}">${e.name}</span>`}
                ${pos >= 0 ? html`<span class="pick-num">${pos + 1}</span>` : ''}
              </button>`;
          }) : html`<p class="muted small">Add games to your list first.</p>`}
        </div>`;
    } else if (s.type === 'info') {
      body = html`
        <input class="input" data-field="title" data-index="${i}" value="${s.title}" maxlength="40" placeholder="Title">
        <textarea class="input" data-field="text" data-index="${i}" maxlength="600" rows="4" placeholder="Write something…">${s.text}</textarea>`;
    }
    return html`
      <div class="showcase-editor">
        <div class="showcase-editor-head">
          <strong>${info.name}</strong>
          <div class="icon-buttons">
            <button type="button" data-move="-1" data-index="${i}" aria-label="Move up" ${i === 0 ? html`disabled` : ''}>${icon('up')}</button>
            <button type="button" data-move="1" data-index="${i}" aria-label="Move down" ${i === draft.showcases.length - 1 ? html`disabled` : ''}>${icon('down')}</button>
            <button type="button" data-remove="${i}" aria-label="Remove showcase">${icon('trash')}</button>
          </div>
        </div>
        ${body}
      </div>`;
  }

  const showcasesSection = () => html`
    ${draft.showcases.length
      ? draft.showcases.map(showcaseEditor)
      : html`<p class="muted">No showcases yet. Add one below. They appear on your profile in this order.</p>`}
    <div class="add-showcase">
      <span class="muted small">Add a showcase (${draft.showcases.length}/${options.maxShowcases})</span>
      <div class="add-buttons">
        ${options.showcaseTypes.map((type) => html`
          <button type="button" class="btn btn-quiet btn-sm" data-add="${type}" ${draft.showcases.length >= options.maxShowcases ? html`disabled` : ''}>
            ${icon('plus')} ${SHOWCASE_INFO[type].name}
          </button>`)}
      </div>
    </div>`;

  const avatarSection = () => html`
    <div class="avatar-edit">
      ${avatar(previewUser(), 'xl')}
      <div class="avatar-actions">
        <label class="btn btn-accent">${icon('upload')} Upload image<input type="file" id="avatar-file" accept="image/*" hidden></label>
        ${state.user.avatarUrl ? html`<button type="button" class="btn btn-quiet" id="avatar-remove">Remove</button>` : ''}
        <p class="muted small">Square images look best. We crop and resize it for you.</p>
      </div>
    </div>
    <h3 class="subhead">Avatar frame</h3>
    <div class="swatches">
      ${options.frames.map((f) => swatch(draft.avatarFrame === f, html`data-frame="${f}"`, avatar({ ...previewUser(), avatarFrame: f }, 'md'), FRAME_NAMES[f]))}
    </div>`;

  const backgroundSection = () => html`
    <h3 class="subhead">Scenes</h3>
    <div class="swatches">
      ${options.backgrounds.map((b) => swatch(draft.background === b, html`data-background="${b}"`, html`<span class="bg-swatch bg-${b}"></span>`, BACKGROUND_NAMES[b]))}
    </div>
    <h3 class="subhead">From your games</h3>
    ${withArt.length
      ? html`<div class="swatches">${withArt.map((e) => swatch(
          draft.background === `game:${e.gameId}`,
          html`data-background="game:${e.gameId}"`,
          html`<span class="bg-swatch" data-bg="${e.backdrop || e.image}"></span>`,
          e.name,
        ))}</div>`
      : html`<p class="muted small">Add games to your list to use their artwork as your background.</p>`}`;

  const themeSection = () => html`
    <div class="colors">
      ${options.accents.map((c) => html`
        <button type="button" class="color ${draft.accent === c ? 'selected' : ''}" data-accent-pick="${c}" data-accent="${c}" aria-label="Color ${c}" aria-pressed="${draft.accent === c}"></button>`)}
    </div>`;

  mount(app, html`
    <div class="page customize" data-accent="${draft.accent}" id="customize">
      <div class="customize-head">
        <div>
          <h1>Edit profile</h1>
          <p class="muted">Changes show in the preview straight away. Nothing is public until you save.</p>
        </div>
        <a class="btn btn-quiet" href="${profileHref(state.user.username)}">View profile</a>
      </div>
      <div class="preview" id="preview">${preview()}</div>
      <div class="customize-layout">
        <nav class="side-nav">
          <a href="#general">${icon('user')} General</a>
          <a href="#avatar">${icon('image')} Avatar</a>
          <a href="#background">${icon('layers')} Background</a>
          <a href="#theme">${icon('sparkle')} Theme</a>
          <a href="#showcases">${icon('trophy')} Showcases</a>
        </nav>
        <div class="customize-sections">
          <section class="panel" id="general">
            <h2>General</h2>
            <div class="form-grid">
              <label>Display name<input class="input" data-draft="displayName" value="${draft.displayName}" maxlength="40" required></label>
              <label>Headline<input class="input" data-draft="headline" value="${draft.headline}" maxlength="60" placeholder="e.g. Souls-like addict"></label>
              <label>Location<input class="input" data-draft="country" value="${draft.country}" maxlength="40" placeholder="e.g. Dubai, UAE"></label>
              <label class="full">Bio<textarea class="input" data-draft="bio" maxlength="600" rows="4" placeholder="Tell people what you love to play">${draft.bio}</textarea></label>
            </div>
          </section>
          <section class="panel" id="avatar"><h2>Avatar</h2><div id="avatar-section">${avatarSection()}</div></section>
          <section class="panel" id="background"><h2>Profile background</h2><div id="background-section">${backgroundSection()}</div></section>
          <section class="panel" id="theme"><h2>Theme color</h2><div id="theme-section">${themeSection()}</div></section>
          <section class="panel" id="showcases"><h2>Showcases</h2><div id="showcases-section">${showcasesSection()}</div></section>
        </div>
      </div>
      <div class="save-bar" id="save-bar">
        <span>You have unsaved changes</span>
        <div>
          <button type="button" class="btn btn-quiet" id="discard">Discard</button>
          <button type="button" class="btn btn-accent" id="save">Save changes</button>
        </div>
      </div>
    </div>
  `);

  const $ = (id) => document.getElementById(id);
  // Listeners go on this page's own root so they disappear with it.
  const root = $('customize');
  const refresh = (id, render) => mount($(id), render());
  function changed({ sections = [] } = {}) {
    mount($('preview'), preview());
    root.style.setProperty('--accent', draft.accent);
    for (const s of sections) refresh(`${s}-section`, { avatar: avatarSection, background: backgroundSection, theme: themeSection, showcases: showcasesSection }[s]);
    $('save-bar').classList.toggle('show', isDirty());
  }

  // Side nav scrolls within the page instead of changing the route.
  root.querySelector('.side-nav').addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link) return;
    e.preventDefault();
    document.querySelector(link.getAttribute('href')).scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.draft) {
      draft[t.dataset.draft] = t.value;
      changed();
    } else if (t.dataset.field) {
      draft.showcases[Number(t.dataset.index)][t.dataset.field] = t.value;
      changed();
    }
  });

  root.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.frame) {
      draft.avatarFrame = d.frame;
      changed({ sections: ['avatar'] });
    } else if (d.background) {
      draft.background = d.background;
      changed({ sections: ['background'] });
    } else if (d.accentPick) {
      draft.accent = d.accentPick;
      changed({ sections: ['theme'] });
    } else if (d.add) {
      const s = { type: d.add };
      if (d.add === 'favorite') s.gameId = library[0]?.gameId || '';
      if (d.add === 'collection') Object.assign(s, { title: 'My collection', gameIds: [] });
      if (d.add === 'info') Object.assign(s, { title: 'About me', text: '' });
      draft.showcases.push(s);
      changed({ sections: ['showcases'] });
    } else if (d.remove !== undefined) {
      draft.showcases.splice(Number(d.remove), 1);
      changed({ sections: ['showcases'] });
    } else if (d.move) {
      const i = Number(d.index);
      const j = i + Number(d.move);
      [draft.showcases[i], draft.showcases[j]] = [draft.showcases[j], draft.showcases[i]];
      changed({ sections: ['showcases'] });
    } else if (d.pick) {
      const s = draft.showcases[Number(d.index)];
      const pos = s.gameIds.indexOf(d.pick);
      if (pos >= 0) s.gameIds.splice(pos, 1);
      else if (s.gameIds.length < options.maxCollection) s.gameIds.push(d.pick);
      else toast(`A collection holds up to ${options.maxCollection} games`, { error: true });
      changed({ sections: ['showcases'] });
    }
  });

  root.addEventListener('change', async (e) => {
    if (e.target.id !== 'avatar-file' || !e.target.files[0]) return;
    try {
      const image = await resizeAvatar(e.target.files[0]);
      const { user } = await api('/me/avatar', { method: 'PUT', body: { image } });
      state.user.avatarUrl = user.avatarUrl;
      changed({ sections: ['avatar'] });
      document.dispatchEvent(new Event('user-changed'));
      toast('Avatar updated');
    } catch (err) {
      toast(err.message, { error: true });
    }
  });

  root.addEventListener('click', async (e) => {
    if (e.target.closest('#avatar-remove')) {
      const { user } = await api('/me/avatar', { method: 'DELETE' });
      state.user.avatarUrl = user.avatarUrl;
      changed({ sections: ['avatar'] });
      document.dispatchEvent(new Event('user-changed'));
    }
  });

  $('discard').addEventListener('click', () => {
    runCleanups();
    customizeView(app);
  });
  $('save').addEventListener('click', async () => {
    const button = $('save');
    button.disabled = true;
    try {
      const result = await api('/me', { method: 'PATCH', body: draft });
      state.user = result.user;
      state.showcases = result.showcases;
      draft = initial();
      saved = JSON.stringify(draft);
      changed();
      document.dispatchEvent(new Event('user-changed'));
      toast('Profile saved');
    } catch (err) {
      toast(err.message, { error: true });
    } finally {
      button.disabled = false;
    }
  });

  const warn = (e) => {
    if (isDirty()) e.preventDefault();
  };
  window.addEventListener('beforeunload', warn);
  onLeave(() => window.removeEventListener('beforeunload', warn));
}
