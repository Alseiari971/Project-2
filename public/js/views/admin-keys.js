// Admin Panel → AES Keys & Recipes ("إدارة مفاتيح التشفير ووصفات المحرك"): an
// admin gives an encrypted Unreal game's AES key ahead of time, so players'
// apps can read it the first time anyone asks for its Arabic.
//
// Every key goes out as a key recipe signed with GameShelf's pack key, which
// never reaches the server:
// - in the desktop app, the Pack Studio signs with pack-signing.key on that PC;
// - in a browser, the admin unlocks the key in this tab only (admin-signer.js),
//   where it's held in memory, never sent or saved, and forgotten on Lock or leave.
// The server checks each signature against GameShelf's public key before keeping it.
import { html, bdi, mount, api, toast, onLeave } from '../lib.js';
import { icon } from '../icons.js';
import { t, locale } from '../i18n.js';
import { readPrivateKey, createSigner, normalizeAesKey, maskAesKey, keyRecipeText, SignerError } from '../admin-signer.js';

const desktop = window.gameshelfDesktop;
const CONTAINERS = {
  iostore: { label: 'Unreal Engine 5 (IoStore .utoc/.ucas)', note: 'UE5 IoStore (.utoc/.ucas)' },
  pak: { label: 'Unreal Engine 4 (.pak)', note: 'UE4 .pak' },
};
const errorText = (err) => t(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
const shortDate = (text) => (text ? new Date(`${String(text).replace(' ', 'T')}Z`).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

/** "steam:<app id>" or "game:<id>" for a catalog game, or for what an admin typed ("steam:123", "2109880"). */
const gameKeyOf = (game) => (game.steamAppId ? `steam:${game.steamAppId}` : `game:${game.id}`);
function typedGameKey(text) {
  const value = String(text || '').trim();
  if (/^\d{1,10}$/.test(value)) return `steam:${value}`;
  if (/^steam:\d{1,10}$/.test(value) || /^game:[a-z0-9][a-z0-9-]{0,99}$/.test(value)) return value;
  return null;
}
const noteFor = (container, extra) => [CONTAINERS[container]?.note, String(extra || '').trim()].filter(Boolean).join(' · ');

// The signer: the desktop app's Pack Studio, or the key unlocked in this tab.
let signer = null;
const lock = () => {
  signer?.lock();
  signer = null;
};

/**
 * Signs and sends recipes: [{ game, title, container, aesKey, note }] → the
 * server's results, one per item ({ ok, recipe, answered } or { ok: false, error }).
 */
async function signAndSend(items) {
  if (desktop?.attachRecipe) {
    const results = [];
    for (const item of items) {
      try {
        const done = await desktop.attachRecipe(item.game, keyRecipeText(item.game, item.aesKey, item.note), { title: item.title, container: item.container });
        results.push({ game: item.game, ok: true, ...done });
      } catch (err) {
        results.push({ game: item.game, ok: false, error: errorText(err) });
      }
    }
    return results;
  }
  if (!signer) throw new SignerError('Unlock the admin signer first.');
  const signed = [];
  for (const item of items) {
    const recipe = keyRecipeText(item.game, item.aesKey, item.note);
    signed.push({ game: item.game, title: item.title, container: item.container, recipe, signature: await signer.sign(recipe) });
  }
  if (signed.length === 1) {
    const done = await api('/admin/recipes', { method: 'POST', body: signed[0] });
    return [{ game: signed[0].game, ok: true, ...done }];
  }
  return (await api('/admin/recipes/batch', { method: 'POST', body: { items: signed } })).results;
}

export async function keysTab(body, params = new URLSearchParams()) {
  onLeave(lock);
  const { recipes, publicKeys } = await api('/admin/recipes');
  mount(body, html`
    <h2 class="admin-board-head">${icon('shield')} ${t('AES Keys & Engine Recipes Manager')}</h2>
    <p class="muted small">${t('Give an encrypted Unreal game\'s AES key here, before or after anyone asks for its Arabic. GameShelf never looks for keys: use the key the game\'s publisher or its modding community published. Players\' apps get it signed with GameShelf\'s pack key, and use it only to read the game\'s text.')}</p>

    <section class="panel signer-panel" id="signer"></section>

    <section class="panel">
      <div class="panel-head-row">
        <h2>${t('Quick add an AES key')}</h2>
        <button class="btn btn-sm btn-quiet" type="button" id="bulk-open">${icon('list')} ${t('Bulk paste keys')}</button>
      </div>
      <form class="key-form" id="key-form" autocomplete="off">
        <label class="key-game">${t('Game')}
          <input class="input" name="game" placeholder="${t('Search the catalog, or a Steam app id')}" autocomplete="off" spellcheck="false" required>
          <span class="muted small" id="key-game-picked"></span>
          <ul class="key-suggest" id="key-suggest" role="listbox" hidden></ul>
        </label>
        <label>${t('Engine')}
          <select class="input" name="container">
            ${Object.entries(CONTAINERS).map(([id, c]) => html`<option value="${id}">${t(c.label)}</option>`)}
          </select>
        </label>
        <label class="key-aes">${t('AES-256 key')}
          <span class="key-input-row">
            <input class="input" name="aesKey" placeholder="0x…" autocomplete="off" spellcheck="false" dir="ltr" required>
            <span class="key-valid" id="key-valid" aria-live="polite"></span>
          </span>
          <span class="muted small">${t('"0x" and 64 hex digits, or 44 characters of base64.')}</span>
        </label>
        <label>${t('Notes / container path (optional)')}
          <input class="input" name="note" maxlength="300" placeholder="Content/Paks/~mods" spellcheck="false">
        </label>
        <div class="row-actions">
          <button class="btn btn-accent" type="submit" id="key-save">${icon('check')} ${t('Sign & save recipe')}</button>
        </div>
      </form>
    </section>

    <section class="panel">
      <h2>${t('Signed recipes')}</h2>
      <div id="recipe-list"></div>
    </section>

    <dialog class="consent-dialog bulk-dialog" id="bulk-dialog">
      <form method="dialog" id="bulk-form">
        <h2>${t('Bulk paste keys')}</h2>
        <p class="muted small">${t('One game per line: its name, Steam app id or steam:<id>, then | and its key.')}</p>
        <textarea class="input bulk-text" name="lines" rows="7" dir="ltr" spellcheck="false" placeholder="Phantom Blade Zero | 0x4BC8…E01D&#10;2358720 | 0x…"></textarea>
        <label>${t('Engine')}
          <select class="input" name="container">
            ${Object.entries(CONTAINERS).map(([id, c]) => html`<option value="${id}">${t(c.label)}</option>`)}
          </select>
        </label>
        <div class="row-actions">
          <button class="btn" type="button" id="bulk-check">${t('Check lines')}</button>
          <button class="btn btn-accent" type="button" id="bulk-sign" disabled>${t('Sign & attach checked')}</button>
          <button class="btn btn-quiet" value="close">${t('Close')}</button>
        </div>
        <div id="bulk-table"></div>
      </form>
    </dialog>`);

  // ---- The signer ----
  const signerBox = document.getElementById('signer');
  // In the desktop app: the Pack Studio's pack-signing.key on this PC, chosen here or in the Pack Studio.
  async function showAppSigner() {
    const s = await desktop.studio?.settings?.().catch(() => null);
    const ready = Boolean(s?.keyFile && s.keyOk && s.keyMatchesApp);
    const note = !s?.keyFile
      ? t('No signing key chosen on this PC yet. Choose GameShelf\'s pack-signing.key: it stays on this PC and is never uploaded.')
      : !s.keyOk ? t('That file isn\'t a signing key.')
        : !s.keyMatchesApp ? t('This key isn\'t the one players\' apps check with, so they won\'t accept what it signs. Choose GameShelf\'s pack-signing.key.')
          : t('Signed in this app with the Pack Studio\'s key (pack-signing.key on this PC). It never leaves this PC.');
    mount(signerBox, html`
      <h2>${icon('shield')} ${t('Signer')}</h2>
      <p class="signer-state ${ready ? 'ok' : 'warn'}">${ready ? icon('check') : icon('info')} ${note}</p>
      ${s?.keyFile ? html`<p class="muted small" dir="ltr">${s.keyFile}</p>` : ''}
      <div class="row-actions"><button class="btn btn-sm ${ready ? '' : 'btn-accent'}" type="button" id="signer-pick">${icon('upload')} ${ready ? t('Choose another key') : t('Choose pack-signing.key')}</button></div>`);
    document.getElementById('signer-pick').addEventListener('click', async () => {
      try {
        const chosen = await desktop.studio.pick('key');
        if (!chosen) return;
        await desktop.studio.saveSettings({ keyFile: chosen });
        await showAppSigner();
      } catch (err) {
        toast(errorText(err), { error: true });
      }
    });
  }
  const showSigner = () => {
    if (desktop?.attachRecipe) {
      showAppSigner();
      return;
    }
    mount(signerBox, signer
      ? html`
        <h2>${icon('shield')} ${t('Admin signer')}</h2>
        <p class="signer-state ok">${icon('check')} ${t('Unlocked in this tab only ({method}). It\'s GameShelf\'s pack key.', { method: signer.method === 'webcrypto' ? 'WebCrypto Ed25519' : 'Ed25519' })}</p>
        <p class="muted small">${t('The key is in this tab\'s memory only: it isn\'t sent, saved or remembered, and leaving this tab or closing the page forgets it.')}</p>
        <div class="row-actions"><button class="btn btn-sm" type="button" id="signer-lock">${t('Lock')}</button></div>`
      : html`
        <h2>${icon('shield')} ${t('Unlock admin signer (in-browser only)')}</h2>
        <p class="muted small">${t('Pick or paste GameShelf\'s pack-signing.key (PEM/PKCS#8, or the raw Ed25519 key as hex or base64). It stays in this tab\'s memory and is never sent to the server, which only checks signatures with the public key.')}</p>
        <div class="signer-form">
          <input class="input" type="password" id="signer-paste" placeholder="-----BEGIN PRIVATE KEY-----…" autocomplete="off" spellcheck="false" aria-label="${t('Paste the private key')}">
          <label class="btn btn-quiet signer-file">${icon('upload')} ${t('Pick key file')}<input type="file" id="signer-file" accept=".key,.pem,.txt" hidden></label>
          <button class="btn btn-accent" type="button" id="signer-unlock">${t('Unlock')}</button>
        </div>
        ${publicKeys.length ? '' : html`<p class="form-error">${t('The server has no pack public key (PACK_PUBLIC_KEY), so it can\'t check signatures yet.')}</p>`}`);
    document.getElementById('signer-lock')?.addEventListener('click', () => {
      lock();
      showSigner();
      toast(t('Signer locked. The key is forgotten.'));
    });
    const unlock = async (input) => {
      try {
        const made = await createSigner(readPrivateKey(input));
        if (!publicKeys.includes(made.publicKey)) {
          made.lock();
          throw new SignerError('That key isn\'t GameShelf\'s pack key, so players\' apps would refuse what it signs.');
        }
        lock();
        signer = made;
        showSigner();
        toast(t('Signer unlocked in this tab.'));
      } catch (err) {
        toast(errorText(err), { error: true });
      }
    };
    const paste = document.getElementById('signer-paste');
    document.getElementById('signer-unlock')?.addEventListener('click', () => {
      const value = paste.value;
      paste.value = '';
      unlock(value);
    });
    document.getElementById('signer-file')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > 16 * 1024) return toast(t('That file is too big to be a signing key.'), { error: true });
      unlock(new Uint8Array(await file.arrayBuffer()));
    });
  };
  showSigner();

  // ---- Quick add ----
  const form = document.getElementById('key-form');
  const suggest = document.getElementById('key-suggest');
  const picked = document.getElementById('key-game-picked');
  let chosen = null; // { game, title }
  const showPicked = () => {
    picked.textContent = chosen ? `${chosen.title ? `${chosen.title} · ` : ''}${chosen.game}` : '';
  };
  // From Admin Panel → Requests ("Add AES key…"): the game is filled in.
  const asked = typedGameKey(params.get('game'));
  if (asked) {
    chosen = { game: asked, title: String(params.get('title') || '').slice(0, 200) };
    form.game.value = chosen.title || asked;
    showPicked();
  }
  let searchTimer = null;
  let searchFor = '';
  form.game.addEventListener('input', () => {
    const text = form.game.value.trim();
    const typed = typedGameKey(text);
    chosen = typed ? { game: typed, title: '' } : null;
    showPicked();
    clearTimeout(searchTimer);
    if (typed || text.length < 2) {
      suggest.hidden = true;
      return;
    }
    searchTimer = setTimeout(async () => {
      searchFor = text;
      const { results = [] } = await api(`/games?search=${encodeURIComponent(text)}`).catch(() => ({}));
      if (searchFor !== text) return;
      mount(suggest, html`${results.slice(0, 8).map((g) => html`
        <li role="option" data-key="${gameKeyOf(g)}" data-title="${g.name}">
          ${g.image ? html`<img src="${g.image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : html`<span class="key-suggest-blank"></span>`}
          <span><strong>${bdi(g.name)}</strong> <span class="muted small" dir="ltr">${gameKeyOf(g)}</span></span>
        </li>`)}`);
      suggest.hidden = !results.length;
    }, 250);
  });
  suggest.addEventListener('click', (e) => {
    const li = e.target.closest('[data-key]');
    if (!li) return;
    chosen = { game: li.dataset.key, title: li.dataset.title };
    form.game.value = li.dataset.title;
    suggest.hidden = true;
    showPicked();
  });
  const valid = document.getElementById('key-valid');
  const checkKey = () => {
    const ok = normalizeAesKey(form.aesKey.value);
    valid.className = `key-valid ${form.aesKey.value ? (ok ? 'ok' : 'bad') : ''}`;
    mount(valid, form.aesKey.value ? (ok ? html`${icon('check')} ${t('Valid AES-256 key')}` : html`${icon('x')} ${t('Not an AES-256 key yet')}`) : html``);
    return ok;
  };
  form.aesKey.addEventListener('input', checkKey);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const aesKey = checkKey();
    if (!chosen) return toast(t('Pick the game from the list, or type its Steam app id.'), { error: true });
    if (!aesKey) return toast(t('That isn\'t an AES-256 key: "0x" and 64 hex digits, or 44 characters of base64.'), { error: true });
    const button = document.getElementById('key-save');
    button.disabled = true;
    try {
      const [result] = await signAndSend([{ ...chosen, container: form.container.value, aesKey, note: noteFor(form.container.value, form.note.value) }]);
      if (!result.ok) throw new Error(result.error);
      toast(result.answered === 1
        ? t('Key signed and saved. 1 waiting request is ready, and that player was told.')
        : result.answered
        ? t('Key signed and saved. {n} waiting requests are ready, and those players were told.', { n: result.answered })
        : t('Key signed and saved. Players\' apps can read this game now.'));
      form.reset();
      chosen = null;
      showPicked();
      checkKey();
      await showList();
    } catch (err) {
      toast(errorText(err), { error: true });
    }
    button.disabled = false;
  });

  // ---- Signed recipes ----
  const list = document.getElementById('recipe-list');
  const showList = async (rows = null) => {
    const all = rows || (await api('/admin/recipes')).recipes;
    mount(list, all.length
      ? html`<div class="admin-table recipe-table">${all.map((r) => html`
          <div class="admin-row">
            <div><strong>${bdi(r.title || r.game)}</strong> <span class="muted small" dir="ltr">${r.game}</span></div>
            <span class="muted small">${r.engine === 'unreal' ? t(CONTAINERS[r.container]?.label || 'Unreal Engine') : t('Engine recipe ({tool})', { tool: r.tool || r.engine })}</span>
            <code class="masked-key" dir="ltr">${r.maskedKey || '—'}</code>
            <span class="sig-state ${r.verified ? 'ok' : 'bad'}">${r.verified ? html`${icon('check')} ${t('Verified Ed25519')}` : html`${icon('x')} ${t('Not signed with today\'s key')}`}</span>
            <span class="muted small">${shortDate(r.updatedAt)}${r.requestsAnswered ? html` · <span class="boost-badge">${r.requestsAnswered === 1 ? t('1 request ready') : t('{n} requests ready', { n: r.requestsAnswered })}</span>` : ''}</span>
            <span class="admin-row-actions">
              ${r.engine === 'unreal' ? html`<button class="btn btn-sm btn-quiet" type="button" data-update="${r.game}" data-title="${r.title}" data-container="${r.container}">${t('Update')}</button>` : ''}
              <button class="btn btn-sm btn-quiet" type="button" data-revoke="${r.game}" data-title="${r.title}">${t('Revoke')}</button>
            </span>
          </div>`)}</div>`
      : html`<p class="muted">${t('No signed recipes yet.')}</p>`);
  };
  list.addEventListener('click', async (e) => {
    const update = e.target.closest('[data-update]');
    if (update) {
      chosen = { game: update.dataset.update, title: update.dataset.title };
      form.game.value = update.dataset.title || update.dataset.update;
      if (CONTAINERS[update.dataset.container]) form.container.value = update.dataset.container;
      showPicked();
      form.aesKey.focus();
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const revoke = e.target.closest('[data-revoke]');
    if (!revoke || !window.confirm(t('Revoke the signed recipe for {game}? Players\' apps stop getting its key; Arabic already made keeps working.', { game: revoke.dataset.title || revoke.dataset.revoke }))) return;
    revoke.disabled = true;
    try {
      await api(`/admin/recipes/${encodeURIComponent(revoke.dataset.revoke)}`, { method: 'DELETE' });
      toast(t('Recipe revoked.'));
      await showList();
    } catch (err) {
      toast(errorText(err), { error: true });
      revoke.disabled = false;
    }
  });
  await showList(recipes);

  // ---- Bulk paste ----
  const dialog = document.getElementById('bulk-dialog');
  const bulk = document.getElementById('bulk-form');
  const bulkTable = document.getElementById('bulk-table');
  const signAll = document.getElementById('bulk-sign');
  let rows = [];
  document.getElementById('bulk-open').addEventListener('click', () => dialog.showModal());
  const drawRows = () => {
    mount(bulkTable, rows.length ? html`<div class="admin-table bulk-rows">${rows.map((r, i) => html`
      <div class="admin-row">
        <label class="check-row"><input type="checkbox" data-row="${i}" ${r.checked ? 'checked' : ''} ${r.game && r.aesKey ? '' : 'disabled'}></label>
        <div>
          <strong>${bdi(r.text)}</strong>
          ${r.candidates.length > 1
            ? html`<select class="input input-sm" data-pick="${i}">${r.candidates.map((c) => html`<option value="${c.game}" ${c.game === r.game ? 'selected' : ''}>${c.title} (${c.game})</option>`)}</select>`
            : html`<span class="muted small" dir="ltr">${r.game ? `${r.title ? `${r.title} · ` : ''}${r.game}` : t('No game found: use its Steam app id')}</span>`}
        </div>
        <code class="masked-key" dir="ltr">${r.aesKey ? maskAesKey(r.aesKey) : t('Not an AES-256 key')}</code>
        <span class="small ${r.status === 'error' ? 'form-error' : r.status === 'done' ? 'sig-state ok' : 'muted'}">${r.message || ''}</span>
      </div>`)}</div>` : '');
    signAll.disabled = !rows.some((r) => r.checked);
  };
  document.getElementById('bulk-check').addEventListener('click', async () => {
    const lines = bulk.lines.value.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 100);
    rows = lines.map((line) => {
      const [left, ...rest] = line.split('|');
      return { text: left.trim(), aesKey: normalizeAesKey(rest.join('|')), game: typedGameKey(left), title: '', candidates: [], checked: false, status: '', message: '' };
    });
    drawRows();
    // Names are looked up one at a time, gently.
    for (const row of rows) {
      if (!row.game && row.text.length >= 2) {
        const { results = [] } = await api(`/games?search=${encodeURIComponent(row.text)}`).catch(() => ({}));
        row.candidates = results.slice(0, 5).map((g) => ({ game: gameKeyOf(g), title: g.name }));
        const exact = row.candidates.find((c) => c.title.toLowerCase().replace(/[^a-z0-9]+/g, '') === row.text.toLowerCase().replace(/[^a-z0-9]+/g, ''));
        const pick = exact || row.candidates[0];
        if (pick) Object.assign(row, { game: pick.game, title: pick.title });
      }
      row.checked = Boolean(row.game && row.aesKey);
      drawRows();
    }
    // The same game twice: only the first line is signed (the last would quietly replace it).
    rows.forEach((row, i) => {
      const first = rows.findIndex((r) => r.game && r.game === row.game);
      if (row.game && first < i) Object.assign(row, { checked: false, status: 'error', message: t('Same game as line {n}', { n: first + 1 }) });
    });
    drawRows();
  });
  bulkTable.addEventListener('change', (e) => {
    const box = e.target.closest('[data-row]');
    if (box) rows[box.dataset.row].checked = box.checked;
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const row = rows[pick.dataset.pick];
      const c = row.candidates.find((x) => x.game === pick.value);
      Object.assign(row, { game: c.game, title: c.title });
    }
    signAll.disabled = !rows.some((r) => r.checked);
  });
  signAll.addEventListener('click', async () => {
    const todo = rows.filter((r) => r.checked);
    signAll.disabled = true;
    try {
      const results = await signAndSend(todo.map((r) => ({ game: r.game, title: r.title || r.text, container: bulk.container.value, aesKey: r.aesKey, note: noteFor(bulk.container.value, '') })));
      results.forEach((res, i) => Object.assign(todo[i], res.ok
        ? { status: 'done', checked: false, message: res.answered ? t('Signed · {n} requests ready', { n: res.answered }) : t('Signed') }
        : { status: 'error', message: res.error }));
      drawRows();
      const ok = results.filter((r) => r.ok).length;
      toast(t('{ok} of {n} keys signed and attached.', { ok, n: results.length }), { error: ok < results.length });
      await showList();
    } catch (err) {
      toast(errorText(err), { error: true });
      signAll.disabled = false;
    }
  });
}
