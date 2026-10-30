// Talks to the OCR helper (ocr-helper.ps1 on Windows): one long-running
// process, so PowerShell and Windows' OCR start once rather than per subtitle.
// Requests go out as "<id>\t<op>\t<argument>" lines, answers come back as JSON
// lines. A helper that dies is started again on the next request.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'ocr-helper.ps1');

class OcrError extends Error {}

/**
 * How to start the helper. The app is packed into an archive PowerShell can't
 * read from, so the script is copied to `dataDir` first. GAMESHELF_OCR_HELPER
 * (a Node script speaking the same protocol) replaces it when developing.
 */
function defaultSpawn({ dataDir, devHelper } = {}) {
  if (devHelper) {
    return () => spawn(process.execPath, [devHelper], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }
  if (process.platform !== 'win32') return null;
  return () => {
    const copy = path.join(dataDir, 'ocr-helper.ps1');
    const script = fs.readFileSync(SCRIPT);
    let current = null;
    try {
      current = fs.readFileSync(copy);
    } catch {
      // Not copied yet.
    }
    if (!current || !current.equals(script)) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(copy, script);
    }
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', copy], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  };
}

function createOcrHelper({ spawnHelper, timeoutMs = 4000, startTimeoutMs = 20000 }) {
  let child = null;
  let ready = null;
  let nextId = 1;
  const waiting = new Map();

  function failAll(message) {
    for (const { reject, timer } of waiting.values()) {
      clearTimeout(timer);
      reject(new OcrError(message));
    }
    waiting.clear();
  }

  function start() {
    if (!spawnHelper) return Promise.reject(new OcrError('The subtitle overlay needs Windows 10 or newer.'));
    child = spawnHelper();
    const proc = child;
    let buffered = '';
    let stderr = '';
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new OcrError('Windows OCR didn\'t start in time.')), startTimeoutMs);
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.type === 'ready') {
            clearTimeout(timer);
            resolve({ ocr: Boolean(message.ocr), language: message.language || null });
            continue;
          }
          const entry = waiting.get(message.id);
          if (!entry) continue;
          waiting.delete(message.id);
          clearTimeout(entry.timer);
          if (message.error) entry.reject(new OcrError(message.error));
          else entry.resolve(message);
        }
      });
      proc.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      const gone = (why) => {
        clearTimeout(timer);
        if (child === proc) {
          child = null;
          ready = null;
        }
        reject(new OcrError(why));
        failAll(why);
      };
      proc.on('error', (err) => gone(`The OCR helper couldn't start: ${err.message}`));
      proc.on('exit', (code) => gone(`The OCR helper stopped (${code ?? 'killed'}). ${stderr.trim().split('\n').pop() || ''}`.trim()));
      proc.stdin.on('error', () => {});
    });
    ready.catch(() => {});
    return ready;
  }

  async function request(op, argument = '') {
    const info = await (child ? ready : start());
    if (op === 'ocr' && !info.ocr) throw new OcrError('Windows has no OCR language installed.');
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new OcrError(`The OCR helper didn't answer "${op}" in time.`));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      child.stdin.write(`${id}\t${op}\t${argument}\n`);
    });
  }

  return {
    /** Starts the helper if needed; resolves to { ocr, language }. */
    ready: () => (child ? ready : start()),
    /** The lines Windows reads in a BMP image: { lines: [{ text, box }], ms }. */
    async recognize(image) {
      const reply = await request('ocr', Buffer.from(image).toString('base64'));
      return { lines: Array.isArray(reply.lines) ? reply.lines : [], ms: reply.ms ?? null };
    },
    /** The game's main window: { hwnd, x, y, w, h, minimized } in screen pixels, or null. */
    async findWindow(pids) {
      const list = (pids || []).filter((p) => Number.isInteger(p) && p > 0);
      if (!list.length) return null;
      return (await request('window', list.join(','))).window || null;
    },
    close() {
      const proc = child;
      child = null;
      ready = null;
      failAll('The OCR helper was closed.');
      if (proc) {
        proc.stdin.end();
        setTimeout(() => proc.kill(), 1000).unref();
      }
    },
    get running() {
      return Boolean(child);
    },
  };
}

module.exports = { createOcrHelper, defaultSpawn, OcrError, SCRIPT };
