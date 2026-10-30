// The desktop app keeps its API keys in a .env-style file. Lines it doesn't
// manage (comments, PORT, RAWG_API_KEY and so on) are left exactly as they are.
const fs = require('node:fs');

// DISCORD_ACTIVITY is "off" when the player turned the Discord activity off.
const SETTINGS_KEYS = ['IGDB_CLIENT_ID', 'IGDB_CLIENT_SECRET', 'STEAM_API_KEY', 'DISCORD_ACTIVITY'];
// API keys are letters, digits, dashes and underscores. Anything else is a paste mistake.
const VALID = /^[\w-]{0,200}$/;

const linePattern = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/;
const unquote = (v) => v.replace(/^(['"])(.*)\1$/, '$2');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readSettings(file) {
  const values = Object.fromEntries(SETTINGS_KEYS.map((k) => [k, '']));
  for (const line of readText(file).split(/\r?\n/)) {
    const m = linePattern.exec(line);
    if (m && SETTINGS_KEYS.includes(m[1])) values[m[1]] = unquote(m[2]);
  }
  return values;
}

// Returns the cleaned values, or throws with a message meant for the person typing them.
function cleanSettings(input) {
  const values = {};
  for (const key of SETTINGS_KEYS) {
    const value = String(input?.[key] ?? '').trim();
    if (!VALID.test(value)) throw new Error(`${key} can only contain letters, numbers, dashes and underscores.`);
    values[key] = value;
  }
  if (Boolean(values.IGDB_CLIENT_ID) !== Boolean(values.IGDB_CLIENT_SECRET)) {
    throw new Error('IGDB needs both the Client ID and the Client Secret.');
  }
  return values;
}

function writeSettings(file, input) {
  const values = cleanSettings(input);
  const pending = new Set(SETTINGS_KEYS);
  const lines = readText(file).split(/\r?\n/).map((line) => {
    const key = linePattern.exec(line)?.[1];
    if (!pending.has(key)) return line;
    pending.delete(key);
    return `${key}=${values[key]}`;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const key of pending) lines.push(`${key}=${values[key]}`);
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return values;
}

module.exports = { SETTINGS_KEYS, readSettings, writeSettings };
