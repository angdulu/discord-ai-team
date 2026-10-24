const { ApplicationCommandType } = require('discord.js');

// Keep these names recognizable so registration can safely remove our old commands.
const LEGACY_SLASH_COMMANDS = ['panel', 'new', 'resume', 'rename', 'model', 'usage', 'usage-all',
  'stop', 'stop-all', 'agent', 'debate'];

function commandDefinitions() {
  const commands = [
    { name: 'panel', description: 'Open this bot’s control panel', type: ApplicationCommandType.ChatInput },
    { name: 'Ask', type: ApplicationCommandType.Message },
  ];
  return commands;
}

function isManagedCommand(command) {
  return commandDefinitions().some((entry) => entry.type === command.type && entry.name === command.name) ||
    (command.type === ApplicationCommandType.Message && command.name === 'Panel') ||
    (command.type === ApplicationCommandType.ChatInput && LEGACY_SLASH_COMMANDS.includes(command.name));
}

module.exports = { commandDefinitions, LEGACY_SLASH_COMMANDS, isManagedCommand };
