// Subtitle Studio (a GameShelf Supporter perk): the Arabic subtitle overlay's
// font, size, text color and background box opacity. Saved on this PC in
// subtitle-studio.json. Without the perk the defaults are used (saved choices
// are kept, so they come back when the perk does). Arabic packs themselves
// are free for everyone and never depend on this.
const fs = require('node:fs');
const path = require('node:path');

// The fonts bundled in public/fonts/studio (all under the SIL Open Font License).
const FONTS = {
  default: { name: 'GameShelf (Thmanyah Sans / Alexandria)', family: null },
  cairo: { name: 'Cairo', family: 'GS Cairo' },
  tajawal: { name: 'Tajawal', family: 'GS Tajawal' },
  amiri: { name: 'Amiri', family: 'GS Amiri' },
  'ibm-plex-sans-arabic': { name: 'IBM Plex Sans Arabic', family: 'GS IBM Plex Sans Arabic' },
};
const DEFAULTS = Object.freeze({ font: 'default', size: 100, color: '#ffffff', background: 86 });

/** Valid settings from anything (unknown or out-of-range values fall back to the defaults). */
function cleanStudio(input = {}) {
  const size = Math.round(Number(input.size));
  const background = Math.round(Number(input.background));
  return {
    font: Object.hasOwn(FONTS, input.font) ? input.font : DEFAULTS.font,
    size: size >= 80 && size <= 150 ? size : DEFAULTS.size,
    color: /^#[0-9a-f]{6}$/i.test(String(input.color || '')) ? String(input.color).toLowerCase() : DEFAULTS.color,
    background: background >= 0 && background <= 100 ? background : DEFAULTS.background,
  };
}

const isDefault = (s) => Object.keys(DEFAULTS).every((k) => cleanStudio(s)[k] === DEFAULTS[k]);

function createStudioStore(dataDir) {
  const file = path.join(dataDir, 'subtitle-studio.json');
  return {
    read() {
      try {
        return cleanStudio(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        return { ...DEFAULTS };
      }
    },
    save(input) {
      const settings = cleanStudio(input);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(settings, null, 2));
      return settings;
    },
  };
}

/** What the overlay applies: the saved settings with the perk, else the defaults. */
const effectiveStudio = (saved, allowed) => (allowed ? cleanStudio(saved) : { ...DEFAULTS });

module.exports = { FONTS, DEFAULTS, cleanStudio, isDefault, createStudioStore, effectiveStudio };
