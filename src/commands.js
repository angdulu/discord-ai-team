const { ApplicationCommandType, ApplicationCommandOptionType } = require('discord.js');

function commandDefinitions() {
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
    {
      name: 'agent', description: 'View or edit this agent’s settings', type: ApplicationCommandType.ChatInput,
      options: [
        { name: 'settings', description: 'Edit this agent’s name, prompts, and idle time', type: ApplicationCommandOptionType.Subcommand },
      ],
    },
    {
      name: 'debate', description: 'View or edit debate settings for this channel', type: ApplicationCommandType.ChatInput,
      options: [
        { name: 'settings', description: 'Edit debate settings for this channel', type: ApplicationCommandOptionType.Subcommand },
      ],
    },
    { name: 'Ask', type: ApplicationCommandType.Message },
  ];
  return commands;
}

module.exports = { commandDefinitions };
