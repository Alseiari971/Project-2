// The Pack Studio, in the desktop app's Admin Panel: builds an Arabic pack
// from a game folder or a file of its text, signs it with GameShelf's pack key
// and publishes it to the cloud catalog, with no command prompt. It runs the
// same pack builder as scripts/build-arabic-pack.py (with the app's own Python,
// see builder.js) and shows its output as it goes.
//
// Its settings (translation provider, model, the signing key file) are kept in
// <data>/studio/settings.json. API keys are kept there too, but only encrypted
// with the operating system's own protection (Electron's safeStorage: DPAPI on
// Windows); when that isn't available they're kept for this session only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: defaultSpawn } = require('node:child_process');
const { readLine } = require('./builder');
const { writeZip } = require('../../src/zip');

const ENGINES = ['auto', 'unreal', 'unity', 'reengine', 'godot', 'renpy', 'overlay'];
const PROVIDERS = { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
const TRANSLATE = ['shared', 'provider', 'none'];
const ID_RE = /^[\w.\-]{1,80}$/;

class StudioError extends Error {}

/**
 * The builder's command line for a Studio build. `options`: { source, engine,
 * id, version, title, steamAppId, gameId, translate: 'shared' | 'provider' |
 * 'none', provider, model, pakList, reviewed }.
 */
function buildArgs(options, { script, msgTool, keyFile, outDir, server }) {
  const o = options || {};
  if (!o.source) throw new StudioError('Pick the game folder or the file with its text.');
  if (!ID_RE.test(String(o.id || ''))) throw new StudioError('The pack ID can only have letters, numbers, dots, dashes and underscores.');
  if (!ID_RE.test(String(o.version || ''))) throw new StudioError('Give the pack a version, like 1.0.0.');
  if (!o.steamAppId && !o.gameId) throw new StudioError('Give the game\'s Steam app ID or its GameShelf game ID.');
  if (o.steamAppId && !/^\d{1,10}$/.test(String(o.steamAppId))) throw new StudioError('The Steam app ID is a number.');
  if (!keyFile) throw new StudioError('Pick GameShelf\'s pack signing key (pack-signing.key) first.');
  const engine = ENGINES.includes(o.engine) ? o.engine : 'auto';
  const translate = TRANSLATE.includes(o.translate) ? o.translate : 'shared';
  const args = [script, o.source, '--id', o.id, '--version', o.version, '--key', keyFile, '--out', path.join(outDir, o.id)];
  if (o.title) args.push('--title', String(o.title).slice(0, 120));
  args.push(...(o.steamAppId ? ['--steam-app-id', String(o.steamAppId)] : ['--game-id', String(o.gameId)]));
  if (engine !== 'auto') args.push('--engine', engine);
  if (translate === 'shared') args.push('--shared', server);
  else if (translate === 'provider') {
    if (!PROVIDERS[o.provider]) throw new StudioError('Pick OpenAI or Gemini.');
    if (!o.model) throw new StudioError('Give the model name.');
    args.push('--provider', o.provider, '--model', String(o.model));
  } else args.push('--no-translate');
  if (msgTool) args.push('--msg-tool', msgTool);
  if (o.pakList) args.push('--pak-list', o.pakList);
  if (o.reviewed) args.push('--translations', o.reviewed);
  return args;
}

/** The public half of a private key file, as PEM; null if it isn't a key. */
function publicKeyOf(keyFile) {
  try {
    return crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'))).export({ type: 'spki', format: 'pem' });
  } catch {
    return null;
  }
}

const samePem = (a, b) => Boolean(a && b) && a.replace(/\s+/g, '') === b.replace(/\s+/g, '');

/** Every file under `dir`, as [{ name, data }] with forward-slash names. */
function readTree(dir) {
  const out = [];
  const walk = (folder, prefix) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else if (entry.isFile()) out.push({ name: prefix + entry.name, data: fs.readFileSync(full) });
    }
  };
  walk(dir, '');
  return out;
}

/**
 * `secure` encrypts API keys for storing: { available(), encrypt(text) -> Buffer, decrypt(Buffer) -> text }
 * (Electron's safeStorage); without it, keys are kept for this session only.
 */
