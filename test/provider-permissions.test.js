const test = require('node:test');
const assert = require('node:assert/strict');

function withMockWorkers(providerFile, event) {
  const streamPath = require.resolve('../src/stream-worker');
  const providerPath = require.resolve(providerFile);
  const streamModule = require(streamPath);
  const original = streamModule.createStreamWorker;
  const spawned = [];
  streamModule.createStreamWorker = (_command, args, _cwd, onClose) => {
    const entry = {
      args,
      closed: false,
      worker: {
        request: async (_input, handle) => handle(event).value,
        close: () => {
          if (entry.closed) return;
          entry.closed = true;
          onClose();
        },
        setIdleTimeoutMs: () => {},
      },
    };
    spawned.push(entry);
    return entry.worker;
  };
  delete require.cache[providerPath];
  return {
    create: require(providerPath),
    spawned,
    restore: () => {
      streamModule.createStreamWorker = original;
      delete require.cache[providerPath];
    },
  };
}

test('Claude replaces a warm full-access worker when access becomes read-only', async () => {
  const mocked = withMockWorkers('../src/providers/claude',
    { type: 'result', result: 'ok', session_id: 'session' });
  try {
    let mode = 'full';
    const provider = mocked.create({ workdir: '/tmp/workspace', permission: 'full', getPermission: () => mode });
    await provider.run('first');
    assert.ok(mocked.spawned[0].args.includes('--dangerously-skip-permissions'));
    mode = 'read-only';
    await provider.run('second', 'session');
    assert.equal(mocked.spawned[0].closed, true);
    assert.ok(mocked.spawned[1].args.includes('--disallowedTools'));
    provider.refreshPermission();
    assert.equal(mocked.spawned[1].closed, true);
  } finally {
    mocked.restore();
  }
});

test('Gemini replaces a warm full-access worker when access becomes read-only', async () => {
  const mocked = withMockWorkers('../src/providers/gemini',
    { event: 'result', result: { status: 'SUCCESS', response: 'ok', conversation_id: 'session' } });
  try {
    let mode = 'full';
    const provider = mocked.create({ workdir: '/tmp/workspace', permission: 'full', getPermission: () => mode });
    await provider.run('first');
    assert.ok(mocked.spawned[0].args.includes('--dangerously-skip-permissions'));
    mode = 'read-only';
    await provider.run('second', 'session');
    assert.equal(mocked.spawned[0].closed, true);
    assert.ok(!mocked.spawned[1].args.includes('--dangerously-skip-permissions'));
    provider.refreshPermission();
    assert.equal(mocked.spawned[1].closed, true);
  } finally {
    mocked.restore();
  }
});

test('Codex applies the current file access mode to each turn', async () => {
  const appPath = require.resolve('../src/app-server-client');
  const providerPath = require.resolve('../src/providers/codex');
  const appModule = require(appPath);
  const original = appModule.createAppServerClient;
  const policies = [];
  let turnCount = 0;
  appModule.createAppServerClient = () => {
    const listeners = new Set();
    return {
      ready: Promise.resolve(), closed: false,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      request: async (method, params) => {
        if (method === 'thread/start') return { thread: { id: 'thread' } };
        if (method === 'turn/start') {
          policies.push(params.sandboxPolicy);
          const id = `turn-${++turnCount}`;
          setImmediate(() => {
            for (const listener of listeners) listener({ method: 'turn/completed',
              params: { threadId: params.threadId, turn: { id, status: 'completed' } } });
          });
          return { turn: { id } };
        }
        return {};
      },
    };
  };
  delete require.cache[providerPath];
  try {
    let mode = 'full';
    const provider = require(providerPath)({ workdir: '/tmp/workspace', permission: 'full', getPermission: () => mode });
    await provider.run('first');
    mode = 'read-only';
    await provider.run('second', 'thread');
    assert.deepEqual(policies.map((policy) => policy.type), ['dangerFullAccess', 'readOnly']);
  } finally {
    appModule.createAppServerClient = original;
    delete require.cache[providerPath];
  }
});
