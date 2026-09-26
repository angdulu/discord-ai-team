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
        request: async (_input, handle) => {
          for (const next of Array.isArray(event) ? event : [event]) {
            const result = handle(next);
            if (result?.done) return result.value;
          }
        },
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

test('Claude reports tool activity alongside its streamed draft', async () => {
  const mocked = withMockWorkers('../src/providers/claude', [
    { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Unfinished answer' } } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'result', result: 'Final answer', session_id: 'session' },
  ]);
  try {
    const statuses = [];
    const drafts = [];
    const provider = mocked.create({ workdir: '/tmp/workspace', permission: 'read-only' });
    const result = await provider.run('question', null, null, null, [],
      (draft) => drafts.push(draft), (status) => statuses.push(status));
    assert.deepEqual(statuses, ['Exploring files', 'Thinking']);
    assert.deepEqual(drafts, ['Unfinished answer']);
    assert.equal(result.text, 'Final answer');
  } finally {
    mocked.restore();
  }
});

test('Gemini reports activity alongside its streamed draft', async () => {
  const mocked = withMockWorkers('../src/providers/gemini', [
    { event: 'step_update', step_update: { text_delta: 'Unfinished answer' } },
    { event: 'result', result: { status: 'SUCCESS', response: 'Final answer', conversation_id: 'session' } },
  ]);
  try {
    const statuses = [];
    const drafts = [];
    const provider = mocked.create({ workdir: '/tmp/workspace', permission: 'read-only' });
    const result = await provider.run('question', null, null, null, [],
      (draft) => drafts.push(draft), (status) => statuses.push(status));
    assert.deepEqual(statuses, ['Working']);
    assert.deepEqual(drafts, ['Unfinished answer']);
    assert.equal(result.text, 'Final answer');
  } finally {
    mocked.restore();
  }
});

test('Codex reports active commands alongside its streamed draft', async () => {
  const appPath = require.resolve('../src/app-server-client');
  const providerPath = require.resolve('../src/providers/codex');
  const appModule = require(appPath);
  const original = appModule.createAppServerClient;
  appModule.createAppServerClient = () => {
    const listeners = new Set();
    const emit = (method, extra) => {
      for (const listener of listeners) listener({ method, params: { threadId: 'thread', ...extra } });
    };
    return {
      ready: Promise.resolve(), closed: false,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      request: async (method) => {
        if (method === 'thread/start') return { thread: { id: 'thread' } };
        if (method === 'turn/start') {
          setImmediate(() => {
            emit('item/started', { item: { id: 'one', type: 'commandExecution' } });
            emit('item/started', { item: { id: 'two', type: 'commandExecution' } });
            emit('item/agentMessage/delta', { itemId: 'answer', delta: 'Unfinished answer' });
            emit('item/completed', { item: { id: 'one', type: 'commandExecution' } });
            emit('item/completed', { item: { id: 'two', type: 'commandExecution' } });
            emit('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Final answer' } });
            emit('turn/completed', { turn: { id: 'turn', status: 'completed' } });
          });
          return { turn: { id: 'turn' } };
        }
        return {};
      },
    };
  };
  delete require.cache[providerPath];
  try {
    const statuses = [];
    const drafts = [];
    const provider = require(providerPath)({ workdir: '/tmp/workspace', permission: 'read-only' });
    const result = await provider.run('question', null, null, null, [],
      (draft) => drafts.push(draft), (status) => statuses.push(status));
    assert.deepEqual(statuses, ['Running 1 command', 'Running 2 commands', 'Running 1 command', 'Thinking']);
    assert.deepEqual(drafts, ['Unfinished answer']);
    assert.equal(result.text, 'Final answer');
  } finally {
    appModule.createAppServerClient = original;
    delete require.cache[providerPath];
  }
});
