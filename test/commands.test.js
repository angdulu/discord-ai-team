const test = require('node:test');
const assert = require('node:assert/strict');
const { ApplicationCommandType } = require('discord.js');
const { commandDefinitions } = require('../src/commands');

test('every management action is a slash command and each bot has a message menu', () => {
  const commands = commandDefinitions('Claire');
  const slash = commands.filter((command) => command.type === ApplicationCommandType.ChatInput);
  assert.deepEqual(slash.map((command) => command.name),
    ['new', 'resume', 'rename', 'model', 'usage', 'usage-all', 'stop', 'stop-all']);
  assert.deepEqual(commands.filter((command) => command.type === ApplicationCommandType.Message).map((command) => command.name), ['Ask Claire']);
  assert.equal(new Set(commands.map((command) => `${command.type}:${command.name}`)).size, commands.length);
});

test('team commands can be left to another bot', () => {
  const names = commandDefinitions('Claire', { teamCommands: false }).map((command) => command.name);
  assert.ok(!names.includes('usage-all') && !names.includes('stop-all'));
  assert.ok(names.includes('usage') && names.includes('stop'));
});
