// Builds a game's Arabic pack on this PC, from the player's own copy of the
// game, with the Arabic from GameShelf's server: what the "Request Arabic
// subtitles" button and the switch for games with Arabic ready run. It's the
// same pack builder as scripts/build-arabic-pack.py, run with a Python that
// comes with the app (see scripts/bundle-arabic-builder.py), so players never
// open a command prompt. Only Arabic text comes from the server; the game's own
// files never leave the PC.
//
// Engines it can do without extra tools: RE Engine (with REMSG_Converter, which
// comes with the app) and Ren'Py.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: defaultSpawn } = require('node:child_process');

const BUILDABLE = { 're-patch': 'reengine', 'renpy-tl': 'renpy' };

/**
 * Where the builder and its Python are. Installed, they're in the app's
 * resources (arabic-builder/); from source, the repository's own builder runs
 * with build-tools/arabic-builder's Python if there is one, else python on the PATH.
 * GAMESHELF_PYTHON and GAMESHELF_MSG_TOOL override, for development.
 */
function findBuilder({ packaged, resourcesPath, repoDir, env = process.env, platform = process.platform, exists = fs.existsSync }) {
  const bundle = packaged ? path.join(resourcesPath, 'arabic-builder') : path.join(repoDir, 'build-tools', 'arabic-builder');
  const bundledPython = path.join(bundle, 'python', platform === 'win32' ? 'python.exe' : 'bin/python3');
  const bundledMsgTool = path.join(bundle, 'remsg', 'src', 'main.py');
  const python = env.GAMESHELF_PYTHON || (exists(bundledPython) ? bundledPython : packaged ? null : platform === 'win32' ? 'python' : 'python3');
  return {
    python,
    script: packaged ? path.join(bundle, 'scripts', 'build-arabic-pack.py') : path.join(repoDir, 'scripts', 'build-arabic-pack.py'),
    msgTool: env.GAMESHELF_MSG_TOOL || (exists(bundledMsgTool) ? bundledMsgTool : null),
    // Signing runs on the app's own Node (Electron); its script is kept outside app.asar (asarUnpack).
    signer: packaged ? path.join(resourcesPath, 'app.asar.unpacked', 'scripts', 'localization-pack.js') : path.join(repoDir, 'scripts', 'localization-pack.js'),
  };
}

/** The signing key this copy of the app signs its own packs with, made the first time. */
function localPackKey(dataDir) {
  const dir = path.join(dataDir, 'localization');
  const keyFile = path.join(dir, 'local-pack.key');
  const pubFile = path.join(dir, 'local-pack.pub');
  if (!fs.existsSync(keyFile) || !fs.existsSync(pubFile)) {
    fs.mkdirSync(dir, { recursive: true });
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }));
  }
  return { keyFile, publicKey: fs.readFileSync(pubFile, 'utf8') };
}

/** Reads one line of the builder's output into `state`: { phase, total, translating, asked, missing, limited, translated, packDir }. */
function readLine(line, state) {
  let m;
  if (/^Reading the game|^Took \d+ message files|^REMSG_Converter read/.test(line)) state.phase = 'reading';
  else if ((m = /^(\d+) English lines/.exec(line))) state.total = Number(m[1]);
  else if ((m = /^Shared memory had (\d+) of (\d+) lines/.exec(line))) {
    state.phase = 'translating';
    state.have = Number(m[1]);
    state.asking = Number(m[2]) - Number(m[1]);
    state.asked = 0;
  } else if ((m = /^Shared memory: (\d+)\/(\d+) asked for/.exec(line))) {
    state.phase = 'translating';
    state.asked = Number(m[1]);
    state.asking = Number(m[2]);
  } else if (/translation limit for today/.test(line)) state.limited = true;
  else if ((m = /^(\d+) lines have no Arabic/.exec(line))) state.missing = Number(m[1]);
  else if ((m = /^The shared memory has (\d+) of this game's (\d+) lines/.exec(line))) {
    state.translated = Number(m[1]);
    state.lines = Number(m[2]);
  } else if (/^Put the |^Packed \d+ files|^Arabic files:|^Signed /.test(line)) state.phase = 'packing';
  else if ((m = /^Done: (.*?)(?: \(\d+ lines\))?\. Add it/.exec(line))) {
    state.phase = 'done';
    state.packDir = m[1];
  }
  return state;
}

function createPackBuilder({ paths, outDir, keyFile, spawn = defaultSpawn, nodePath = process.execPath }) {
  const running = new Map(); // game key -> { promise, child, state }

  const canBuild = (tier) => Boolean(BUILDABLE[tier] && paths.python && (tier !== 're-patch' || paths.msgTool));

  /**
   * Builds the pack for a game. `game` is { key, dir, tier, steamAppId, gameId,
   * title }; `server` and `token` are GameShelf's server and this app's device
   * token. Resolves to the final state (packDir set when a pack was made).
   */
  function build(game, { server, token, onProgress = () => {} }) {
    if (running.has(game.key)) return running.get(game.key).promise;
    if (!canBuild(game.tier)) return Promise.reject(new Error('GameShelf can\'t make Arabic for this game on this PC.'));
    const id = `gameshelf-${game.steamAppId ? `steam-${game.steamAppId}` : game.gameId}-ar`;
    const args = [paths.script, game.dir, '--id', id, '--version', `1.0.${Math.floor(Date.now() / 1000)}`,
      '--key', keyFile, '--out', path.join(outDir, id), '--shared', server, '--title', String(game.title || '').slice(0, 120) || id,
      ...(game.steamAppId ? ['--steam-app-id', String(game.steamAppId)] : ['--game-id', String(game.gameId)])];
    if (game.tier === 're-patch') args.push('--engine', 'reengine', '--msg-tool', paths.msgTool, '--require-fonts');
    const state = { phase: 'starting', total: 0, have: 0, asking: 0, asked: 0, missing: 0, translated: 0, lines: 0, limited: false, packDir: null };
    const child = spawn(paths.python, args, {
      windowsHide: true,
      env: {
        ...process.env,
        GAMESHELF_TOKEN: token,
        GAMESHELF_NODE: nodePath,
        GAMESHELF_SIGNER: paths.signer,
        ELECTRON_RUN_AS_NODE: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });
    const errors = [];
    const promise = new Promise((resolve, reject) => {
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          readLine(line.trim(), state);
          onProgress({ ...state });
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => errors.push(chunk));
      child.on('error', (err) => reject(new Error(`GameShelf couldn't start its Arabic builder: ${err.message}`)));
      child.on('close', (code) => {
        if (buffer) readLine(buffer.trim(), state);
        if (code === 0 && state.packDir) return resolve({ ...state });
        const text = errors.join('').trim().split(/\r?\n/).filter(Boolean).pop() || '';
        reject(new Error(text.replace(/^error:\s*/, '') || 'GameShelf couldn\'t make the Arabic for this game.'));
      });
    }).finally(() => running.delete(game.key));
    running.set(game.key, { promise, child, state });
    return promise;
  }

  return {
    canBuild,
    build,
    /** The progress of a build that's running, or null. */
    progress: (key) => (running.has(key) ? { ...running.get(key).state } : null),
    stopAll: () => {
      for (const { child } of running.values()) child.kill();
    },
  };
}

module.exports = { createPackBuilder, findBuilder, localPackKey, readLine, BUILDABLE };
