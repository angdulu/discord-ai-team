const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const MAX_LINE_BYTES = 10 * 1024 * 1024;
const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// idleTimeoutMs: close after this long without a turn; null keeps the process open
function createStreamWorker(command, args, cwd, onClose, idleTimeoutMs = IDLE_TIMEOUT_MS) {
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let stderr = '';
  let pending = null;
  let idleTimer;
  let idleSince = null;
  let currentIdleTimeoutMs = idleTimeoutMs;
  let closed = false;

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (closed || pending || !currentIdleTimeoutMs || idleSince === null) return;
    const remaining = currentIdleTimeoutMs - (Date.now() - idleSince);
    if (remaining <= 0) return close();
    idleTimer = setTimeout(close, remaining);
    idleTimer.unref();
  }

  function settle(error, value) {
    const turn = pending;
    if (!turn) return;
    pending = null;
    clearTimeout(turn.timer);
    turn.signal?.removeEventListener('abort', turn.abort);
    if (error) turn.reject(error);
    else turn.resolve(value);
    idleSince = Date.now();
    scheduleIdle();
  }

  function close(error = new Error(`${command} stopped`)) {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    settle(error);
    child.kill();
    onClose?.();
  }

  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      close(new Error(`${command} output exceeded the line limit`));
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!pending) continue;
      try {
        const result = pending.handle(event);
        if (result?.done) settle(null, result.value);
      } catch (error) {
        close(error);
        return;
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  child.stdin.on('error', (error) => close(error));
  child.on('error', (error) => close(error));
  child.on('close', (code) => close(new Error(stderr.trim() || `${command} exited (${code})`)));

  function request(input, handle, signal) {
    if (closed) return Promise.reject(new Error(`${command} is closed`));
    if (pending) return Promise.reject(new Error(`${command} is already processing a turn`));
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    clearTimeout(idleTimer);
    idleSince = null;
    return new Promise((resolve, reject) => {
      const abort = () => close(new Error('aborted'));
      const timer = setTimeout(() => close(new Error(`${command} timed out`)), TURN_TIMEOUT_MS);
      pending = { resolve, reject, handle, signal, abort, timer };
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(`${JSON.stringify(input)}\n`, (error) => {
        if (error) close(error);
      });
    });
  }

  return { request, close, setIdleTimeoutMs(value) {
    currentIdleTimeoutMs = value;
    scheduleIdle();
  }, get closed() { return closed; } };
}

module.exports = { createStreamWorker };
