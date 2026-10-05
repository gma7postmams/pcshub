const { spawn } = require('child_process');
const cfg = require('./config');

// Split the connection string into libpq env vars so the password never appears in the process list.
function connEnv() {
  const u = new URL(cfg.DATABASE_URL);
  const env = { ...process.env };
  env.PGHOST = decodeURIComponent(u.hostname) || env.PGHOST;
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  env.PGDATABASE = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (process.env.PGSSL === 'true') env.PGSSLMODE = 'require';
  return env;
}

function databaseName() {
  return decodeURIComponent(new URL(cfg.DATABASE_URL).pathname.replace(/^\//, ''));
}

/** Run a binary without a shell. Resolves with { stdout, stderr }; rejects with a short error message. */
function run(bin, args, { env, timeoutMs, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (onSpawn) onSpawn(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s, d) => (s + d).slice(-8192);
    child.stdout.on('data', (d) => { stdout = cap(stdout, d); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d); });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? `${bin} not found on this host` : e.message));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return reject(new Error(`${bin} timed out`));
      if (code !== 0) return reject(new Error(`${bin} exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
      resolve({ stdout, stderr });
    });
  });
}

async function toolVersion(bin) {
  try {
    const { stdout } = await run(bin, ['--version'], { timeoutMs: 10000 });
    const m = /(\d+(?:\.\d+)*)/.exec(stdout);
    return { ok: true, version: m ? m[1] : stdout.trim() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function dump(outFile) {
  await run(cfg.PG_DUMP_BIN, [
    '--format=custom', '--no-owner', '--no-privileges',
    '--exclude-table-data=user_sessions',
    `--file=${outFile}`,
  ], { env: connEnv(), timeoutMs: cfg.TIMEOUT_MS });
}

/** Confirms a custom-format dump is readable and returns its TOC entry count. */
async function listDump(file) {
  const { stdout } = await run(cfg.PG_RESTORE_BIN, ['--list', file], { timeoutMs: 120000 });
  return stdout.split('\n').filter((l) => l && !l.startsWith(';')).length;
}

// Object types a PCS Hub dump may contain. Anything else (functions, triggers, extensions, ...) is refused.
const ALLOWED_TOC = ['FK CONSTRAINT', 'CHECK CONSTRAINT', 'CONSTRAINT', 'TABLE DATA', 'TABLE', 'SEQUENCE OWNED BY', 'SEQUENCE SET', 'SEQUENCE', 'DEFAULT', 'INDEX', 'COMMENT', 'SCHEMA'];

/** @returns {{total:number, disallowed:string[]}} */
async function inspectToc(file) {
  const { stdout } = await run(cfg.PG_RESTORE_BIN, ['--list', file], { timeoutMs: 120000 });
  const disallowed = new Set();
  let total = 0;
  for (const line of stdout.split('\n')) {
    const m = /^\d+; \d+ \d+ (.+)$/.exec(line);
    if (!m) continue;
    total++;
    if (!ALLOWED_TOC.some((t) => m[1] === t || m[1].startsWith(`${t} `))) disallowed.add(m[1].split(' ').slice(0, 2).join(' '));
  }
  return { total, disallowed: [...disallowed] };
}

async function restoreInto(dumpFile, dbName) {
  await run(cfg.PG_RESTORE_BIN, [
    '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', `--dbname=${dbName}`, dumpFile,
  ], { env: connEnv(), timeoutMs: cfg.TIMEOUT_MS });
}

module.exports = { run, toolVersion, dump, listDump, inspectToc, restoreInto, databaseName };
