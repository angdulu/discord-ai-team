const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');

const COMMANDS = { codex: 'codex', claude: 'claude', gemini: 'agy' };

function execute(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`${command} ${args.join(' ')} failed: ${error.code || error.message}`));
      else resolve(stdout.trim());
    });
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function createCliMaintenance({ key, providerId, enabled = false,
  directory = path.join(__dirname, '..', 'state', 'cli-maintenance'),
  registryFile = path.join(directory, '..', 'agents.json'),
  intervalMs = 6 * 60 * 60 * 1000, idleMs = 2 * 60 * 1000, pollMs = 60000,
  pid = process.pid, now = Date.now, isAlive = processAlive,
  readVersion = () => execute(COMMANDS[providerId], ['--version'], 20000),
  update = () => execute(COMMANDS[providerId], ['update'], 5 * 60 * 1000),
  validate, apply, log = (message) => console.log(`[CLI ${providerId}] ${message}`),
}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const activityFile = path.join(directory, `${providerId}.${key}.${pid}.json`);
  const resultFile = path.join(directory, `${providerId}.updates.json`);
  const lockFile = path.join(directory, `${providerId}.lock`);
  let pending = 0;
  let lastActivity = now();
  let appliedVersion;
  let phase = 'idle';
  let lastError = null;
  let checking = false;
  let closed = false;

  function publish() {
    writeJson(activityFile, { key, providerId, pid, pending, lastActivity, updatedAt: now(),
      enabled, appliedVersion, phase, lastError });
  }
  publish();
  const ready = readVersion().then((version) => { appliedVersion = version; if (!closed) publish(); }).catch((error) => {
    lastError = error.message;
    if (!closed) publish();
    log(lastError);
  });

  function locked() {
    const owner = readJson(lockFile);
    if (owner && isAlive(owner.pid)) return true;
    if (owner) fs.rmSync(lockFile, { force: true });
    else {
      try {
        if (now() - fs.statSync(lockFile).mtimeMs < 10 * 60 * 1000) return true;
        fs.rmSync(lockFile, { force: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return false;
  }

  function peersIdle() {
    const live = [];
    for (const file of fs.readdirSync(directory)) {
      if (!file.startsWith(`${providerId}.`) || file.endsWith('.updates.json') || !file.endsWith('.json')) continue;
      const status = readJson(path.join(directory, file));
      if (!status) return false;
      if (!isAlive(status.pid)) { fs.rmSync(path.join(directory, file), { force: true }); continue; }
      live.push(status);
      if (status.pending || now() - status.lastActivity < idleMs) return false;
    }
    const registered = Object.values(readJson(registryFile) || {});
    return !registered.some((agent) => agent.providerId === providerId && isAlive(agent.pid)
      && !live.some((status) => status.pid === agent.pid));
  }

  function reserve() {
    pending++;
    lastActivity = now();
    publish();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pending--;
      lastActivity = now();
      if (!closed) publish();
    };
  }

  async function wait() {
    await ready;
    const started = now();
    while (locked()) {
      if (closed || now() - started > 10 * 60 * 1000) throw new Error('CLI maintenance is still running; please try again');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function run(task) {
    const release = reserve();
    try { await wait(); return await task(); }
    finally { release(); }
  }

  async function check() {
    if (!enabled || closed || checking) return false;
    checking = true;
    let lock;
    try {
      await ready;
      if (locked()) return false;
      try { lock = fs.openSync(lockFile, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
      fs.writeFileSync(lock, JSON.stringify({ pid, startedAt: now() }));
      if (!peersIdle()) return false;
      const previous = readJson(resultFile) || {};
      const due = !previous.nextCheckAt || previous.nextCheckAt <= now();
      let version = await readVersion();
      if (!due && version === appliedVersion) return false;
      phase = 'updating';
      publish();
      if (due) {
        log('Checking for updates');
        await update();
        version = await readVersion();
      }
      if (!version) throw new Error('CLI returned no version after update');
      if (version !== appliedVersion) {
        const catalog = await validate();
        if (!Array.isArray(catalog) || !catalog.length) throw new Error('Updated CLI returned no models');
        await apply(catalog);
        appliedVersion = version;
        log(`Applied ${version}; CLI connections will reopen on demand`);
      }
      lastError = null;
      if (due) writeJson(resultFile, { checkedAt: now(), nextCheckAt: now() + intervalMs, version, error: null });
      return true;
    } catch (error) {
      lastError = error.message;
      writeJson(resultFile, { checkedAt: now(), nextCheckAt: now() + Math.min(intervalMs, 60 * 60 * 1000),
        version: appliedVersion, error: lastError });
      log(`Update failed; existing CLI connections retained: ${lastError}`);
      return false;
    } finally {
      if (lock !== undefined) { fs.closeSync(lock); fs.rmSync(lockFile, { force: true }); }
      phase = 'idle';
      checking = false;
      if (!closed) publish();
    }
  }

  const timer = setInterval(() => {
    publish();
    check().catch((error) => log(error.message));
  }, pollMs);
  timer.unref();

  function close() {
    closed = true;
    clearInterval(timer);
    fs.rmSync(activityFile, { force: true });
    process.removeListener('exit', close);
  }
  process.once('exit', close);
  return { reserve, wait, run, check, ready, close, status() {
    const result = readJson(resultFile) || {};
    return { enabled, phase, version: appliedVersion, checkedAt: result.checkedAt,
      nextCheckAt: result.nextCheckAt, error: lastError || result.error || null };
  } };
}

module.exports = { createCliMaintenance };
