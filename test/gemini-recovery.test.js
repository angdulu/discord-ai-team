const test = require('node:test');
const assert = require('node:assert/strict');

const apiError = 'API error (attempt 3): INTERNAL (code 500): Internal error encountered.';
const sessionId = 'gemini-session';
const step = (step_index, step_type, state, text_delta) => ({ event: 'step_update',
  step_update: { conversation_id: sessionId, step_index, step_type, state, text_delta } });
const result = (response = '') => ({ event: 'result',
  result: { conversation_id: sessionId, status: 'ERROR', response, error: apiError } });

function providerWithEvents(t, events, failure) {
  const streamModule = require('../src/stream-worker');
  const providerPath = require.resolve('../src/providers/gemini');
  const workers = [];
  const requests = [];
  t.mock.method(streamModule, 'createStreamWorker', (_command, _args, _cwd, onClose) => {
    const worker = {
      request: async (input, handle) => {
        requests.push(input);
        for (const event of events) {
          const handled = handle(event);
          if (handled?.done) return handled.value;
        }
        throw failure;
      },
      close: t.mock.fn(() => onClose?.()),
      setIdleTimeoutMs: () => {},
    };
    workers.push(worker);
    return worker;
  });
  t.mock.method(console, 'warn', () => {});
  delete require.cache[providerPath];
  const provider = require(providerPath)({ workdir: '/tmp/workspace', permission: 'full' });
  t.after(() => { provider.refreshPermission(); delete require.cache[providerPath]; });
  return { provider, workers, requests };
}

test('a completed current Gemini reply survives a historical API 500 and keeps its worker', async (t) => {
  // agy 1.4.4 emitted this sequence on a resumed conversation with an older 500.
  const { provider, workers, requests } = providerWithEvents(t, [
    step(48, 'user_input', 'DONE'),
    step(49, 'system_message', 'DONE'),
    step(50, 'agent_response', 'ACTIVE', 'GEMINI_OK'),
    step(50, 'agent_response', 'DONE', '\n'),
    result('GEMINI_OK\n'),
  ]);
  const drafts = [];
  assert.deepEqual(await provider.run('question', sessionId, null, null, [], (text) => drafts.push(text)),
    { text: 'GEMINI_OK', sessionId });
  assert.deepEqual(drafts, ['GEMINI_OK', 'GEMINI_OK\n']);
  assert.equal(workers[0].close.mock.callCount(), 0);
  await provider.run('next question', sessionId, null);
  assert.equal(workers.length, 1);
  assert.equal(requests.length, 2);
});

test('a real API failure during Gemini streaming keeps partial text without retrying', async (t) => {
  const { provider, workers, requests } = providerWithEvents(t, [
    step(48, 'user_input', 'DONE'),
    step(49, 'agent_response', 'ACTIVE', 'Answer so far'),
    result('Answer so far'),
  ]);
  await assert.rejects(provider.run('question'), (error) => {
    assert.match(error.message, /INTERNAL.*500/);
    assert.equal(error.partialText, 'Answer so far');
    assert.equal(error.sessionId, sessionId);
    return true;
  });
  assert.equal(workers[0].close.mock.callCount(), 1);
  assert.equal(requests.length, 1);
});

test('old response events cannot turn a failed new Gemini request into success', async (t) => {
  const { provider } = providerWithEvents(t, [
    step(40, 'agent_response', 'DONE', 'Previous answer'),
    step(48, 'user_input', 'DONE'),
    result('Previous answer'),
  ]);
  await assert.rejects(provider.run('question'), (error) => {
    assert.match(error.message, /INTERNAL.*500/);
    assert.equal(error.partialText, '');
    return true;
  });
});

test('a tool failure after an intermediate Gemini reply remains a failure', async (t) => {
  const { provider } = providerWithEvents(t, [
    step(48, 'user_input', 'DONE'),
    step(49, 'agent_response', 'DONE', 'Checking files'),
    step(50, 'tool_call', 'ERROR'),
    result('Checking files'),
  ]);
  await assert.rejects(provider.run('question'), /INTERNAL.*500/);
});

test('a mismatched terminal Gemini response is not accepted as the completed reply', async (t) => {
  const { provider } = providerWithEvents(t, [
    step(48, 'user_input', 'DONE'),
    step(49, 'agent_response', 'DONE', 'Current answer'),
    result('Previous answer'),
  ]);
  await assert.rejects(provider.run('question'), /INTERNAL.*500/);
});

test('a Gemini worker disconnect keeps its streamed text and conversation', async (t) => {
  const { provider, requests } = providerWithEvents(t, [
    step(48, 'user_input', 'DONE'),
    step(49, 'agent_response', 'ACTIVE', 'Answer so far'),
  ], new Error('agy exited (1)'));
  await assert.rejects(provider.run('question'), (error) => {
    assert.equal(error.message, 'agy exited (1)');
    assert.equal(error.partialText, 'Answer so far');
    assert.equal(error.sessionId, sessionId);
    return true;
  });
  assert.equal(requests.length, 1);
});
