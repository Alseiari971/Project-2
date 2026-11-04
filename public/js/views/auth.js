// Sign in and sign up, in a Steam-like dark card. Signing in on a browser or
// app the account hasn't remembered asks for a GameShelf Guard code (an
// authenticator app's, an emailed one, or a recovery code) before the session
// starts. Signing up checks the username as it's typed, rates the password,
// and asks for a nationality, shown as a flag on the profile.
import { html, th, api, mount, state, refreshMe, profileHref, onLeave, toast } from '../lib.js';
import { t } from '../i18n.js';
import { icon } from '../icons.js';
import { countryPicker, wireCountryPicker } from '../country-picker.js';

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

/** 0 to 4, with what would make it better; the server has the final say. */
export function passwordStrength(password, username = '') {
  if (!password) return { score: 0, label: '' };
  const lower = password.toLowerCase();
  if (password.length < 8) return { score: 0, label: t('Too short') };
  if (['password', '12345678', 'qwerty', 'gameshelf', 'letmein', 'iloveyou'].some((w) => lower.includes(w)) || (username && lower.includes(username))) {
    return { score: 0, label: t('Too easy to guess') };
  }
  let score = password.length >= 12 ? 2 : 1;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (kinds >= 3) score += 1;
  if (password.length >= 16 || (password.length >= 12 && kinds >= 3)) score += 1;
  score = Math.min(4, score);
  return { score, label: [t('Too short'), t('Weak'), t('Fair'), t('Good'), t('Strong')][score] };
}

async function shell(app, inner) {
  // Game art behind the card, dimmed under a Steam-blue glow.
  const art = await api('/games?sort=popular').then((d) => d.results.filter((g) => g.image).slice(0, 12)).catch(() => []);
  mount(app, html`
    <div class="auth auth-steam">
      <div class="auth-wall" aria-hidden="true">${art.map((g) => html`<div class="auth-tile" data-bg="${g.image}" data-bg-fallback="${g.fallbackImage || ''}"></div>`)}</div>
      <div class="auth-shade"></div>
      <div class="auth-stack" id="auth-stack">${inner}</div>
    </div>`);
  return document.getElementById('auth-stack');
}

async function signedIn(goTo) {
  await refreshMe();
  document.dispatchEvent(new Event('user-changed'));
  window.gameshelfDesktop?.refreshPresence?.().catch(() => {});
  location.hash = goTo || profileHref(state.user.username);
}

// ---- Sign in ----

function loginCard() {
  return html`
    <form class="auth-card" id="auth-form" novalidate>
      <div class="auth-brand">Game<span>Shelf</span></div>
      <h1>${t('Sign in')}</h1>
      <label>${t('Username or email')}
        <input class="input" name="username" required autocomplete="username" autofocus dir="ltr" spellcheck="false" autocapitalize="none">
      </label>
      <label>${t('Password')}
        <input class="input" name="password" type="password" required autocomplete="current-password">
      </label>
      <p class="form-error" id="auth-error" role="alert"></p>
      <button class="btn btn-steam btn-lg btn-block" type="submit">${t('Sign in')}</button>
      <p class="muted small center">${t('New here?')} <a href="#/register">${t('Create an account')}</a></p>
    </form>`;
}

