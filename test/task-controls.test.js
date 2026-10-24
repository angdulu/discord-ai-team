const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tick = () => new Promise(setImmediate);
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  assert.ok(check(), 'expected asynchronous state');
}

function fakeChannel(id = 'channel') {
  return { id, sent: [], async sendTyping() {}, async send(payload) {
    const message = { ...(typeof payload === 'string' ? { content: payload } : payload), deleted: false,
      async edit(next) { Object.assign(this, next); return this; }, async delete() { this.deleted = true; } };
    this.sent.push(message);
    return message;
  } };
}

async function setup(t, runPrompt, { mockHistory = false, allowedChannelIds = [],
  getUsage = async () => ({ plan: 'Test', sections: [] }) } = {}) {
  const discord = require('discord.js');
  class Client extends EventEmitter {
    constructor() {
      super();
      this.user = { id: 'bot', username: 'Test Bot' };
      this.channels = { cache: new Map() };
    }
    login() {}
  }
  const originalClient = discord.Client;
  discord.Client = Client;
  t.after(() => { discord.Client = originalClient; });
  t.mock.method(require('../src/cli-maintenance'), 'createCliMaintenance', () => ({
    run: (fn) => fn(), reserve: () => () => {}, wait: async () => {}, status: () => ({}), close() {},
  }));
  const file = require.resolve('../src/runner');
  delete require.cache[file];
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-controls-'));
  if (mockHistory) t.mock.method(require('../src/session-history'), 'listResumableSessions', ({ file, userId }) =>
    fs.existsSync(file) ? Object.values(JSON.parse(fs.readFileSync(file, 'utf8'))).filter((entry) => entry.ownerId === userId) : []);
  const stops = [];
  t.mock.method(require('../src/team-control'), 'publishStop', (channelId) => { stops.push(channelId); });
  delete require.cache[file];
  const client = require(file).startBot({ key: 'test', token: 'unused', name: 'Test Bot', defaultName: 'Test Bot',
    runPrompt, providerId: 'codex', workdir: stateDir, permission: 'read-only',
    allowedChannelIds, allowedUserIds: ['user', 'other'], historyLimit: 0, stateDir,
    models: [{ key: 'test', label: 'Test', id: () => 'test' }], getUsage,
  });
  const target = fakeChannel();
  const send = async (text, channel = target) => {
    await client.listeners('messageCreate')[0]({ id: 'message', channelId: channel.id, channel,
      author: { id: 'user', username: 'User', bot: false }, guild: null, content: text,
      attachments: new Map(), messageSnapshots: new Map(), createdTimestamp: Date.now(),
      mentions: { has: () => false, users: new Map(), members: new Map() } });
    await tick();
  };
  const click = async (customId, { userId = 'user', channel = target, kind = 'button', value, values = [], commandName, message,
    guild = null, memberPermissions } = {}) => {
    const interaction = { customId, commandName, user: { id: userId }, channelId: channel.id, channel,
      guild, guildId: guild?.id, memberPermissions, values, message, fields: { getTextInputValue: () => value },
      isButton: () => kind === 'button', isModalSubmit: () => kind === 'modal',
      isStringSelectMenu: () => kind === 'select', isChatInputCommand: () => kind === 'command',
      isAutocomplete: () => false, isMessageContextMenuCommand: () => kind === 'context',
      async reply(payload) { this.response = payload; this.replied = true; },
      async deferReply() { this.deferred = true; }, async deferUpdate() { this.deferred = true; },
      async editReply(payload) { this.response = payload; }, async followUp(payload) { this.response = payload; },
      async update(payload) { this.response = payload; }, async showModal(modal) { this.modal = modal.toJSON(); },
    };
    await client.listeners('interactionCreate')[0](interaction);
    return interaction;
  };
  t.after(async () => {
    await click('control:stop');
    await tick();
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete require.cache[file];
  });
  return { target, send, click, stateDir, stops };
}

function controls(message) {
  return (message.components || []).flatMap((row) => row.toJSON().components);
}

