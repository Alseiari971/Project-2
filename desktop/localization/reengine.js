// Arabic in Capcom RE Engine games (Resident Evil, Devil May Cry, Monster
// Hunter, Dragon's Dogma...), through the game's own patch files.
//
// These games keep their data in re_chunk_000.pak and load numbered patch
// files after it, in order: re_chunk_000.pak.patch_001.pak, patch_002.pak and
// so on, each one's files winning over the ones before. Game updates arrive
// this way, and mod managers add mods this way too. A pack's .pak goes in as
// the next number, so it loads last and its message files (natives/stm/...
// .msg.<version>) are the ones the game shows.
//
// The game looks for the numbers one after another, so the chain must have no
// gaps:
// - when the game's patch files already skip a number, nothing is added (the
//   new file would never load);
// - Arabic's file is only taken out while it's the last one. If another patch
//   was added after it (by a mod manager, say), taking it out would leave a
//   gap and the game would stop loading that one, so it stays until that one
//   is gone.
const BASE_PAK = 're_chunk_000.pak';
const PATCH = /^re_chunk_000\.pak\.patch_(\d{3,})\.pak$/i;
// What a pack calls its .pak; GameShelf picks the number when it adds it.
const PACK_TARGET = 're_chunk_000.pak.patch_XXX.pak';
const PAK_MAGIC = 'KPKA';

const patchName = (number) => `re_chunk_000.pak.patch_${String(number).padStart(3, '0')}.pak`;

/** The patch numbers among file names, lowest first. */
function patchNumbers(names) {
  return names.map((n) => n.match(PATCH)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
}

/**
 * Where Arabic's patch would go: { next, gap }. `next` is one more than the
 * highest patch (001 when there are none); `gap` is the first number missing
 * between the lowest and the highest, or null.
 */
function nextPatch(numbers) {
  if (!numbers.length) return { next: 1, gap: null };
  for (let n = numbers[0], i = 0; i < numbers.length; n++, i++) {
    if (numbers[i] !== n) return { next: numbers.at(-1) + 1, gap: n };
  }
  return { next: numbers.at(-1) + 1, gap: null };
}

// RE Engine games played online with others: their files are never changed,
// whatever anti-cheat they do or don't ship. Matched by Steam app ID or program name.
const ONLINE_GAMES = [
  { name: 'Street Fighter 6', steamAppId: 1364780, exe: 'streetfighter6.exe' },
  { name: 'Monster Hunter Rise', steamAppId: 1446780, exe: 'monsterhunterrise.exe' },
  { name: 'Monster Hunter Wilds', steamAppId: 2246340, exe: 'monsterhunterwilds.exe' },
  { name: 'Exoprimal', steamAppId: 1286320, exe: 'exoprimal.exe' },
];

function onlineGame({ steamAppId, programs = [] }) {
  const names = new Set(programs.map((p) => p.toLowerCase()));
  return ONLINE_GAMES.find((g) => g.steamAppId === Number(steamAppId) || names.has(g.exe)) || null;
}

module.exports = { BASE_PAK, PATCH, PACK_TARGET, PAK_MAGIC, patchName, patchNumbers, nextPatch, onlineGame, ONLINE_GAMES };
