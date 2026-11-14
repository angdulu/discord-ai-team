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
  await new Promise(setImmediate);
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
  await new Promise(setImmediate);
  await progress.cancel();
  await draft.finish({ channel }, 'Final answer');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].content, 'Thinking …');
  assert.equal(sent[0].deleted, true);
  assert.equal(sent[1].content, 'Final answer');
});

test('progress hides commentary already visible in the answer draft in either event order', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { channel, sent } = fakeChannel();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const draft = createDraft(channel);
  const progress = createProgress(channel, { getDraftText: () => draft.preview, getQueueCount: () => 2 });
  const flush = async () => { now += 2100; t.mock.timers.tick(2100); progress.refresh(); await new Promise(setImmediate); };
  try {
    draft.update('Checking the requested change.');
    progress.commentary('Checking the requested change.');
    await flush();
    assert.equal(sent.filter((message) => message.content.includes('Checking the requested change.')).length, 1);
    assert.match(sent[0].content, /Thinking.*2 queued/);

    progress.commentary('Applying the update.');
    await flush();
    assert.match(sent[0].content, /Applying the update\./);
    draft.update('Applying the update.\nHere is the revised answer.');
    progress.draftUpdated();
    await flush();
    assert.equal(sent.filter((message) => message.content.includes('Applying the update.')).length, 1);
    assert.match(sent[0].content, /2 queued/);

    // Text beyond the visible draft preview must not hide progress commentary.
    draft.update('x'.repeat(2000) + '\nApplying the update.');
    progress.draftUpdated();
    await flush();
    assert.match(sent[0].content, /Applying the update\./);
    assert.doesNotMatch(sent[1].content, /Applying the update\./);
  } finally {
    await progress.cancel();
    await draft.finish({ channel }, 'Final answer');
  }
  assert.equal(sent[0].deleted, true);
  assert.equal(sent[1].content, 'Final answer');
  assert.equal(sent[1].deleted, false);
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

test('a failed skip hides the control marker while preserving the error', async () => {
  const { channel, sent } = fakeChannel();
  const draft = createDraft(channel);
  const error = Object.assign(new Error('Stream interrupted'), { partialText: ' [[SKIP]]\n' });
  await sendTurnError({ channel }, 'Gemini Bot', error, draft);
  await draft.cancel();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, '[Gemini Bot] Error: Stream interrupted');
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


test('streamed fence previews are closed and final messages keep language fences balanced', async () => {
  const { channel, sent } = fakeChannel();
  const draft = createDraft(channel);
  draft.update('```js\nconst first = 1;');
  await new Promise(setImmediate);
  assert.equal(sent[0].content, '```js\nconst first = 1;\n```\n…');
  const lines = Array.from({ length: 180 }, (_, i) => `const value${i} = ${i};\n`);
  await draft.finish({ channel }, '```js\n' + lines.join('') + '```');
  assert.ok(sent.length > 1);
  assert.ok(sent.every(message => message.content.length <= 1900 && !message.deleted));
  assert.ok(sent.every(message => message.content.startsWith('```js\n') && message.content.trimEnd().endsWith('\n```')));
  for (const line of lines) assert.equal(sent.map(message => message.content).join('').split(line).length - 1, 1);
});

test('non-streaming partial replies also balance continued bare fences', async () => {
  const { channel, sent } = fakeChannel();
  const body = 'A literal line.\n'.repeat(300);
  await sendTurnError({ channel }, 'Test Bot', Object.assign(new Error('Stopped'), { partialText: '```\n' + body + '```' }));
  assert.ok(sent.length > 1);
  assert.ok(sent.every(message => message.content.length <= 1900 && !message.deleted));
  assert.ok(sent[0].content.startsWith('```\n') && sent[0].content.endsWith('\n```'));
  assert.ok(sent.at(-1).content.includes('Response interrupted'));
});
