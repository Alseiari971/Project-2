// Options for an installed game, from the arrow on its Play button: which
// graphics card Windows uses for it, its folder, launcher tools and uninstalling.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Windows keeps each program's graphics card choice here, the same setting as
// Settings > System > Display > Graphics. 0 = let Windows decide, 1 = power saving, 2 = high performance.
const GPU_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
const GPU_VALUES = [0, 1, 2];

function reg(args) {
  return new Promise((resolve, reject) => {
    execFile('reg', args, { windowsHide: true }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/** The GpuPreference number in a value like "SwapEffectUpgradeEnable=1;GpuPreference=2;", or 0. */
function parseGpuPreference(text) {
  return Number(/GpuPreference=(\d)/.exec(text || '')?.[1] || 0);
}

/** The value with GpuPreference set, keeping Windows' other settings (such as windowed game optimizations). */
function withGpuPreference(text, value) {
  const others = String(text || '').split(';').map((s) => s.trim()).filter((s) => s && !s.startsWith('GpuPreference='));
  return [...others, ...(value ? [`GpuPreference=${value}`] : [])].map((s) => `${s};`).join('');
}

async function readRegValue(exe) {
  try {
    const out = await reg(['query', GPU_KEY, '/v', exe]);
    return /REG_SZ\s+(.*)$/m.exec(out)?.[1].trim() || '';
  } catch {
    return '';
  }
}

async function getGpuPreference(exe) {
  return parseGpuPreference(await readRegValue(exe));
}

async function setGpuPreference(exe, value) {
  if (!GPU_VALUES.includes(value)) throw new Error('Unknown graphics setting.');
  const next = withGpuPreference(await readRegValue(exe), value);
  if (next) await reg(['add', GPU_KEY, '/v', exe, '/t', 'REG_SZ', '/d', next, '/f']);
  else await reg(['delete', GPU_KEY, '/v', exe, '/f']).catch(() => {});
}

// Helper programs that run beside a game; never the one to set graphics for.
const HELPER = /(crash|start_protected|report|launcher|helper|unins|redist|setup|install|anticheat|easyanticheat|battleye|beservice|vc_?redist|dxsetup|ue4prereq|cefprocess|webhelper)/i;

/** The game's own program among the files seen running from its folder. */
function pickMainProgram(paths) {
  const exes = [...new Set(paths)];
  return exes.find((p) => !HELPER.test(path.basename(p))) || exes[0] || null;
}

/**
 * Remembers each game's program file once it has been seen running, so the
 * graphics card setting works for Steam and Epic games too, whose manifests
 * don't say which file is the game.
 */
function createProgramStore(file) {
  let programs = {};
  try {
    programs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return {
    get: (key) => programs[key] || null,
    remember(key, exe) {
      if (!exe || programs[key] === exe) return;
      programs[key] = exe;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(programs, null, 2));
      } catch {}
    },
  };
}

/** GOG's own uninstaller in the game's folder, if there is one. */
function gogUninstaller(dir) {
  if (!dir) return null;
  const file = path.join(dir, 'unins000.exe');
  return fs.existsSync(file) ? file : null;
}

module.exports = {
  getGpuPreference,
  setGpuPreference,
  parseGpuPreference,
  withGpuPreference,
  pickMainProgram,
  createProgramStore,
  gogUninstaller,
};