test('streamed commentary appears once while the progress card keeps its controls', async (t) => {
  let stream;
  let complete;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const ui = await setup(t, (...args) => new Promise((resolve) => {
    stream = { update: args[5], progress: args[6], commentary: args[8].onCommentary };
    complete = resolve;
    args[3].addEventListener('abort', () => resolve({ text: '' }), { once: true });
  }));
  await ui.send('Make the requested change');
  await until(() => stream);
  const commentary = 'I’ll update the requested setting.';
  stream.update(commentary);
  stream.commentary(commentary);
  now += 2100;
  stream.progress('Working');
  await tick();
  const visible = ui.target.sent.filter((message) => !message.deleted);
  assert.equal(visible.filter((message) => message.content.includes(commentary)).length, 1);
  const progress = visible.find((message) => controls(message).some((item) => item.label === 'Stop'));
  assert.match(progress.content, /Working/);
  assert.doesNotMatch(progress.content, /I’ll update/);
  assert.deepEqual(controls(progress).map((item) => item.label), ['Stop', 'Stop all', 'Queue']);
  complete({ text: 'Updated.' });
  await until(() => ui.target.sent.some((message) => message.content === 'Updated.'));
  assert.ok(progress.deleted);
  assert.equal(ui.target.sent.filter((message) => !message.deleted).length, 1);
});

test('queued requests can be cancelled independently and stale task controls never stop the next request', async (t) => {
  const calls = [];
  const ui = await setup(t, (...args) => new Promise((resolve) => {
    calls.push({ args, resolve });
    args[8].onControl({ steer: async () => {} });
    args[3].addEventListener('abort', () => resolve({ text: 'Aborted answer', sessionId: 'session' }), { once: true });
  }));
  await ui.send('First request');
  await until(() => calls.length === 1);
  const progress = ui.target.sent.find((message) => controls(message).some((item) => item.label === 'Stop'));
  const stop = controls(progress).find((item) => item.label === 'Stop').custom_id;
  await ui.send('Cancel this request');
  await ui.send('Keep this request');
  const receipts = ui.target.sent.filter((message) => message.content.includes('Request queued'));
  assert.equal(receipts.length, 2);
  const cancel = controls(receipts[0]).find((item) => item.label === 'Cancel request').custom_id;
  const denied = await ui.click(cancel, { userId: 'other' });
  assert.match(denied.response.content, /Only the requester/);
  await ui.click(cancel);
  await ui.click(stop);
  await until(() => calls.length === 2);
  assert.match(calls[1].args[0], /Keep this request/);
  assert.ok(!ui.target.sent.some((message) => message.content === 'Aborted answer'));
  const stale = await ui.click(stop);
  assert.match(stale.response.content, /no longer active/);
  assert.equal(calls[1].args[3].aborted, false);
  calls[1].resolve({ text: 'Done', sessionId: 'session' });
  await until(() => ui.target.sent.some((message) => message.content === 'Done'));
  assert.deepEqual(controls(ui.target.sent.find((message) => message.content === 'Done')), []);
});

test('steering is tied to the active task and task cards no longer offer per-task alerts', async (t) => {
  let complete;
  let received;
  const ui = await setup(t, (...args) => new Promise((resolve) => {
    complete = resolve;
    args[8].onControl({ steer: async (text) => { received = text; } });
    args[3].addEventListener('abort', () => resolve({ text: '', sessionId: 'session' }), { once: true });
  }));
  await ui.send('Build a page');
  await until(() => complete);
  const progress = ui.target.sent.find((message) => controls(message).some((item) => item.label === 'Stop'));
  assert.deepEqual(controls(progress).map((item) => item.label), ['Stop', 'Stop all', 'Send update', 'Queue']);
  const id = controls(progress).find((item) => item.label === 'Stop').custom_id.split(':')[1];
  const wrongChannel = await ui.click(`task:${id}:steer`, { channel: fakeChannel('elsewhere') });
  assert.match(wrongChannel.response.content, /no longer active/);
  const open = await ui.click(`task:${id}:steer`);
  assert.equal(open.modal.title, 'Update the running task');
  await ui.click(open.modal.custom_id, { kind: 'modal', value: 'Use a mobile layout' });
  assert.equal(received, 'Use a mobile layout');
  const retired = await ui.click(`task:${id}:notify`);
  assert.match(retired.response.content, /Invalid task action/);
  complete({ text: 'Done', sessionId: 'session' });
  await until(() => ui.target.sent.some((message) => message.content === 'Done'));
  assert.ok(!ui.target.sent.some((message) => message.content.includes('finished your task')));
});

