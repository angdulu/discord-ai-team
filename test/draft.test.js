const test = require('node:test');
const assert = require('node:assert/strict');
const { createDraft, createProgress } = require('../src/runner');

function fakeChannel() {
  const sent = [];
  const channel = {
    async send(content) {
      const message = {
        content: typeof content === 'string' ? content : content.content,
        deleted: false,
        async edit(next) { this.content = next.content; },
        async delete() { this.deleted = true; },
      };
      sent.push(message);
      return message;
    },
  };
  return { channel, sent };
}

test('streamed draft becomes the final reply without a duplicate message', async () => {
  const { channel, sent } = fakeChannel();
  const draft = createDraft(channel);
  draft.update('Partial answer');
  await draft.finish({ channel }, 'Final answer');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'Final answer');
  await draft.cancel();
  assert.equal(sent[0].deleted, false);
});

test('cancel removes an unfinished draft', async () => {
  const { channel, sent } = fakeChannel();
  const draft = createDraft(channel);
  draft.update('Partial answer');
  await draft.cancel();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].deleted, true);
});

test('progress disappears while the streamed draft becomes the final answer', async () => {
  const { channel, sent } = fakeChannel();
  const progress = createProgress(channel);
  const draft = createDraft(channel);
  progress.update('Running 2 commands');
  draft.update('Partial answer');
  await progress.cancel();
  await draft.finish({ channel }, 'Final answer');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].deleted, true);
  assert.equal(sent[1].content, 'Final answer');
});
