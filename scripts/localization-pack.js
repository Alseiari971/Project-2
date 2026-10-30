#!/usr/bin/env node
// Builds and signs Arabic localization packs (see desktop/localization/pack.js).
//
//   node scripts/localization-pack.js keygen <folder>
//     Makes the signing key pair: pack-signing.key (keep it secret, never
//     commit it) and pack-signing.pub (goes in desktop/config.json as
//     "localizationPackKey").
//
//   node scripts/localization-pack.js make <pack folder> --engine unreal|unity|overlay --id <id> --version <x.y.z>
//        --key pack-signing.key (--steam-app-id <n> | --game-id <GameShelf id>) [--title "..."]
//        [--font-bundle <name>] [--backend mono|il2cpp] [--unity <version>] [--arch x64]
//        [--region x,y,w,h] [--text-luma 170] [--dark-text] [--threshold 0.72]
//     Lists every file under <pack folder>/payload (each lands at the same
//     path in the game: in Content/Paks for Unreal, in the game folder for
//     Unity; an overlay pack holds just fingerprints.json from the Arabic
//     compiler), writes pack.json and signs it.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { writePack } = require('../desktop/localization/pack');

async function payloadFiles(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await payloadFiles(full, base)));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const name = args[i].slice(2);
    out[name] = args[i + 1] === undefined || args[i + 1].startsWith('--') ? true : args[++i];
  }
  return out;
}

async function main([command, folder, ...rest]) {
  if (command === 'keygen' && folder) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'pack-signing.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    await fs.writeFile(path.join(folder, 'pack-signing.pub'), publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx' });
    console.log(`Wrote ${path.join(folder, 'pack-signing.key')} (secret) and pack-signing.pub.`);
    return;
  }
  if (command === 'make' && folder) {
    const opt = flags(rest);
    for (const name of ['engine', 'id', 'version', 'key']) if (!opt[name]) throw new Error(`--${name} is required.`);
    if (!opt['steam-app-id'] && !opt['game-id']) throw new Error('--steam-app-id or --game-id is required: it says which game the pack is for.');
    const game = {};
    if (opt['steam-app-id']) game.steamAppId = Number(opt['steam-app-id']);
    if (opt['game-id']) game.gameId = opt['game-id'];
    const overlay = {};
    if (opt.region) overlay.region = opt.region.split(',').map(Number);
    if (opt['text-luma']) overlay.textLuma = Number(opt['text-luma']);
    if (opt['dark-text']) overlay.darkText = true;
    if (opt.threshold) overlay.threshold = Number(opt.threshold);
    const files = (await payloadFiles(path.join(folder, 'payload'))).map((rel) => ({ source: `payload/${rel}`, target: rel }));
    const requires = {};
    if (opt.backend) requires.unityBackend = opt.backend;
    if (opt.unity) requires.unityVersion = opt.unity;
    if (opt.arch) requires.arch = opt.arch;
    const manifest = await writePack(folder, {
      id: opt.id,
      version: opt.version,
      engine: opt.engine,
      game,
      ...(opt.title ? { title: opt.title } : {}),
      ...(Object.keys(overlay).length ? { overlay } : {}),
      ...(opt['font-bundle'] ? { fontBundle: opt['font-bundle'] } : {}),
      ...(opt['ugui-font'] ? { uguiFont: opt['ugui-font'] } : {}),
      ...(Object.keys(requires).length ? { requires } : {}),
      files,
      privateKey: crypto.createPrivateKey(await fs.readFile(opt.key)),
    });
    console.log(`Signed ${manifest.id} ${manifest.version}: ${manifest.files.length} files.`);
    return;
  }
  console.log('Usage: node scripts/localization-pack.js keygen <folder> | make <pack folder> --engine ... --id ... --version ... --key ...');
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
