// The Steam account signed in on this PC, from Steam's config/loginusers.vdf
// (the entry with MostRecent "1"). It's only shown, as "Steam on this PC:
// name", next to the Link button: a file on a PC proves nothing to the
// server, so linking always goes through Steam's own sign-in (OpenID, checked
// with Valve), and nothing here is ever sent as a Steam ID to link.
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseVdf, defaultSteamRoots } = require('./installed');

const STEAM_ID_RE = /^7656119\d{10}$/;

/** The most recent account in a loginusers.vdf text: { steamId, accountName, personaName } or null. */
function parseLoginUsers(text) {
  const lower = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const users = lower(parseVdf(String(text || ''))).users;
  if (!users || typeof users !== 'object') return null;
  const accounts = Object.entries(users)
    .filter(([id, fields]) => STEAM_ID_RE.test(id) && fields && typeof fields === 'object')
    .map(([id, fields]) => ({ id, ...lower(fields) }));
  const pick = accounts.find((a) => a.mostrecent === '1') || (accounts.length === 1 ? accounts[0] : null);
  if (!pick) return null;
  return { steamId: pick.id, accountName: String(pick.accountname || ''), personaName: String(pick.personaname || '') };
}

/** Looks in each Steam folder on this PC; null when Steam isn't installed or no one signed in. */
async function localSteamAccount(roots) {
  for (const root of roots || await defaultSteamRoots()) {
    const text = await fs.readFile(path.join(root, 'config', 'loginusers.vdf'), 'utf8').catch(() => null);
    const account = text && parseLoginUsers(text);
    if (account) return account;
  }
  return null;
}

module.exports = { parseLoginUsers, localSteamAccount };
