// Seasons: the home page dresses up for the time of year, the way stores redo
// their front page for a seasonal sale. The season comes from the visitor's
// own calendar. Holidays that move follow the calendars built into the
// browser: Ramadan and Eid the Islamic (Umm al-Qura) one, Lunar New Year the
// Chinese one. What each season shows is decided in src/seasons.js; its
// colors are in the stylesheet under [data-season].

import { mount } from './lib.js';
import { icon } from './icons.js';
import { t, tn } from './i18n.js';

const PREF_KEY = 'gs-season';
const DAY = 24 * 60 * 60 * 1000;
const ZODIAC = ['Rat', 'Ox', 'Tiger', 'Rabbit', 'Dragon', 'Snake', 'Horse', 'Goat', 'Monkey', 'Rooster', 'Dog', 'Pig'];

/** Month and day of `date` in another calendar, or {} if the browser lacks it. */
function calendarDate(date, calendar) {
  try {
    const out = {};
    for (const p of new Intl.DateTimeFormat(`en-u-ca-${calendar}`, { month: 'numeric', day: 'numeric' }).formatToParts(date)) {
      if (p.type === 'month' || p.type === 'day') out[p.type] = parseInt(p.value, 10);
    }
    return out;
  } catch {
    return {};
  }
}
const hijri = (d) => calendarDate(d, 'islamic-umalqura');
const chinese = (d) => calendarDate(d, 'chinese');
// Month and day as one number: October 17 is 1017.
const monthDay = (d) => (d.getMonth() + 1) * 100 + d.getDate();
const daysUntil = (d, month, day) => Math.round((new Date(d.getFullYear(), month - 1, day) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / DAY);

// Checked in order: the first season whose dates match wins, so a holiday
// that falls inside a longer season shows instead of it.
export const SEASONS = [
  {
    id: 'eid',
    name: t('Eid Mubarak'),
    ornament: 'season-sparkle',
    fx: 'sparkles',
    active: (d) => {
      const h = hijri(d);
      return (h.month === 10 && h.day <= 3) || (h.month === 12 && h.day >= 10 && h.day <= 13);
    },
    note: (d) => (hijri(d).month === 10 ? t('Eid al-Fitr') : t('Eid al-Adha')),
  },
  {
    id: 'ramadan',
    name: t('Ramadan Nights'),
    ornament: 'season-crescent',
    fx: 'stars',
    active: (d) => hijri(d).month === 9,
    note: (d) => t('Ramadan Kareem · Night {n}', { n: hijri(d).day }),
  },
  {
    id: 'lunar-new-year',
    name: t('Lunar New Year'),
    ornament: 'season-lantern',
    fx: 'lanterns',
    active: (d) => {
      const c = chinese(d);
      return c.month === 1 && c.day <= 15;
    },
    note: (d) => t('Year of the {animal}', { animal: t(ZODIAC[(((d.getFullYear() - 4) % 12) + 12) % 12]) }),
  },
  {
    id: 'fright-night',
    name: t('Fright Night'),
    ornament: 'season-pumpkin',
    fx: 'embers',
    active: (d) => monthDay(d) >= 1017 && monthDay(d) <= 1102,
    note: (d) => {
      const days = daysUntil(d, 10, 31);
      if (days > 1) return t('Halloween in {days}', { days: tn(days, 'day') });
      if (days === 1) return t('Halloween is tomorrow');
      if (days === 0) return t('Happy Halloween');
      return t('Until November 2');
    },
  },
  {
    id: 'winter',
    name: t('Winter Shelf'),
    ornament: 'season-snowflake',
    fx: 'snow',
    active: (d) => monthDay(d) >= 1210 || monthDay(d) <= 106,
    note: (d) => (monthDay(d) >= 1231 || monthDay(d) <= 101 ? t('Happy New Year') : t('Happy holidays')),
  },
  {
    id: 'summer',
    name: t('Summer Heat'),
    ornament: 'season-sun',
    fx: 'motes',
    active: (d) => monthDay(d) >= 615 && monthDay(d) <= 831,
    note: () => t('Long days, big games'),
  },
];

/** The visitor's choice: "auto" follows the calendar, "off" turns seasons off, or a season id to preview. */
export function seasonPreference() {
  try {
    return localStorage.getItem(PREF_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

export function setSeasonPreference(value) {
  try {
    if (value === 'auto') localStorage.removeItem(PREF_KEY);
    else localStorage.setItem(PREF_KEY, value);
  } catch {}
  applySeason();
}

/** The season showing now, or null for the everyday look. */
export function currentSeason(date = new Date()) {
  const pref = seasonPreference();
  if (pref === 'off') return null;
  if (pref !== 'auto') return SEASONS.find((s) => s.id === pref) || null;
  return SEASONS.find((s) => s.active(date)) || null;
}

/** The short line under the season's name, like "Halloween in 2 days". */
export const seasonNote = (season, date = new Date()) => season.note(date);

/** Marks the page with the season, which sets its colors, and puts the season's ornament by the logo. */
export function applySeason() {
  const season = currentSeason();
  if (season) document.documentElement.dataset.season = season.id;
  else delete document.documentElement.dataset.season;
  const logo = document.querySelector('.topbar .logo');
  if (logo) {
    let ornament = logo.querySelector('.logo-ornament');
    if (season) {
      if (!ornament) {
        ornament = document.createElement('span');
        ornament.className = 'logo-ornament';
        logo.append(ornament);
      }
      ornament.title = season.name;
      mount(ornament, icon(season.ornament));
    } else {
      ornament?.remove();
    }
  }
  return season;
}
