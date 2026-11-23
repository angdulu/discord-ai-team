const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readSettings, updateSettings, guildSettings, channelSettings,
  debateSetting, promptSetting, agentNameSetting, historySetting, permissionSetting, idleSetting, workerLimitSetting, maxWarmWorkers, autoParticipationSetting,
} = require('../src/agent-settings');
const { agentSettingsView, debateSettingsView } = require('../src/agent-ui');

function embedText(panel) {
  const data = panel.embeds?.[0]?.toJSON?.() || {};
  return [data.title, data.description, ...(data.fields || []).map((f) => `${f.name}: ${f.value}`), data.footer?.text]
    .filter(Boolean).join('\n');
}

test('shared channel prompts apply to every agent while server prompts remain agent-specific', () => {
  const settings = { guilds: { guild: { agents: { claude: { prompt: { text: 'Claude server role' } } },
    channels: { channel: { prompt: { text: 'Shared instructions' },
      agents: { claude: { prompt: { text: 'Legacy instructions' } } } } } } } };
  assert.equal(promptSetting(settings, 'guild', 'channel', 'claude').text, 'Claude server role\n\nShared instructions');
  assert.equal(promptSetting(settings, 'guild', 'channel', 'gemini').text, 'Shared instructions');
  assert.equal(promptSetting(settings, 'guild', 'elsewhere', 'gemini').text, '');
});

test('channel participation is shared by all agents, with legacy ON migrated and explicit OFF respected', () => {
  const channel = { agents: { claude: { autoParticipation: true }, codex: { autoParticipation: false } } };
  const settings = { guilds: { guild: { channels: { channel } } } };
  assert.equal(autoParticipationSetting({}, 'guild', 'channel'), false);
  assert.equal(autoParticipationSetting(settings, 'guild', 'other'), false);
  assert.equal(autoParticipationSetting(settings, 'guild', 'channel'), true);
  channel.autoParticipation = false;
  assert.equal(autoParticipationSetting(settings, 'guild', 'channel'), false);
  channel.autoParticipation = true;
  for (const botKey of ['claude', 'codex', 'gemini']) {
    const panel = agentSettingsView({ settings, guildId: 'guild', channelId: 'channel', channelName: 'test',
      botKey, name: botKey, providerId: botKey, requester: 'user', canManage: true });
    assert.match(embedText(panel), /Auto participation: \*\*ON\*\* \(all agents\)/);
  }
});

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

