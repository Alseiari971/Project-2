// The Admin Panel (#/admin), for accounts with the admin role: the site at a
// glance, users and their roles, the cloud catalog of Arabic packs (drop a
// signed pack's .zip to publish it), what players ask for, the Windows
// installer the website hands out and, in the desktop app, the Pack Studio.
// The server checks the role on every request; hiding the page is only a nicety.
import { html, bdi, mount, state, api, toast, onLeave } from '../lib.js';
import { pillGroup, emptyState } from '../components.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

const desktop = window.gameshelfDesktop;
const TABS = ['overview', 'users', 'packs', 'requests', 'installer', ...(desktop?.studio ? ['studio'] : [])];
const TAB_LABELS = { overview: 'Overview', users: 'Users', packs: 'Arabic packs', requests: 'Requests', installer: 'Windows app', studio: 'Pack Studio' };
const ENGINE_LABELS = { auto: 'Detect it', unreal: 'Unreal Engine', unity: 'Unity', reengine: 'Capcom RE Engine', godot: 'Godot', renpy: "Ren'Py", overlay: 'Accessibility overlay' };

const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const errorText = (err) => t(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));

/** Sends a file as the request body, reporting upload progress (0 to 1). */
function upload(url, file, { method = 'POST', type = 'application/octet-stream', onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('Content-Type', type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error ? t(data.error) : t('Request failed ({status})', { status: xhr.status })));
    };
    xhr.onerror = () => reject(new Error(t('The upload stopped. Check your internet connection.')));
    xhr.send(file);
  });
}

