const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } = require('discord.js');
const { debateSetting, promptSetting, agentNameSetting, historySetting, permissionSetting, idleSetting, workerLimitSetting, autoParticipationSetting } = require('./agent-settings');

const PROVIDER_COLORS = { claude: 0xd97757, gemini: 0x4285f4, codex: 0x10a37f };
const AGENT_TABS = ['channel', 'agent', 'runtime'];

function preview(value, length = 140) {
  const line = String(value || '').replace(/\s+/g, ' ').trim();
  return line ? `“${line.slice(0, length)}${line.length > length ? '…' : ''}”` : '(none)';
}

function button(id, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
}

function footerSummary({ settings, botKey, providerId, permissionFallback, cliUpdate }) {
  const permission = permissionSetting(settings, botKey, permissionFallback);
  const idle = idleSetting(settings, botKey, providerId);
  const workers = workerLimitSetting(settings, botKey);
  const parts = [
    `Access: ${permission.mode}`,
    `Idle: ${idle.enabled ? `${idle.minutes}m` : 'OFF'}`,
    ...(providerId !== 'codex' ? [`Workers: ${workers.limit === null ? 'unlimited' : workers.limit}`] : []),
    ...(cliUpdate?.version ? [`CLI ${String(cliUpdate.version).split(/\s+/)[0].slice(0, 24)}`] : []),
  ];
  return parts.join(' · ');
}