test('agent settings uses a tabbed embed layout (Channel, Agent, Runtime) with compact footer summary', () => {
  const settings = { agentNames: { cody: { name: 'Cody' } }, guilds: { guild: { agents: {
    cody: { prompt: { text: 'Check every claim' } },
  }, channels: { channel: { debate: { enabled: true, maxTurns: 8 }, agents: {
    cody: { prompt: { text: 'Cite sources' } },
  } } } } }, idle: { cody: { enabled: true, minutes: 20 } } };
  const args = { settings, guildId: 'guild', channelId: 'channel', channelName: 'review',
    botKey: 'cody', name: 'Cody', defaultName: 'Claudebot', discordUsername: 'Cody', providerId: 'claude', requester: 'user',
    allowedUserIds: ['123456789012345678'], workdir: '/workspace', permissionFallback: 'full', tokenConfigured: true,
    cliUpdate: { enabled: true, phase: 'idle', version: '2.1.330 (Claude Code)', checkedAt: 1795400000000 },
    canManage: true };

  // Channel tab (default)
  const channelPanel = agentSettingsView(args);
  assert.equal(channelPanel.content, '');
  const channelText = embedText(channelPanel);
  assert.match(channelText, /Cody · #review/);
  assert.match(channelText, /Recent messages: \*\*20\*\*/);
  assert.match(channelText, /Channel prompt \(all agents\): “Cite sources”/);
  assert.match(channelText, /Access: full · Idle: 20m · Workers: 8 · CLI 2\.1\.330/);
  assert.doesNotMatch(channelText, /Discord token|Applies to new messages/);
  assert.equal(channelPanel.components.length, 2);
  assert.deepEqual(channelPanel.components[0].components.map((c) => c.data.label), ['Channel', 'Agent', 'Runtime']);
  assert.deepEqual(channelPanel.components[1].components.map((c) => c.data.label),
    ['Channel prompt', 'Auto-reply: OFF', 'History limit', 'Alerts: OFF', 'Debate']);

  // Agent tab
  const agentTab = agentSettingsView({ ...args, tab: 'agent' });
  const agentText = embedText(agentTab);
  assert.match(agentText, /Bot name: “Cody” \(custom\)/);
  assert.match(agentText, /Server prompt: “Check every claim”/);
  assert.match(agentText, /Allowed users: <@123456789012345678>/);
  assert.match(agentText, /Workspace: `\/workspace`/);
  assert.match(agentText, /File access: \*\*full\*\* \(default\)/);
  assert.equal(agentTab.components.length, 3);
  assert.deepEqual(agentTab.components[1].components.map((c) => c.data.label), ['Edit name', 'Reset name', 'Server prompt']);
  assert.equal(agentTab.components[1].components[1].data.disabled, false);
  assert.deepEqual(agentTab.components[2].components[0].options.map((o) => o.data.label),
    ['Use bot default', 'Read-only', 'Edit', 'Full']);

  // Runtime tab
  const runtimeTab = agentSettingsView({ ...args, tab: 'runtime' });
  const runtimeText = embedText(runtimeTab);
  assert.match(runtimeText, /Idle shutdown: \*\*ON\*\* · 20 min/);
  assert.match(runtimeText, /Warm workers: \*\*8\*\* \(default\)/);
  assert.match(runtimeText, /Auto CLI updates: \*\*ON\*\* · 6h/);
  assert.equal(runtimeTab.components.length, 2);
  assert.deepEqual(runtimeTab.components[1].components.map((c) => c.data.label), ['Idle: ON', 'Idle time', 'Worker limit']);

  // Debate panel unchanged
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
    allowedChannelIds: ['another-channel'], canManage: true });
  assert.doesNotMatch(embedText(panel), /Channel replies|Replies ON|Replies OFF/);
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

test('warm worker limit defaults to 8, supports custom caps and unlimited, and is omitted for codex', () => {
  assert.deepEqual(workerLimitSetting({}, 'claude'), { limit: 8, source: 'default', changed: null });
  assert.equal(maxWarmWorkers({}, 'gemini'), 8);
  const settings = { maxWorkers: { claude: { limit: 12 }, gemini: { limit: null }, bad: { limit: -1 } } };
  assert.equal(maxWarmWorkers(settings, 'claude'), 12);
  assert.equal(workerLimitSetting(settings, 'claude').source, 'agent');
  assert.equal(maxWarmWorkers(settings, 'gemini'), null);
  assert.equal(workerLimitSetting(settings, 'gemini').source, 'agent');
  assert.equal(maxWarmWorkers(settings, 'bad'), 8);

  const geminiPanel = agentSettingsView({ settings, guildId: 'g', channelId: 'c', channelName: 'c',
    botKey: 'gemini', name: 'Geminibot', providerId: 'gemini', requester: 'user', canManage: true, tab: 'runtime' });
  assert.match(embedText(geminiPanel), /Warm workers: \*\*unlimited\*\* \(custom\)/);
  assert.ok(geminiPanel.components[1].components.some((c) => c.data.label === 'Worker limit'));

  const codexPanel = agentSettingsView({ settings, guildId: 'g', channelId: 'c', channelName: 'c',
    botKey: 'chatgpt', name: 'ChatGPTbot', providerId: 'codex', requester: 'user', canManage: true, tab: 'runtime' });
  assert.doesNotMatch(embedText(codexPanel), /Warm workers:/);
  assert.ok(!codexPanel.components[1].components.some((c) => c.data.label === 'Worker limit'));
});