/** A drop zone that takes one file (or a click to pick one). */
function dropZone(el, { accept, onFile }) {
  const input = el.querySelector('input[type=file]');
  el.addEventListener('click', (e) => {
    if (e.target !== input) input.click();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => input.files[0] && onFile(input.files[0]));
  for (const type of ['dragenter', 'dragover']) {
    el.addEventListener(type, (e) => {
      e.preventDefault();
      el.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) el.addEventListener(type, () => el.classList.remove('is-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (accept && !accept.test(file.name)) return toast(t('That isn\'t the right kind of file.'), { error: true });
    onFile(file);
  });
}

export async function adminView(app, params) {
  if (!state.user) {
    location.hash = '#/login';
    return;
  }
  if (state.user.role !== 'admin') {
    mount(app, html`<div class="page">${emptyState(t('Admins only'), t('This part of GameShelf is for the people who run it.'), html`<a class="pill-btn pill-light" href="#/">${t('Go home')}</a>`)}</div>`);
    return;
  }
  document.title = `${t('Admin Panel')} · ${t('GameShelf')}`;
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'overview';
  mount(app, html`
    <div class="page admin">
      <div class="page-head"><h1>${icon('shield')} ${t('Admin Panel')}</h1></div>
      ${pillGroup(TABS.map((key) => ({ key, label: t(TAB_LABELS[key]), href: `#/admin?tab=${key}` })), tab)}
      <div id="admin-body" class="admin-body"></div>
    </div>`);
  const body = document.getElementById('admin-body');
  await { overview, users, packs, requests, installer, studio }[tab](body);
}

// ---- Overview ------------------------------------------------------------------

async function overview(body) {
  const s = await api('/admin/stats');
  const tile = (value, label) => html`<div class="stat-tile"><strong>${value.toLocaleString()}</strong><span>${label}</span></div>`;
  mount(body, html`
    <div class="stat-grid">
      ${tile(s.users, t('Accounts'))}
      ${tile(s.newUsersThisWeek, t('New this week'))}
      ${tile(s.admins, t('Admins'))}
      ${tile(s.packs.packs, t('Arabic packs in the catalog'))}
      ${tile(s.packs.downloads, t('Pack downloads'))}
      ${tile(s.packs.players, t('Players who downloaded a pack'))}
      ${tile(s.translatedLines, t('Lines in the shared Arabic memory'))}
      ${tile(s.requests, t('Arabic requests'))}
    </div>
    ${s.packKey ? '' : html`<p class="form-error">${t('The server has no pack signing key, so it can\'t take packs. Put the public key in desktop/config.json (localizationPackKey) or PACK_PUBLIC_KEY.')}</p>`}`);
}

// ---- Users -----------------------------------------------------------------------

async function users(body) {
  mount(body, html`
    <form class="search-bar" id="user-search" role="search">
      <label class="search-field">${icon('search')}<input type="search" name="q" placeholder="${t('Find a user')}" aria-label="${t('Find a user')}" autocomplete="off"></label>
    </form>
    <div id="user-list"></div>`);
  const list = document.getElementById('user-list');
  const show = async (q = '') => {
    const { users: rows } = await api(`/admin/users?q=${encodeURIComponent(q)}`);
    mount(list, rows.length
      ? html`<div class="admin-table">${rows.map((u) => html`
          <div class="admin-row">
            <div><strong>${bdi(u.displayName)}</strong> <span class="muted small">${bdi(`@${u.username}`)}</span></div>
            <span class="muted small">${t('{n} games', { n: u.games })}</span>
            <span class="role-tag ${u.role}">${t(u.role === 'admin' ? 'Admin' : 'User')}</span>
            <button class="btn btn-sm btn-quiet" type="button" data-role="${u.role === 'admin' ? 'user' : 'admin'}" data-user="${u.username}">${t(u.role === 'admin' ? 'Make user' : 'Make admin')}</button>
          </div>`)}</div>`
      : html`<p class="muted">${t('No users match.')}</p>`);
  };
  list.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-role]');
    if (!button) return;
    button.disabled = true;
    try {
      await api(`/admin/users/${encodeURIComponent(button.dataset.user)}`, { method: 'PATCH', body: { role: button.dataset.role } });
      toast(t('{name} is now {role}', { name: button.dataset.user, role: t(button.dataset.role === 'admin' ? 'an admin' : 'a user') }));
      await show(document.querySelector('#user-search input').value);
    } catch (err) {
      toast(errorText(err), { error: true });
      button.disabled = false;
    }
  });
  const form = document.getElementById('user-search');
  form.addEventListener('submit', (e) => e.preventDefault());
  form.querySelector('input').addEventListener('input', (e) => show(e.target.value.trim()));
  await show();
}

// ---- Arabic packs ----------------------------------------------------------------

async function packs(body) {
  mount(body, html`
    <section class="panel">
      <h2>${t('Publish a pack')}</h2>
      <div class="drop-zone" id="pack-drop" tabindex="0" role="button" aria-label="${t('Drop a signed pack (.zip) here, or click to choose one')}">
        ${icon('upload')}
        <strong>${t('Drop a signed pack (.zip) here, or click to choose one')}</strong>
        <span class="muted small">${t('A .zip of the pack folder (pack.json, its signature and its files). It\'s checked against GameShelf\'s pack key before it goes in the catalog.')}</span>
        <input type="file" accept=".zip,application/zip" hidden>
        <div class="upload-bar" hidden><span></span></div>
      </div>
    </section>
    <section class="panel">
      <h2>${t('The catalog')}</h2>
      <div id="pack-list"></div>
    </section>`);
  const list = document.getElementById('pack-list');
  const show = async () => {
    const { packs: rows } = await api('/admin/packs');
    mount(list, rows.length
      ? html`<div class="admin-table">${rows.map((p) => html`
          <div class="admin-row ${p.published ? '' : 'is-off'}">
            <div><strong>${bdi(p.title || p.id)}</strong>
              <span class="muted small">${p.id} · ${t('version {version}', { version: p.version })} · ${t(ENGINE_LABELS[p.engine] || p.engine)} · ${p.steamAppId ? t('Steam app {id}', { id: p.steamAppId }) : p.gameSlug} · ${formatSize(p.size)}</span></div>
            <span class="muted small">${t('{n} downloads', { n: p.downloads })}</span>
            <label class="check-row small"><input type="checkbox" data-publish="${p.id}" data-version="${p.version}" ${p.published ? 'checked' : ''}> ${t('Published')}</label>
            <button class="btn btn-sm btn-quiet" type="button" data-delete="${p.id}" data-version="${p.version}">${t('Delete')}</button>
          </div>`)}</div>`
      : html`<p class="muted">${t('No packs yet. Publish one from the Pack Studio in the desktop app, or drop its .zip above.')}</p>`);
  };
  list.addEventListener('change', async (e) => {
    const box = e.target.closest('[data-publish]');
    if (!box) return;
    try {
      await api(`/admin/packs/${encodeURIComponent(box.dataset.publish)}/${encodeURIComponent(box.dataset.version)}`, { method: 'PATCH', body: { published: box.checked } });
      toast(t(box.checked ? 'Published' : 'Taken out of the catalog'));
    } catch (err) {
      toast(errorText(err), { error: true });
    }
    show();
  });
  list.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-delete]');
    if (!button || !confirm(t('Delete version {version} of {id}? Players who have it keep it.', { version: button.dataset.version, id: button.dataset.delete }))) return;
    try {
      await api(`/admin/packs/${encodeURIComponent(button.dataset.delete)}/${encodeURIComponent(button.dataset.version)}`, { method: 'DELETE' });
    } catch (err) {
      toast(errorText(err), { error: true });
    }
    show();
  });
  const zone = document.getElementById('pack-drop');
  const bar = zone.querySelector('.upload-bar');
  dropZone(zone, {
    accept: /\.zip$/i,
    onFile: async (file) => {
      bar.hidden = false;
      try {
        const { pack } = await upload('/api/admin/packs', file, { type: 'application/zip', onProgress: (p) => bar.firstElementChild.style.setProperty('width', `${Math.round(p * 100)}%`) });
        toast(t('Published {name} {version}', { name: pack.title || pack.id, version: pack.version }));
        show();
      } catch (err) {
        toast(errorText(err), { error: true });
      } finally {
        bar.hidden = true;
      }
    },
  });
  await show();
}

// ---- Requests --------------------------------------------------------------------

async function requests(body) {
  const { requests: rows } = await api('/admin/requests');
  const STATUS = { ready: 'Arabic ready', partial: 'Partly translated', none: 'Not started' };
  mount(body, rows.length
    ? html`<div class="admin-table">${rows.map((r) => html`
        <div class="admin-row">
          <div><strong>${bdi(r.name || r.game)}</strong> <span class="muted small">${r.game}</span></div>
          <span>${r.requests === 1 ? t('1 player asked') : t('{count} players asked', { count: r.requests })}</span>
          <span class="muted small">${t(STATUS[r.status])}${r.total ? ` · ${r.translated}/${r.total}` : ''}</span>
        </div>`)}</div>`
    : html`<p class="muted">${t('Nobody has asked for Arabic in a game yet.')}</p>`);
}

// ---- Windows installer -------------------------------------------------------------

async function installer(body) {
  const info = await api('/download/info');
  mount(body, html`
    <section class="panel">
      <h2>${t('The Windows app')}</h2>
      <p class="muted">${info.available
        ? (info.size ? t('The website\'s download button hands out the installer below ({size}).', { size: formatSize(info.size) }) : t('The download button sends people to DOWNLOAD_URL.'))
        : t('There\'s no installer yet: the website\'s download button says it\'s coming soon.')}</p>
      ${info.available ? html`<p><a class="pill-btn" href="/download/windows">${icon('download')} ${t('Download it')}</a></p>` : ''}
      <div class="drop-zone" id="exe-drop" tabindex="0" role="button" aria-label="${t('Drop GameShelf-Setup.exe here, or click to choose it')}">
        ${icon('upload')}
        <strong>${t('Drop GameShelf-Setup.exe here, or click to choose it')}</strong>
        <span class="muted small">${t('Made with npm run dist:win (it\'s in the dist folder). It replaces the one the website hands out.')}</span>
        <input type="file" accept=".exe" hidden>
        <div class="upload-bar" hidden><span></span></div>
      </div>
    </section>`);
  const zone = document.getElementById('exe-drop');
  const bar = zone.querySelector('.upload-bar');
  dropZone(zone, {
    accept: /\.exe$/i,
    onFile: async (file) => {
      bar.hidden = false;
      try {
        await upload('/api/admin/installer', file, { method: 'PUT', onProgress: (p) => bar.firstElementChild.style.setProperty('width', `${Math.round(p * 100)}%`) });
        toast(t('The new installer is up.'));
        installer(body);
      } catch (err) {
        toast(errorText(err), { error: true });
        bar.hidden = true;
      }
    },
  });
}

// ---- Pack Studio (desktop app) ---------------------------------------------------------

async function studio(body) {
  const s = await desktop.studio.settings();
  const saved = JSON.parse(sessionStorage.getItem('gs-studio') || '{}');
  const form = { engine: 'auto', translate: 'shared', ...saved };
  const path = (name, value, kind, label) => html`
    <div class="path-field">
      <span class="path-value" id="${name}-value" dir="ltr">${value || t('Not chosen')}</span>
      <button class="btn btn-sm btn-quiet" type="button" data-pick="${kind}" data-into="${name}">${label}</button>
    </div>`;
  mount(body, html`
    <section class="panel studio">
      <h2>${t('1. The game')}</h2>
      <div class="studio-source">
        ${path('source', form.source, 'folder', t('Choose game folder'))}
        <button class="btn btn-sm btn-quiet" type="button" data-pick="file" data-into="source">${t('…or a file with its text')}</button>
      </div>
      <div class="form-grid">
        <label>${t('Engine')}<select class="input" name="engine">${s.engines.map((e) => html`<option value="${e}" ${form.engine === e ? 'selected' : ''}>${t(ENGINE_LABELS[e])}</option>`)}</select></label>
        <label>${t('Title')}<input class="input" name="title" value="${form.title || ''}" placeholder="Resident Evil 3 Demo"></label>
        <label>${t('Steam app ID')}<input class="input" name="steamAppId" inputmode="numeric" value="${form.steamAppId || ''}" placeholder="1173690"></label>
        <label>${t('…or GameShelf game ID')}<input class="input" name="gameId" value="${form.gameId || ''}"></label>
        <label>${t('Pack ID')}<input class="input" name="id" value="${form.id || ''}" placeholder="re3-demo-ar" dir="ltr"></label>
        <label>${t('Version')}<input class="input" name="version" value="${form.version || '1.0.0'}" dir="ltr"></label>
      </div>
      <p class="muted small">${t('RE Engine games: the game\'s file list (from REE.PAK.Tool) tells the Studio which fonts to give the Arabic font.')}</p>
      ${path('pakList', form.pakList, 'list', t('Choose file list'))}

      <h2>${t('2. The Arabic')}</h2>
      <div class="lang-choices" role="radiogroup" aria-label="${t('Translate with')}">
        ${[['shared', 'GameShelf\'s shared memory'], ['provider', 'My own API key'], ['none', 'My checked translations only']].map(([key, label]) => html`
          <button type="button" class="mood-chip ${form.translate === key ? 'active' : ''}" role="radio" aria-checked="${form.translate === key}" data-translate="${key}">${t(label)}</button>`)}
      </div>
      <div class="form-grid" id="provider-fields" ${form.translate === 'provider' ? '' : 'hidden'}>
        <label>${t('Provider')}<select class="input" name="provider">${['openai', 'gemini'].map((p) => html`<option value="${p}" ${s.provider === p ? 'selected' : ''}>${p === 'openai' ? 'OpenAI' : 'Google Gemini'}</option>`)}</select></label>
        <label>${t('Model')}<input class="input" name="model" value="${s.model}" placeholder="gpt-4.1-mini" dir="ltr"></label>
        <label class="full">${t('API key')}<input class="input" name="apiKey" type="password" autocomplete="off" placeholder="${s.hasKey[s.provider] ? t('Saved. Type a new one to replace it.') : 'sk-…'}" dir="ltr"></label>
        <p class="muted small full">${s.keysStoredSafely ? t('Saved on this PC, encrypted by Windows. It\'s only sent to the provider.') : t('Kept until you close GameShelf: this PC can\'t store it encrypted.')}</p>
      </div>
      ${path('reviewed', form.reviewed, 'csv', t('Use my checked translations.csv'))}

      <h2>${t('3. Sign and build')}</h2>
      <div class="studio-key ${s.keyMatchesApp ? 'ok' : 'warn'}">
        ${path('keyFile', s.keyFile, 'key', t('Choose pack-signing.key'))}
        <p class="small">${!s.keyFile
          ? t('Packs are signed with GameShelf\'s private key (pack-signing.key), kept only on admins\' PCs.')
          : !s.keyOk ? t('That file isn\'t a signing key.')
            : s.keyMatchesApp ? t('This is GameShelf\'s key: players\' apps will accept these packs.')
              : t('This key isn\'t the one players\' apps check with (localizationPackKey in desktop/config.json), so they won\'t accept its packs.')}</p>
        <button class="btn btn-sm btn-quiet" type="button" id="make-keys">${t('Make a new key pair')}</button>
      </div>
      <div class="settings-actions">
        <button class="btn btn-light" type="button" id="build" ${s.canBuild ? '' : 'disabled'}>${t('Build pack')}</button>
        <button class="btn btn-quiet" type="button" id="cancel" hidden>${t('Stop')}</button>
      </div>
      ${s.canBuild ? '' : html`<p class="form-error">${t('This copy of GameShelf has no pack builder.')}</p>`}
      <div class="studio-progress" id="studio-progress" hidden><span></span></div>
      <pre class="studio-log" id="studio-log" dir="ltr" aria-live="polite"></pre>
      <div class="studio-result" id="studio-result" hidden></div>
    </section>`);

  const read = () => {
    const values = Object.fromEntries([...body.querySelectorAll('input[name], select[name]')].map((el) => [el.name, el.value.trim()]));
    for (const name of ['source', 'pakList', 'reviewed']) values[name] = form[name] || '';
    return { ...form, ...values };
  };
  const remember = () => {
    const { apiKey, ...rest } = read();
    sessionStorage.setItem('gs-studio', JSON.stringify(rest));
  };
  body.addEventListener('input', remember);

  body.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-pick]');
    const choice = e.target.closest('[data-translate]');
    if (choice) {
      form.translate = choice.dataset.translate;
      body.querySelectorAll('[data-translate]').forEach((b) => {
        b.classList.toggle('active', b === choice);
        b.setAttribute('aria-checked', String(b === choice));
      });
      document.getElementById('provider-fields').hidden = form.translate !== 'provider';
      remember();
    }
    if (!pick) return;
    try {
      const chosen = await desktop.studio.pick(pick.dataset.pick);
      if (!chosen) return;
      if (pick.dataset.into === 'keyFile') {
        await desktop.studio.saveSettings({ keyFile: chosen });
        return studio(body);
      }
      form[pick.dataset.into] = chosen;
      document.getElementById(`${pick.dataset.into}-value`).textContent = chosen;
      remember();
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  });

  document.getElementById('make-keys').addEventListener('click', async () => {
    try {
      const folder = await desktop.studio.pick('keys-folder');
      if (!folder) return;
      const made = await desktop.studio.makeKeys(folder);
      await navigator.clipboard?.writeText(made.publicKey).catch(() => {});
      toast(t('New key pair made. Its public key is on the clipboard: put it in desktop/config.json as localizationPackKey, then build the app again.'));
      studio(body);
    } catch (err) {
      toast(errorText(err), { error: true });
    }
  });

  const log = document.getElementById('studio-log');
  const progress = document.getElementById('studio-progress');
  const result = document.getElementById('studio-result');
  const stopLog = desktop.studio.onLog(({ line, stream }) => {
    const row = document.createElement('div');
    row.textContent = line;
    if (stream === 'stderr') row.className = 'is-error';
    log.append(row);
    log.scrollTop = log.scrollHeight;
  });
  const stopProgress = desktop.studio.onProgress((p) => {
    const share = p.phase === 'translating' && p.asking ? p.asked / p.asking : { reading: 0.15, packing: 0.9, done: 1 }[p.phase] || 0.05;
    progress.firstElementChild.style.setProperty('width', `${Math.round(share * 100)}%`);
  });
  onLeave(stopLog);
  onLeave(stopProgress);

  const cancel = document.getElementById('cancel');
  cancel.addEventListener('click', () => desktop.studio.cancel());
  document.getElementById('build').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const options = read();
    try {
      if (options.translate === 'provider') {
        await desktop.studio.saveSettings({ provider: options.provider, model: options.model, ...(options.apiKey ? { apiKey: options.apiKey } : {}) });
        body.querySelector('input[name=apiKey]').value = '';
      }
    } catch (err) {
      return toast(errorText(err), { error: true });
    }
    delete options.apiKey;
    button.disabled = true;
    cancel.hidden = false;
    progress.hidden = false;
    result.hidden = true;
    log.textContent = '';
    try {
      const built = await desktop.studio.build(options);
      result.hidden = false;
      mount(result, html`
        <p><strong>${t('Pack ready:')}</strong> <span dir="ltr">${options.id} ${options.version}</span></p>
        <div class="settings-actions">
          <button class="btn btn-light" type="button" data-step="publish">${icon('upload')} ${t('Publish to Cloud Catalog')}</button>
          <button class="btn btn-quiet" type="button" data-step="add">${t('Add to this PC')}</button>
          <button class="btn btn-quiet" type="button" data-step="review">${t('Open translations.csv')}</button>
          <button class="btn btn-quiet" type="button" data-step="folder">${t('Open folder')}</button>
        </div>
        <p class="muted small">${t('Fix lines in translations.csv, save it, pick it under "Use my checked translations.csv", choose "My checked translations only" and build again with a new version.')}</p>`);
      result.onclick = async (ev) => {
        const step = ev.target.closest('[data-step]')?.dataset.step;
        if (!step) return;
        try {
          if (step === 'publish') {
            const pack = await desktop.studio.publish(built.packDir);
            toast(t('Published {name} {version}: players get it the next time they turn Arabic on.', { name: pack.title || pack.id, version: pack.version }));
          } else if (step === 'add') {
            const added = await desktop.studio.addLocal(built.packDir);
            toast(t('Added {name}', { name: added.title || added.id }));
          } else if (step === 'review') {
            await desktop.studio.open(built.review);
          } else {
            await desktop.studio.open(built.outDir);
          }
        } catch (err) {
          toast(errorText(err), { error: true });
        }
      };
    } catch (err) {
      toast(errorText(err), { error: true });
    } finally {
      button.disabled = false;
      cancel.hidden = true;
    }
  });
}