function agentSettingsView(args) {
  const { settings, guildId, channelId, channelName, botKey, name, defaultName, providerId,
    requester, allowedUserIds = [], historyFallback, workdir, permissionFallback, cliUpdate,
    canManage, completionAlerts } = args;
  const base = (action) => `agent:${action}:${requester}`;
  const color = PROVIDER_COLORS[providerId] ?? 0x5865f2;

  if (!canManage) {
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${name} settings · ${guildId ? '#' : ''}${channelName}`)
      .addFields({
        name: 'Completion alerts',
        value: `**${completionAlerts ? 'ON' : 'OFF'}** · Mentions you after tasks ≥ 1 min in this channel.`,
      });
    return {
      content: '',
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        button(base('notifications'), `Alerts: ${completionAlerts ? 'ON' : 'OFF'}`),
      )],
      allowedMentions: { parse: [] },
    };
  }

  const tab = AGENT_TABS.includes(args.tab) ? args.tab : 'channel';
  const tabsRow = new ActionRowBuilder().addComponents(
    button(base('tab-channel'), 'Channel', tab === 'channel' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    button(base('tab-agent'), 'Agent', tab === 'agent' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    button(base('tab-runtime'), 'Runtime', tab === 'runtime' ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  const footer = footerSummary(args);

  if (tab === 'agent') {
    const botName = agentNameSetting(settings, botKey, defaultName || name);
    const prompt = promptSetting(settings, guildId, channelId, botKey);
    const permission = permissionSetting(settings, botKey, permissionFallback);
    const users = allowedUserIds.length
      ? `${allowedUserIds.slice(0, 5).map((id) => `<@${id}>`).join(', ')}${allowedUserIds.length > 5 ? ` +${allowedUserIds.length - 5}` : ''}`
      : 'Anyone';
    const folder = String(workdir || '').replace(/`/g, '\\`').slice(0, 250);
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${name} · Agent`)
      .addFields(
        { name: 'Bot name', value: `${preview(botName.name, 32)} (${botName.source})`, inline: true },
        { name: 'File access', value: `**${permission.mode}** (${permission.source === 'discord' ? 'Discord' : 'default'})`, inline: true },
        { name: 'Allowed users', value: users, inline: true },
        { name: 'Workspace', value: folder ? `\`${folder}\`` : '(none)', inline: false },
        { name: 'Server prompt', value: preview(prompt.serverText, 240), inline: false },
      )
      .setFooter({ text: footer });
    const permissionMenu = new StringSelectMenuBuilder().setCustomId(base('permission-select'))
      .setPlaceholder('Change file access')
      .addOptions(
        { label: 'Use bot default', value: 'default', description: 'Follow PERMISSIONS in the bot config', default: permission.source === 'default' },
        { label: 'Read-only', value: 'read-only', description: 'Use the provider’s restricted read mode', default: permission.source === 'discord' && permission.mode === 'read-only' },
        { label: 'Edit', value: 'edit', description: 'Edit workspace files', default: permission.source === 'discord' && permission.mode === 'edit' },
        { label: 'Full', value: 'full', description: 'Unrestricted file and command access', default: permission.source === 'discord' && permission.mode === 'full' },
      );
    return {
      content: '',
      embeds: [embed],
      components: [
        tabsRow,
        new ActionRowBuilder().addComponents(
          button(base('name-edit'), 'Edit name').setDisabled(!allowedUserIds.length),
          button(base('name-reset'), 'Reset name').setDisabled(botName.source === 'provider default' || !allowedUserIds.length),
          button(base('prompt-server'), 'Server prompt'),
        ),
        new ActionRowBuilder().addComponents(permissionMenu),
      ],
      allowedMentions: { parse: [] },
    };
  }

  if (tab === 'runtime') {
    const idle = idleSetting(settings, botKey, providerId);
    const workers = workerLimitSetting(settings, botKey);
    const fields = [
      { name: 'Idle shutdown', value: `**${idle.enabled ? 'ON' : 'OFF'}** · ${idle.minutes} min`, inline: true },
      ...(providerId !== 'codex' ? [{
        name: 'Warm workers',
        value: `**${workers.limit === null ? 'unlimited' : workers.limit}** (${workers.source === 'agent' ? 'custom' : 'default'})`,
        inline: true,
      }] : []),
      ...(cliUpdate ? [
        { name: 'Auto CLI updates', value: `**${cliUpdate.enabled ? 'ON' : 'OFF'}**${cliUpdate.phase === 'updating' ? ' · Updating' : cliUpdate.enabled ? ' · 6h' : ''}`, inline: true },
        { name: 'CLI version', value: preview(cliUpdate.version, 70), inline: true },
        { name: 'Last check', value: cliUpdate.checkedAt ? `<t:${Math.floor(cliUpdate.checkedAt / 1000)}:R>` : 'Not checked yet', inline: true },
        ...(cliUpdate.error ? [{ name: 'Update error', value: preview(cliUpdate.error, 180), inline: false }] : []),
      ] : []),
    ];
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${name} · Runtime`)
      .addFields(fields)
      .setFooter({ text: footer });
    return {
      content: '',
      embeds: [embed],
      components: [
        tabsRow,
        new ActionRowBuilder().addComponents(
          button(base('idle-toggle'), `Idle: ${idle.enabled ? 'ON' : 'OFF'}`),
          button(base('idle-set'), 'Idle time'),
          ...(providerId !== 'codex' ? [button(base('workers-set'), 'Worker limit')] : []),
        ),
      ],
      allowedMentions: { parse: [] },
    };
  }

  // Default: Channel tab
  const prompt = promptSetting(settings, guildId, channelId, botKey);
  const history = historySetting(settings, guildId, channelId, botKey, historyFallback);
  const autoPart = autoParticipationSetting(settings, guildId, channelId);
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${name} · #${channelName}`)
    .addFields(
      { name: 'Auto participation', value: `**${autoPart ? 'ON' : 'OFF'}** (all agents)`, inline: true },
      { name: 'Recent messages', value: `**${history.limit}** (${history.source === 'channel' ? 'channel' : 'default'})`, inline: true },
      { name: 'Completion alerts', value: `**${completionAlerts ? 'ON' : 'OFF'}** (tasks ≥ 1m)`, inline: true },
      { name: 'Channel prompt (all agents)', value: preview(prompt.channelText, 240), inline: false },
    )
    .setFooter({ text: footer });
  return {
    content: '',
    embeds: [embed],
    components: [
      tabsRow,
      new ActionRowBuilder().addComponents(
        button(base('prompt-channel'), 'Channel prompt'),
        button(base('participation-toggle'), `Auto-reply: ${autoPart ? 'ON' : 'OFF'}`),
        button(base('history-set'), 'History limit'),
        button(base('notifications'), `Alerts: ${completionAlerts ? 'ON' : 'OFF'}`),
        button('control:debate', 'Debate'),
      ),
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

module.exports = { agentSettingsView, debateSettingsView, preview, AGENT_TABS };
