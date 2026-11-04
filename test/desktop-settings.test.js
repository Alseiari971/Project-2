const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSettings, writeSettings } = require('../desktop/settings');

const tempFile = (text) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gameshelf-')), 'settings.env');
  if (text !== undefined) fs.writeFileSync(file, text);
  return file;
};

test('a missing settings file reads as empty keys', () => {
  assert.deepStrictEqual(readSettings(tempFile()), { STEAM_API_KEY: '', DISCORD_ACTIVITY: '' });
});

test('saving keys keeps the other lines of the file (old IGDB lines are left alone, unused)', () => {
  const file = tempFile('# my settings\nIGDB_CLIENT_ID="old"\nPORT=4000\r\nRAWG_API_KEY=abc\n');
  writeSettings(file, { STEAM_API_KEY: 'KEY_1' });
  assert.strictEqual(fs.readFileSync(file, 'utf8'),
    '# my settings\nIGDB_CLIENT_ID="old"\nPORT=4000\nRAWG_API_KEY=abc\nSTEAM_API_KEY=KEY_1\nDISCORD_ACTIVITY=\n');
  assert.deepStrictEqual(readSettings(file), { STEAM_API_KEY: 'KEY_1', DISCORD_ACTIVITY: '' });
});

test('pasted spaces are trimmed', () => {
  const file = tempFile();
  writeSettings(file, { STEAM_API_KEY: '  ABC123\n' });
  assert.strictEqual(readSettings(file).STEAM_API_KEY, 'ABC123');
});

test('keys that could break the file are refused', () => {
  const file = tempFile('PORT=4000\n');
  assert.throws(() => writeSettings(file, { STEAM_API_KEY: 'abc\nPORT=1' }), /letters, numbers/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'PORT=4000\n');
});