test('ordinary chat questions finish the turn and the next message resumes the saved session without injected instructions', async (t) => {
  const calls = [];
  const ui = await setup(t, async (...args) => {
    calls.push(args);
    return { sessionId: 'session', text: calls.length === 1 ? '어떤 디자인을 원해?' : '간결하게 만들었어.' };
  });
  await ui.send('페이지를 만들기 전에 디자인을 물어봐줘');
  await until(() => ui.target.sent.some((message) => message.content === '어떤 디자인을 원해?'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '페이지를 만들기 전에 디자인을 물어봐줘');
  assert.equal(calls[0][8].onQuestion, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ui.stateDir, 'test.sessions.json'))).channel, 'session');
  assert.deepEqual(controls(ui.target.sent.find((message) => message.content === '어떤 디자인을 원해?')), []);
  await ui.send('간결하게 해줘');
  await until(() => ui.target.sent.some((message) => message.content === '간결하게 만들었어.'));
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], 'session');
  assert.equal(calls[1][0], '간결하게 해줘');
  const panel = await ui.click('', { kind: 'command', commandName: 'panel' });
  assert.match(panel.response.content, /Test Bot controls/);
  assert.equal(panel.response.flags, require('discord.js').MessageFlags.Ephemeral);
  const model = await ui.click('control:model');
  assert.ok(model.deferred && model.response.components.length);
  const settings = await ui.click('control:settings');
  assert.match(settings.response.content, /Completion alerts: \*\*OFF\*\*/);
  assert.equal(controls(settings.response).length, 1);
});

test('saved completion alerts apply only to this user and channel, and only to long future tasks', async (t) => {
  const pending = [];
  const ui = await setup(t, (...args) => new Promise((resolve) => {
    pending.push(resolve);
    args[3].addEventListener('abort', () => resolve({ text: '', sessionId: 'session' }), { once: true });
  }));
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const settings = await ui.click('control:settings');
  const toggleId = controls(settings.response)[0].custom_id;
  const wrongUser = await ui.click(toggleId, { userId: 'other' });
  assert.match(wrongUser.response.content, /own settings panel/);
  const toggled = await ui.click(toggleId);
  assert.match(toggled.response.content, /Completion alerts: \*\*ON\*\*/);
  assert.equal(controls(toggled.response)[0].label, 'Completion alerts: ON');
  const preferences = JSON.parse(fs.readFileSync(path.join(ui.stateDir, 'test.notifications.json')));
  assert.deepEqual(preferences, { 'channel:user': true });
  await ui.send('Short task');
  pending[0]({ text: 'Short done.', sessionId: 'session' });
  await until(() => ui.target.sent.some((message) => message.content === 'Short done.'));
  assert.ok(!ui.target.sent.some((message) => message.content.includes('finished your task')));
  await ui.send('Long task');
  await until(() => pending.length === 2);
  now += 61000;
  pending[1]({ text: 'Long done.', sessionId: 'session' });
  await until(() => ui.target.sent.some((message) => message.content.includes('finished your task')));
  const alert = ui.target.sent.find((message) => message.content.includes('finished your task'));
  assert.deepEqual(alert.allowedMentions, { users: ['user'] });
  const otherSettings = await ui.click('control:settings', { userId: 'other' });
  assert.match(otherSettings.response.content, /Completion alerts: \*\*OFF\*\*/);
  const otherUser = await ui.click(controls(otherSettings.response)[0].custom_id, { userId: 'other' });
  assert.match(otherUser.response.content, /\*\*ON\*\*/);
  const elsewhere = await ui.click('control:settings', { channel: fakeChannel('elsewhere') });
  assert.match(elsewhere.response.content, /Completion alerts: \*\*OFF\*\*/);
});

test('former question protocol is streamed and delivered as text without starting an answer wait', async (t) => {
  const calls = [];
  const output = '```discord-question\n{"questions":[{"question":"Which design?","options":["Minimal"]}]}\n```';
  const ui = await setup(t, async (...args) => {
    calls.push(args);
    const text = calls.length === 1 ? output : 'Done.';
    args[5](text);
    return { sessionId: 'session', text };
  });
  await ui.send('Show this protocol as text');
  await until(() => ui.target.sent.some((message) => message.content === output));
  assert.equal(calls.length, 1);
  assert.deepEqual(controls(ui.target.sent.find((message) => message.content === output)), []);
  assert.ok(!ui.target.sent.some((message) => message.content.includes('Question 1 of 1')));
  await ui.send('Continue');
  await until(() => ui.target.sent.some((message) => message.content === 'Done.'));
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], 'session');
});

