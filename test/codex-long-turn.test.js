const test = require('node:test');
const assert = require('node:assert/strict');

test('Codex accepts a completed turn after five minutes', async (t) => {
  const appPath = require.resolve('../src/app-server-client');
  const providerPath = require.resolve('../src/providers/codex');
  const appModule = require(appPath);
  const original = appModule.createAppServerClient;
  const listeners = new Set();
  let turnStarted;
  const started = new Promise((resolve) => { turnStarted = resolve; });
  const requests = [];

  appModule.createAppServerClient = () => ({
    ready: Promise.resolve(), closed: false,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    request: async (method) => {
      requests.push(method);
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'turn/start') {
        turnStarted();
        return { turn: { id: 'turn' } };
      }
      return {};
    },
  });
  delete require.cache[providerPath];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const provider = require(providerPath)({ workdir: '/tmp/workspace', permission: 'read-only' });
    let settled = false;
    const result = provider.run('long task').finally(() => { settled = true; });
    await started;
    await Promise.resolve();

    t.mock.timers.tick(5 * 60 * 1000 + 1000);
    assert.equal(settled, false);
    assert.equal(requests.includes('turn/interrupt'), false);

    for (const listener of listeners) listener({ method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    assert.deepEqual(await result, { text: '', sessionId: 'thread' });
  } finally {
    t.mock.timers.reset();
    appModule.createAppServerClient = original;
    delete require.cache[providerPath];
  }
});
