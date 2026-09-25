const test = require('node:test');
const assert = require('node:assert/strict');
const { ApplicationCommandType } = require('discord.js');
const { commandDefinitions } = require('../src/commands');

test('every management action is a slash command and each bot has a message menu', () => {
  const commands = commandDefinitions();
  const slash = commands.filter((command) => command.type === ApplicationCommandType.ChatInput);
  assert.deepEqual(slash.map((command) => command.name),
    ['new', 'resume', 'rename', 'model', 'usage', 'usage-all', 'stop', 'stop-all', 'agent', 'debate']);
  assert.deepEqual(commands.filter((command) => command.type === ApplicationCommandType.Message).map((command) => command.name), ['Ask']);
  assert.equal(new Set(commands.map((command) => `${command.type}:${command.name}`)).size, commands.length);
  assert.deepEqual(commands.find((command) => command.name === 'agent').options.map((option) => option.name), ['settings']);
  assert.deepEqual(commands.find((command) => command.name === 'debate').options.map((option) => option.name), ['settings']);
});

test('team commands are registered on every bot', () => {
  const names = commandDefinitions().map((command) => command.name);
  assert.ok(names.includes('usage-all') && names.includes('stop-all') && names.includes('debate'));
});