test('Resume and Rename work from the panel, including modal ownership and channel checks', async (t) => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ui = await setup(t, async () => ({ text: 'Saved.', sessionId: id }), { mockHistory: true });
  await ui.send('Project conversation');
  await until(() => ui.target.sent.some((message) => message.content === 'Saved.'));
  const rename = await ui.click('control:rename');
  const menu = rename.response.components[0].toJSON().components[0];
  assert.equal(menu.options[0].value, id);
  const open = await ui.click(menu.custom_id, { kind: 'select', values: [id] });
  assert.equal(open.modal.title, 'Rename conversation');
  const wrongUser = await ui.click(open.modal.custom_id, { kind: 'modal', userId: 'other', value: 'Wrong' });
  assert.match(wrongUser.response.content, /own Rename menu/);
  const wrongChannel = await ui.click(open.modal.custom_id, { kind: 'modal', channel: fakeChannel('elsewhere'), value: 'Wrong' });
  assert.match(wrongChannel.response.content, /original channel/);
  const renamed = await ui.click(open.modal.custom_id, { kind: 'modal', value: 'Updated project name' });
  assert.match(renamed.response.content, /Updated project name/);
  const resume = await ui.click('control:resume');
  const resumeMenu = resume.response.components[0].toJSON().components[0];
  assert.equal(resumeMenu.options[0].label, 'Updated project name');
  const resumed = await ui.click(resumeMenu.custom_id, { kind: 'select', values: [id] });
  assert.match(resumed.response.content, /Resuming/);
  await ui.click('control:new');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ui.stateDir, 'test.sessions.json'))), {});
});

test('settings and debate are reachable without slash options and retain server-manager checks', async (t) => {
  const ui = await setup(t, async () => ({ text: 'Done.' }));
  const guild = { id: 'guild', members: { fetch: async () => null } };
  const channel = Object.assign(fakeChannel(), { guild });
  const permissions = { has: () => true };
  const agent = await ui.click('control:settings', { guild, channel, memberPermissions: permissions });
  assert.match(agent.response.content, /Test Bot settings/);
  const debateId = controls(agent.response).find((item) => item.label === 'Debate settings').custom_id;
  const debate = await ui.click(debateId, { guild, channel, memberPermissions: permissions });
  assert.match(debate.response.content, /Debate settings/);
  const denied = await ui.click('control:debate', { guild, channel, memberPermissions: { has: () => false } });
  assert.match(denied.response.content, /Manage Server permission/);
});

test('regular users can change personal alerts without gaining administrative access', async (t) => {
  const ui = await setup(t, async () => ({ text: 'Done.' }), { allowedChannelIds: ['channel'] });
  const guild = { id: 'guild' };
  const channel = Object.assign(fakeChannel(), { guild });
  const memberPermissions = { has: () => false };
  const options = { guild, channel, memberPermissions };
  const settings = await ui.click('control:settings', options);
  assert.equal(settings.response.flags, require('discord.js').MessageFlags.Ephemeral);
  assert.doesNotMatch(settings.response.content, /Workspace|Server prompt|File access|Discord token/);
  assert.deepEqual(controls(settings.response).map((item) => item.label), ['Completion alerts: OFF']);
  const toggled = await ui.click(controls(settings.response)[0].custom_id, options);
  assert.match(toggled.response.content, /Completion alerts: \*\*ON\*\*/);
  for (const action of ['name-edit', 'prompt-server', 'idle-toggle', 'history-set', 'permission-select']) {
    const denied = await ui.click(`agent:${action}:user`, { ...options, kind: action === 'permission-select' ? 'select' : 'button', values: ['full'] });
    assert.match(denied.response.content, /Manage Server permission/);
  }
  const blockedOptions = { ...options, channel: fakeChannel('blocked') };
  const blocked = await ui.click('control:settings', blockedOptions);
  assert.match(blocked.response.content, /not allowed/);
  const blockedToggle = await ui.click(controls(settings.response)[0].custom_id, blockedOptions);
  assert.match(blockedToggle.response.content, /not allowed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ui.stateDir, 'test.notifications.json'))), { 'channel:user': true });
});

