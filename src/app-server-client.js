const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

function createAppServerClient(cwd, onClose) {
  const child = spawn('codex', ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const decoder = new StringDecoder('utf8');
  const requests = new Map();
  const listeners = new Set();
  let nextId = 0;
  let buffer = '';
  let stderr = '';
  let closed = false;
  const stopWithParent = () => child.kill();
  process.once('exit', stopWithParent);

  function send(message) {
    if (closed) throw new Error('codex app-server is closed');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params) {
    if (closed) return Promise.reject(new Error('codex app-server is closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error(`${method} timed out`));
      }, 60 * 1000);
      requests.set(id, { resolve, reject, timer });
      send({ method, id, params });
    });
  }

  function close(error = new Error('codex app-server stopped')) {
    if (closed) return;
    closed = true;
    process.removeListener('exit', stopWithParent);
    for (const pending of requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    requests.clear();
    for (const listener of listeners) {
      try { listener({ method: 'server/closed', params: { error } }); } catch { /* client cleanup failed */ }
    }
    child.kill();
    onClose?.();
  }

  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 10 * 1024 * 1024) {
      close(new Error('codex app-server output exceeded the line limit'));
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && requests.has(message.id)) {
        const pending = requests.get(message.id);
        requests.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        send({ id: message.id, error: { code: -32000, message: 'No interactive client available' } });
      } else if (message.method) {
        for (const listener of listeners) {
          try { listener(message); } catch { /* ignore a subscriber error */ }
        }
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  child.stdin.on('error', (error) => close(error));
  child.on('error', (error) => close(error));
  child.on('close', (code) => close(new Error(stderr.trim() || `codex app-server exited (${code})`)));

  const ready = request('initialize', {
    clientInfo: { name: 'discord-ai-team', title: 'Discord AI Team', version: '1.0' },
  }).then(() => send({ method: 'initialized', params: {} }));

  return { request, ready, close, subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, get closed() { return closed; } };
}

module.exports = { createAppServerClient };
