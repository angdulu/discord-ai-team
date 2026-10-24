const test = require('node:test');
const assert = require('node:assert/strict');

test('Codex streams commentary separately and steers only its active turn', async (t) => {
  const module = require('../src/app-server-client');
  const file = require.resolve('../src/providers/codex');
  const listeners = new Set();
  const calls = [];
  const emit = (method, params) => {
    for (const listener of listeners) listener({ method, params: { threadId: 'thread', ...params } });
  };
  t.mock.method(module, 'createAppServerClient', () => ({
    ready: Promise.resolve(), closed: false,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'turn/start') return { turn: { id: 'turn' } };
      return {};
    },
  }));
  delete require.cache[file];
  t.after(() => { delete require.cache[file]; });
  const provider = require(file)({ workdir: '/tmp', permission: 'read-only' });
  const commentary = [];
  const drafts = [];
  let control;
  let saved;
  const pending = provider.run('Task', null, null, null, [], (text) => drafts.push(text), null, (id) => { saved = id; }, {
    onCommentary: (text) => commentary.push(text), onControl: (next) => { control = next; },
  });
  await new Promise(setImmediate);
  assert.equal(saved, 'thread');
  emit('item/started', { item: { id: 'comment', type: 'agentMessage', phase: 'commentary' } });
  emit('item/agentMessage/delta', { itemId: 'comment', delta: 'First, I’ll inspect ' });
  emit('item/agentMessage/delta', { itemId: 'comment', delta: 'the code.' });
  assert.deepEqual(commentary, ['First, I’ll inspect ', 'First, I’ll inspect the code.']);
  assert.deepEqual(drafts, []);
  await control.steer('Focus on mobile');
  assert.deepEqual(calls.at(-1), { method: 'turn/steer', params: {
    threadId: 'thread', expectedTurnId: 'turn', input: [{ type: 'text', text: 'Focus on mobile' }],
  } });
  emit('item/started', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer' } });
  emit('item/agentMessage/delta', { itemId: 'answer', delta: 'Done.' });
  emit('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Done.' } });
  emit('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  assert.deepEqual(await pending, { text: 'Done.', sessionId: 'thread' });
  assert.deepEqual(drafts, ['Done.']);
  assert.equal(control, null);
});
