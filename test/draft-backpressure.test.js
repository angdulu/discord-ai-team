const test = require('node:test');
const assert = require('node:assert/strict');
const { createDraft, createProgress } = require('../src/runner');
const turn = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  return async () => { now += 2100; t.mock.timers.tick(2100); await turn(); };
}
function channelWith({ sendGate, editGate, deleteGate } = {}) {
  const edits = [];
  let sends = 0, deletes = 0, active = 0, peak = 0;
  const message = {
    content: '', deleted: false,
    async edit(payload) {
      edits.push(payload.content);
      active++; peak = Math.max(peak, active);
      try {
        if (edits.length === 1 && editGate) await editGate.promise;
        this.content = payload.content;
      } finally { active--; }
    },
    async delete() { deletes++; if (deleteGate) await deleteGate.promise; this.deleted = true; },
  };
  return {
    channel: { async send(payload) { sends++; if (sendGate) await sendGate.promise; message.content = payload.content; return message; } },
    message, edits,
    get sends() { return sends; }, get deletes() { return deletes; }, get peak() { return peak; },
  };
}

test('1,000 slow-edit updates retain only the latest snapshot and one in-flight edit', async (t) => {
  const advance = clock(t), gate = deferred(), fake = channelWith({ editGate: gate });
  const draft = createDraft(fake.channel);
  draft.update('Initial'); await turn(); await advance();
  draft.update('First slow edit'); await turn();
  for (let i = 0; i < 1000; i++) { await advance(); draft.update(`Obsolete ${i}`); }
  draft.update('Newest');
  assert.deepEqual(fake.edits, ['First slow edit …']);
  gate.resolve(); await turn();
  assert.equal(fake.edits.length, 1, 'completion still respects the refresh interval');
  await advance();
  assert.deepEqual(fake.edits, ['First slow edit …', 'Newest …']);
  assert.equal(fake.peak, 1);
  await draft.cancel();
});

test('cancel resolves without waiting for a blocked edit or deletion and drops pending updates', async (t) => {
  const advance = clock(t), editGate = deferred(), deleteGate = deferred();
  const fake = channelWith({ editGate, deleteGate }), draft = createDraft(fake.channel);
  draft.update('Initial'); await turn(); await advance();
  draft.update('Blocked'); await turn();
  draft.update('Never send');
  let done = false;
  void draft.cancel().then(() => { done = true; });
  await turn();
  assert.equal(done, true);
  assert.equal(fake.deletes, 1);
  draft.update('Still never send');
  editGate.resolve(); deleteGate.resolve(); await turn(); await advance();
  assert.deepEqual(fake.edits, ['Blocked …']);
  assert.equal(fake.message.deleted, true);
});

test('a message created after cancellation is deleted without reviving the draft', async () => {
  const sendGate = deferred(), fake = channelWith({ sendGate });
  const draft = createDraft(fake.channel);
  draft.update('Initial'); await turn();
  await draft.cancel();
  assert.equal(fake.deletes, 0);
  sendGate.resolve(); await turn();
  assert.equal(fake.sends, 1);
  assert.equal(fake.deletes, 1);
  assert.equal(fake.message.deleted, true);
  draft.update('Do not revive'); await turn();
  assert.equal(fake.sends, 1);
});

test('finish waits for only the active edit, drops stale previews and preserves the final reply', async (t) => {
  const advance = clock(t), gate = deferred(), fake = channelWith({ editGate: gate });
  const draft = createDraft(fake.channel);
  draft.update('Initial'); await turn(); await advance();
  draft.update('Active edit'); await turn();
  for (let i = 0; i < 100; i++) draft.update(`Discard ${i}`);
  let done = false;
  const finishing = draft.finish({ channel: fake.channel }, 'Final answer').then(() => { done = true; });
  await turn(); assert.equal(done, false);
  gate.resolve(); await finishing; await advance();
  assert.deepEqual(fake.edits, ['Active edit …', 'Final answer']);
  assert.equal(fake.peak, 1);
  await draft.cancel();
  assert.equal(fake.message.deleted, false);
});

test('Stop interrupts finalization waiting on a preview even after provider completion', async (t) => {
  const advance = clock(t), gate = deferred(), fake = channelWith({ editGate: gate });
  const controller = new AbortController();
  const draft = createDraft(fake.channel, undefined, controller.signal);
  draft.update('Initial'); await turn(); await advance();
  draft.update('Blocked'); await turn();
  let done = false;
  void draft.finish({ channel: fake.channel }, 'Must not publish').then(() => { done = true; });
  controller.abort(); await turn();
  assert.equal(done, true);
  assert.equal(fake.deletes, 1);
  gate.resolve(); await turn(); await advance();
  assert.deepEqual(fake.edits, ['Blocked …']);
});

test('progress cancellation does not block a separate final answer behind its old edit', async (t) => {
  const advance = clock(t), gate = deferred(), fake = channelWith({ editGate: gate });
  const progress = createProgress(fake.channel);
  await turn(); await advance();
  progress.update('Working'); await turn();
  await progress.cancel();
  const answer = channelWith(), draft = createDraft(answer.channel);
  await draft.finish({ channel: answer.channel }, 'Complete answer');
  assert.equal(answer.message.content, 'Complete answer');
  gate.resolve(); await turn(); await advance();
  assert.equal(fake.edits.length, 1);
  assert.equal(fake.message.deleted, true);
});

test('a failed slow edit releases its slot for the newest update', async (t) => {
  const advance = clock(t), gate = deferred(), fake = channelWith({ editGate: gate });
  const draft = createDraft(fake.channel);
  draft.update('Initial'); await turn(); await advance();
  draft.update('Will fail'); await turn(); draft.update('Recovery');
  gate.reject(new Error('Network failure')); await turn(); await advance();
  assert.deepEqual(fake.edits, ['Will fail …', 'Recovery …']);
  await draft.cancel();
});

test('an already aborted request never creates a draft', async () => {
  const controller = new AbortController(); controller.abort();
  const fake = channelWith(), draft = createDraft(fake.channel, undefined, controller.signal);
  draft.update('Do not send'); await draft.finish({ channel: fake.channel }, 'Do not finalize');
  assert.equal(fake.sends, 0);
});
