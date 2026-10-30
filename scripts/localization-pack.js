#!/usr/bin/env node
// Builds and signs Arabic localization packs (see desktop/localization/pack.js).
//
//   node scripts/localization-pack.js keygen <folder>
//     Makes the signing key pair: pack-signing.key (keep it secret, never
//     commit it) and pack-signing.pub (goes in desktop/config.json as
//     "localizationPackKey").
//
//   node scripts/localization-pack.js make <pack folder> --engine unreal|unity --id <id> --version <x.y.z>
//        --key pack-signing.key [--font-bundle <name>] [--backend mono|il2cpp] [--unity <version>] [--arch x64]
//     Lists every file under <pack folder>/payload (each lands at the same
//     path in the game: in Content/Paks for Unreal, in the game folder for
//     Unity), writes pack.json and signs it.
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
    if (args[i].startsWith('--')) out[args[i].slice(2)] = args[++i];
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
    const files = (await payloadFiles(path.join(folder, 'payload'))).map((rel) => ({ source: `payload/${rel}`, target: rel }));
    const requires = {};
    if (opt.backend) requires.unityBackend = opt.backend;
    if (opt.unity) requires.unityVersion = opt.unity;
    if (opt.arch) requires.arch = opt.arch;
    const manifest = await writePack(folder, {
      id: opt.id,
      version: opt.version,
      engine: opt.engine,
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
