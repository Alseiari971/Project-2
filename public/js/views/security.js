// Settings → Security: the email address, GameShelf Guard (an authenticator
// app or emailed codes, plus recovery codes), the linked Steam account, the
// password, and every place the account is signed in.
import { html, bdi, th, api, mount, state, refreshMe, toast, onLeave } from '../lib.js';
import { t, locale } from '../i18n.js';
import { icon } from '../icons.js';
import { countryPicker, wireCountryPicker, flagBadge } from '../country-picker.js';
import qrcode from '../vendor/qrcode.mjs';

const desktop = window.gameshelfDesktop;

function ago(ms) {
  if (!ms) return t('a while ago');
  const seconds = (ms - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return t('just now');
}

/** "Chrome on Windows", from a user agent, for the sessions list. */
export function describeAgent(ua = '', device = 'web') {
  if (device === 'desktop') {
    const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? t('GameShelf app on {os}', { os }) : t('GameShelf app');
  }
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : t('A browser');
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? t('{browser} on {os}', { browser, os }) : browser;
}

const methodName = (m) => ({ totp: t('Authenticator app'), email: t('Email codes') }[m] || t('Off'));

function codesBlock(codes) {
  return html`
    <div class="backup-codes">
      <p><strong>${t('Save these recovery codes somewhere safe.')}</strong> ${t('Each one signs you in once if you lose your phone or email. They won\'t be shown again.')}</p>
      <ol class="code-grid" dir="ltr">${codes.map((c) => html`<li><code>${c}</code></li>`)}</ol>
      <div class="row-actions">
        <button type="button" class="btn btn-sm" data-copy="${codes.join('\n')}">${icon('check')} ${t('Copy codes')}</button>
        <button type="button" class="btn btn-sm" data-download="${codes.join('\r\n')}">${icon('download')} ${t('Download .txt')}</button>
      </div>
    </div>`;
}

export async function securityView(app, params) {
  if (!state.user) {
    location.hash = '#/login?next=' + encodeURIComponent('#/settings/security');
    return;
  }
  let sec = await api('/me/security');
  let local = null;
  if (desktop?.localSteamAccount) local = await desktop.localSteamAccount().catch(() => null);
  let steamWatch = null;
  onLeave(() => clearInterval(steamWatch));

  // Steam's sign-in coming back to this page.
  if (params.get('steam') === 'linked') toast(t('Steam account linked.'));
  if (params.get('steam') === 'error') toast(t(params.get('reason') || 'Steam wasn\'t linked.'), { error: true });
  if (params.get('steam')) history.replaceState(null, '', '#/settings/security');

  const draw = (extra = {}) => {
    const g = sec.twoFactor;
    mount(app, html`
      <div class="page settings-page">
        <header class="settings-head">
          <h1>${t('Security')}</h1>
          <p class="muted">${t('Keep your GameShelf account yours: Guard codes at sign-in, a linked Steam account, and where you\'re signed in.')}</p>
        </header>

        <section class="panel settings-card" id="sec-account">
          <h2>${t('Account')}</h2>
          <div class="kv">
            <span>${t('Username')}</span><span dir="ltr">@${state.user.username}</span>
            <span>${t('Friend code')}</span><span dir="ltr"><code>${state.user.friendCode || '—'}</code></span>
            <span>${t('Email address')}</span>
            <span>${sec.email ? html`<bdi dir="ltr">${sec.email}</bdi> ${sec.emailVerified ? html`<span class="chip chip-good">${icon('check')}${t('Confirmed')}</span>` : html`<span class="chip chip-warn">${t('Not confirmed')}</span>`}` : html`<span class="muted">${t('None yet')}</span>`}</span>
            <span>${t('Nationality')}</span><span>${state.user.nationality ? flagBadge(state.user.nationality, { withName: true }) : html`<span class="muted">${t('Not set')}</span>`}</span>
          </div>
          ${sec.email && !sec.emailVerified ? html`
            <form class="inline-form" id="verify-email">
              <input class="input" name="code" inputmode="numeric" maxlength="6" placeholder="${t('6-digit code')}" dir="ltr" autocomplete="one-time-code" required>
              <button class="btn btn-light" type="submit">${t('Confirm email')}</button>
              ${sec.mailEnabled ? html`<button class="btn" type="button" id="send-verify">${t('Send a code')}</button>` : ''}
            </form>
            ${sec.mailEnabled ? '' : html`<p class="muted small">${t('This server can\'t send email yet, so addresses can\'t be confirmed. The authenticator app still works.')}</p>`}` : ''}
          <details class="settings-more">
            <summary>${sec.email ? t('Change email address') : t('Add an email address')}</summary>
            <form class="stack-form" id="change-email">
              <label>${t('New email address')}<input class="input" name="email" type="email" required dir="ltr" autocomplete="email"></label>
              <label>${t('Your password')}<input class="input" name="password" type="password" required autocomplete="current-password"></label>
              <button class="btn btn-light" type="submit">${t('Save email')}</button>
            </form>
          </details>
          <details class="settings-more">
            <summary>${t('Change nationality')}</summary>
            <form class="stack-form" id="change-country">
              ${countryPicker({ id: 'country-edit', value: state.user.nationality || '' })}
              <button class="btn btn-light" type="submit">${t('Save nationality')}</button>
            </form>
          </details>
        </section>

        <section class="panel settings-card guard-panel ${g.method ? 'is-on' : ''}" id="sec-guard">
          <div class="settings-card-head">
            <div class="guard-shield sm">${icon('shield')}</div>
            <div>
              <h2>${t('GameShelf Guard')}</h2>
              <p class="muted small">${g.method
                ? t('On, with {method}. New browsers and PCs need a code to sign in. {n} recovery codes left.', { method: methodName(g.method), n: g.backupCodesLeft })
                : t('Off. Anyone with your password can sign in. Turn Guard on so new browsers and PCs need a code too.')}</p>
            </div>
            <span class="chip ${g.method ? 'chip-good' : 'chip-warn'}">${g.method ? t('On') : t('Off')}</span>
          </div>
          <div id="guard-body">${extra.guard || (g.method ? html`
            <div class="row-actions">
              <button type="button" class="btn" id="guard-new-codes">${t('New recovery codes')}</button>
              <button type="button" class="btn btn-danger" id="guard-off">${t('Turn off Guard')}</button>
            </div>` : html`
            <div class="guard-options">
              <button type="button" class="guard-option" id="guard-totp">
                <strong>${t('Authenticator app')}</strong> <span class="chip chip-good">${t('Recommended')}</span>
                <span class="muted small">${t('Google Authenticator, Microsoft Authenticator, 1Password, Authy or any app that reads a QR code.')}</span>
              </button>
              <button type="button" class="guard-option" id="guard-email" ${sec.mailEnabled && sec.emailVerified ? '' : html`disabled`}>
                <strong>${t('Email codes')}</strong>
                <span class="muted small">${sec.mailEnabled ? (sec.emailVerified ? t('A code is emailed to you each time you sign in somewhere new.') : t('Confirm your email address first.')) : t('This server can\'t send email yet.')}</span>
              </button>
            </div>`)}</div>
        </section>

        <section class="panel settings-card" id="sec-steam">
          <div class="settings-card-head">
            <div class="steam-mark">${icon('link')}</div>
            <div>
              <h2>${t('Steam account')}</h2>
              <p class="muted small">${t('Linked with Steam\'s own sign-in, so only the owner of a Steam account can link it. One Steam account per GameShelf account.')}</p>
            </div>
            <span class="chip ${sec.steam?.linked ? 'chip-good' : ''}">${sec.steam?.linked ? t('Linked') : t('Not linked')}</span>
          </div>
          ${sec.steam?.linked ? html`
            <div class="kv">
              <span>${t('Steam name')}</span><span>${sec.steam.name ? bdi(sec.steam.name) : html`<span class="muted">${t('Hidden on Steam')}</span>`}</span>
              <span>SteamID64</span><span dir="ltr"><code>${sec.steam.steamId}</code></span>
            </div>
            <div class="row-actions">
              <a class="btn" href="${sec.steam.profileUrl}" target="_blank" rel="noopener noreferrer">${icon('external')} ${t('Steam profile')}</a>
              <a class="btn" href="#/import">${t('Import my Steam games')}</a>
              <button type="button" class="btn btn-danger" id="steam-unlink">${t('Unlink')}</button>
            </div>` : html`
            ${local ? html`<p class="local-steam">${icon('info')} ${th('Steam on this PC is signed in as {name}. Linking still asks Steam to confirm it\'s you.', { name: html`<b>${bdi(local.personaName || local.accountName)}</b>` })}</p>` : ''}
            <div class="row-actions">
              <button type="button" class="btn btn-steam" id="steam-link">${icon('link')} ${t('Sign in through Steam')}</button>
            </div>
            <p class="muted small" id="steam-wait" hidden>${t('Finish signing in to Steam in your web browser. This page updates by itself.')}</p>`}
        </section>

        <section class="panel settings-card" id="sec-password">
          <h2>${t('Password')}</h2>
          <form class="stack-form" id="change-password">
            <label>${t('Current password')}<input class="input" name="current" type="password" required autocomplete="current-password"></label>
            <label>${t('New password')}<input class="input" name="next" type="password" required minlength="8" autocomplete="new-password"></label>
            <p class="muted small">${t('Changing it signs you out everywhere else and forgets remembered devices.')}</p>
            <button class="btn btn-light" type="submit">${t('Change password')}</button>
          </form>
        </section>

        <section class="panel settings-card" id="sec-sessions">
          <div class="settings-card-head">
            <div><h2>${t('Where you\'re signed in')}</h2><p class="muted small">${t('Sign out anything you don\'t recognise, then change your password.')}</p></div>
          </div>
          <ul class="session-list">${sec.sessions.map((s) => html`
            <li class="session-row ${s.current ? 'current' : ''}">
              <span class="session-icon">${icon(s.device === 'desktop' ? 'grid' : 'globe')}</span>
              <div>
                <strong>${describeAgent(s.userAgent, s.device)}</strong> ${s.current ? html`<span class="chip chip-good">${t('This device')}</span>` : ''}
                <div class="muted small">${t('Signed in {when}', { when: ago(s.createdAt) })} · ${t('Last active {when}', { when: ago(s.lastSeen) })}${s.ip ? html` · <bdi dir="ltr">${s.ip}</bdi>` : ''}</div>
              </div>
              ${s.current ? '' : html`<button type="button" class="btn btn-sm" data-revoke="${s.id}">${t('Sign out')}</button>`}
            </li>`)}</ul>
          <div class="row-actions">
            ${sec.sessions.length > 1 ? html`<button type="button" class="btn" id="revoke-others">${t('Sign out everywhere else')}</button>` : ''}
            ${g.method ? html`<button type="button" class="btn" id="forget-devices">${t('Forget remembered devices')}</button>` : ''}
          </div>
        </section>
      </div>`);
    wire();
  };

  const run = async (button, fn) => {
    if (button) button.disabled = true;
    try {
      return await fn();
    } catch (err) {
      toast(err.message, { error: true });
      return null;
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  };
  const update = async (next, message) => {
    if (next) sec = { ...sec, ...next };
    await refreshMe();
    draw();
    if (message) toast(message);
  };

  // A small form inside the Guard card: password, then whatever comes next.
  const guardForm = (inner, onSubmit) => {
    draw({ guard: html`<form class="stack-form guard-step" id="guard-step">${inner}
      <p class="form-error" id="guard-step-error" role="alert"></p>
      <div class="row-actions"><button class="btn btn-light" type="submit">${t('Continue')}</button><button class="btn" type="button" id="guard-step-cancel">${t('Cancel')}</button></div></form>` });
    const form = document.getElementById('guard-step');
    form.querySelector('input')?.focus();
    document.getElementById('guard-step-cancel').addEventListener('click', () => draw());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await onSubmit(new FormData(form));
      } catch (err) {
        const el = document.getElementById('guard-step-error');
        if (el) el.textContent = err.message;
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  };
  const passwordField = html`<label>${t('Your password')}<input class="input" name="password" type="password" required autocomplete="current-password"></label>`;
  const codeField = (label) => html`<label>${label}<input class="input code-input" name="code" required autocomplete="one-time-code" dir="ltr" maxlength="9" spellcheck="false"></label>`;
  const showCodes = (result, message) => {
    sec = { ...sec, ...result };
    refreshMe();
    draw({ guard: html`${codesBlock(result.backupCodes)}<div class="row-actions"><button type="button" class="btn btn-light" id="codes-done">${t('I saved them')}</button></div>` });
    toast(message);
    document.getElementById('codes-done').addEventListener('click', () => draw());
  };

  function startTotp() {
    guardForm(passwordField, async (fd) => {
      const setup = await api('/me/2fa/totp/start', { method: 'POST', body: { password: fd.get('password') } });
      const qr = qrcode(0, 'M');
      qr.addData(setup.uri);
      qr.make();
      guardForm(html`
        <ol class="steps">
          <li>${t('Open your authenticator app and scan this code.')}</li>
        </ol>
        <div class="qr-wrap"><img class="qr" src="${qr.createDataURL(5, 4)}" alt="${t('QR code for your authenticator app')}" width="200" height="200"></div>
        <p class="muted small">${t('Can\'t scan it? Type this key in instead:')} <code class="secret" dir="ltr">${setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code></p>
        ${codeField(t('Then enter the 6-digit code it shows'))}`, async (fd2) => {
        showCodes(await api('/me/2fa/totp/confirm', { method: 'POST', body: { code: String(fd2.get('code')).replace(/\s/g, '') } }), t('GameShelf Guard is on.'));
      });
    });
  }

  function startEmail() {
    guardForm(passwordField, async (fd) => {
      const sent = await api('/me/2fa/email/start', { method: 'POST', body: { password: fd.get('password') } });
      guardForm(html`<p class="muted">${th('We emailed a code to {email}.', { email: html`<b dir="ltr">${sent.email}</b>` })}</p>${codeField(t('6-digit code'))}`, async (fd2) => {
        showCodes(await api('/me/2fa/email/confirm', { method: 'POST', body: { code: String(fd2.get('code')).trim() } }), t('GameShelf Guard is on.'));
      });
    });
  }

  // Turning Guard off or making new recovery codes needs the password and a code.
  function withGuardCode(title, route, done) {
    const email = sec.twoFactor.method === 'email';
    guardForm(html`<p><strong>${title}</strong></p>${passwordField}
      ${codeField(email ? t('A code from your email, or a recovery code') : t('A code from your authenticator app, or a recovery code'))}
      ${email ? html`<button type="button" class="link-btn" id="email-me-code">${t('Email me a code')}</button>` : ''}`, async (fd) => {
      done(await api(route, { method: 'POST', body: { password: fd.get('password'), code: String(fd.get('code')).trim() } }));
    });
    document.getElementById('email-me-code')?.addEventListener('click', (e) => run(e.currentTarget, async () => {
      const sent = await api('/me/2fa/code', { method: 'POST' });
      toast(t('We emailed a code to {email}.', { email: sent.email }));
    }));
  }

  function wire() {
    app.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      await navigator.clipboard.writeText(b.dataset.copy).then(() => toast(t('Copied.')), () => toast(t('Couldn\'t copy. Select the codes and copy them yourself.'), { error: true }));
    }));
    app.querySelectorAll('[data-download]').forEach((b) => b.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([`GameShelf recovery codes for @${state.user.username}\r\n\r\n${b.dataset.download}\r\n`], { type: 'text/plain' }));
      a.download = `gameshelf-recovery-codes-${state.user.username}.txt`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }));

    document.getElementById('verify-email')?.addEventListener('submit', (e) => {
      e.preventDefault();
      run(e.target.querySelector('button'), async () => update(await api('/me/email/verify', { method: 'POST', body: { code: e.target.code.value.trim() } }), t('Email address confirmed.')));
    });
    document.getElementById('send-verify')?.addEventListener('click', (e) => run(e.currentTarget, async () => {
      await api('/me/email/send', { method: 'POST' });
      toast(t('We sent a code to {email}.', { email: sec.email }));
    }));
    document.getElementById('change-email')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      run(e.target.querySelector('button'), async () => {
        const next = await api('/me/email', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } });
        await update(next, next.emailSent ? t('Saved. We sent a code to {email}.', { email: next.email }) : t('Email address saved.'));
      });
    });
    const picker = document.getElementById('country-edit');
    if (picker) wireCountryPicker(picker);
    document.getElementById('change-country')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const nationality = new FormData(e.target).get('nationality');
      if (!nationality) return;
      run(e.target.querySelector('button[type="submit"]'), async () => {
        await api('/me', { method: 'PATCH', body: { nationality } });
        await update(null, t('Nationality saved.'));
      });
    });

    document.getElementById('guard-totp')?.addEventListener('click', startTotp);
    document.getElementById('guard-email')?.addEventListener('click', startEmail);
    document.getElementById('guard-new-codes')?.addEventListener('click', () => withGuardCode(t('Make new recovery codes'), '/me/2fa/backup-codes', (r) => showCodes(r, t('New recovery codes made. The old ones no longer work.'))));
    document.getElementById('guard-off')?.addEventListener('click', () => withGuardCode(t('Turn off GameShelf Guard'), '/me/2fa/disable', (r) => update(r, t('GameShelf Guard is off.'))));

    document.getElementById('steam-link')?.addEventListener('click', (e) => run(e.currentTarget, async () => {
      if (!desktop?.openSteamLink) {
        // The website: straight to Steam's sign-in, which comes back here.
        location.href = '/api/auth/steam/link';
        return;
      }
      // The app: Steam's sign-in opens in the web browser; watch for the link.
      await desktop.openSteamLink();
      document.getElementById('steam-wait').hidden = false;
      const until = Date.now() + 10 * 60 * 1000;
      clearInterval(steamWatch);
      steamWatch = setInterval(async () => {
        if (Date.now() > until) return clearInterval(steamWatch);
        const steam = await api('/me/steam').catch(() => null);
        if (steam?.linked) {
          clearInterval(steamWatch);
          await update({ steam }, t('Steam account linked.'));
        }
      }, 3000);
    }));
    document.getElementById('steam-unlink')?.addEventListener('click', (e) => {
      if (!confirm(t('Unlink this Steam account? You can link it again any time.'))) return;
      run(e.currentTarget, async () => update({ steam: await api('/me/steam', { method: 'DELETE' }) }, t('Steam account unlinked.')));
    });

    document.getElementById('change-password')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      run(e.target.querySelector('button'), async () => update(await api('/me/password', { method: 'POST', body: { current: fd.get('current'), next: fd.get('next') } }), t('Password changed. You\'re signed out everywhere else.')));
    });
    app.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
      update(await api(`/me/sessions/${b.dataset.revoke}`, { method: 'DELETE' }), t('Signed out.'));
    })));
    document.getElementById('revoke-others')?.addEventListener('click', (e) => run(e.currentTarget, async () => update(await api('/me/sessions/revoke-others', { method: 'POST' }), t('Signed out everywhere else.'))));
    document.getElementById('forget-devices')?.addEventListener('click', (e) => run(e.currentTarget, async () => {
      await api('/me/devices', { method: 'DELETE' });
      toast(t('Every device will need a Guard code next time.'));
    }));
  }

  draw();
  if (params.get('section')) document.getElementById(`sec-${params.get('section')}`)?.scrollIntoView();
}
