// Email for GameShelf Guard codes and address checks, sent over SMTP with no
// extra packages. Set SMTP_URL (and MAIL_FROM):
//
//   SMTP_URL=smtps://user:password@smtp.example.com:465    TLS from the start
//   SMTP_URL=smtp://user:password@smtp.example.com:587     STARTTLS (required)
//   MAIL_FROM="GameShelf <no-reply@example.com>"
//
// Without SMTP_URL, email is off: sign-up still works, but addresses can't be
// checked and Email Guard can't be turned on (the authenticator app still can).
// MAIL_DEV_LOG=1 prints messages to the server log instead, for development only.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

class MailError extends Error {}

/** Reads SMTP replies (multi-line ones too) off a socket, one at a time. */
function replies(socket) {
  let buffer = '';
  const waiting = [];
  const ready = [];
  let lines = [];
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: lines.join('\n') };
        lines = [];
        const next = waiting.shift();
        if (next) next.resolve(reply);
        else ready.push(reply);
      }
    }
  };
  const fail = (err) => {
    while (waiting.length) waiting.shift().reject(err);
  };
  socket.on('data', onData);
  socket.on('error', fail);
  socket.on('close', () => fail(new MailError('The mail server closed the connection.')));
  return {
    next: () => (ready.length ? Promise.resolve(ready.shift()) : new Promise((resolve, reject) => waiting.push({ resolve, reject }))),
    detach: () => socket.removeListener('data', onData),
  };
}

const header = (text) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`);

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');

/** The message: plain text, or plain text and HTML as alternatives (mail apps show the HTML when they can). */
function message({ from, to, subject, text, html = null }) {
  const host = /@([^>\s]+)/.exec(from)?.[1] || 'gameshelf.local';
  const head = [
    `From: ${from}`, `To: ${to}`, `Subject: ${header(subject)}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${host}>`, 'MIME-Version: 1.0',
  ];
  if (!html) {
    return [...head, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text), ''].join('\r\n');
  }
  const boundary = `gs-${crypto.randomUUID()}`;
  return [
    ...head, `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html),
    `--${boundary}--`, '',
  ].join('\r\n');
}

async function sendSmtp(url, { from, to, subject, text, html }, { timeoutMs = 20000 } = {}) {
  const secure = url.protocol === 'smtps:';
  const host = url.hostname;
  const port = Number(url.port) || (secure ? 465 : 587);
  let socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  socket.setTimeout(timeoutMs, () => socket.destroy(new MailError('The mail server took too long.')));
  let reader = replies(socket);
  const expect = async (codes) => {
    const reply = await reader.next();
    if (!codes.includes(reply.code)) throw new MailError(`The mail server said: ${reply.text.slice(0, 200)}`);
    return reply;
  };
  const say = async (line, codes) => {
    socket.write(`${line}\r\n`);
    return expect(codes);
  };
  try {
    await expect([220]);
    let ehlo = await say('EHLO gameshelf', [250]);
    if (!secure) {
      if (!/STARTTLS/i.test(ehlo.text)) throw new MailError('The mail server doesn\'t offer STARTTLS; use smtps:// instead.');
      await say('STARTTLS', [220]);
      reader.detach();
      socket = tls.connect({ socket, servername: host });
      await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
      reader = replies(socket);
      ehlo = await say('EHLO gameshelf', [250]);
    }
    if (url.username) {
      const user = decodeURIComponent(url.username);
      const pass = decodeURIComponent(url.password);
      await say(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, [235]);
    }
    const address = (value) => /<([^>]+)>/.exec(value)?.[1] || value;
    await say(`MAIL FROM:<${address(from)}>`, [250]);
    await say(`RCPT TO:<${address(to)}>`, [250, 251]);
    await say('DATA', [354]);
    const data = message({ from, to, subject, text, html }).replace(/^\./gm, '..');
    await say(`${data}\r\n.`, [250]);
    await say('QUIT', [221]).catch(() => {});
  } finally {
    socket.destroy();
  }
}

/** The sender: MAIL_FROM, else the mailbox signed in to (mail services refuse other senders). */
function senderOf(env, url) {
  if (env.MAIL_FROM) return env.MAIL_FROM;
  const login = url ? decodeURIComponent(url.username) : '';
  return login.includes('@') ? `GameShelf <${login}>` : 'GameShelf <no-reply@gameshelf.local>';
}

function createMailer(env = process.env) {
  let url = null;
  try {
    url = env.SMTP_URL ? new URL(env.SMTP_URL) : null;
  } catch {
    url = null;
  }
  if (url && !['smtp:', 'smtps:'].includes(url.protocol)) url = null;
  const devLog = env.MAIL_DEV_LOG === '1';
  const from = senderOf(env, url);
  return {
    enabled: Boolean(url) || devLog,
    async send({ to, subject, text, html }) {
      if (url) return sendSmtp(url, { from, to, subject, text, html });
      if (devLog) {
        console.log(`[mail to ${to}] ${subject}\n${text}`);
        return;
      }
      throw new MailError('Email isn\'t set up on this server.');
    },
  };
}

/** A stand-in that keeps what it would send, for tests. */
function createMemoryMailer() {
  const sent = [];
  return { enabled: true, sent, async send(mail) { sent.push(mail); } };
}

module.exports = { createMailer, createMemoryMailer, MailError, message };
