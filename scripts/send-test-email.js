// Sends one test email with the server's email settings, and says exactly
// what went wrong if it can't:
//
//   node scripts/send-test-email.js you@example.com
//
// It reads SMTP_URL and MAIL_FROM from the environment, or from
// /etc/gameshelf.env (the VPS settings file) when they aren't set.
const fs = require('node:fs');
const { createMailer } = require('../src/mailer');

const ENV_FILE = process.env.GAMESHELF_ENV || '/etc/gameshelf.env';
const env = { ...process.env };
if (!env.SMTP_URL && fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const to = process.argv[2];
if (!to || !to.includes('@')) {
  console.error('Usage: node scripts/send-test-email.js you@example.com');
  process.exit(2);
}
if (!env.SMTP_URL) {
  console.error(`SMTP_URL isn't set (looked in the environment and ${ENV_FILE}). Add it, e.g.\n  SMTP_URL=smtps://no-reply%40your-domain.com:PASSWORD@smtppro.zoho.com:465`);
  process.exit(1);
}

let shown;
try {
  const u = new URL(env.SMTP_URL);
  shown = `${u.protocol}//${decodeURIComponent(u.username)}@${u.host}`;
} catch {
  console.error('SMTP_URL isn\'t a valid address. Write the @ in the user name as %40, and encode symbols in the password.');
  process.exit(1);
}
console.log(`Sending through ${shown}, from ${env.MAIL_FROM || `GameShelf <${decodeURIComponent(new URL(env.SMTP_URL).username)}> (MAIL_FROM isn't set, so the mailbox you sign in with)`} …`);
// A sample of the real code email, so the design can be checked too.
const sample = require('../src/email-templates').codeEmail('verify', '123456', { site: env.PUBLIC_URL || null });
createMailer(env).send({
  to,
  subject: 'GameShelf test email (sample design)',
  text: `This is a test from your GameShelf server. Email works. The code below is only a sample.\n\n${sample.text}`,
  html: sample.html,
}).then(() => {
  console.log(`Sent. Check ${to} (and its spam folder).`);
}, (err) => {
  console.error(`Not sent: ${err.message}`);
  process.exit(1);
});