function guardCard(guard) {
  const byEmail = guard.method === 'email';
  return html`
    <form class="auth-card guard-card" id="guard-form" novalidate>
      <div class="guard-shield">${icon('shield')}</div>
      <h1>${t('GameShelf Guard')}</h1>
      <p class="muted" id="guard-help">${byEmail
        ? th('This browser isn\'t one you\'ve used before. We emailed a code to {email}.', { email: html`<b dir="ltr">${guard.email}</b>` })
        : t('This browser isn\'t one you\'ve used before. Enter the 6-digit code from your authenticator app.')}</p>
      <div class="code-boxes" id="code-boxes" dir="ltr" role="group" aria-label="${t('6-digit code')}">
        ${Array.from({ length: 6 }, (_, i) => html`<input class="code-box" inputmode="numeric" maxlength="1" autocomplete="${i === 0 ? 'one-time-code' : 'off'}" aria-label="${t('Digit {n}', { n: i + 1 })}" ${i === 0 ? html`autofocus` : ''}>`)}
      </div>
      <label class="backup-field" hidden>${t('Recovery code')}
        <input class="input" name="backup" autocomplete="off" dir="ltr" placeholder="XXXX-XXXX" spellcheck="false">
      </label>
      <label class="check-row"><input type="checkbox" name="remember" checked> <span>${t('Remember this device')}</span></label>
      <p class="form-error" id="guard-error" role="alert"></p>
      <button class="btn btn-steam btn-lg btn-block" type="submit">${t('Submit')}</button>
      <div class="guard-links">
        ${byEmail ? html`<button type="button" class="link-btn" id="guard-resend">${t('Send another code')}</button>` : ''}
        <button type="button" class="link-btn" id="guard-backup">${t('Use a recovery code instead')}</button>
        <a class="link-btn" href="#/login" id="guard-cancel">${t('Cancel')}</a>
      </div>
    </form>`;
}

/** Six boxes: typing moves on, backspace moves back, pasting fills them all. */
function wireCodeBoxes(root, onFull) {
  const boxes = [...root.querySelectorAll('.code-box')];
  const value = () => boxes.map((b) => b.value).join('');
  const fill = (digits, from = 0) => {
    [...digits].slice(0, boxes.length - from).forEach((d, i) => { boxes[from + i].value = d; });
    const next = Math.min(from + digits.length, boxes.length - 1);
    boxes[next].focus();
    if (value().length === boxes.length) onFull(value());
  };
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      const digits = box.value.replace(/\D/g, '');
      box.value = '';
      if (digits) fill(digits, i);
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
    });
    box.addEventListener('paste', (e) => {
      e.preventDefault();
      fill((e.clipboardData.getData('text') || '').replace(/\D/g, ''), 0);
    });
  });
  return { value, clear: () => { boxes.forEach((b) => { b.value = ''; }); boxes[0].focus(); } };
}

function showGuard(stack, guard, goTo) {
  mount(stack, guardCard(guard));
  const form = stack.querySelector('#guard-form');
  const error = stack.querySelector('#guard-error');
  const backupField = stack.querySelector('.backup-field');
  const boxesEl = stack.querySelector('#code-boxes');
  let useBackup = false;
  let busy = false;

  const submit = async () => {
    if (busy) return;
    const code = useBackup ? form.backup.value.trim() : codes.value();
    if (!useBackup && code.length !== 6) return void (error.textContent = t('Enter all 6 digits.'));
    if (useBackup && !code) return void (error.textContent = t('Enter a recovery code.'));
    busy = true;
    error.textContent = '';
    try {
      const done = await api('/auth/guard', { method: 'POST', body: { challenge: guard.challenge, code, remember: form.remember.checked } });
      if (done.via === 'backup') toast(t('Recovery code used. {n} left.', { n: done.backupCodesLeft }));
      await signedIn(goTo);
    } catch (err) {
      error.textContent = err.message;
      // An expired or worn-out sign-in starts over with the password.
      if (err.status === 410 || err.status === 429) setTimeout(() => { location.hash = '#/login'; authView(document.getElementById('app'), 'login'); }, 1800);
      else if (!useBackup) codes.clear();
    } finally {
      busy = false;
    }
  };
  const codes = wireCodeBoxes(boxesEl, submit);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  stack.querySelector('#guard-backup').addEventListener('click', (e) => {
    useBackup = !useBackup;
    boxesEl.hidden = useBackup;
    backupField.hidden = !useBackup;
    e.currentTarget.textContent = useBackup ? t('Use a 6-digit code instead') : t('Use a recovery code instead');
    (useBackup ? form.backup : boxesEl.querySelector('.code-box')).focus();
  });
  stack.querySelector('#guard-resend')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      await api('/auth/guard/resend', { method: 'POST', body: { challenge: guard.challenge } });
      toast(t('We sent another code.'));
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setTimeout(() => { button.disabled = false; }, 30000);
    }
  });
}

