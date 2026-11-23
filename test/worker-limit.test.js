const test = require('node:test');
const assert = require('node:assert/strict');
const streamWorkerPath = require.resolve('../src/stream-worker');
const geminiPath = require.resolve('../src/providers/gemini');
const claudePath = require.resolve('../src/providers/claude');

function stubStreamWorker(t, factory) {
  const original = require(streamWorkerPath);
  const created = [];
  require.cache[streamWorkerPath].exports = {
    createStreamWorker(command, args, cwd, onClose, idleTimeoutMs) {
      const worker = factory(command, args, cwd, onClose, idleTimeoutMs);
      created.push(worker);
      return worker;
    },
  };
  delete require.cache[geminiPath];
  delete require.cache[claudePath];
  t.after(() => {
    require.cache[streamWorkerPath].exports = original;
    delete require.cache[geminiPath];
    delete require.cache[claudePath];
  });
  return created;
}

test('gemini provider enforces LRU warm worker cap, supports unlimited, and trims on refreshWorkers', async (t) => {
  let limit = 2;
  const created = stubStreamWorker(t, () => {
    let closed = false;
    return {
      get closed() { return closed; },
      close() { closed = true; },
      setIdleTimeoutMs() {},
      async request(input, handle) {
        const id = input.message.content;
        return handle({ event: 'result', result: { status: 'SUCCESS', response: 'ok', conversation_id: id } }).value;
      },
    };
  });
  const createGemini = require('../src/providers/gemini');
  const provider = createGemini({ workdir: '/tmp', permission: 'full', getMaxWarmWorkers: () => limit });

  await provider.run('s1', null, 'm');
  await provider.run('s2', null, 'm');
  await provider.run('s3', null, 'm');
  assert.equal(created[0].closed, true); // s1 evicted by LRU cap=2
  assert.equal(created[1].closed, false);
  assert.equal(created[2].closed, false);

  // Touch s2 so s3 becomes LRU, then lower limit to 1 via refreshWorkers
  await provider.run('s2', 's2', 'm');
  limit = 1;
  provider.refreshWorkers();
  assert.equal(created[2].closed, true);
  assert.equal(created[1].closed, false);

  // Unlimited (null) keeps all subsequent workers open
  limit = null;
  await provider.run('s4', null, 'm');
  await provider.run('s5', null, 'm');
  assert.equal(created[1].closed, false);
  assert.equal(created[3].closed, false);
  assert.equal(created[4].closed, false);
});

test('claude provider supports dynamic warm worker limit and unlimited via getMaxWarmWorkers', async (t) => {
  let limit = 2;
  const created = stubStreamWorker(t, () => {
    let closed = false;
    return {
      get closed() { return closed; },
      close() { closed = true; },
      setIdleTimeoutMs() {},
      async request(input, handle) {
        const id = input.message.content[0].text;
        return handle({ type: 'result', result: 'ok', session_id: id }).value;
      },
    };
  });
  const createClaude = require('../src/providers/claude');
  const provider = createClaude({ workdir: '/tmp', permission: 'full', getMaxWarmWorkers: () => limit });

  await provider.run('c1', null, 'default@high');
  await provider.run('c2', null, 'default@high');
  await provider.run('c3', null, 'default@high');
  assert.equal(created[0].closed, true);
  assert.equal(created[1].closed, false);
  assert.equal(created[2].closed, false);

  limit = 1;
  provider.refreshWorkers();
  assert.equal(created[1].closed, true);
  assert.equal(created[2].closed, false);

  limit = null;
  await provider.run('c4', null, 'default@high');
  await provider.run('c5', null, 'default@high');
  assert.equal(created[2].closed, false);
  assert.equal(created[3].closed, false);
  assert.equal(created[4].closed, false);
});
