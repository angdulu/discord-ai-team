const test = require('node:test');
const assert = require('node:assert/strict');
const { ApplicationCommandType } = require('discord.js');
const { commandDefinitions, LEGACY_SLASH_COMMANDS, LEGACY_MESSAGE_COMMANDS, isManagedCommand } = require('../src/commands');
const { controlComponents } = require('../src/task-ui');

test('panel is the only registered command', () => {
  assert.deepEqual(commandDefinitions(), [
    { name: 'panel', description: 'Open this bot’s control panel', type: ApplicationCommandType.ChatInput },
  ]);
});

test('the main panel keeps settings, model, usage, and conversation shortcuts in two rows', () => {
  const publicIds = new Set(controlComponents()
    .flatMap((row) => row.toJSON().components.map((component) => component.custom_id)));
  assert.deepEqual(publicIds, new Set(['control:settings', 'control:model', 'control:usage',
    'control:new', 'control:resume', 'control:rename']));
  const ephemeralIds = new Set(controlComponents({ ephemeral: true })
    .flatMap((row) => row.toJSON().components.map((component) => component.custom_id)));
  assert.deepEqual(ephemeralIds, new Set(['control:settings', 'control:model', 'control:usage', 'control:post-panel',
    'control:new', 'control:resume', 'control:rename']));
  assert.equal(controlComponents().length, 2);
  assert.ok(controlComponents().every((row) => row.toJSON().components.length <= 5));
  assert.ok(controlComponents({ ephemeral: true }).every((row) => row.toJSON().components.length <= 5));
});

test('registration recognizes retired commands for removal without claiming unrelated commands', () => {
  for (const name of LEGACY_SLASH_COMMANDS) assert.equal(isManagedCommand({ name, type: ApplicationCommandType.ChatInput }), true);
  for (const name of LEGACY_MESSAGE_COMMANDS) assert.equal(isManagedCommand({ name, type: ApplicationCommandType.Message }), true);
  assert.equal(isManagedCommand({ name: 'ban', type: ApplicationCommandType.ChatInput }), false);
  assert.equal(isManagedCommand({ name: 'Other menu', type: ApplicationCommandType.Message }), false);
});