function createStudio({ paths, dataDir, cloud, appKeys = [], secure = null, spawn = defaultSpawn, nodePath = process.execPath }) {
  const canStore = () => Boolean(secure?.available());
  const dir = path.join(dataDir, 'studio');
  const settingsFile = path.join(dir, 'settings.json');
  const outDir = path.join(dir, 'builds');
  const sessionKeys = {}; // API keys kept for this session when they can't be stored safely
  let running = null;

  function readSettings() {
    try {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {
      return {};
    }
  }

  function writeSettings(settings) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
  }

  function apiKey(provider) {
    const stored = readSettings().apiKeys?.[provider];
    if (stored && canStore()) {
      try {
        return secure.decrypt(Buffer.from(stored, 'base64'));
      } catch {}
    }
    return sessionKeys[provider] || null;
  }

  /** What the Studio shows: the choices, whether keys are saved, and whether the signing key is GameShelf's. */
  function settings() {
    const s = readSettings();
    const keyPublic = s.keyFile ? publicKeyOf(s.keyFile) : null;
    return {
      provider: s.provider || 'openai',
      model: s.model || '',
      keyFile: s.keyFile || null,
      keyOk: Boolean(keyPublic),
      // The app checks packs with GameShelf's public key: a pack signed with another key won't be accepted.
      keyMatchesApp: Boolean(keyPublic) && appKeys.some((k) => samePem(k, keyPublic)),
      hasKey: Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, Boolean(apiKey(p))])),
      keysStoredSafely: canStore(),
      canBuild: Boolean(paths.python),
      engines: ENGINES,
    };
  }

  function saveSettings({ provider, model, keyFile, apiKey: newKey } = {}) {
    const s = readSettings();
    if (provider !== undefined) {
      if (!PROVIDERS[provider]) throw new StudioError('Pick OpenAI or Gemini.');
      s.provider = provider;
    }
    if (model !== undefined) s.model = String(model).trim().slice(0, 100);
    if (keyFile !== undefined) {
      if (keyFile && !publicKeyOf(keyFile)) throw new StudioError('That file isn\'t a signing key (pack-signing.key).');
      s.keyFile = keyFile || null;
    }
    if (newKey !== undefined) {
      const which = s.provider || 'openai';
      s.apiKeys ??= {};
      if (!newKey) {
        delete s.apiKeys[which];
        delete sessionKeys[which];
      } else if (canStore()) {
        s.apiKeys[which] = secure.encrypt(String(newKey).trim()).toString('base64');
      } else {
        sessionKeys[which] = String(newKey).trim();
      }
    }
    writeSettings(s);
    return settings();
  }

  /** Makes a new signing key pair in `folder` (never over an existing one). */
  function makeKeys(folder) {
    const keyFile = path.join(folder, 'pack-signing.key');
    const pubFile = path.join(folder, 'pack-signing.pub');
    if (fs.existsSync(keyFile) || fs.existsSync(pubFile)) throw new StudioError('That folder already has a pack-signing.key. Pick it instead, or another folder.');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    const pem = publicKey.export({ type: 'spki', format: 'pem' });
    fs.writeFileSync(pubFile, pem, { flag: 'wx' });
    saveSettings({ keyFile });
    return { keyFile, publicKey: pem };
  }

  /**
   * Builds and signs a pack. onLog gets every line the builder prints
   * ({ line, stream }), onProgress the parsed progress (see builder.js's readLine).
   * Resolves to { packDir, outDir, review } (review: the translations.csv to check).
   */
  async function build(options, { onLog = () => {}, onProgress = () => {} } = {}) {
    if (running) throw new StudioError('A pack is already being built.');
    if (!paths.python) throw new StudioError('This copy of GameShelf has no pack builder.');
    // Taken before anything waits, so a second click can't start a second build.
    running = { kill: () => {} };
    try {
      return await startBuild(options, { onLog, onProgress });
    } finally {
      running = null;
    }
  }

  async function startBuild(options, { onLog, onProgress }) {
    const s = readSettings();
    const args = buildArgs(options, { script: paths.script, msgTool: paths.msgTool, keyFile: s.keyFile, outDir, server: cloud.server() });
    const env = { ...process.env, GAMESHELF_TOKEN: '', GAMESHELF_NODE: nodePath, GAMESHELF_SIGNER: paths.signer, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
    if (options.translate === 'provider') {
      const key = apiKey(options.provider);
      if (!key) throw new StudioError('Save your API key for that provider first.');
      env[PROVIDERS[options.provider]] = key;
    }
    if (options.translate !== 'provider' && options.translate !== 'none') {
      const session = await cloud.session();
      if (!session) throw new StudioError('Log in to GameShelf first.');
      env.GAMESHELF_SESSION = session;
    }
    const state = { phase: 'starting' };
    const child = spawn(paths.python, args, { windowsHide: true, env });
    running = child;
    let stopped = false;
    child.kill = ((kill) => (...a) => {
      stopped = true;
      return kill(...a);
    })(child.kill.bind(child));
    const errors = [];
    return new Promise((resolve, reject) => {
      const reader = (stream) => {
        let buffer = '';
        child[stream].setEncoding('utf8');
        child[stream].on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop();
          for (const line of lines) {
            if (stream === 'stderr') errors.push(line);
            onLog({ line, stream });
            readLine(line.trim(), state);
            onProgress({ ...state });
          }
        });
        child[stream].on('end', () => {
          if (buffer) {
            onLog({ line: buffer, stream });
            readLine(buffer.trim(), state);
          }
        });
      };
      reader('stdout');
      reader('stderr');
      child.on('error', (err) => reject(new StudioError(`The pack builder couldn't start: ${err.message}`)));
      child.on('close', (code, signal) => {
        if (signal || stopped) return reject(new StudioError('The build was stopped.'));
        if (code === 0 && state.packDir) {
          const out = path.join(outDir, options.id);
          return resolve({ packDir: state.packDir, outDir: out, review: path.join(out, 'translations.csv'), state });
        }
        reject(new StudioError(errors.filter(Boolean).pop()?.replace(/^error:\s*/, '') || 'The build didn\'t finish.'));
      });
    });
  }

  return {
    settings,
    saveSettings,
    makeKeys,
    build,
    cancel: () => running?.kill(),
    /** A built pack folder as a .zip (what the catalog takes). */
    zip: (packDir) => writeZip(readTree(packDir)),
    /** Publishes a built pack to the cloud catalog (admins only; the server checks). */
    async publish(packDir) {
      const res = await cloud.request('/api/admin/packs', { method: 'POST', raw: writeZip(readTree(packDir)), type: 'application/zip', timeout: 10 * 60 * 1000 });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new StudioError('Log in to GameShelf first.');
      if (!res.ok) throw new StudioError(data.error || 'GameShelf\'s server didn\'t take the pack.');
      return data.pack;
    },
    outDir,
  };
}

module.exports = { createStudio, buildArgs, publicKeyOf, StudioError, ENGINES };
