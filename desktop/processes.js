// Tells which installed games are running, and stops them. A game counts as
// running when a program from its folder is running, which also catches games
// started from Steam or a desktop shortcut rather than from GameShelf.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const STOP_GRACE_MS = 5000;
const STOP_CHECK_MS = 500;
const windows = process.platform === 'win32';

const norm = (p) => {
  const clean = path.resolve(p).replace(/[\\/]+$/, '');
  return windows ? clean.toLowerCase() : clean;
};

/**
 * The folder whose programs belong to this game, or null when it's too broad
 * to say (a drive, the user's home, Desktop, Downloads or Documents), in which
 * case only the game's own program file counts.
 */
function gameFolder(game) {
  if (!game.dir) return null;
  const dir = norm(game.dir);
  const depth = path.relative(path.parse(dir).root, dir).split(/[\\/]+/).filter(Boolean).length;
  const home = os.homedir();
  const broad = [home, ...['Desktop', 'Downloads', 'Documents'].map((d) => path.join(home, d))].map(norm);
  return depth >= 2 && !broad.includes(dir) ? dir : null;
}

/** The running programs that belong to `game`, from a list of { pid, path }. */
function processesOf(game, processes) {
  const folder = gameFolder(game);
  const exe = game.exe ? norm(game.exe) : null;
  return processes.filter((p) => {
    if (p.pid === process.pid || !p.path) return false;
    const file = norm(p.path);
    return folder ? file.startsWith(folder + path.sep) : file === exe;
  });
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15000 }, (err, out) => resolve(err ? '' : out));
  });
}

// Windows: every program's ID and file, one "pid|path" line each.
const LIST_SCRIPT = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
  "Get-CimInstance Win32_Process -Property ProcessId,ExecutablePath | ForEach-Object { if ($_.ExecutablePath) { '{0}|{1}' -f $_.ProcessId, $_.ExecutablePath } }";

/** Every running program this user can see, as { pid, path }. */
async function listProcesses() {
  if (windows) {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LIST_SCRIPT]);
    return out.split(/\r?\n/).map((line) => {
      const i = line.indexOf('|');
      return { pid: Number(line.slice(0, i)), path: line.slice(i + 1).trim() };
    }).filter((p) => p.pid && p.path);
  }
  // Linux reads /proc; elsewhere running games simply aren't detected.
  const pids = (await fs.readdir('/proc').catch(() => [])).filter((d) => /^\d+$/.test(d));
  const found = await Promise.all(pids.map(async (pid) => ({ pid: Number(pid), path: await fs.readlink(`/proc/${pid}/exe`).catch(() => null) })));
  return found.filter((p) => p.path);
}

const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Asks the game's programs to close, the way clicking the window's X would, then forces them after a few seconds. */
async function stopProcesses(pids) {
  if (!pids.length) return;
  const each = pids.flatMap((pid) => ['/PID', String(pid)]);
  if (windows) await run('taskkill', [...each, '/T']);
  else pids.forEach((pid) => { try { process.kill(pid, 'SIGTERM'); } catch {} });

  // Most games close within a second or two; check often so the button updates quickly.
  for (let waited = 0; waited < STOP_GRACE_MS && pids.some(isRunning); waited += STOP_CHECK_MS) {
    await new Promise((resolve) => setTimeout(resolve, STOP_CHECK_MS));
  }
  const left = pids.filter(isRunning);
  if (!left.length) return;
  if (windows) await run('taskkill', [...left.flatMap((pid) => ['/PID', String(pid)]), '/T', '/F']);
  else left.forEach((pid) => { try { process.kill(pid, 'SIGKILL'); } catch {} });
}

module.exports = { gameFolder, processesOf, listProcesses, stopProcesses };
