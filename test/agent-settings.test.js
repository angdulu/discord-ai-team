const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readSettings, updateSettings, guildSettings, channelSettings,
  debateSetting, promptSetting, agentNameSetting, historySetting, permissionSetting, idleSetting,
} = require('../src/agent-settings');
const { agentSettingsView, debateSettingsView } = require('../src/agent-ui');

test('channel debate defaults to ON with four turns, while prompts compose by scope', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-settings-'));
  const file = path.join(directory, 'settings.json');
  try {
    assert.deepEqual(debateSetting(readSettings(file), 'guild', 'channel'),
      { enabled: true, source: 'default', maxTurns: 4 });
    await updateSettings((settings) => {
      const guild = guildSettings(settings, 'guild');
      guild.agents = { cody: { prompt: { text: 'Server instruction' } } };
      const channel = channelSettings(settings, 'guild', 'channel');
      channel.debate = { enabled: true, maxTurns: 7 };
      channel.agents = { cody: { prompt: { text: 'Channel instruction' } } };
      settings.idle = { cody: { enabled: true, minutes: 30 } };
    }, file);
    const settings = readSettings(file);
    assert.deepEqual(debateSetting(settings, 'guild', 'channel'),
      { enabled: true, source: 'channel', maxTurns: 7 });
    assert.deepEqual(debateSetting(settings, 'guild', 'other'),
      { enabled: true, source: 'default', maxTurns: 4 });
    assert.deepEqual(promptSetting(settings, 'guild', 'channel', 'cody').text, 'Server instruction\n\nChannel instruction');
    assert.deepEqual(promptSetting(settings, 'guild', 'other', 'cody').text, 'Server instruction');
    assert.deepEqual(historySetting(settings, 'guild', 'channel', 'cody', 30),
      { limit: 30, source: 'default' });
    assert.deepEqual(permissionSetting(settings, 'cody', 'full'), { mode: 'full', source: 'default' });
    assert.deepEqual(idleSetting(settings, 'cody', 'claude').minutes, 30);
    assert.equal(idleSetting(settings, 'cody', 'claude').enabled, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('simultaneous settings updates keep every change', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-settings-'));
  const file = path.join(directory, 'settings.json');
  try {
    await Promise.all(Array.from({ length: 15 }, (_, index) => updateSettings((settings) => {
      settings.values ||= {};
      settings.values[index] = true;
    }, file)));
    assert.equal(Object.keys(readSettings(file).values).length, 15);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('bot name uses the provider default until this agent has a saved name', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-name-'));
  const file = path.join(directory, 'settings.json');
  try {
    assert.deepEqual(agentNameSetting(readSettings(file), 'cody', 'ChatGPTbot'),
      { name: 'ChatGPTbot', source: 'provider default' });
    await updateSettings((settings) => {
      settings.agentNames = { cody: { name: 'Cody' } };
    }, file);
    const settings = readSettings(file);
    assert.deepEqual(agentNameSetting(settings, 'cody', 'ChatGPTbot'), { name: 'Cody', source: 'custom' });
    assert.equal(agentNameSetting(settings, 'minnie', 'Geminibot').name, 'Geminibot');
    await updateSettings((value) => { delete value.agentNames.cody; }, file);
    assert.equal(agentNameSetting(readSettings(file), 'cody', 'ChatGPTbot').name, 'ChatGPTbot');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('agent and debate panels show their own settings and controls', () => {
  const settings = { agentNames: { cody: { name: 'Cody' } }, guilds: { guild: { agents: {
    cody: { prompt: { text: 'Check every claim' } },
  }, channels: { channel: { debate: { enabled: true, maxTurns: 8 }, agents: {
    cody: { prompt: { text: 'Cite sources' } },
  } } } } }, idle: { cody: { enabled: true, minutes: 20 } } };
  const args = { settings, guildId: 'guild', channelId: 'channel', channelName: 'review',
    botKey: 'cody', name: 'Cody', defaultName: 'Claudebot', discordUsername: 'Cody', providerId: 'claude', requester: 'user',
    allowedUserIds: ['123456789012345678'], workdir: '/workspace', permissionFallback: 'full', tokenConfigured: true };
  const panel = agentSettingsView(args);
  assert.match(panel.content, /Bot name \(all servers and DMs\): “Cody” \(custom\)/);
  assert.match(panel.content, /Discord username: “Cody”/);
  assert.doesNotMatch(panel.content, /Base prompt/);
  assert.match(panel.content, /Server prompt: “Check every claim”/);
  assert.match(panel.content, /Channel prompt: “Cite sources”/);
  assert.doesNotMatch(panel.content, /Channel replies/);
  assert.match(panel.content, /Recent messages: \*\*20\*\*/);
  assert.match(panel.content, /Allowed users: <@123456789012345678>/);
  assert.match(panel.content, /Workspace: `\/workspace`/);
  assert.match(panel.content, /File access: \*\*full\*\* \(bot default\)/);
  assert.match(panel.content, /Discord token: Configured \(hidden\)/);
  assert.doesNotMatch(panel.content, /read.only information|읽기 전용/);
  assert.equal(panel.components.length, 3);
  assert.deepEqual(panel.components[0].components.map((component) => component.data.label),
    ['Edit bot name', 'Use default name', 'Edit server prompt', 'Edit channel prompt']);
  assert.equal(panel.components[0].components[1].data.disabled, false);
  assert.deepEqual(panel.components[1].components.map((component) => component.data.label),
    ['Set history limit', 'Idle OFF', 'Set idle time']);
  assert.deepEqual(panel.components[2].components[0].options.map((option) => option.data.label),
    ['Use bot default', 'Read-only', 'Edit', 'Full']);
  const debate = debateSettingsView({ ...args, active: true });
  assert.match(debate.content, /Debate: \*\*ON\*\*/);
  assert.match(debate.content, /Maximum agent turns: \*\*8\*\*/);
  assert.deepEqual(debate.components.flatMap((row) => row.components.map((item) => item.data.label)),
    ['Debate ON', 'Debate OFF', 'Set turn limit']);
});

test('old response settings do not appear in the panel or affect history settings', () => {
  const settings = { guilds: { guild: { channels: { review: { agents: {
    cody: { response: { enabled: false }, historyLimit: 12 },
  } } } } } };
  assert.deepEqual(historySetting(settings, 'guild', 'review', 'cody', 20),
    { limit: 12, source: 'channel' });
  assert.deepEqual(historySetting(settings, 'guild', 'review', 'minnie', 20),
    { limit: 20, source: 'default' });
  const panel = agentSettingsView({ settings, guildId: 'guild', channelId: 'review', channelName: 'review',
    botKey: 'minnie', name: 'Minnie', providerId: 'gemini', requester: 'user',
    allowedChannelIds: ['another-channel'] });
  assert.doesNotMatch(panel.content, /Channel replies|Replies ON|Replies OFF/);
  assert.deepEqual(panel.components[1].components.map((component) => component.data.label),
    ['Set history limit', 'Idle OFF', 'Set idle time']);
});

test('Discord file access overrides are agent-wide and can return to the bot default', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-permissions-'));
  const file = path.join(directory, 'settings.json');
  try {
    await updateSettings((settings) => {
      settings.permissions = { claire: { mode: 'read-only' } };
    }, file);
    assert.deepEqual(permissionSetting(readSettings(file), 'claire', 'full'),
      { mode: 'read-only', source: 'discord' });
    assert.deepEqual(permissionSetting(readSettings(file), 'cody', 'edit'),
      { mode: 'edit', source: 'default' });
    await updateSettings((settings) => { delete settings.permissions.claire; }, file);
    assert.deepEqual(permissionSetting(readSettings(file), 'claire', 'full'),
      { mode: 'full', source: 'default' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('channel OFF overrides the ON default; legacy automatic mode uses the default', () => {
  const settings = { guilds: { guild: { debate: { mode: 'off' }, channels: {
    automatic: { debate: { mode: 'auto' } },
    explicit: { debate: { mode: 'on' } },
    disabled: { debate: { enabled: false } },
  } } } };
  assert.deepEqual(debateSetting(settings, 'guild', 'automatic'),
    { enabled: true, source: 'default', maxTurns: 4 });
  assert.equal(debateSetting(settings, 'guild', 'unknown').enabled, true);
  assert.equal(debateSetting(settings, 'guild', 'explicit').enabled, true);
  assert.deepEqual(debateSetting(settings, 'guild', 'disabled'),
    { enabled: false, source: 'channel', maxTurns: 4 });
  const panel = debateSettingsView({ settings, guildId: 'guild', channelId: 'unknown',
    channelName: 'general', requester: 'user', active: false, peerCount: 0 });
  assert.match(panel.content, /Debate: \*\*ON\*\* \(default\)/);
});
