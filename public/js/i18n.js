// Languages: English and Arabic. Text in the code is written in English and
// passed through t(), which returns the Arabic from lang/ar.js when Arabic is
// on (and the English itself when a phrase has no translation yet). Arabic
// also turns the page right-to-left.
import { AR, AR_PLURALS } from './lang/ar.js';

const KEY = 'gs-lang';
export const LANGUAGES = [
  { id: 'en', name: 'English' },
  { id: 'ar', name: 'العربية' },
];

function saved() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** "ar" or "en": the visitor's choice, or their browser's language the first time. */
export const lang = (() => {
  const choice = saved();
  if (choice === 'ar' || choice === 'en') return choice;
  return (navigator.languages || [navigator.language]).some((l) => /^ar\b/i.test(l || '')) ? 'ar' : 'en';
})();
export const isArabic = lang === 'ar';
// Arabic text with Western digits (2026, 7.0), as Gulf apps and the game stores show them.
export const locale = isArabic ? 'ar-u-nu-latn' : 'en';

const fill = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text);

/** The phrase in the current language, with {placeholders} filled in from `vars`. */
export function t(text, vars) {
  return fill(isArabic ? AR[text] ?? text : text, vars);
}

// English counts: "1 game", "3 games". Arabic has six forms (see lang/ar.js).
const EN_PLURALS = {
  game: { one: '{n} game', other: '{n} games' },
  player: { one: '{n} player', other: '{n} players' },
  day: { one: '{n} day', other: '{n} days' },
  hour: { one: '{n} hour', other: '{n} hours' },
  comment: { one: '{n} comment', other: '{n} comments' },
  price: { one: '{n} price', other: '{n} prices' },
  addon: { one: '{n} add-on', other: '{n} add-ons' },
  language: { one: '{n} language', other: '{n} languages' },
};
const rules = new Intl.PluralRules(isArabic ? 'ar' : 'en');

/** A count with its word in the right form: tn(3, 'game') is "3 games" or "3 ألعاب". */
export function tn(n, word) {
  const forms = (isArabic ? AR_PLURALS : EN_PLURALS)[word] || EN_PLURALS[word];
  const form = forms[rules.select(n)] ?? forms.other;
  return fill(form, { n: Number(n).toLocaleString(locale) });
}

/** Switches language; the page reloads so everything is drawn again in it. */
export function setLang(id) {
  try {
    localStorage.setItem(KEY, id);
  } catch {}
  location.reload();
}

/** Sets the page's language and direction. Called once at startup. */
export function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = isArabic ? 'rtl' : 'ltr';
}
