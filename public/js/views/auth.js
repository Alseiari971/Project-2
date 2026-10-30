import { html, th, api, mount, state, refreshMe, profileHref } from '../lib.js';
import { t } from '../i18n.js';

export async function authView(app, mode) {
  const isLogin = mode === 'login';
  // A wall of game art behind the form, streaming-service style.
  const art = await api('/games?sort=popular').then((d) => d.results.filter((g) => g.image).slice(0, 12)).catch(() => []);

  mount(app, html`
    <div class="auth">
      <div class="auth-wall" aria-hidden="true">${art.map((g) => html`<div class="auth-tile" data-bg="${g.image}"></div>`)}</div>
      <div class="auth-shade"></div>
      <form class="auth-card" id="auth-form">
        <h1>${isLogin ? t('Welcome back') : t('Start your shelf')}</h1>
        <p class="muted">${isLogin ? t('Pick up where you left off.') : t('Log every game you play, rate them, and show your profile off.')}</p>
        <label>${t('Username')}
          <input class="input" name="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_]+" autocomplete="username" autofocus>
        </label>
        <label>${t('Password')}
          <input class="input" name="password" type="password" required minlength="8" autocomplete="${isLogin ? 'current-password' : 'new-password'}">
        </label>
        <p class="form-error" id="auth-error" role="alert"></p>
        ${isLogin ? '' : html`<p class="muted small">${th('By creating an account you agree to the {terms}.', { terms: html`<a href="#/legal">${t('terms, community rules and privacy notice')}</a>` })}</p>`}
        <button class="btn btn-light btn-lg btn-block" type="submit">${isLogin ? t('Log in') : t('Create account')}</button>
        <p class="muted small center">${isLogin
          ? html`${t('New here?')} <a href="#/register">${t('Create an account')}</a>`
          : html`${t('Already have an account?')} <a href="#/login">${t('Log in')}</a>`}</p>
      </form>
    </div>
  `);

  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api(`/auth/${isLogin ? 'login' : 'register'}`, {
        method: 'POST',
        body: { username: fd.get('username'), password: fd.get('password') },
      });
      await refreshMe();
      document.dispatchEvent(new Event('user-changed'));
      // New accounts go straight to profile setup.
      location.hash = isLogin ? profileHref(state.user.username) : '#/customize';
    } catch (err) {
      document.getElementById('auth-error').textContent = err.message;
    }
  });
}
