const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskStore, queuePanel, controlComponents } = require('../src/task-ui');

test('queued cancellations are scoped, and private queue panels only reveal the requester’s text', () => {
  const tasks = createTaskStore();
  const active = tasks.add('channel', 'user', 'First');
  active.status = 'running';
  const next = tasks.add('channel', 'user', 'Second');
  tasks.add('channel', 'other', 'Another user’s private prompt');
  const elsewhere = tasks.add('other-channel', 'user', 'Elsewhere');
  const panel = queuePanel(tasks, 'channel', 'user', 'Test Bot');
  assert.match(panel.content, /Running: \*\*1\*\* · Queued: \*\*2\*\*/);
  assert.ok(!panel.content.includes('private prompt'));
  assert.equal(panel.components[0].toJSON().components[0].options[0].value, next.id);
  tasks.cancelQueued('channel');
  assert.equal(active.status, 'running');
  assert.equal(next.status, 'cancelled');
  assert.equal(elsewhere.status, 'queued');
  tasks.finish(active);
  assert.equal(tasks.list('channel').length, 0);
  assert.ok(controlComponents()[0].toJSON().components.some((item) => item.label === 'Agent settings'));
});
