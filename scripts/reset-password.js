// Sets a new password for an account, for whoever runs the server (on the
// VPS, as root):
//
//   cd /opt/gameshelf && node scripts/reset-password.js hamad
//
// It asks for the new password twice without showing it, then signs the
// account out everywhere and forgets its remembered devices. GameShelf Guard
// stays as it was. It reads DB_FILE from the environment or /etc/gameshelf.env.
const fs = require('node:fs');
const readline = require('node:readline');

const ENV_FILE = process.env.GAMESHELF_ENV || '/etc/gameshelf.env';
if (!process.env.DB_FILE && fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*DB_FILE\s*=\s*(.*?)\s*$/.exec(line);
    if (m) process.env.DB_FILE = m[1].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const { openDatabase } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { passwordProblem } = require('../src/account-api');

// One reader for both questions (two readers would lose typed-ahead lines).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
let hiding = false;
const show = rl._writeToOutput?.bind(rl);
// While a password is typed, nothing it types is shown.
rl._writeToOutput = (text) => {
  if (!hiding || /: $/.test(text)) show?.(text);
};
const lines = rl[Symbol.asyncIterator]();

/** Reads one line without showing it. */
async function askHidden(question) {
  process.stdout.write(question);
  hiding = true;
  const { value = '' } = await lines.next();
  hiding = false;
  process.stdout.write('\n');
  return value;
}

(async () => {
  const username = String(process.argv[2] || '').trim().toLowerCase();
  if (!username) {
    console.error('Usage: node scripts/reset-password.js <username>');
    process.exit(2);
  }
  const db = openDatabase();
  const user = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
  if (!user) {
    console.error(`There's no account called @${username} in ${process.env.DB_FILE || 'the database'}.`);
    process.exit(1);
  }
  const password = await askHidden(`New password for @${user.username}: `);
  const problem = passwordProblem(password, user.username);
  if (problem) {
    console.error(`${problem} Nothing was changed.`);
    process.exit(1);
  }
  if ((await askHidden('Type it again: ')) !== password) {
    console.error('The two passwords don\'t match. Nothing was changed.');
    process.exit(1);
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
  const signedOut = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id).changes;
  db.prepare('DELETE FROM trusted_devices WHERE user_id = ?').run(user.id);
  console.log(`Done. @${user.username} (${user.role}) has a new password; ${signedOut} session(s) were signed out.`);
  rl.close();
})();