// ---- Sign up ----

function registerCard() {
  return html`
    <form class="auth-card auth-card-wide" id="auth-form" novalidate>
      <div class="auth-brand">Game<span>Shelf</span></div>
      <h1>${t('Create your account')}</h1>
      <p class="muted">${t('Log every game you play, rate them, and show your profile off.')}</p>
      <label>${t('Username')}
        <input class="input" name="username" required minlength="3" maxlength="24" autocomplete="username" autofocus dir="ltr" spellcheck="false" autocapitalize="none" aria-describedby="username-note">
        <span class="field-note" id="username-note">${t('3 to 24 lowercase letters, numbers or underscores.')}</span>
      </label>
      <label>${t('Email address')}
        <input class="input" name="email" type="email" required autocomplete="email" dir="ltr" spellcheck="false">
        <span class="field-note">${t('For GameShelf Guard codes and getting back into your account.')}</span>
      </label>
      <div class="field-pair">
        <label>${t('Password')}
          <input class="input" name="password" type="password" required minlength="8" autocomplete="new-password" aria-describedby="strength-label">
        </label>
        <label>${t('Confirm password')}
          <input class="input" name="confirmPassword" type="password" required autocomplete="new-password" aria-describedby="confirm-note">
        </label>
      </div>
      <div class="strength" id="strength" data-score="0" aria-live="polite">
        <div class="strength-bar"><span></span><span></span><span></span><span></span></div>
        <span class="field-note" id="strength-label">${t('At least 8 characters. A short phrase is easiest to remember.')}</span>
      </div>
      <span class="field-note" id="confirm-note"></span>
      <div class="label-like">${t('Nationality')}
        ${countryPicker({ id: 'nationality' })}
        <span class="field-note">${t('Shown as a flag on your profile.')}</span>
      </div>
      <p class="form-error" id="auth-error" role="alert"></p>
      <p class="muted small">${th('By creating an account you agree to the {terms}.', { terms: html`<a href="#/legal">${t('terms, community rules and privacy notice')}</a>` })}</p>
      <button class="btn btn-steam btn-lg btn-block" type="submit">${t('Create account')}</button>
      <p class="muted small center">${t('Already have an account?')} <a href="#/login">${t('Sign in')}</a></p>
    </form>`;
}

function verifyCard(email) {
  return html`
    <form class="auth-card" id="verify-form" novalidate>
      <div class="guard-shield">${icon('check')}</div>
      <h1>${t('Check your email')}</h1>
      <p class="muted">${th('We sent a 6-digit code to {email}. It confirms the address is yours, so it can get you back into your account.', { email: html`<b dir="ltr">${email}</b>` })}</p>
      <div class="code-boxes" id="code-boxes" dir="ltr" role="group" aria-label="${t('6-digit code')}">
        ${Array.from({ length: 6 }, (_, i) => html`<input class="code-box" inputmode="numeric" maxlength="1" aria-label="${t('Digit {n}', { n: i + 1 })}" ${i === 0 ? html`autofocus` : ''}>`)}
      </div>
      <p class="form-error" id="verify-error" role="alert"></p>
      <button class="btn btn-steam btn-lg btn-block" type="submit">${t('Confirm email')}</button>
      <div class="guard-links"><a class="link-btn" href="#/customize">${t('Do this later')}</a></div>
    </form>`;
}

