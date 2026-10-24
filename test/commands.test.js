const test = require('node:test');
const assert = require('node:assert/strict');
const { ApplicationCommandType } = require('discord.js');
const { commandDefinitions, LEGACY_SLASH_COMMANDS, isManagedCommand } = require('../src/commands');
const { controlComponents } = require('../src/task-ui');

test('panel is the only slash command and Ask remains in the message menu', () => {
  assert.deepEqual(commandDefinitions(), [
    { name: 'panel', description: 'Open this bot’s control panel', type: ApplicationCommandType.ChatInput },
    { name: 'Ask', type: ApplicationCommandType.Message },
  ]);
});

test('the main panel keeps settings, model, usage, and conversation shortcuts in two rows', () => {
  const ids = new Set(controlComponents()
    .flatMap((row) => row.toJSON().components.map((component) => component.custom_id)));
  assert.deepEqual(ids, new Set(['control:settings', 'control:model', 'control:usage',
    'control:new', 'control:resume', 'control:rename']));
  assert.equal(controlComponents().length, 2);
  assert.ok(controlComponents().every((row) => row.toJSON().components.length <= 5));
});

test('registration recognizes retired commands for removal without claiming unrelated commands', () => {
  for (const name of LEGACY_SLASH_COMMANDS) assert.equal(isManagedCommand({ name, type: ApplicationCommandType.ChatInput }), true);
  assert.equal(isManagedCommand({ name: 'Panel', type: ApplicationCommandType.Message }), true);
  assert.equal(isManagedCommand({ name: 'ban', type: ApplicationCommandType.ChatInput }), false);
  assert.equal(isManagedCommand({ name: 'Other menu', type: ApplicationCommandType.Message }), false);
});
