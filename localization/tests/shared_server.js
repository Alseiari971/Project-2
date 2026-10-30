// For test_shared.py: the real GameShelf server, with an in-memory database and
// a stand-in for the OpenAI API ("عربي " before each line). Prints its address,
// a signed-in user's access token, and then a line for each translation request.
const path = require('node:path');
const repo = path.resolve(__dirname, '..', '..');
const { createApp } = require(path.join(repo, 'server'));
const { openDatabase } = require(path.join(repo, 'src/db'));
const { createLocalProvider } = require(path.join(repo, 'src/games/local'));
const { createTranslationMemory } = require(path.join(repo, 'src/translation-memory'));

const fetch = async (_url, init) => {
  const user = JSON.parse(init.body).messages[1].content;
  const lines = JSON.parse(user.slice(user.indexOf('[')));
  console.log(JSON.stringify({ asked: lines.length }));
  const translations = lines.map(({ id, text }) => ({ id, arabic: `عربي ${text}` }));
  return { ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }) };
};

(async () => {
  const db = openDatabase(':memory:');
  const translations = createTranslationMemory({ db, env: { OPENAI_API_KEY: 'server-key' }, fetch });
  const server = createApp({ db, games: createLocalProvider(), translations }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const reg = await globalThis.fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'builder', password: 'correct horse' }) });
  const cookie = reg.headers.get('set-cookie').split(';')[0];
  const made = await (await globalThis.fetch(`${base}/api/me/tokens`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'test' }) })).json();
  console.log(JSON.stringify({ base, token: made.token }));
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
})();
