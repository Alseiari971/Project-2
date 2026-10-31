#!/usr/bin/env node
// Gets everything ready for `npm run dist:win` (run first by it):
//
// 1. GameShelf's pack signing key pair, in ../gameshelf-keys/ beside the
//    repository (or GAMESHELF_KEYS_DIR). Made the first time if there's none.
//    pack-signing.key is private: keep it off GitHub and back it up. The Pack
//    Studio signs with it.
// 2. Its public half in desktop/config.json (localizationPackKey), so every
//    copy of the app, and the server, check packs with it. Commit that change.
// 3. Python and the Arabic pack builder for the installer
//    (scripts/bundle-arabic-builder.py --if-missing).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const keysDir = process.env.GAMESHELF_KEYS_DIR || path.join(REPO, '..', 'gameshelf-keys');
const keyFile = path.join(keysDir, 'pack-signing.key');
const pubFile = path.join(keysDir, 'pack-signing.pub');
const configFile = path.join(REPO, 'desktop', 'config.json');

function ensureKeys() {
  if (fs.existsSync(keyFile)) {
    if (!fs.existsSync(pubFile)) {
      const pub = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'))).export({ type: 'spki', format: 'pem' });
      fs.writeFileSync(pubFile, pub);
    }
    console.log(`Pack signing key: ${keyFile}`);
    return fs.readFileSync(pubFile, 'utf8');
  }
  if (fs.existsSync(pubFile)) {
    // Only the public half here (a build PC without the private key): fine for building the app.
    console.log(`Pack public key: ${pubFile} (the private key is elsewhere)`);
    return fs.readFileSync(pubFile, 'utf8');
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(keysDir, { recursive: true });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(pubFile, pub, { flag: 'wx' });
  console.log(`Made GameShelf's pack signing keys in ${keysDir}.`);
  console.log('  pack-signing.key is private: never put it on GitHub, and keep a backup. Packs signed with it are the only ones the app takes.');
  return pub;
}

function embed(pub) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (config.localizationPackKey === pub) return;
  if (config.localizationPackKey) console.log('desktop/config.json had another pack key: it now has the one in your keys folder.');
  config.localizationPackKey = pub;
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  console.log('Put the pack public key in desktop/config.json. Commit it, and update your server, so both check packs with it.');
}

function bundleBuilder() {
  const script = path.join(REPO, 'scripts', 'bundle-arabic-builder.py');
  for (const python of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const result = spawnSync(python, [script, '--if-missing'], { stdio: 'inherit' });
    if (result.error?.code === 'ENOENT') continue;
    if (result.status !== 0) process.exit(result.status || 1);
    return;
  }
  console.error('Python 3 is needed once, to fetch the Python that goes in the installer: https://www.python.org/downloads/');
  process.exit(1);
}

if (require.main === module) {
  embed(ensureKeys());
  if (!process.argv.includes('--keys-only')) bundleBuilder();
}

module.exports = { ensureKeys, embed };
