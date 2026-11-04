// #/pricing ("العضوية والدعم"): GameShelf Supporter, and the promise that
// every Arabic pack stays free. Signed-in players see their plan, what
// they've used, and can redeem a prepaid / gift code.
import { html, api, mount, state, toast, refreshMe } from '../lib.js';
import { t, locale } from '../i18n.js';
import { icon } from '../icons.js';

const fmt = (n) => (n == null ? '∞' : Number(n).toLocaleString(locale));
const date = (ms) => new Date(ms).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });

function meter(label, used, limit) {
  const share = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return html`
    <div class="usage">
      <div class="usage-head"><span>${label}</span><span dir="ltr">${fmt(used)} / ${fmt(limit)}</span></div>
      <div class="usage-bar" data-progress="${share / 100}"><span></span></div>
    </div>`;
}

export async function pricingView(app) {
  document.title = `${t('Membership & support')} · ${t('GameShelf')}`;
  const [info, mine] = await Promise.all([api('/plans'), state.user ? api('/me/plan').catch(() => null) : null]);
  const s = info.plans.supporter;
  const f = info.plans.free;
  const supporter = mine?.plan === 'supporter';

  mount(app, html`
    <div class="page pricing-page">
      <header class="pricing-head">
        <h1>${t('Membership & support')}</h1>
        <p class="free-promise">${icon('check')} <strong>${t('All Arabic packs are free forever.')}</strong>
          ${t('Supporting GameShelf funds our AI translation servers and unlocks cloud compute and customization perks.')}</p>
      </header>

      ${mine ? html`
        <section class="panel my-plan ${supporter ? 'is-supporter' : ''}">
          <div class="plan-head">
            <div>
              <h2>${supporter ? t('You\'re a GameShelf Supporter') : t('Your plan: Free')}</h2>
              <p class="muted small">${supporter
                ? (mine.renews ? t('Renews on {date}.', { date: date(mine.until) }) : t('Supporter until {date}.', { date: date(mine.until) }))
                : t('Everything you need to play in Arabic, free.')}</p>
            </div>
            ${supporter ? html`<span class="supporter-badge">${t('Supporter')}</span>` : ''}
          </div>
          ${meter(t('AI translation today (new lines)'), mine.compute.today.used, mine.compute.today.limit)}
          ${mine.compute.month.limit ? meter(t('AI translation this month (new lines)'), mine.compute.month.used, mine.compute.month.limit) : ''}
          ${mine.compute.newGamesPerDay ? html`<p class="muted small">${t('New games the AI started on today: {used} of {limit}.', { used: mine.compute.newGamesToday, limit: mine.compute.newGamesPerDay })}</p>` : ''}
          ${supporter ? html`<p class="muted small">${t('Boost tokens left this month: {n} of {total}.', { n: mine.boosts.left, total: mine.boosts.perMonth })} <a href="#/arabic">${t('Boost a requested game')}</a></p>` : ''}
          <form class="inline-form" id="redeem-form">
            <input class="input" name="code" placeholder="XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" dir="ltr" aria-label="${t('Gift or prepaid code')}" required>
            <button class="btn btn-light" type="submit">${t('Redeem code')}</button>
          </form>
        </section>` : ''}

      <div class="plan-grid">
        <section class="panel plan-card">
          <h2>${t('Free')} <span class="muted plan-ar" lang="ar">مجاني</span></h2>
          <p class="plan-price">${t('0 AED')}</p>
          <ul class="plan-list">
            <li>${icon('check')} ${t('Download, install and switch on every Arabic pack, unlimited')}</li>
            <li>${icon('check')} ${t('Request Arabic for any game and upvote requests')}</li>
            <li>${icon('check')} ${t('Cloud AI translation: {lines} new lines a day, {games} new game a day', { lines: fmt(f.dailyLines), games: fmt(f.newGamesPerDay) })}</li>
            <li>${icon('check')} ${t('Friends, profiles, lists and support tickets')}</li>
          </ul>
        </section>
        <section class="panel plan-card plan-supporter">
          <h2>${t('GameShelf Supporter')} <span class="plan-ar" lang="ar">داعم GameShelf</span></h2>
          <p class="plan-price">${t('Support GameShelf')}</p>
          <ul class="plan-list">
            <li>${icon('check')} ${t('Everything in Free: Arabic packs stay free for everyone')}</li>
            <li>${icon('star')} ${t('Cloud AI translation: {month} new lines a month, any number of new games, first in the queue', { month: fmt(s.monthlyStrings) })}</li>
            <li>${icon('star')} ${t('{n} boost tokens a month to push requested games up the queue', { n: fmt(s.boostsPerMonth) })}</li>
            <li>${icon('star')} ${t('Subtitle Studio in the desktop app: Cairo, Tajawal, Amiri or IBM Plex Sans Arabic, size 80–150%, text color and box opacity')}</li>
            <li>${icon('star')} ${t('The Supporter badge on your profile and in friends lists')}</li>
            <li>${icon('star')} ${t('Priority support tickets')}</li>
          </ul>
          <div class="row-actions">
            ${info.checkout.monthly ? html`<a class="btn btn-accent" href="${info.checkout.monthly}" target="_blank" rel="noopener noreferrer">${t('Support monthly')}</a>` : ''}
            ${info.checkout.yearly ? html`<a class="btn" href="${info.checkout.yearly}" target="_blank" rel="noopener noreferrer">${t('Support yearly')}</a>` : ''}
            ${!info.checkout.monthly && !info.checkout.yearly ? html`<p class="muted small">${t('Supporter memberships are sold as prepaid codes for now. Ask GameShelf\'s team through Support.')}</p>` : ''}
          </div>
        </section>
      </div>

      <section class="panel pricing-rules">
        <h2>${t('Why the packs are free')}</h2>
        <p class="muted">${t('Games belong to their publishers. GameShelf never sells access to a game or to its Arabic translation: every finished pack is free to download, install and switch on or off, for every player. What a membership pays for is the cloud computing that makes new translations, and extras for GameShelf itself.')}</p>
      </section>
    </div>`);

  document.getElementById('redeem-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button');
    button.disabled = true;
    try {
      const done = await api('/me/plan/redeem', { method: 'POST', body: { code: e.target.code.value } });
      toast(t('Code redeemed: {days} days of GameShelf Supporter. Thank you!', { days: done.days }));
      await refreshMe();
      document.dispatchEvent(new Event('user-changed'));
      pricingView(app);
    } catch (err) {
      toast(err.message, { error: true });
      button.disabled = false;
    }
  });
}
