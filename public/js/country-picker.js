// Nationality: a flag badge for profiles, and a searchable country picker
// (Arab countries first) that keeps the ISO code in a hidden input.
import { html, mount, onLeave } from './lib.js';
import { t, lang } from './i18n.js';
import { COUNTRIES, ARAB_COUNTRIES, flagEmoji, countryName } from './countries.js';

const name = (code) => countryName(code, lang);

/** The «داعم» badge of a GameShelf Supporter. */
export const supporterBadge = (user) => (user?.supporter ? html`<span class="supporter-badge" title="${t('GameShelf Supporter')}">${t('Supporter')}</span>` : '');

/** A small flag with the country's name on hover (and for screen readers). */
export function flagBadge(code, { withName = false } = {}) {
  if (!code) return '';
  const label = name(code);
  return html`<span class="flag-badge" title="${label}"><span class="flag" role="img" aria-label="${label}">${flagEmoji(code)}</span>${withName ? html`<span>${label}</span>` : ''}</span>`;
}

const fold = (text) => String(text).toLocaleLowerCase(lang).normalize('NFKD').replace(/[̀-ًͯ-ٟ]/g, '');

/** Every country with its name here, Arab countries first, then the rest by name. */
function ordered() {
  const collator = new Intl.Collator(lang);
  const all = COUNTRIES.map((code) => ({ code, name: name(code), en: countryName(code, 'en') }));
  const arab = new Set(ARAB_COUNTRIES);
  return {
    arab: ARAB_COUNTRIES.map((code) => all.find((c) => c.code === code)),
    rest: all.filter((c) => !arab.has(c.code)).sort((a, b) => collator.compare(a.name, b.name)),
  };
}

/** The picker's markup; `wireCountryPicker` makes it work. */
export function countryPicker({ inputName = 'nationality', value = '', id = 'country-picker', required = true } = {}) {
  return html`
    <div class="country-picker" id="${id}">
      <input type="hidden" name="${inputName}" value="${value}" ${required ? html`data-required="1"` : ''}>
      <button type="button" class="input country-current" aria-haspopup="listbox" aria-expanded="false">
        ${value ? html`<span class="flag" aria-hidden="true">${flagEmoji(value)}</span><span>${name(value)}</span>` : html`<span class="muted">${t('Choose your country')}</span>`}
      </button>
      <div class="country-panel" hidden>
        <input class="input country-search" type="search" placeholder="${t('Search countries')}" aria-label="${t('Search countries')}" autocomplete="off">
        <ul class="country-list" role="listbox" aria-label="${t('Nationality')}"></ul>
      </div>
    </div>`;
}

export function wireCountryPicker(root, { onChange = () => {} } = {}) {
  const hidden = root.querySelector('input[type="hidden"]');
  const current = root.querySelector('.country-current');
  const panel = root.querySelector('.country-panel');
  const search = root.querySelector('.country-search');
  const list = root.querySelector('.country-list');
  const { arab, rest } = ordered();
  let active = 0;

  const option = (c) => html`<li role="option" data-code="${c.code}" aria-selected="${c.code === hidden.value}"><span class="flag" aria-hidden="true">${flagEmoji(c.code)}</span><span>${c.name}</span></li>`;
  const draw = () => {
    const q = fold(search.value.trim());
    const hit = (c) => !q || fold(c.name).includes(q) || fold(c.en).includes(q) || c.code.toLowerCase() === q;
    const a = arab.filter(hit);
    const r = rest.filter(hit);
    mount(list, a.length || r.length
      ? html`${a.length ? html`<li class="country-group" role="presentation">${t('Arab countries')}</li>${a.map(option)}` : ''}
        ${r.length ? html`<li class="country-group" role="presentation">${t('All countries')}</li>${r.map(option)}` : ''}`
      : html`<li class="country-group" role="presentation">${t('No country matches that.')}</li>`);
    active = 0;
    highlight();
  };
  const options = () => [...list.querySelectorAll('[data-code]')];
  const highlight = () => options().forEach((el, i) => el.classList.toggle('active', i === active));
  const open = (yes) => {
    panel.hidden = !yes;
    current.setAttribute('aria-expanded', String(yes));
    if (yes) {
      search.value = '';
      draw();
      search.focus();
    }
  };
  const pick = (code) => {
    hidden.value = code;
    mount(current, html`<span class="flag" aria-hidden="true">${flagEmoji(code)}</span><span>${name(code)}</span>`);
    open(false);
    current.focus();
    onChange(code);
  };

  current.addEventListener('click', (e) => {
    e.stopPropagation();
    open(panel.hidden);
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  search.addEventListener('input', draw);
  search.addEventListener('keydown', (e) => {
    const all = options();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % Math.max(all.length, 1);
      highlight();
      all[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (all[active]) pick(all[active].dataset.code);
    } else if (e.key === 'Escape') {
      open(false);
      current.focus();
    }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-code]');
    if (li) pick(li.dataset.code);
  });
  const close = () => { if (!panel.hidden) open(false); };
  document.addEventListener('click', close);
  onLeave(() => document.removeEventListener('click', close));
  return { value: () => hidden.value, close };
}
