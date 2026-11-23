const { ApplicationCommandType } = require('discord.js');

// Keep these names recognizable so registration can safely remove our old commands.
const LEGACY_SLASH_COMMANDS = ['panel', 'new', 'resume', 'rename', 'model', 'usage', 'usage-all',
  'stop', 'stop-all', 'agent', 'debate'];
const LEGACY_MESSAGE_COMMANDS = ['Panel', 'Ask'];

function commandDefinitions() {
  return [
    { name: 'panel', description: 'Open this bot’s control panel', type: ApplicationCommandType.ChatInput },
  ];
}

function isManagedCommand(command) {
  return commandDefinitions().some((entry) => entry.type === command.type && entry.name === command.name) ||
    (command.type === ApplicationCommandType.Message && LEGACY_MESSAGE_COMMANDS.includes(command.name)) ||
    (command.type === ApplicationCommandType.ChatInput && LEGACY_SLASH_COMMANDS.includes(command.name));
}

module.exports = { commandDefinitions, LEGACY_SLASH_COMMANDS, LEGACY_MESSAGE_COMMANDS, isManagedCommand };
