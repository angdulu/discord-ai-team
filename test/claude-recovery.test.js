const test = require('node:test');
const assert = require('node:assert/strict');

test('Claude publishes a new session before timeout and resumes it without retrying the failed request', async (t) => {
  const streamModule = require('../src/stream-worker');
  const providerPath = require.resolve('../src/providers/claude');
  const sessionId = '6bbd509f-d21c-487d-82b7-213385676a14';
  const spawned = [];
  const requests = [];
  t.mock.method(streamModule, 'createStreamWorker', (_command, args, _cwd, onClose) => {
    const index = spawned.length;
    const worker = {
      request: async (input, handle) => {
        requests.push(input);
        handle({ type: 'system', subtype: 'init', session_id: sessionId });
        if (index === 0) {
          worker.close();
          throw Object.assign(new Error('claude timed out after 30 minutes without progress'),
            { code: 'TURN_INACTIVITY_TIMEOUT' });
        }
        return handle({ type: 'result', session_id: sessionId, result: 'State checked' }).value;
      },
      close: () => onClose?.(),
      setIdleTimeoutMs: () => {},
    };
    spawned.push({ args, worker });
    return worker;
  });
  delete require.cache[providerPath];
  t.after(() => { delete require.cache[providerPath]; });
  const provider = require(providerPath)({ workdir: '/tmp/workspace', permission: 'read-only' });
  let savedSession;
  const saveSession = (id) => { savedSession = id; };
  await assert.rejects(provider.run('original request', null, null, null, [], null, null, saveSession), (error) => {
    assert.equal(savedSession, sessionId);
    assert.equal(error.sessionId, sessionId);
    assert.equal(error.code, 'TURN_INACTIVITY_TIMEOUT');
    assert.match(error.message, /completion is unconfirmed/);
    assert.match(error.message, /not undone/);
    assert.match(error.message, /not automatically retried/);
    return true;
  });
  assert.equal(requests.length, 1);
  const completed = await provider.run('check current state', savedSession);
  assert.deepEqual(completed, { text: 'State checked', sessionId });
  const resumeIndex = spawned[1].args.indexOf('--resume');
  assert.equal(spawned[1].args[resumeIndex + 1], sessionId);
  assert.equal(requests.length, 2);
  provider.closeSession(sessionId);
});