function wireRegister(stack) {
  const form = stack.querySelector('#auth-form');
  const error = stack.querySelector('#auth-error');
  const note = stack.querySelector('#username-note');
  const strength = stack.querySelector('#strength');
  const confirmNote = stack.querySelector('#confirm-note');
  wireCountryPicker(stack.querySelector('#nationality'));

  // Live username check, a moment after typing stops.
  let timer = null;
  let asked = '';
  const setNote = (text, kind = '') => {
    note.textContent = text;
    note.className = `field-note ${kind}`;
  };
  form.username.addEventListener('input', () => {
    const name = form.username.value.trim().toLowerCase();
    clearTimeout(timer);
    if (!name) return setNote(t('3 to 24 lowercase letters, numbers or underscores.'));
    if (!USERNAME_RE.test(name)) return setNote(t('Usernames need 3 to 24 lowercase letters, numbers or underscores.'), 'bad');
    setNote(t('Checking…'));
    timer = setTimeout(async () => {
      asked = name;
      try {
        const r = await api(`/auth/username?name=${encodeURIComponent(name)}`);
        if (asked !== form.username.value.trim().toLowerCase()) return;
        if (r.available) setNote(t('@{name} is available', { name: r.username }), 'good');
        else setNote(t(r.reason || 'That username is taken.'), 'bad');
      } catch {
        setNote('');
      }
    }, 350);
  });
  onLeave(() => clearTimeout(timer));

  const rate = () => {
    const s = passwordStrength(form.password.value, form.username.value.trim().toLowerCase());
    strength.dataset.score = String(form.password.value ? s.score : 0);
    strength.classList.toggle('empty', !form.password.value);
    strength.querySelector('#strength-label').textContent = form.password.value
      ? t('Password strength: {label}', { label: s.label })
      : t('At least 8 characters. A short phrase is easiest to remember.');
    const both = form.confirmPassword.value;
    confirmNote.textContent = both ? (both === form.password.value ? t('Passwords match') : t('The two passwords don\'t match.')) : '';
    confirmNote.className = `field-note ${both ? (both === form.password.value ? 'good' : 'bad') : ''}`;
  };
  form.password.addEventListener('input', rate);
  form.confirmPassword.addEventListener('input', rate);
  form.username.addEventListener('input', rate);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    error.textContent = '';
    if (!fd.get('nationality')) return void (error.textContent = t('Pick your nationality.'));
    if (fd.get('password') !== fd.get('confirmPassword')) return void (error.textContent = t('The two passwords don\'t match.'));
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const made = await api('/auth/register', {
        method: 'POST',
        body: {
          username: String(fd.get('username')).trim().toLowerCase(),
          email: fd.get('email'),
          password: fd.get('password'),
          confirmPassword: fd.get('confirmPassword'),
          nationality: fd.get('nationality'),
        },
      });
      await refreshMe();
      document.dispatchEvent(new Event('user-changed'));
      window.gameshelfDesktop?.refreshPresence?.().catch(() => {});
      if (made.emailSent) showVerify(stack, String(fd.get('email')));
      else location.hash = '#/customize';
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  });
}

function showVerify(stack, email) {
  mount(stack, verifyCard(email));
  const error = stack.querySelector('#verify-error');
  const submit = async (code) => {
    try {
      await api('/me/email/verify', { method: 'POST', body: { code } });
      toast(t('Email address confirmed.'));
      location.hash = '#/customize';
    } catch (err) {
      error.textContent = err.message;
      codes.clear();
    }
  };
  const codes = wireCodeBoxes(stack.querySelector('#code-boxes'), submit);
  stack.querySelector('#verify-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (codes.value().length === 6) submit(codes.value());
  });
}

export async function authView(app, mode, params = new URLSearchParams()) {
  if (state.user) {
    location.hash = profileHref(state.user.username);
    return;
  }
  const goTo = params.get('next') && params.get('next').startsWith('#/') ? params.get('next') : null;
  if (mode === 'register') {
    wireRegister(await shell(app, registerCard()));
    return;
  }
  const stack = await shell(app, loginCard());
  const form = stack.querySelector('#auth-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const error = stack.querySelector('#auth-error');
    error.textContent = '';
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await api('/auth/login', { method: 'POST', body: { username: String(fd.get('username')).trim(), password: fd.get('password') } });
      if (result.guard) showGuard(stack, result.guard, goTo);
      else await signedIn(goTo);
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  });
}