test('Stop all on the running-task card clears pending requests and publishes a team stop', async (t) => {
  let calls = 0;
  let activeSignal;
  const ui = await setup(t, (...args) => new Promise((resolve) => {
    calls++;
    activeSignal = args[3];
    activeSignal.addEventListener('abort', () => resolve({ text: 'Stopped.' }), { once: true });
  }));
  await ui.send('Active');
  await ui.send('Queued');
  const progress = ui.target.sent.find((message) => controls(message).some((item) => item.label === 'Stop all'));
  await ui.click(controls(progress).find((item) => item.label === 'Stop all').custom_id);
  assert.equal(activeSignal.aborted, true);
  assert.deepEqual(ui.stops, ['channel']);
  await tick();
  assert.equal(calls, 1);
  const queue = await ui.click('control:queue');
  assert.match(queue.response.content, /Queued: \*\*0\*\*/);
});

test('Usage opens All usage in the same private view without invoking live providers in the test', async (t) => {
  const ui = await setup(t, async () => ({ text: 'Done.' }));
  const registryFile = require('../src/agent-registry').REGISTRY_FILE;
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => file === registryFile
    ? JSON.stringify({ test: { id: 'bot', pid: process.pid, providerId: 'codex', name: 'Test Bot' } }) : read(file, ...args));
  const providerFile = require.resolve('../src/providers/codex');
  const original = require(providerFile);
  let calls = 0;
  require.cache[providerFile].exports = () => ({ usage: async () => {
    calls++;
    return { plan: 'Test plan', sections: [{ name: 'Limits', buckets: [{ label: '5h', left: 80 }] }] };
  } });
  t.after(() => { require.cache[providerFile].exports = original; });
  const usage = await ui.click('control:usage');
  assert.equal(usage.response.embeds[0].toJSON().title, 'Test Bot · Plan usage');
  const privateMessage = { flags: { has: () => true } };
  const all = await ui.click(controls(usage.response).find((item) => item.label === 'All usage').custom_id,
    { message: privateMessage });
  assert.equal(all.deferred, true);
  assert.equal(all.replied, undefined);
  assert.equal(calls, 1);
  assert.equal(all.response.embeds[0].toJSON().title, 'Test Bot · Plan usage');
  const back = await ui.click(controls(all.response).find((item) => item.label === 'This agent').custom_id,
    { message: privateMessage });
  assert.equal(back.response.content, '');
  assert.equal(controls(back.response)[0].label, 'All usage');
});

test('All usage remains accessible when this agent’s usage cannot be read', async (t) => {
  const ui = await setup(t, async () => ({ text: 'Done.' }), {
    getUsage: async () => { throw new Error('Usage unavailable'); },
  });
  const usage = await ui.click('control:usage');
  assert.match(usage.response.content, /Could not read usage: Usage unavailable/);
  assert.deepEqual(usage.response.embeds, []);
  assert.equal(controls(usage.response)[0].custom_id, 'control:usage-all');
});

test('panel entry points are private and dismissible, including legacy posting controls', async (t) => {
  const ui = await setup(t, async () => ({ text: 'Done.' }));
  const opened = await ui.click('control:panel');
  assert.equal(opened.response.flags, require('discord.js').MessageFlags.Ephemeral);
  const posted = await ui.click('control:post-panel');
  assert.equal(posted.response.flags, require('discord.js').MessageFlags.Ephemeral);
  const legacyMenu = await ui.click('', { kind: 'context', commandName: 'Panel' });
  assert.equal(legacyMenu.response.flags, require('discord.js').MessageFlags.Ephemeral);
  assert.match(opened.response.content, /private panel you can dismiss/);
  assert.doesNotMatch(opened.response.content, /pin this panel/);
  assert.deepEqual(controls(posted.response).map((item) => item.label),
    ['Agent settings', 'Model', 'Usage', 'New conversation', 'Resume', 'Rename']);
  for (const label of ['Queue', 'Stop', 'Stop all', 'Post panel to channel', 'Refresh panel', 'Completion alerts', 'Debate settings', 'All usage']) {
    assert.ok(!controls(posted.response).some((item) => item.label === label));
  }
  const refreshed = await ui.click('control:refresh-panel');
  assert.ok(controls(refreshed.response).some((item) => item.label === 'Rename'));
});
