const test = require('node:test');
const assert = require('node:assert/strict');
const { createDraft, createProgress, sendTurnError } = require('../src/runner');

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
  assert.equal(sent[0].content, 'Thinking …');
  assert.equal(sent[0].deleted, true);
  assert.equal(sent[1].content, 'Final answer');
});

test('a failed streamed response stays visible with an incomplete notice after cleanup', async () => {
  const { channel, sent } = fakeChannel();
  const draft = createDraft(channel);
  draft.update('Answer so far');
  const error = Object.assign(new Error('API error: INTERNAL (code 500)'), { partialText: 'Answer so far' });
  await sendTurnError({ channel }, 'Gemini Bot', error, draft);
  await draft.cancel();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].deleted, false);
  assert.ok(sent[0].content.startsWith('Answer so far\n\n'));
  assert.match(sent[0].content, /may be incomplete/);
  assert.match(sent[0].content, /INTERNAL.*500/);
});

test('a failure before any text still shows the original error', async () => {
  const { channel, sent } = fakeChannel();
  const draft = createDraft(channel);
  await sendTurnError({ channel }, 'Gemini Bot', new Error('API error'), draft);
  await draft.cancel();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '[Gemini Bot] Error: API error');
  assert.equal(sent[0].deleted, false);
});

test('a long partial response is preserved in chunks when no streamed draft was shown', async () => {
  const { channel, sent } = fakeChannel();
  const partialText = 'Long partial answer. '.repeat(250);
  await sendTurnError({ channel }, 'Gemini Bot', Object.assign(new Error('API error'), { partialText }));
  assert.ok(sent.length > 1);
  assert.ok(sent.every((message) => message.content.length <= 1900 && !message.deleted));
  assert.equal(sent.map((message) => message.content).join(''),
    `${partialText.trim()}\n\n⚠️ [Gemini Bot] Response interrupted; the text above may be incomplete.\nAPI error`);
});
