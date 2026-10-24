const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskStore, queuePanel, createQuestionBroker, parseQuestion, visibleDraft,
  runInteractive, normalizeQuestions, controlComponents } = require('../src/task-ui');

function channel(id = 'channel') {
  const sent = [];
  return { id, sent, async send(payload) {
    const message = { ...payload, async edit(next) { Object.assign(this, next); } };
    sent.push(message);
    return message;
  } };
}

function interaction(customId, { userId = 'user', channelId = 'channel', value, values = [], kind = 'button' } = {}) {
  return { customId, user: { id: userId }, channelId, values,
    isButton: () => kind === 'button', isModalSubmit: () => kind === 'modal', isStringSelectMenu: () => kind === 'select',
    fields: { getTextInputValue: () => value },
    async reply(payload) { this.replyPayload = payload; },
    async deferUpdate() { this.deferred = true; },
    async showModal(modal) { this.modal = modal.toJSON(); },
  };
}

const question = { id: 'style', question: 'Which design do you prefer?', options: ['Minimal', 'Liquid glass'] };
const block = '```discord-question\n' + JSON.stringify({ questions: [question] }) + '\n```';

test('questions are parsed only from a valid final protocol block and withheld during streaming', () => {
  assert.equal(parseQuestion(`I have a question.\n${block}`).questions[0].id, 'style');
  assert.equal(parseQuestion(`${block}\nI already chose for you.`), null);
  assert.equal(parseQuestion('```discord-question\ninvalid\n```'), null);
  assert.equal(parseQuestion('```discord-question\n{"questions":[]}\n```'), null);
  for (let i = 1; i <= block.length; i++) {
    const visible = visibleDraft(`Before the question.\n${block.slice(0, i)}`);
    assert.ok(!visible.includes('discord-question') && !visible.includes('"questions"'));
  }
  assert.throws(() => normalizeQuestions([{ ...question, isSecret: true }]), /Invalid question/);
  assert.throws(() => normalizeQuestions([question, question]), /Invalid question ID/);
});

test('questions reject other users and channels, accept a choice once, and expire stale controls', async () => {
  const broker = createQuestionBroker();
  const target = channel();
  const pending = broker.ask([question], { channel: target, userId: 'user' });
  const choice = target.sent[0].components[0].toJSON().components[0].custom_id;
  const wrong = interaction(choice, { userId: 'other' });
  await broker.handle(wrong);
  assert.match(wrong.replyPayload.content, /Only the requester/);
  const elsewhere = interaction(choice, { channelId: 'other' });
  await broker.handle(elsewhere);
  assert.match(elsewhere.replyPayload.content, /original channel/);
  await broker.handle(interaction(choice));
  assert.deepEqual(await pending, { answers: { style: { answers: ['Minimal'] } } });
  assert.equal(target.sent[0].components.length, 0);
  const stale = interaction(choice);
  await broker.handle(stale);
  assert.match(stale.replyPayload.content, /no longer waiting/);
});

test('custom input opens only on interaction and resumes sequential questions without exposing answers', async () => {
  const broker = createQuestionBroker();
  const target = channel();
  const pending = broker.ask([question, { id: 'details', question: 'Any details?' }], { channel: target, userId: 'user' });
  const custom = target.sent[0].components[1].toJSON().components[0].custom_id;
  const open = interaction(custom);
  await broker.handle(open);
  assert.equal(open.modal.title, 'Custom answer');
  await broker.handle(interaction(open.modal.custom_id, { kind: 'modal', value: 'A private detail' }));
  await new Promise(setImmediate);
  assert.equal(target.sent.length, 2);
  const second = target.sent[1].components[0].toJSON().components[0].custom_id;
  const secondOpen = interaction(second);
  await broker.handle(secondOpen);
  await broker.handle(interaction(secondOpen.modal.custom_id, { kind: 'modal', value: 'No animation' }));
  assert.deepEqual(await pending, { answers: { style: { answers: ['A private detail'] }, details: { answers: ['No animation'] } } });
  assert.ok(!target.sent[0].content.includes('private detail'));
});

test('multi-select validates values, and abort closes a pending question', async () => {
  const broker = createQuestionBroker();
  const target = channel();
  const controller = new AbortController();
  const pending = broker.ask([{ ...question, multiSelect: true }], { channel: target, userId: 'user', signal: controller.signal });
  const select = target.sent[0].components[0].toJSON().components[0];
  assert.equal(select.max_values, 2);
  const invalid = interaction(select.custom_id, { kind: 'select', values: ['-1'] });
  await broker.handle(invalid);
  assert.match(invalid.replyPayload.content, /valid option/);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(target.sent[0].components.length, 0);
  assert.match(target.sent[0].content, /Task stopped/);
});

test('question timeout never selects an answer automatically', async () => {
  const broker = createQuestionBroker({ timeoutMs: 15 });
  const target = channel();
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(broker.ask([question], { channel: target, userId: 'user' }), /Question expired/);
    assert.equal(target.sent[0].components.length, 0);
  } finally { clearTimeout(keepAlive); }
});

test('a question continues the same provider session, and cancellation prevents a new turn', async () => {
  const calls = [];
  const saved = [];
  const controller = new AbortController();
  const result = await runInteractive({ prompt: 'Build a page', signal: controller.signal, onSession: (id) => saved.push(id),
    runTurn: async (prompt, sessionId) => {
      calls.push({ prompt, sessionId });
      return { text: calls.length === 1 ? block : 'Built.', sessionId: 'same-session' };
    }, ask: async () => ({ answers: { style: { answers: ['Minimal'] } } }) });
  assert.equal(result.text, 'Built.');
  assert.equal(calls[1].sessionId, 'same-session');
  assert.match(calls[1].prompt, /Minimal/);
  assert.deepEqual(saved, ['same-session', 'same-session']);
  let turns = 0;
  await assert.rejects(runInteractive({ prompt: 'Build', signal: controller.signal,
    runTurn: async () => { turns++; return { text: block, sessionId: 'session' }; },
    ask: async () => { controller.abort(); return {}; } }), /aborted/);
  assert.equal(turns, 1);
});

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
