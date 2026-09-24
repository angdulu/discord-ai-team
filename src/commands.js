const { ApplicationCommandType, ApplicationCommandOptionType } = require('discord.js');

const TEAM_COMMANDS = ['usage-all', 'stop-all'];

function commandDefinitions(name, { teamCommands = true } = {}) {
  const commands = [
    { name: 'new', description: 'Start a new conversation in this channel', type: ApplicationCommandType.ChatInput },
    { name: 'resume', description: 'Choose a previous conversation to continue here', type: ApplicationCommandType.ChatInput },
    {
      name: 'rename', description: 'Name a current or previous conversation', type: ApplicationCommandType.ChatInput,
      options: [
        { name: 'name', description: 'New conversation name', type: ApplicationCommandOptionType.String, required: true, max_length: 90 },
        { name: 'conversation', description: 'Leave empty to name the current conversation', type: ApplicationCommandOptionType.String, autocomplete: true },
      ],
    },
    { name: 'model', description: 'Choose the model and reasoning effort for this channel', type: ApplicationCommandType.ChatInput },
    { name: 'usage', description: 'Show this bot’s plan usage', type: ApplicationCommandType.ChatInput },
    { name: 'usage-all', description: 'Show plan usage for every running agent', type: ApplicationCommandType.ChatInput },
    { name: 'stop', description: 'Stop this bot in this channel', type: ApplicationCommandType.ChatInput },
    { name: 'stop-all', description: 'Stop every agent in this channel', type: ApplicationCommandType.ChatInput },
    { name: `Ask ${name}`.slice(0, 32), type: ApplicationCommandType.Message },
  ];
  // /usage-all and /stop-all act on every agent, so one bot registering them is enough.
  return teamCommands ? commands : commands.filter((command) => !TEAM_COMMANDS.includes(command.name));
}

module.exports = { commandDefinitions };
