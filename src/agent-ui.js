const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { debateSetting, promptSetting, agentNameSetting, historySetting, permissionSetting, idleSetting } = require('./agent-settings');

function preview(value, length = 140) {
  const line = String(value || '').replace(/\s+/g, ' ').trim();
  return line ? `“${line.slice(0, length)}${line.length > length ? '…' : ''}”` : '(none)';
}

function button(id, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}

function agentSummary({ settings, guildId, channelId, channelName, botKey, name, defaultName, discordUsername, providerId,
  allowedUserIds = [], historyFallback, workdir, permissionFallback, tokenConfigured }) {
  const prompt = promptSetting(settings, guildId, channelId, botKey);
  const botName = agentNameSetting(settings, botKey, defaultName || name);
  const idle = idleSetting(settings, botKey, providerId);
  const history = historySetting(settings, guildId, channelId, botKey, historyFallback);
  const permission = permissionSetting(settings, botKey, permissionFallback);
  const users = allowedUserIds.length
    ? `${allowedUserIds.slice(0, 5).map((id) => `<@${id}>`).join(', ')}${allowedUserIds.length > 5 ? ` and ${allowedUserIds.length - 5} more` : ''}`
    : 'Anyone';
  const folder = String(workdir || '').replace(/`/g, '\\`').slice(0, 250);
  return [
    `**${name} settings · #${channelName}**`,
    `Bot name (all servers and DMs): ${preview(botName.name, 32)} (${botName.source})`,
    `Discord username: ${preview(discordUsername || '', 32)}`,
    `Recent messages: **${history.limit}** (${history.source === 'channel' ? 'channel setting' : 'bot default'}; max 8,000 characters)`,
    `Channel prompt: ${preview(prompt.channelText)}`,
    `Server prompt: ${preview(prompt.serverText)}`,
    `Idle: **${idle.enabled ? 'ON' : 'OFF'}** · ${idle.minutes} min`,
    '',
    '**Agent access**',
    `Allowed users: ${users}`,
    `Workspace: ${folder ? `\`${folder}\`` : '(none)'}`,
    `File access: **${permission.mode}** (${permission.source === 'discord' ? 'Discord setting' : 'bot default'})`,
    `Discord token: ${tokenConfigured ? 'Configured (hidden)' : 'Not configured'}`,
  ].join('\n');
}

function agentSettingsView(args) {
  const base = (action) => `agent:${action}:${args.requester}`;
  const permission = permissionSetting(args.settings, args.botKey, args.permissionFallback);
  const botName = agentNameSetting(args.settings, args.botKey, args.defaultName || args.name);
  const permissionMenu = new StringSelectMenuBuilder().setCustomId(base('permission-select'))
    .setPlaceholder('Change file access')
    .addOptions(
      { label: 'Use bot default', value: 'default', description: 'Follow PERMISSIONS in the bot config', default: permission.source === 'default' },
      { label: 'Read-only', value: 'read-only', description: 'Use the provider’s restricted read mode', default: permission.source === 'discord' && permission.mode === 'read-only' },
      { label: 'Edit', value: 'edit', description: 'Edit workspace files', default: permission.source === 'discord' && permission.mode === 'edit' },
      { label: 'Full', value: 'full', description: 'Unrestricted file and command access', default: permission.source === 'discord' && permission.mode === 'full' },
    );
  return {
    content: agentSummary(args),
    components: [
      new ActionRowBuilder().addComponents(
        button(base('name-edit'), 'Edit bot name', ButtonStyle.Primary).setDisabled(!args.allowedUserIds?.length),
        button(base('name-reset'), 'Use default name').setDisabled(botName.source === 'provider default' || !args.allowedUserIds?.length),
        button(base('prompt-server'), 'Edit server prompt', ButtonStyle.Primary),
        button(base('prompt-channel'), 'Edit channel prompt', ButtonStyle.Primary),
      ),
      new ActionRowBuilder().addComponents(
        button(base('history-set'), 'Set history limit'),
        button(base('idle-toggle'), `Idle ${idleSetting(args.settings, args.botKey, args.providerId).enabled ? 'OFF' : 'ON'}`),
        button(base('idle-set'), 'Set idle time'),
      ),
      new ActionRowBuilder().addComponents(permissionMenu),
    ],
    allowedMentions: { parse: [] },
  };
}

function debateSummary({ settings, guildId, channelId, channelName, active, peerCount }) {
  const debate = debateSetting(settings, guildId, channelId);
  const availability = debate.enabled && !active ? `\nAvailable peer agents: ${peerCount || 0}` : '';
  return `**#${channelName} Debate settings**\nDebate: **${debate.enabled ? 'ON' : 'OFF'}** (${debate.source === 'default' ? 'default' : 'channel setting'})${availability}\nMaximum agent turns: **${debate.maxTurns}**\nAn agent continues the debate by tagging an available peer with @name.`;
}

function debateSettingsView(args) {
  const debate = debateSetting(args.settings, args.guildId, args.channelId);
  const base = (action) => `debate:${action}:${args.requester}`;
  return {
    content: debateSummary(args),
    components: [
      new ActionRowBuilder().addComponents(
        button(base('on'), 'Debate ON', debate.enabled ? ButtonStyle.Primary : ButtonStyle.Secondary),
        button(base('off'), 'Debate OFF', !debate.enabled ? ButtonStyle.Primary : ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        button(base('turns'), 'Set turn limit'),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

module.exports = { agentSettingsView, debateSettingsView, preview };
