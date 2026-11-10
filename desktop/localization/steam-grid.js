// A game's Arabic logo in the player's Steam library. Steam shows a custom logo
// from <Steam>/userdata/<account>/config/grid/<appid>_logo.png (its own "Set
// custom artwork"). A pack with a title logo (steamLogo in pack.json) can put it
// there, for every account on this PC, when the player turns that on.
//
// A logo the player set themselves is never lost: it's kept beside the new one
// (<appid>_logo.png.gameshelf-backup) and put back when the Arabic logo comes
// out. GameShelf only removes a logo that is still the one it put in.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Each Steam account's artwork folder on this PC: <root>/userdata/<digits>/config/grid. */
async function gridFolders(roots) {
  const out = [];
  for (const root of roots || []) {
    const users = await fs.readdir(path.join(root, 'userdata'), { withFileTypes: true }).catch(() => []);
    for (const user of users) {
      if (user.isDirectory() && /^\d{1,12}$/.test(user.name) && user.name !== '0') out.push(path.join(root, 'userdata', user.name, 'config', 'grid'));
    }
  }
  return out;
}

const names = (appId) => {
  const id = Number(appId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('The Steam app ID is a number.');
  return { logo: `${id}_logo.png`, backup: `${id}_logo.png.gameshelf-backup`, mark: `${id}_logo.gameshelf.json` };
};

/** Puts `png` in as the game's library logo for every Steam account here. Returns how many folders it went into. */
async function applyLogo({ roots, appId, png }) {
  const n = names(appId);
  const data = await fs.readFile(png);
  if (!data.subarray(0, 8).equals(PNG) || data.length > 8 * 1024 * 1024) throw new Error('The logo isn\'t a PNG image (up to 8 MB).');
  const hash = sha256(data);
  let count = 0;
  for (const grid of await gridFolders(roots)) {
    await fs.mkdir(grid, { recursive: true });
    const target = path.join(grid, n.logo);
    const current = await fs.readFile(target).catch(() => null);
    const mark = JSON.parse(await fs.readFile(path.join(grid, n.mark), 'utf8').catch(() => 'null'));
    if (current && sha256(current) === hash) {
      if (!mark) await fs.writeFile(path.join(grid, n.mark), JSON.stringify({ sha256: hash }));
      count += 1;
      continue;
    }
    // A logo that isn't GameShelf's (the player's own artwork) is kept, once.
    if (current && (!mark || sha256(current) !== mark.sha256)) await fs.writeFile(path.join(grid, n.backup), current, { flag: 'wx' }).catch(() => {});
    await fs.writeFile(target, data);
    await fs.writeFile(path.join(grid, n.mark), JSON.stringify({ sha256: hash }));
    count += 1;
  }
  return count;
}

/** Takes GameShelf's logo out again (only where it's still the one put in), and puts the player's own back. */
async function removeLogo({ roots, appId }) {
  const n = names(appId);
  let count = 0;
  for (const grid of await gridFolders(roots)) {
    const mark = JSON.parse(await fs.readFile(path.join(grid, n.mark), 'utf8').catch(() => 'null'));
    if (!mark) continue;
    const target = path.join(grid, n.logo);
    const current = await fs.readFile(target).catch(() => null);
    if (current && sha256(current) === mark.sha256) {
      await fs.rm(target, { force: true });
      const backup = await fs.readFile(path.join(grid, n.backup)).catch(() => null);
      if (backup) await fs.writeFile(target, backup);
      count += 1;
    }
    // Changed since (the player picked other artwork): theirs now, left alone.
    await fs.rm(path.join(grid, n.backup), { force: true });
    await fs.rm(path.join(grid, n.mark), { force: true });
  }
  return count;
}

module.exports = { gridFolders, applyLogo, removeLogo };
