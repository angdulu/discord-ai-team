const test = require('node:test');
const assert = require('node:assert/strict');
const { repliedText } = require('../src/runner');

const ref = (over = {}) => ({ content: 'Question 1: save X?', author: { username: 'Claudebot', bot: true }, ...over });

test('includes the replied-to message with its author', async () => {
  const message = { reference: { messageId: '1', type: 0 }, fetchReference: async () => ref() };
  assert.equal(await repliedText(message), 'Claudebot (bot): Question 1: save X?');
});

test('ignores plain messages and forwards', async () => {
  assert.equal(await repliedText({ reference: null }), '');
  let fetched = false;
  const forward = { reference: { messageId: '1', type: 1 }, fetchReference: async () => { fetched = true; return ref(); } };
  assert.equal(await repliedText(forward), '');
  assert.equal(fetched, false);
});

test('a deleted or unreadable original is skipped', async () => {
  const message = { reference: { messageId: '1', type: 0 }, fetchReference: async () => { throw new Error('Unknown Message'); } };
  assert.equal(await repliedText(message), '');
});
