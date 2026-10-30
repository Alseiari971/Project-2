// Stands in for desktop/localization/ocr-helper.ps1 in tests and when
// developing off Windows: the same line protocol, with "OCR" that returns the
// text in FAKE_OCR_TEXT_FILE (what a fake game says it's showing) and a
// window from FAKE_WINDOW_FILE.
const fs = require('node:fs');
const readline = require('node:readline');

const delay = Number(process.env.FAKE_OCR_DELAY_MS || 0);
const read = (file, fallback) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
};

process.stdout.write(`${JSON.stringify({ type: 'ready', ocr: process.env.FAKE_OCR_OFF !== '1', language: 'en-US' })}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [id, op, argument = ''] = line.split('\t');
  const reply = { id: Number(id) };
  const send = () => process.stdout.write(`${JSON.stringify(reply)}\n`);
  if (op === 'crash') process.exit(3);
  if (op === 'ping') reply.pong = true;
  else if (op === 'ocr') {
    const image = Buffer.from(argument, 'base64');
    if (image.toString('latin1', 0, 2) !== 'BM') {
      reply.error = 'Not a BMP image.';
    } else {
      const text = process.env.FAKE_OCR_TEXT_FILE ? read(process.env.FAKE_OCR_TEXT_FILE, '') : 'We must reach the castle before nightfall';
      const width = image.readInt32LE(18);
      const height = Math.abs(image.readInt32LE(22));
      if (width === 7) process.exit(3); // lets tests check a crashed helper comes back
      reply.lines = text.trim() ? text.trim().split('\n').map((t, i, all) => ({
        text: t,
        box: { x: Math.round(width * 0.25), y: Math.round((height * (i + 1)) / (all.length + 2)), w: Math.round(width * 0.5), h: Math.round(height / (all.length + 2)) },
      })) : [];
      reply.ms = delay;
    }
  } else if (op === 'window') {
    const raw = process.env.FAKE_WINDOW_FILE ? read(process.env.FAKE_WINDOW_FILE, 'null') : 'null';
    reply.window = JSON.parse(raw || 'null');
  } else {
    reply.error = `Unknown request: ${op}`;
  }
  if (op === 'ocr' && delay) setTimeout(send, delay);
  else send();
});
