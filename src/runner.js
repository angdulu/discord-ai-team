const fs = require('fs');
const { randomUUID } = require('crypto');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const { attachmentsForTurn, imageAttachments, documentAttachments, saveImageAttachments } = require('./attachments');
const { documentContext } = require('./documents');
const { rememberSession, renameSession, listResumableSessions, assignSession } = require('./session-history');
const { publishStop, watchStops } = require('./team-control');
const {
  readSettings, updateSettings, guildSettings, channelSettings, stamp,
  DEFAULT_DEBATE_TURNS, PERMISSION_MODES, debateSetting, promptSetting, agentNameSetting,
  historySetting, permissionSetting, idleSetting,
} = require('./agent-settings');
const { agentSettingsView, debateSettingsView } = require('./agent-ui');
const { debatePeerInstructions, resolveDebateHandoff } = require('./peer-mentions');
const { createCliMaintenance } = require('./cli-maintenance');
const { REGISTRY_FILE, createAgentRegistration } = require('./agent-registry');
const { panelView, taskComponents, inputModal, createTaskStore, queuePanel } = require('./task-ui');

const MAX_CHUNK = 1900;
const DEFAULT_MODEL_PREF = '_default';
const FORWARD_WAIT_MS = 500;
const TYPING_REFRESH_MS = 8000;
const DRAFT_REFRESH_MS = 2000;

// sessions, model choices and the shared bot registry live here (git-ignored)
const STATE_DIR = path.join(__dirname, '..', 'state');

// "4h 50m" / "6d 4h" until a reset time
function untilText(date) {
  const mins = Math.max(0, Math.round((new Date(date) - Date.now()) / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  return d ? `${d}d ${h}h` : `${h}h ${m}m`;
}

// usage: { plan, sections: [{ name, buckets: [{ label, left (0-100), resetsAt }] }], note }
function usageBar(left) {
  const filled = Math.round(Math.max(0, Math.min(100, left)) / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function usageEmbed(name, usage) {
  const all = usage.sections.flatMap((s) => s.buckets);
  const lowest = Math.min(...all.map((b) => b.left));
  const color = lowest >= 50 ? 0x57f287 : lowest >= 20 ? 0xfee75c : 0xed4245;
  const embed = new EmbedBuilder().setTitle(`${name} · Plan usage`).setDescription(usage.plan).setColor(color);
  for (const s of usage.sections) {
    const value = s.buckets
      .map((b) => {
        const resets = b.resetsText ? `resets ${b.resetsText}` : b.resetsAt ? `resets in ${untilText(b.resetsAt)}` : '';
        return `\`${b.label.padEnd(6)}\` ${usageBar(b.left)} **${Math.round(b.left)}%** left${resets ? ` · ${resets}` : ''}`;
      })
      .join('\n');
    embed.addFields({ name: s.name, value });
  }
  if (usage.note) embed.setFooter({ text: usage.note });
  return embed;
}

// bot turns in the chain since the last human message (consecutive messages by one bot = one turn);
// noticed: a bot already posted the limit notice in this chain (parallel branches can hit the limit twice)
const LIMIT_NOTICE = 'Agent-to-agent limit';
// latest: count the chain as it stands now (including messages after this one), for re-checking a queued turn
async function botTurnsSinceHuman(message, { latest = false } = {}) {
  let fetched;
  try {
    fetched = await message.channel.messages.fetch(latest ? { limit: 100 } : { limit: 100, before: message.id });
  } catch {
    return { turns: Infinity, noticed: true };
  }
  let turns = latest ? 0 : 1;
  let noticed = false;
  let lastAuthor = latest ? null : message.author.id;
  for (const m of fetched.values()) { // newest first
    if (!m.author.bot) {
      return { turns, noticed };
    }
    if (m.content.includes(LIMIT_NOTICE)) {
      noticed = true;
      continue;
    }
    if (m.author.id !== lastAuthor) {
      turns++;
      lastAuthor = m.author.id;
    }
  }
  return { turns, noticed };
}

function canDebate(channel, member) {
  const permissions = channel.permissionsFor(member);
  return permissions && permissions.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
}

function isPrivateChannel(channel) {
  const everyone = channel.guild?.roles.everyone;
  return Boolean(everyone && channel.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel) === false);
}

function shouldAutoReply({ isDM, authorIsBot, mentioned, mentionsOtherBot, privateChannel, peerCount }) {
  return !isDM && !authorIsBot && !mentioned && !mentionsOtherBot && privateChannel && peerCount === 0;
}

function shouldHandleMessageUpdate(before, after, self) {
  if (!after.author || after.author.bot || !after.editedTimestamp) return false;
  if (!before.partial && before.content === after.content) return false;
  if (!after.guild) return true;
  if (after.mentions.has(self) && (before.partial || !before.mentions.has(self))) return true;
  return isPrivateChannel(after.channel);
}

function isRunningAgent(agent) {
  if (!agent || !agent.id || !Number.isInteger(agent.pid) || agent.pid <= 0) return false;
  try {
    process.kill(agent.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function manualDebatePeers(channel, selfId, botKey) {
  if (!channel.guild) return [];
  const self = await channel.guild.members.fetch(selfId).catch(() => null);
  if (!self || !canDebate(channel, self)) return [];
  const candidates = Object.entries(loadJson(REGISTRY_FILE))
    .filter(([key, agent]) => key !== botKey && isRunningAgent(agent) &&
      (!agent.allowedChannelIds?.length || agent.allowedChannelIds.includes(channel.id)))
    .map(([, agent]) => agent);
  const peers = await Promise.all(candidates.map(async (agent) => {
    const member = await channel.guild.members.fetch(agent.id).catch(() => null);
    return member && canDebate(channel, member)
      ? { ...agent, displayName: member.displayName, username: member.user.username } : null;
  }));
  return peers.filter(Boolean);
}

const FORWARD_TTL_MS = 2 * 60 * 1000;

// <@123> → @Name, so the model sees who is addressed (and "(you)" for itself) instead of raw ids
function readableMentions(content, message, selfId) {
  let out = content;
  for (const user of message.mentions.users.values()) {
    const member = message.mentions.members && message.mentions.members.get(user.id);
    const label = user.id === selfId ? `@${(member && member.displayName) || user.username} (you)` : `@${(member && member.displayName) || user.username}`;
    out = out.replace(new RegExp(`<@!?${user.id}>`, 'g'), label);
  }
  return out;
}

const HISTORY_MAX_CHARS = 8000;
const HANDOFF_POLL_MS = 3000;
const HANDOFF_TIMEOUT_MS = 3 * 60 * 1000;

function mentionPos(content, userId) {
  return content.search(new RegExp(`<@!?${userId}>`));
}

// "@A do X, then @B do Y": B waits for the bots mentioned before it and gets their replies as input.
// Mentions with nothing but "and"/commas between them ("@A @B do X") address the group, so nobody waits.
const GROUP_GAP = /^[\s,&/+]*(and|or|와|과|랑|하고)?[\s,&/+]*$/i;
function earlierMentionedBots(message, myId) {
  if (message.contextCommand) return [];
  const content = message.content;
  const myPos = mentionPos(content, myId);
  return [...message.mentions.users.values()]
    .filter((u) => u.bot && u.id !== myId)
    .filter((u) => {
      const pos = mentionPos(content, u.id);
      if (pos < 0 || pos >= myPos) return false;
      const gap = content.slice(content.indexOf('>', pos) + 1, myPos).replace(/<@!?\d+>/g, ' ');
      return !GROUP_GAP.test(gap);
    })
    .map((u) => u.id);
}

async function waitForReplies(message, botIds, isCancelled) {
  const repliesAfter = async () => {
    const fetched = await message.channel.messages.fetch({ after: message.id, limit: 50 });
    return [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  };
  const deadline = Date.now() + HANDOFF_TIMEOUT_MS;
  while (Date.now() < deadline && !isCancelled()) {
    let msgs;
    try {
      msgs = await repliesAfter();
    } catch {
      return '';
    }
    const replied = new Set(msgs.map((m) => m.author.id));
    if (botIds.every((id) => replied.has(id))) {
      await new Promise((r) => setTimeout(r, HANDOFF_POLL_MS)); // let multi-part replies finish posting
      msgs = await repliesAfter().catch(() => msgs);
      return msgs
        .filter((m) => botIds.includes(m.author.id) && m.content)
        .map((m) => `${(m.member && m.member.displayName) || m.author.username}: ${m.content.slice(0, 4000)}`)
        .join('\n\n');
    }
    await new Promise((r) => setTimeout(r, HANDOFF_POLL_MS));
  }
  return '';
}

// messages in the channel since this bot last spoke (other bots included), oldest first,
// so it can see what the other agents said in between; its own earlier turns are already in its session
async function recentHistory(message, botId, limit) {
  let fetched;
  try {
    fetched = await message.channel.messages.fetch({ limit: Math.min(limit, 100), before: message.id });
  } catch {
    return '';
  }
  const lines = [];
  for (const m of fetched.values()) { // newest first
    if (m.author.id === botId) break;
    const text = [readableMentions(m.content, m, botId), forwardedText(m)].filter(Boolean).join('\n');
    if (!text) continue;
    const who = (m.member && m.member.displayName) || m.author.username;
    lines.unshift(`${who}${m.author.bot ? ' (bot)' : ''}: ${text.slice(0, 2000)}`);
  }
  let out = lines.join('\n\n');
  if (out.length > HISTORY_MAX_CHARS) out = '…' + out.slice(-HISTORY_MAX_CHARS);
  return out;
}

function forwardedText(message) {
  if (!message.messageSnapshots || !message.messageSnapshots.size) return '';
  return message.messageSnapshots
    .map((s) => s.content || '')
    .filter(Boolean)
    .join('\n\n');
}

// channelId -> CLI conversation id, persisted so context survives bot restarts
function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function trackedChannelGuilds(known, settings) {
  const tracked = { ...known };
  for (const [guildId, guild] of Object.entries(settings.guilds || {})) {
    for (const channelId of Object.keys(guild.channels || {})) tracked[channelId] = guildId;
  }
  return tracked;
}

async function reconcileDeletedChannels(client, tracked, legacyIds, remember, forget) {
  for (const id of new Set([...Object.keys(tracked), ...legacyIds])) {
    const guildId = tracked[id];
    const guild = guildId && client.guilds.cache.get(guildId);
    if (guildId && (!guild || guild.available === false)) continue;
    try {
      const channel = await client.channels.fetch(id, { force: true, cache: false });
      if (channel?.guildId && client.guilds.cache.has(channel.guildId)) remember(id, channel.guildId);
    } catch (error) {
      if (error.code === 10003) {
        if (guild && !guild.channels?.cache?.has(id)) await forget({ id, guild });
      } else if (error.code !== 50001 && error.code !== 50013) {
        console.error(`Could not verify channel ${id}:`, error);
      }
    }
  }
}

// models: [{ key, label, efforts: [..] | null, id: (effort) => modelId }]
function resolvePref(models, pref) {
  const model = models.find((m) => m.key === pref.model) || models[0];
  let effort = null;
  if (model.efforts) {
    const fallback = model.defaultEffort || model.efforts[model.efforts.length - 1];
    effort = model.efforts.includes(pref.effort) ? pref.effort : fallback;
  }
  return { model, effort, modelId: model.id(effort) };
}

function modelPrefForChannel(prefs, channelId) {
  return prefs[channelId] || prefs[DEFAULT_MODEL_PREF] || {};
}

function saveModelPref(prefs, channelId, pref) {
  prefs[channelId] = { ...pref };
  prefs[DEFAULT_MODEL_PREF] = { ...pref };
}

function modelPanel(key, name, models, pref, page) {
  const { model, effort, modelId } = resolvePref(models, pref);
  const displayId = model.displayId ? model.displayId(effort) : modelId;
  const pages = Math.ceil(models.length / 25);
  const index = Math.min(Math.max(0, page ?? Math.floor(models.indexOf(model) / 25)), pages - 1);
  const modelMenu = new StringSelectMenuBuilder()
    .setCustomId(`${key}:model:${index}`)
    .setPlaceholder('Select model')
    .addOptions(models.slice(index * 25, (index + 1) * 25)
      .map((m) => ({ label: m.label.slice(0, 100), value: m.key, default: m.key === model.key })));
  const effortMenu = new StringSelectMenuBuilder().setCustomId(`${key}:effort:${index}`);
  if (model.efforts) {
    effortMenu
      .setPlaceholder('Select effort')
      .addOptions(model.efforts.map((e) => ({ label: `effort: ${e}`, value: e, default: e === effort })));
  } else {
    effortMenu
      .setPlaceholder('No effort options for this model')
      .addOptions([{ label: 'effort: fixed', value: 'none' }])
      .setDisabled(true);
  }
  const components = [
    new ActionRowBuilder().addComponents(modelMenu),
    new ActionRowBuilder().addComponents(effortMenu),
  ];
  if (pages > 1) components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${key}:model-page:${index - 1}`).setLabel('Previous')
      .setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId(`${key}:model-page:${index + 1}`).setLabel(`Next (${index + 1}/${pages})`)
      .setStyle(ButtonStyle.Secondary).setDisabled(index === pages - 1),
  ));
  return {
    content: `[${name}] Current model: **${model.label}**${effort ? ` · ${effort}` : ''} (\`${displayId}\`)\nChanges here also become the default for new channels.`,
    components,
  };
}

function resumePanel(botKey, name, channelId, userId, entries, currentId, page = 0, purpose = 'resume') {
  if (!entries.length) return { content: `[${name}] No previous Discord bot conversations to ${purpose}.`, components: [] };
  const pages = Math.ceil(entries.length / 25);
  const index = Math.min(Math.max(0, page), pages - 1);
  const choices = entries.slice(index * 25, (index + 1) * 25);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${botKey}:${purpose}:${channelId}:${userId}:${index}`)
    .setPlaceholder(`Select a conversation to ${purpose}`)
    .addOptions(choices.map((entry) => ({
      label: (entry.title || 'Previous conversation').slice(0, 100),
      description: `${entry.channelName ? `#${entry.channelName} · ` : ''}${entry.updatedAt ? new Date(entry.updatedAt).toLocaleString('en-US') : 'Date unknown'} · ${entry.id.slice(0, 8)}`.slice(0, 100),
      value: entry.id,
      default: entry.id === currentId,
    })));
  const components = [new ActionRowBuilder().addComponents(menu)];
  if (pages > 1) components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${botKey}:${purpose}-page:${channelId}:${userId}:${index - 1}`)
      .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId(`${botKey}:${purpose}-page:${channelId}:${userId}:${index + 1}`)
      .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(index === pages - 1),
  ));
  return { content: `[${name}] Select ${purpose === 'resume' ? 'a previous' : 'a'} Discord bot conversation to ${purpose}. (Page ${index + 1}/${pages})`, components };
}

// local file links ([note](file:///Users/you/...)) are useless in Discord and leak paths; keep the label
function cleanReply(text) {
  return text
    .replace(/\[\[([^\]]+)\]\]\(file:\/\/[^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(file:\/\/[^)]*\)/g, '$1')
    .replace(/file:\/\/\/?\S*\/([^/\s)]+)/g, '$1');
}

// Discord caps messages at 2000 chars: split at a line break (or a space) instead of mid-word
function replyChunks(text) {
  let rest = cleanReply(text);
  const chunks = [];
  while (rest.length > MAX_CHUNK) {
    let cut = rest.lastIndexOf('\n', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = rest.lastIndexOf(' ', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendChunked(message, text, draft, allowedMentions, components = []) {
  const chunks = replyChunks(text);
  for (const [index, chunk] of chunks.entries()) {
    const controls = index === chunks.length - 1 ? components : [];
    if (index === 0 && draft) {
      try {
        await draft.edit({ content: chunk, components: controls, allowedMentions: { parse: [] } });
      } catch {
        await draft.delete().catch(() => {});
        await message.channel.send({ content: chunk, components: controls, allowedMentions });
      }
    } else {
      await message.channel.send({ content: chunk, components: controls, allowedMentions });
    }
  }
}

async function sendTurnError(message, name, error, draft) {
  const detail = String(error.message || error).slice(0, 1800);
  const partial = typeof error.partialText === 'string' ? error.partialText.trim() : '';
  if (partial) {
    const reply = `${partial}\n\n⚠️ [${name}] Response interrupted; the text above may be incomplete.\n${detail}`;
    if (draft) await draft.finish(message, reply, { parse: [] });
    else await sendChunked(message, reply, undefined, { parse: [] });
  } else {
    if (draft) await draft.cancel();
    await message.channel.send(`[${name}] Error: ${detail}`);
  }
}

function startTyping(channel) {
  let active = true;
  let sending = false;
  async function refresh() {
    if (!active || sending) return;
    sending = true;
    try {
      await channel.sendTyping();
    } catch {
      // ignore typing indicator failures
    } finally {
      sending = false;
    }
  }
  void refresh();
  const timer = setInterval(refresh, TYPING_REFRESH_MS);
  return () => {
    active = false;
    clearInterval(timer);
  };
}

function createDraft(channel, getComponents = () => []) {
  let message;
  let latest = '';
  let pending = Promise.resolve();
  let timer;
  let lastSentAt = 0;
  let closed = false;
  let finalized = false;

  function flush() {
    if (closed || !latest) return;
    clearTimeout(timer);
    timer = null;
    lastSentAt = Date.now();
    const content = `${latest.slice(0, MAX_CHUNK - 4)} …`;
    pending = pending.then(async () => {
      const payload = { content, components: getComponents(), allowedMentions: { parse: [] } };
      if (message) await message.edit(payload);
      else message = await channel.send(payload);
    }).catch(() => {});
  }

  return {
    get preview() { return closed ? '' : latest.slice(0, MAX_CHUNK - 4); },
    update(text) {
      if (closed) return;
      latest = cleanReply(text).trim();
      if (!latest) return;
      const remaining = DRAFT_REFRESH_MS - (Date.now() - lastSentAt);
      if (remaining <= 0) flush();
      else if (!timer) timer = setTimeout(flush, remaining);
    },
    async finish(request, text, allowedMentions, components = []) {
      closed = true;
      clearTimeout(timer);
      await pending;
      await sendChunked(request, text, message, allowedMentions, components);
      finalized = true;
    },
    async cancel() {
      if (finalized) return;
      closed = true;
      clearTimeout(timer);
      await pending;
      if (message) await message.delete().catch(() => {});
      message = null;
    },
  };
}

function createProgress(channel, { getComponents, getQueueCount, getDraftText } = {}) {
  const draft = createDraft(channel, getComponents);
  let label = 'Thinking';
  let commentary = '';
  let shownCommentary = '';
  const visibleCommentary = () => commentary && !(getDraftText?.() || '').includes(commentary) ? commentary : '';
  let since = Date.now();
  const refresh = () => {
    const seconds = Math.floor((Date.now() - since) / 1000);
    const status = seconds ? `${label} · ${seconds}s` : label;
    const queued = getQueueCount?.() || 0;
    shownCommentary = visibleCommentary();
    draft.update(`${shownCommentary ? `${shownCommentary}\n\n` : ''}${status}${queued ? ` · ${queued} queued` : ''}`);
  };
  refresh();
  const timer = setInterval(refresh, 5000);
  return {
    update(next) {
      if (!next || next === label) return;
      label = next;
      since = Date.now();
      refresh();
    },
    commentary(text) {
      commentary = cleanReply(String(text)).trim().slice(0, 1000);
      refresh();
    },
    draftUpdated() {
      if (shownCommentary !== visibleCommentary()) refresh();
    },
    refresh,
    async cancel() {
      clearInterval(timer);
      await draft.cancel();
    },
  };
}

function messageFromContext(interaction, botUser) {
  const target = interaction.targetMessage;
  const users = new Map(target.mentions.users);
  users.set(botUser.id, botUser);
  return {
    id: target.id,
    createdTimestamp: Date.now(),
    contextCommand: true,
    author: interaction.user,
    channel: interaction.channel,
    channelId: interaction.channelId,
    guild: interaction.guild,
    attachments: target.attachments,
    messageSnapshots: new Map(),
    content: `<@${botUser.id}> Respond to the selected message from ${target.author.username}:\n${target.content || '(no text)'}`,
    mentions: {
      users,
      members: target.mentions.members,
      has: (user) => user.id === botUser.id,
    },
  };
}

// key: the bots/<key>.env file name · allowedUserIds: empty = anyone who can post in allowed channels
function startBot({
  key: botKey, token, name, defaultName, runPrompt, closeSession, refreshIdle, refreshPermission,
  refreshCli, validateCli, cliAutoUpdate = false,
  providerId, workdir, permission, models, getModels, getUsage,
  allowedChannelIds, allowedUserIds, historyLimit, stateDir = STATE_DIR,
}) {
  const sessionsFile = path.join(stateDir, `${botKey}.sessions.json`);
  const sessions = loadJson(sessionsFile);
  const historyFile = path.join(stateDir, `${botKey}.history.json`);
  const prefsFile = path.join(stateDir, `${botKey}.prefs.json`);
  const prefs = loadJson(prefsFile); // channelId -> { model, effort }; _default -> new channels
  let modelRefresh;
  let modelRefreshError;
  function refreshModels(force = false) {
    if (!getModels) return Promise.resolve();
    if (!modelRefresh || force) {
      modelRefresh = maintenance.run(getModels).then((available) => {
        models.splice(0, models.length, ...available);
        modelRefreshError = null;
      }).catch((error) => {
        modelRefreshError = error;
        console.error(`[${name}] Could not refresh model list:`, error);
      });
    }
    return modelRefresh;
  }
  const maintenance = createCliMaintenance({ key: botKey, providerId, enabled: cliAutoUpdate,
    validate: validateCli,
    apply: (available) => {
      refreshCli?.();
      models.splice(0, models.length, ...available);
      modelRefresh = Promise.resolve();
      modelRefreshError = null;
    },
  });
  const readUsage = () => maintenance.run(getUsage);
  const channelsFile = path.join(stateDir, `${botKey}.channels.json`);
  const knownChannels = loadJson(channelsFile); // channelId -> guildId; recorded automatically when state is saved
  const queues = {}; // channelId -> promise chain, so one channel's turns run in order
  const tasks = createTaskStore();
  const notificationsFile = path.join(stateDir, `${botKey}.notifications.json`);
  const notifications = loadJson(notificationsFile);
  const pendingForwards = {}; // `${channelId}:${authorId}` -> { text, at }
  const running = {}; // channelId -> AbortController for the in-flight CLI call
  const stopGen = {}; // channelId -> bumped by channel stop controls so queued turns are dropped
  const stopped = {}; // channelId -> stop bot-to-bot turns until a human mentions an agent
  const lastHumanMentionAt = {};
  function stopChannel(channelId, at = Date.now()) {
    if (at <= (lastHumanMentionAt[channelId] || 0)) return;
    stopGen[channelId] = (stopGen[channelId] || 0) + 1;
    stopped[channelId] = true;
    tasks.cancelQueued(channelId);
    if (running[channelId]) running[channelId].abort();
  }
  function interruptAllTurns() {
    for (const channelId of new Set([...Object.keys(queues), ...Object.keys(running)])) {
      stopGen[channelId] = (stopGen[channelId] || 0) + 1;
      tasks.cancelQueued(channelId);
      running[channelId]?.abort();
    }
  }
  const teamStops = watchStops(stopChannel);
  const userAllowed = (userId) => !allowedUserIds.length || allowedUserIds.includes(userId);
  const resumableFor = (userId) => listResumableSessions({
    file: historyFile, sessions, providerId, name, userId, allowedUserIds,
  }).map((entry) => ({
    ...entry,
    channelName: entry.channelName || client.channels.cache.get(entry.channelId)?.name || '',
  }));

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  async function debateForChannel(channel, channelId, settings = readSettings()) {
    if (!channel.guild) return { active: false, peers: [], maxTurns: DEFAULT_DEBATE_TURNS };
    const debate = debateSetting(settings, channel.guild.id, channelId);
    if (!debate.enabled || (allowedChannelIds.length && !allowedChannelIds.includes(channelId))) {
      return { active: false, peers: [], maxTurns: debate.maxTurns };
    }
    const peers = await manualDebatePeers(channel, client.user.id, botKey);
    return { active: peers.length > 0, peers, maxTurns: debate.maxTurns };
  }

  function releaseSession(sessionId) {
    if (sessionId && !Object.values(sessions).includes(sessionId)) closeSession?.(sessionId);
  }

  function rememberChannel(id, guildId) {
    if (!guildId || knownChannels[id] === guildId) return;
    knownChannels[id] = guildId;
    saveJson(channelsFile, knownChannels);
  }

  function forgetChannel(channel) {
    const id = channel.id;
    stopGen[id] = (stopGen[id] || 0) + 1;
    running[id]?.abort();
    const sessionId = sessions[id];
    if (sessionId) {
      delete sessions[id];
      saveJson(sessionsFile, sessions);
      releaseSession(sessionId);
    }
    if (prefs[id]) {
      delete prefs[id];
      saveJson(prefsFile, prefs);
    }
    if (knownChannels[id]) {
      delete knownChannels[id];
      saveJson(channelsFile, knownChannels);
    }
    for (const key of Object.keys(pendingForwards)) {
      if (key.startsWith(`${id}:`)) delete pendingForwards[key];
    }
    delete queues[id];
    delete stopped[id];
    delete lastHumanMentionAt[id];
    if (channel.guild && readSettings().guilds?.[channel.guild.id]?.channels?.[id]) {
      return updateSettings((settings) => {
        delete settings.guilds?.[channel.guild.id]?.channels?.[id];
      }).catch((error) => console.error(`[${name}] Could not clear deleted channel settings:`, error));
    }
  }

  client.on('channelDelete', forgetChannel);
  client.on('threadDelete', forgetChannel);

  let registration;
  const registrationError = (error) => console.error(`[${name}] Could not refresh agent registry:`, error);
  client.once('clientReady', async () => {
    registration = createAgentRegistration({ key: botKey,
      getAgent: () => ({ name, id: client.user.id, providerId, allowedChannelIds, pid: process.pid }),
      onError: registrationError });
    await registration.refresh().catch(registrationError);
    console.log(`[${name}] logged in as ${client.user.tag}`);
    const legacyIds = [...Object.keys(sessions), ...Object.keys(prefs).filter((id) => id !== DEFAULT_MODEL_PREF)];
    reconcileDeletedChannels(client, trackedChannelGuilds(knownChannels, readSettings()),
      legacyIds, rememberChannel, forgetChannel)
      .catch((error) => console.error(`[${name}] Channel reconciliation failed:`, error));
  });

  async function onMessage(message) {
    const receivedAt = Date.now();
    teamStops.refresh();
    const isDM = !message.guild;
    if (!isDM && allowedChannelIds.length && !allowedChannelIds.includes(message.channelId)) return;
    if (!message.author.bot && !userAllowed(message.author.id)) return;
    const key = message.channelId;
    const settings = readSettings();
    const { active: isDebate, peers: debatePeers, maxTurns } = isDM
      ? { active: false, peers: [], maxTurns: DEFAULT_DEBATE_TURNS } : await debateForChannel(message.channel, key, settings);
    const mentioned = message.mentions.has(client.user);
    const mentionsOtherBot = [...message.mentions.users.values()].some((user) => user.bot && user.id !== client.user.id);
    const privateChannel = !isDM && isPrivateChannel(message.channel);
    let peerCount = debatePeers.length;
    if (privateChannel && !mentioned && !mentionsOtherBot && !message.author.bot &&
        !debateSetting(settings, message.guild.id, key).enabled) {
      peerCount = (await manualDebatePeers(message.channel, client.user.id, botKey)).length;
    }
    const autoReply = shouldAutoReply({ isDM, authorIsBot: message.author.bot, mentioned,
      mentionsOtherBot, privateChannel, peerCount });
    if (!message.author.bot && (autoReply || [...message.mentions.users.keys()].some((id) =>
      Object.values(loadJson(REGISTRY_FILE)).some((agent) => agent.id === id)))) {
      lastHumanMentionAt[key] = message.editedTimestamp || message.createdTimestamp || Date.now();
      delete stopped[key];
    }

    if (message.author.bot) {
      // Only registered peers in an enabled debate channel can trigger another agent.
      if (stopped[key]) return;
      if (!isDebate || !debatePeers.some((agent) => agent.id === message.author.id)) return;
      if (!message.mentions.has(client.user)) return;
      const { turns, noticed } = await botTurnsSinceHuman(message);
      if (turns >= maxTurns) {
        if (!noticed) await message.channel.send(`[${name}] ${LIMIT_NOTICE} (${maxTurns}) reached. Mention one of us to continue.`);
        return;
      }
    }

    // a forward arrives with empty content (text lives in messageSnapshots) and can't carry a mention,
    // so in servers it's held briefly and attached to the same user's next @mention
    const fwdKey = `${message.channelId}:${message.author.id}`;
    const forwarded = forwardedText(message);
    if (forwarded && !isDM && !mentioned && !autoReply && !message.contextCommand) {
      pendingForwards[fwdKey] = { text: forwarded, at: Date.now() };
      return;
    }
    if (!isDM && !mentioned && !autoReply) return;

    let prompt = message.content
      .replace(`<@${client.user.id}>`, '')
      .replace(`<@!${client.user.id}>`, '')
      .trim();
    if (forwarded) {
      prompt = `${prompt}\n\nForwarded message:\n${forwarded}`.trim();
    } else if (!isDM && !message.contextCommand) {
      // the forward may land just after its comment; give it a moment
      await new Promise((r) => setTimeout(r, FORWARD_WAIT_MS));
      const pending = pendingForwards[fwdKey];
      delete pendingForwards[fwdKey];
      if (pending && Date.now() - pending.at < FORWARD_TTL_MS) {
        prompt = `${prompt}\n\nForwarded message:\n${pending.text}`.trim();
      }
    }
    const attachments = await attachmentsForTurn(message, userAllowed);
    if (!prompt && !attachments.length) return;

    const gen = stopGen[key] || 0;
    const wasBusy = tasks.list(key).length > 0;
    const task = tasks.add(key, message.author.id, prompt, notifications[`${key}:${message.author.id}`] === true);
    for (const active of tasks.list(key)) active.progress?.refresh();
    const releaseCli = maintenance.reserve();
    const turn = (queues[key] || Promise.resolve()).catch(() => {}).then(async () => {
      try { await maintenance.wait(); }
      catch (error) { await message.channel.send(`[${name}] Error: ${error.message}`); return; }
      if (task.status === 'cancelled' || (stopGen[key] || 0) !== gen || (message.author.bot && stopped[key])) return;
      if (message.author.bot) {
        // a bot-triggered turn may have waited in the queue while the debate hit its limit
        if (!debateSetting(readSettings(), message.guild.id, key).enabled) return;
        const { turns, noticed } = await botTurnsSinceHuman(message, { latest: true });
        if (noticed || turns >= debateSetting(readSettings(), message.guild.id, key).maxTurns) return;
      }
      task.status = 'running';
      task.startedAt = Date.now();
      const ctrl = new AbortController();
      task.controller = ctrl;
      running[key] = ctrl;
      void task.receipt?.then((receipt) => receipt.edit({ content: `[${name}] Your queued request is now running.`, components: [], allowedMentions: { parse: [] } })).catch(() => {});
      const stopTyping = startTyping(message.channel);
      let savedImages;
      let draft;
      let progress;
      try {
        const images = imageAttachments({ attachments: new Map(attachments.map((item, i) => [i, item])) });
        const documents = documentAttachments({ attachments: new Map(attachments.map((item, i) => [i, item])) });
        savedImages = await saveImageAttachments(images);
        const docsContext = await documentContext(documents);
        if (models) await refreshModels();
        const modelId = models ? resolvePref(models, modelPrefForChannel(prefs, key)).modelId : undefined;
        const history = isDM ? '' : await recentHistory(message, client.user.id,
          historySetting(readSettings(), message.guild.id, key, botKey, historyLimit).limit);
        const waitFor = isDM ? [] : earlierMentionedBots(message, client.user.id);
        const handoff = waitFor.length ? await waitForReplies(message, waitFor, () => (stopGen[key] || 0) !== gen) : '';
        if ((stopGen[key] || 0) !== gen) return;
        const requestText = message.content.replace(/<@!?\d+>/g, '').trim()
          ? readableMentions(message.content, message, client.user.id).trim()
          : savedImages.paths.length ? 'Please inspect and describe the attached image(s).'
            : documents.length ? 'Please read and respond to the attached document(s).' : 'Please respond to the forwarded message.';
        const imageContext = savedImages.paths.length
          ? `Discord image attachments (temporary local files):\n${savedImages.paths.map((file, i) => `${i + 1}. ${file}`).join('\n')}\n` +
            'Inspect each image before answering. Do not infer its contents from the filename or reveal these temporary paths.'
          : '';
        const configuredPrompt = isDM ? null : promptSetting(readSettings(), message.guild.id, key, botKey);
        const fullPrompt = [
          configuredPrompt?.serverText && `Agent instructions for this server:\n${configuredPrompt.serverText}`,
          configuredPrompt?.channelText && `Role and instructions for this channel:\n${configuredPrompt.channelText}`,
          isDebate && debatePeerInstructions(debatePeers),
          history && `Recent messages in this Discord channel since your last reply (context only):\n${history}`,
          waitFor.length && `Replies from the agents mentioned before you in this request:\n${handoff || '(none arrived in time)'}`,
          imageContext,
          docsContext,
          requestText +
            (prompt.includes('Forwarded message:') ? `\n\n${prompt.slice(prompt.indexOf('Forwarded message:'))}` : ''),
        ].filter(Boolean).join('\n\n---\n');
        const rememberTurnSession = (sessionId) => {
          if (!sessionId || (stopGen[key] || 0) !== gen) return;
          rememberChannel(key, message.guild?.id);
          if (sessionId !== sessions[key]) {
            sessions[key] = sessionId;
            saveJson(sessionsFile, sessions);
          }
          rememberSession(historyFile, {
            id: sessionId,
            ownerId: message.author.bot ? (allowedUserIds.length === 1 ? allowedUserIds[0] : null) : message.author.id,
            channelId: key,
            channelName: message.channel.name || 'DM',
            title: requestText,
          });
        };
        const showProgress = !message.author.bot &&
          (isDM || autoReply || [...message.mentions.users.values()].filter((user) => user.bot).length === 1);
        if (showProgress) {
          progress = createProgress(message.channel, {
            getComponents: () => taskComponents(task, Boolean(task.control?.steer)),
            getQueueCount: () => tasks.list(key).filter((item) => item.status === 'queued').length,
            getDraftText: () => draft?.preview || '',
          });
          task.progress = progress;
        }
        if (showProgress && !isDebate) draft = createDraft(message.channel);
        let result;
        const runStartedAt = Date.now();
        try {
          result = await runPrompt(fullPrompt, sessions[key], modelId, ctrl.signal, savedImages.paths,
            (text) => { draft?.update(text); progress?.draftUpdated(); }, progress?.update, rememberTurnSession, {
              onCommentary: (text) => progress?.commentary(text),
              onControl: (control) => {
                task.control = control;
                task.controlVersion = (task.controlVersion || 0) + 1;
                progress?.refresh();
              },
            });
        } catch (err) {
          if (ctrl.signal.aborted) return;
          rememberTurnSession(err.sessionId);
          throw err;
        }
        if (ctrl.signal.aborted) return;
        const runFinishedAt = Date.now();
        if ((stopGen[key] || 0) !== gen) return;
        const text = typeof result === 'string' ? result : result.text;
        rememberTurnSession(result?.sessionId);
        teamStops.refresh();
        if (message.author.bot && stopped[key]) return;
        if (message.author.bot) {
          // the debate may have hit its limit while this answer was being written; don't post past it
          const currentDebate = debateSetting(readSettings(), message.guild.id, key);
          if (!currentDebate.enabled) return;
          const { turns, noticed } = await botTurnsSinceHuman(message, { latest: true });
          if (noticed || turns >= currentDebate.maxTurns) {
            console.log(`[${name}] dropped a late debate reply (limit reached while it ran)`);
            return;
          }
        }
        stopTyping();
        const reply = isDebate
          ? resolveDebateHandoff(text || '(empty response)', debatePeers, { recoverInvalidHandoff: message.author.bot })
          : text || '(empty response)';
        if (progress) await progress.cancel();
        if (draft && !isDebate) await draft.finish(message, reply);
        else {
          await sendChunked(message, reply, undefined,
            isDebate ? { users: debatePeers.map((peer) => peer.id) } : undefined);
        }
        if (task.notify && !message.author.bot && Date.now() - task.startedAt >= 60000) {
          await message.channel.send({ content: `<@${task.userId}> ${name} finished your task.`,
            allowedMentions: { users: [task.userId] } }).catch((error) => console.error(`[${name}] Completion alert failed:`, error));
        }
        task.status = 'completed';
        console.log(`[${name}] latency: prepare=${runStartedAt - receivedAt}ms cli=${runFinishedAt - runStartedAt}ms post=${Date.now() - runFinishedAt}ms`);
      } catch (err) {
        task.status = 'failed';
        console.error(`[${name}] turn failed:`, err);
        stopTyping();
        if (progress) await progress.cancel();
        await sendTurnError(message, name, err, draft);
      } finally {
        if (ctrl.signal.aborted) task.status = 'stopped';
        if (running[key] === ctrl) delete running[key];
        task.control = null;
        stopTyping();
        if (progress) await progress.cancel();
        if (draft) await draft.cancel();
        if (savedImages) await savedImages.cleanup().catch(() => {});
      }
    }).finally(() => {
      releaseCli();
      tasks.finish(task);
      for (const active of tasks.list(key)) active.progress?.refresh();
      if (task.receipt) void task.receipt.then((receipt) => receipt.edit({
        content: `[${name}] ${task.status === 'completed' ? 'Queued request completed.' :
          task.status === 'failed' ? 'Queued request failed.' : 'Queued request cancelled or stopped.'}`,
        components: [], allowedMentions: { parse: [] },
      })).catch(() => {});
    });
    queues[key] = turn;
    if (wasBusy && !message.author.bot) task.receipt = message.channel.send({
      content: `[${name}] Request queued. Use Queue to check or cancel it.`,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`task:${task.id}:cancel`).setLabel('Cancel request').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('control:queue').setLabel('Queue').setStyle(ButtonStyle.Secondary))],
      allowedMentions: { parse: [] },
    }).catch(() => null);
    void turn.catch((error) => console.error(`[${name}] Queued turn failed:`, error));
  }
  client.on('messageCreate', onMessage);
  client.on('messageUpdate', async (before, after) => {
    try {
      // discord.js can make the old partial message inherit fields fetched onto the updated one.
      const previous = { partial: before.partial, content: before.content, mentions: before.mentions };
      if (after.partial) after = await after.fetch();
      if (shouldHandleMessageUpdate(previous, after, client.user)) await onMessage(after);
    } catch (error) {
      console.error(`[${name}] Could not handle message edit:`, error);
    }
  });

  function agentViewArgs(interaction, settings = readSettings()) {
    return { settings, guildId: interaction.guildId, channelId: interaction.channelId,
      channelName: interaction.channel.name || (interaction.guild ? 'channel' : 'DM'), botKey, name, defaultName,
      discordUsername: client.user.username, providerId,
      requester: interaction.user.id, allowedChannelIds, allowedUserIds, historyFallback: historyLimit,
      workdir, permissionFallback: permission, tokenConfigured: Boolean(token), cliUpdate: maintenance.status(),
      canManage: Boolean(interaction.guild && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)),
      completionAlerts: notifications[`${interaction.channelId}:${interaction.user.id}`] === true };
  }

  function agentPanel(interaction) {
    return agentSettingsView(agentViewArgs(interaction));
  }

  async function debateViewArgs(interaction, settings = readSettings()) {
    const debate = await debateForChannel(interaction.channel, interaction.channelId, settings);
    return { settings, guildId: interaction.guildId, channelId: interaction.channelId,
      channelName: interaction.channel.name || 'channel', requester: interaction.user.id,
      active: debate.active, peerCount: debate.peers.length };
  }

  async function debatePanel(interaction) {
    return debateSettingsView(await debateViewArgs(interaction));
  }

  async function updateSettingsPanel(interaction, panel) {
    if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
      await interaction.reply({ ...panel, flags: MessageFlags.Ephemeral });
    } else await interaction.update(panel);
  }

  async function handleAgentControl(interaction) {
    if (!userAllowed(interaction.user.id)) {
      await interaction.reply({ content: 'This setting is only available to allowed users.', flags: MessageFlags.Ephemeral });
      return;
    }
    const parts = interaction.customId.split(':');
    const [, action, requester, scope] = parts;
    if (parts.length !== 3 && !(parts.length === 4 && ['prompt-save', 'idle-save', 'history-save'].includes(action))) {
      await interaction.reply({ content: 'This settings panel is outdated. Open Agent settings from the panel again.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (requester !== interaction.user.id) {
      await interaction.reply({ content: 'Use your own settings panel.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'notifications' && interaction.isButton()) {
      if (interaction.guild && allowedChannelIds.length && !allowedChannelIds.includes(interaction.channelId)) {
        await interaction.reply({ content: 'This channel is not allowed.', flags: MessageFlags.Ephemeral });
        return;
      }
      const key = `${interaction.channelId}:${interaction.user.id}`;
      notifications[key] = notifications[key] !== true;
      saveJson(notificationsFile, notifications);
      await updateSettingsPanel(interaction, agentPanel(interaction));
      return;
    }
    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'Use your own settings panel and a user account with Manage Server permission.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (['name-edit', 'name-save', 'name-reset'].includes(action)) {
      if (!allowedUserIds.length) {
        await interaction.reply({ content: 'Set ALLOWED_USER_IDS in this bot’s .env before changing its name across servers and DMs.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (action === 'name-edit' && interaction.isButton()) {
        const input = new TextInputBuilder().setCustomId('value')
          .setLabel('Bot name and Discord username (2/hour)')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32)
          .setValue(agentNameSetting(readSettings(), botKey, defaultName).name);
        const modal = new ModalBuilder().setCustomId(`agent:name-save:${requester}`)
          .setTitle('Bot name · all servers and DMs')
          .addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }
      if ((action !== 'name-reset' || !interaction.isButton()) &&
          (action !== 'name-save' || !interaction.isModalSubmit())) {
        await interaction.reply({ content: 'This settings panel is outdated. Open Agent settings from the panel again.', flags: MessageFlags.Ephemeral });
        return;
      }
      const nextName = action === 'name-reset' ? defaultName : interaction.fields.getTextInputValue('value').trim();
      if (nextName.length < 2 || nextName.length > 32 || /[\x00-\x1f\x7f<>@]/.test(nextName)) {
        await interaction.reply({ content: 'Enter a bot name of 2–32 characters without mentions or control characters.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (client.user.username !== nextName) {
        try {
          await client.user.setUsername(nextName);
        } catch (error) {
          if (error.code === 50277) {
            await interaction.reply({ content: `Discord rejected “${nextName}” as a bot username. Choose a distinct name in Edit bot name. Nothing was changed.`, flags: MessageFlags.Ephemeral });
            return;
          }
          throw error;
        }
      }
      await updateSettings((settings) => {
        settings.agentNames ||= {};
        if (nextName === defaultName) delete settings.agentNames[botKey];
        else {
          settings.agentNames[botKey] = { name: nextName };
          stamp(settings.agentNames[botKey], interaction.user);
        }
      });
      name = nextName;
      await registration.refresh();
      await updateSettingsPanel(interaction, agentPanel(interaction));
      return;
    }
    if (action === 'permission-select' && interaction.isStringSelectMenu()) {
      const selected = interaction.values[0];
      if (selected !== 'default' && !PERMISSION_MODES.includes(selected)) {
        await interaction.reply({ content: 'Invalid file access mode.', flags: MessageFlags.Ephemeral });
        return;
      }
      const nextMode = selected === 'default' ? permission : selected;
      if (nextMode !== 'read-only' && !allowedUserIds.length) {
        await interaction.reply({ content: 'Set ALLOWED_USER_IDS in this bot’s .env before enabling edit or full access.', flags: MessageFlags.Ephemeral });
        return;
      }
      const previous = permissionSetting(readSettings(), botKey, permission).mode;
      await updateSettings((settings) => {
        settings.permissions ||= {};
        if (selected === 'default') delete settings.permissions[botKey];
        else {
          settings.permissions[botKey] = { mode: selected };
          stamp(settings.permissions[botKey], interaction.user);
        }
      });
      if (previous !== permissionSetting(readSettings(), botKey, permission).mode) {
        interruptAllTurns();
        refreshPermission?.();
      }
      await updateSettingsPanel(interaction, agentPanel(interaction));
      return;
    }
    if (action === 'prompt-server' || action === 'prompt-channel' || action === 'idle-set' || action === 'history-set') {
      const isPrompt = action.startsWith('prompt-');
      const targetScope = action === 'prompt-server' ? 'server' : 'channel';
      const modal = new ModalBuilder()
        .setCustomId(`agent:${action === 'history-set' ? 'history-save' : isPrompt ? 'prompt-save' : 'idle-save'}:${requester}:${targetScope}`)
        .setTitle(action === 'history-set' ? `${name} recent message limit`.slice(0, 45) :
          isPrompt ? `${name} ${targetScope === 'server' ? 'server prompt' : 'channel prompt'}`.slice(0, 45) : `${name} idle time`.slice(0, 45));
      const prompt = promptSetting(readSettings(), interaction.guildId, interaction.channelId, botKey);
      const current = targetScope === 'server' ? prompt.serverText : prompt.channelText;
      const input = new TextInputBuilder().setCustomId('value')
        .setLabel(action === 'history-set' ? '1–100 messages; clear for bot default' :
          isPrompt ? 'Clear and save to remove this prompt' : 'Minutes (1–1440)')
        .setStyle(isPrompt && action !== 'history-set' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(action === 'idle-set').setMaxLength(action === 'history-set' ? 3 : isPrompt ? 3500 : 4);
      if (action === 'history-set') input.setValue(String(historySetting(readSettings(), interaction.guildId, interaction.channelId, botKey, historyLimit).limit));
      else if (isPrompt && current) input.setValue(current);
      else if (!isPrompt) input.setValue(String(idleSetting(readSettings(), botKey, providerId).minutes));
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }
    if (action === 'prompt-save' && (scope === 'server' || scope === 'channel')) {
      let value = '';
      try { value = String(interaction.fields.getTextInputValue('value') || '').trim(); } catch { /* empty optional field */ }
      await updateSettings((settings) => {
        const target = scope === 'server' ? guildSettings(settings, interaction.guildId)
          : channelSettings(settings, interaction.guildId, interaction.channelId);
        target.agents ||= {};
        target.agents[botKey] ||= {};
        if (value) {
          target.agents[botKey].prompt = { text: value };
          stamp(target.agents[botKey].prompt, interaction.user);
        } else delete target.agents[botKey].prompt;
        stamp(target, interaction.user);
      });
    } else if (action === 'history-save') {
      let raw = '';
      try { raw = interaction.fields.getTextInputValue('value').trim(); } catch { /* empty optional field */ }
      const limit = Number(raw);
      if (raw && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
        await interaction.reply({ content: 'Enter an integer from 1 to 100, or clear the field to use the bot default.', flags: MessageFlags.Ephemeral });
        return;
      }
      await updateSettings((settings) => {
        const channel = channelSettings(settings, interaction.guildId, interaction.channelId);
        channel.agents ||= {};
        channel.agents[botKey] ||= {};
        if (raw) channel.agents[botKey].historyLimit = limit;
        else delete channel.agents[botKey].historyLimit;
        stamp(channel, interaction.user);
      });
    } else if (action === 'idle-save') {
      const minutes = Number(interaction.fields.getTextInputValue('value').trim());
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        await interaction.reply({ content: 'Enter an idle time from 1 to 1440 minutes.', flags: MessageFlags.Ephemeral });
        return;
      }
      await updateSettings((settings) => {
        settings.idle ||= {};
        settings.idle[botKey] = { enabled: true, minutes };
        stamp(settings.idle[botKey], interaction.user);
      });
      refreshIdle?.();
    } else if (action === 'idle-toggle') {
      await updateSettings((settings) => {
        settings.idle ||= {};
        const current = idleSetting(settings, botKey, providerId);
        settings.idle[botKey] = { enabled: !current.enabled, minutes: current.minutes };
        stamp(settings.idle[botKey], interaction.user);
      });
      refreshIdle?.();
    } else {
      await interaction.reply({ content: 'This settings panel is outdated. Open Agent settings from the panel again.', flags: MessageFlags.Ephemeral });
      return;
    }
    await updateSettingsPanel(interaction, agentPanel(interaction));
  }

  async function handleDebateControl(interaction) {
    if (!interaction.guild || !userAllowed(interaction.user.id)) {
      await interaction.reply({ content: 'This setting is only available to allowed users in a server.', flags: MessageFlags.Ephemeral });
      return;
    }
    const parts = interaction.customId.split(':');
    const [, action, requester] = parts;
    if (parts.length !== 3) {
      await interaction.reply({ content: 'This settings panel is outdated. Open Debate settings from the panel again.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (requester !== interaction.user.id || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: 'Use your own settings panel and a user account with Manage Server permission.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'turns') {
      const current = debateSetting(readSettings(), interaction.guildId, interaction.channelId);
      const input = new TextInputBuilder().setCustomId('value')
        .setLabel('Maximum agent turns (1–20)')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2)
        .setValue(String(current.maxTurns));
      const modal = new ModalBuilder().setCustomId(`debate:turns-save:${requester}`)
        .setTitle('Debate turn limit for this channel')
        .addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }
    if (!['on', 'off', 'turns-save'].includes(action)) {
      await interaction.reply({ content: 'This settings panel is outdated. Open Debate settings from the panel again.', flags: MessageFlags.Ephemeral });
      return;
    }
    let maxTurns;
    if (action === 'turns-save') {
      maxTurns = Number(interaction.fields.getTextInputValue('value').trim());
      if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 20) {
        await interaction.reply({ content: 'Enter an integer from 1 to 20.', flags: MessageFlags.Ephemeral });
        return;
      }
    }
    await updateSettings((settings) => {
      const channel = channelSettings(settings, interaction.guildId, interaction.channelId);
      const current = debateSetting(settings, interaction.guildId, interaction.channelId);
      channel.debate = {
        enabled: action === 'turns-save' ? current.enabled : action === 'on',
        maxTurns: action === 'turns-save' ? maxTurns : current.maxTurns,
      };
      stamp(channel.debate, interaction.user);
      stamp(channel, interaction.user);
    });
    await updateSettingsPanel(interaction, await debatePanel(interaction));
  }

  async function handleCommand(interaction, commandName = interaction.commandName) {
    const management = (commandName === 'agent' || commandName === 'debate') &&
      interaction.guild && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!userAllowed(interaction.user.id) ||
        (!management && interaction.guild && allowedChannelIds.length && !allowedChannelIds.includes(interaction.channelId))) {
      await interaction.reply({ content: `[${name}] This channel or user is not allowed.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const channelId = interaction.channelId;
    if (commandName === 'panel') {
      await interaction.reply({ ...panelView(name), flags: MessageFlags.Ephemeral });
      return;
    }
    if (commandName === 'agent') {
      await interaction.reply({ ...agentPanel(interaction), flags: MessageFlags.Ephemeral });
      return;
    }
    if (commandName === 'debate') {
      if (!interaction.guild) {
        await interaction.reply({ content: 'Settings require a server channel and Manage Server permission.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: 'Manage Server permission is required to change settings.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({ ...await debatePanel(interaction),
        flags: MessageFlags.Ephemeral });
      return;
    }
    if (commandName === 'new') {
      const oldSessionId = sessions[channelId];
      if (sessions[channelId]) {
        const previous = resumableFor(interaction.user.id).find((entry) => entry.id === sessions[channelId]);
        rememberSession(historyFile, {
          id: sessions[channelId], ownerId: interaction.user.id, channelId,
          channelName: interaction.channel.name || 'DM', title: previous?.title || 'Previous conversation',
        });
      }
      stopGen[channelId] = (stopGen[channelId] || 0) + 1;
      tasks.cancelQueued(channelId);
      if (running[channelId]) running[channelId].abort();
      delete stopped[channelId];
      delete sessions[channelId];
      saveJson(sessionsFile, sessions);
      releaseSession(oldSessionId);
      await interaction.reply({ content: `[${name}] New conversation started in this channel.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (commandName === 'resume') {
      await interaction.reply({
        ...resumePanel(botKey, name, channelId, interaction.user.id, resumableFor(interaction.user.id), sessions[channelId]),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (commandName === 'rename') {
      await interaction.reply({
        ...resumePanel(botKey, name, channelId, interaction.user.id, resumableFor(interaction.user.id), sessions[channelId], 0, 'rename'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (commandName === 'model') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await refreshModels(true);
      const panel = modelPanel(botKey, name, models, modelPrefForChannel(prefs, channelId));
      if (modelRefreshError) panel.content += '\nCould not refresh models; showing the fallback list.';
      await interaction.editReply(panel);
      return;
    }
    if (commandName === 'usage') {
      if (interaction.isButton() && interaction.message?.flags?.has(MessageFlags.Ephemeral)) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const components = [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('control:usage-all').setLabel('All usage').setStyle(ButtonStyle.Secondary))];
      try {
        await interaction.editReply({ content: '', embeds: [usageEmbed(name, await readUsage())], components });
      } catch (error) {
        await interaction.editReply({ content: `[${name}] Could not read usage: ${String(error.message || error).slice(0, 500)}`,
          embeds: [], components });
      }
      return;
    }
    if (commandName === 'usage-all') {
      if (interaction.isButton() && interaction.message?.flags?.has(MessageFlags.Ephemeral)) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const agents = Object.values(loadJson(REGISTRY_FILE)).filter((agent) =>
        isRunningAgent(agent) && ['claude', 'codex', 'gemini'].includes(agent.providerId));
      const results = await Promise.allSettled(agents.map(async (agent) => {
        const reader = require(`./providers/${agent.providerId}`)({ workdir, permission });
        const guard = agent.providerId === providerId ? maintenance : createCliMaintenance({
          key: `${botKey}-usage-${randomUUID()}`, providerId: agent.providerId,
        });
        try { return await guard.run(async () => usageEmbed(agent.name, await reader.usage())); }
        finally { if (guard !== maintenance) guard.close(); }
      }));
      const embeds = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
      const errors = results.flatMap((result, index) => result.status === 'rejected'
        ? [`${agents[index].name}: ${String(result.reason.message || result.reason).slice(0, 300)}`] : []);
      await interaction.editReply({
        content: errors.length ? `Could not read some usage data:\n${errors.join('\n').slice(0, 1800)}` : embeds.length ? '' : 'No running agents found.',
        embeds: embeds.slice(0, 10),
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('control:usage').setLabel('This agent').setStyle(ButtonStyle.Secondary))],
      });
      for (let index = 10; index < embeds.length; index += 10) {
        await interaction.followUp({ embeds: embeds.slice(index, index + 10), flags: MessageFlags.Ephemeral });
      }
      return;
    }
    if (commandName === 'stop' || commandName === 'stop-all') {
      stopChannel(channelId);
      if (commandName === 'stop-all') publishStop(channelId);
      await interaction.reply({
        content: commandName === 'stop-all' ? 'Stopped all agents in this channel.' : `[${name}] Stopped work in this channel.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    return;
  }

  async function handleTaskControl(interaction) {
    const deny = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
    if (!userAllowed(interaction.user.id) ||
        (interaction.guild && allowedChannelIds.length && !allowedChannelIds.includes(interaction.channelId))) {
      return deny('This channel or user is not allowed.');
    }
    if (interaction.customId.startsWith('rename:')) {
      const [, action, channelId, userId, sessionId] = interaction.customId.split(':');
      if (action !== 'save' || !interaction.isModalSubmit() || channelId !== interaction.channelId || userId !== interaction.user.id) {
        return deny('Use your own Rename menu in the original channel.');
      }
      const entry = resumableFor(userId).find((candidate) => candidate.id === sessionId);
      if (!entry) return deny('This conversation is no longer available to rename. Open Rename from the panel again.');
      const title = renameSession(historyFile, entry, interaction.fields.getTextInputValue('value'), userId);
      return interaction.reply({ content: `[${name}] Conversation named **${title}**.`,
        flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    }
    const [prefix, id, action, version] = interaction.customId.split(':');
    if (prefix === 'control') {
      if (id === 'panel' || id === 'post-panel') return handleCommand(interaction, 'panel');
      if (id === 'refresh-panel') return interaction.update(panelView(name));
      if (id === 'queue') {
        const panel = queuePanel(tasks, interaction.channelId, interaction.user.id, name);
        if (interaction.message?.flags?.has(MessageFlags.Ephemeral)) return interaction.update(panel);
        return interaction.reply({ ...panel, flags: MessageFlags.Ephemeral });
      }
      if (id === 'cancel-queued' && interaction.isStringSelectMenu()) {
        const task = tasks.get(interaction.values[0]);
        if (!task || task.channelId !== interaction.channelId || task.userId !== interaction.user.id || task.status !== 'queued') {
          return deny('That request is no longer queued, or belongs to another user.');
        }
        task.status = 'cancelled';
        void task.receipt?.then((receipt) => receipt?.edit({ content: `[${name}] Queued request cancelled.`, components: [], allowedMentions: { parse: [] } })).catch(() => {});
        for (const active of tasks.list(interaction.channelId)) active.progress?.refresh();
        return interaction.update(queuePanel(tasks, interaction.channelId, interaction.user.id, name));
      }
      if (id === 'notifications') {
        const key = `${interaction.channelId}:${interaction.user.id}`;
        notifications[key] = notifications[key] !== true;
        saveJson(notificationsFile, notifications);
        return deny(`Completion alerts are **${notifications[key] ? 'ON' : 'OFF'}** for your future tasks in this channel. Alerts mention you after tasks that run for at least one minute.`);
      }
      if (id === 'settings') return handleCommand(interaction, 'agent');
      if (['model', 'usage', 'usage-all', 'new', 'resume', 'rename', 'debate', 'stop', 'stop-all'].includes(id) && interaction.isButton()) {
        return handleCommand(interaction, id);
      }
      return deny('This control is no longer available. Use /panel to open a new panel.');
    }
    const task = tasks.get(id);
    if (!task || task.channelId !== interaction.channelId) return deny('This task is no longer active.');
    if (task.userId !== interaction.user.id) return deny('Only the requester can control this task.');
    if (action === 'cancel' && interaction.isButton()) {
      if (task.status !== 'queued') return deny('This request has already started. Use Stop on its progress card.');
      task.status = 'cancelled';
      for (const active of tasks.list(interaction.channelId)) active.progress?.refresh();
      return interaction.update({ content: `[${name}] Queued request cancelled.`, components: [], allowedMentions: { parse: [] } });
    }
    if (task.status !== 'running' || task.controller?.signal.aborted) return deny('This task is no longer running.');
    if (action === 'stop' && interaction.isButton()) {
      task.status = 'stopped';
      task.controller.abort();
      return deny('Task stopped. Queued requests remain in the queue.');
    }
    if (action === 'steer' && interaction.isButton()) {
      if (!task.control?.steer) return deny('This task cannot accept an update right now.');
      return interaction.showModal(inputModal(`task:${id}:steer-submit:${task.controlVersion}`, 'Update the running task', 'What should the agent change?'));
    }
    if (action === 'steer-submit' && interaction.isModalSubmit()) {
      const text = interaction.fields.getTextInputValue('value').trim();
      if (!text || text.length > 4000) return deny('Enter an update of 1–4,000 characters.');
      if (!task.control?.steer || version !== String(task.controlVersion)) return deny('The active turn has changed. Send your update as a new message.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await task.control.steer(text);
        await interaction.editReply('Update sent to the running task.');
      } catch {
        await interaction.editReply('The turn ended before it accepted the update. Send it as a new message.');
      }
      return;
    }
    return deny('Invalid task action.');
  }

  client.on('interactionCreate', async (interaction) => {
    if ((interaction.isModalSubmit() || interaction.isButton() || interaction.isStringSelectMenu()) &&
        /^(control|task|rename):/.test(interaction.customId || '')) {
      try { await handleTaskControl(interaction); }
      catch (error) {
        console.error(`[${name}] Task control failed:`, error);
        const payload = { content: 'Could not use this control. Please try again.', flags: MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
        else await interaction.reply(payload).catch(() => {});
      }
      return;
    }
    if ((interaction.isModalSubmit() || interaction.isButton() || interaction.isStringSelectMenu()) &&
        (interaction.customId?.startsWith('agent:') || interaction.customId?.startsWith('debate:'))) {
      try {
        if (interaction.customId.startsWith('agent:')) await handleAgentControl(interaction);
        else await handleDebateControl(interaction);
      }
      catch (error) {
        console.error(`[${name}] Agent settings error:`, error);
        const payload = { content: `Could not update settings: ${String(error.message || error).slice(0, 300)}`, flags: MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
        else await interaction.reply(payload).catch(() => {});
      }
      return;
    }
    if (interaction.isAutocomplete()) {
      await interaction.respond([]);
      return;
    }

    if (interaction.isMessageContextMenuCommand()) {
      if (!userAllowed(interaction.user.id) ||
          (interaction.guild && allowedChannelIds.length && !allowedChannelIds.includes(interaction.channelId))) {
        await interaction.reply({ content: `[${name}] This channel or user is not allowed.`, flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.commandName === 'Panel') {
        await handleCommand(interaction, 'panel');
        return;
      }
      if (interaction.commandName !== 'Ask') return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (interaction.targetMessage.partial) await interaction.targetMessage.fetch();
        await onMessage(messageFromContext(interaction, client.user));
        await interaction.editReply(`[${name}] I'll respond to the selected message in this channel.`);
      } catch (error) {
        await interaction.editReply(`[${name}] Could not read that message: ${String(error.message || error).slice(0, 500)}`);
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'panel') {
        await handleCommand(interaction);
        return;
      }
      if (!userAllowed(interaction.user.id) ||
          (interaction.guild && allowedChannelIds.length && !allowedChannelIds.includes(interaction.channelId))) return;
      await interaction.reply({ ...panelView(name), flags: MessageFlags.Ephemeral });
      return;
    }

    if (!interaction.isStringSelectMenu() && !interaction.isButton()) return;
    const [bot, field, targetChannel, requester, pageText] = interaction.customId.split(':');
    if (bot !== botKey) return;
    if (!userAllowed(interaction.user.id)) {
      await interaction.reply({ content: `[${name}] You're not on this bot's user list.`, ephemeral: true });
      return;
    }

    if (['resume', 'resume-page', 'rename', 'rename-page'].includes(field)) {
      if (interaction.user.id !== requester || interaction.channelId !== targetChannel ||
          (interaction.guild && allowedChannelIds.length && !allowedChannelIds.includes(targetChannel))) {
        await interaction.reply({ content: `[${name}] This menu can only be used by its requester in the original channel.`, ephemeral: true });
        return;
      }
      const entries = resumableFor(requester);
      const purpose = field.startsWith('rename') ? 'rename' : 'resume';
      if (field === 'rename' && interaction.isStringSelectMenu()) {
        const entry = entries.find((candidate) => candidate.id === interaction.values[0]);
        if (!entry) {
          await interaction.reply({ content: 'This conversation is no longer available. Open Rename from the panel again.', flags: MessageFlags.Ephemeral });
          return;
        }
        const input = new TextInputBuilder().setCustomId('value').setLabel('Conversation name')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(90).setValue((entry.title || 'Conversation').slice(0, 90));
        await interaction.showModal(new ModalBuilder().setCustomId(`rename:save:${targetChannel}:${requester}:${entry.id}`)
          .setTitle('Rename conversation').addComponents(new ActionRowBuilder().addComponents(input)));
        return;
      }
      await interaction.deferUpdate();
      if (field === 'resume-page' || field === 'rename-page') {
        await interaction.editReply(resumePanel(botKey, name, targetChannel, requester, entries, sessions[targetChannel], Number(pageText), purpose));
        return;
      }
      const chosen = entries.find((entry) => entry.id === interaction.values[0]);
      if (!chosen) {
        await interaction.editReply({ content: `[${name}] That conversation is no longer available. Open Resume from the panel again.`, components: [] });
        return;
      }
      const oldChannel = Object.keys(sessions).find((id) => id !== targetChannel && sessions[id] === chosen.id);
      const pending = [queues[targetChannel], oldChannel && queues[oldChannel]].filter(Boolean);
      const switchTurn = Promise.all(pending).then(() => {
        const oldSessionId = sessions[targetChannel];
        rememberChannel(targetChannel, interaction.guildId);
        assignSession(sessions, targetChannel, chosen.id);
        saveJson(sessionsFile, sessions);
        if (oldSessionId !== chosen.id) releaseSession(oldSessionId);
        rememberSession(historyFile, {
          id: chosen.id, ownerId: requester, channelId: targetChannel,
          channelName: interaction.channel.name || 'DM', title: chosen.title,
        });
      });
      queues[targetChannel] = switchTurn;
      try {
        await switchTurn;
        await interaction.editReply({ content: `[${name}] Resuming **${chosen.title}** in this channel.`, components: [], allowedMentions: { parse: [] } });
      } catch (error) {
        await interaction.editReply({ content: `[${name}] Could not switch conversations: ${String(error.message || error).slice(0, 500)}`, components: [] });
      }
      return;
    }

    if (models && field === 'model-page' && interaction.isButton()) {
      await interaction.update(modelPanel(botKey, name, models, modelPrefForChannel(prefs, interaction.channelId), Number(targetChannel)));
      return;
    }
    if (!models || !interaction.isStringSelectMenu() || !['model', 'effort'].includes(field)) return;

    const key = interaction.channelId;
    const pref = { ...modelPrefForChannel(prefs, key) };
    if (field === 'model') pref.model = interaction.values[0];
    if (field === 'effort') pref.effort = interaction.values[0];
    const { model, effort } = resolvePref(models, pref);
    rememberChannel(key, interaction.guildId);
    saveModelPref(prefs, key, { model: model.key, effort: effort || pref.effort });
    saveJson(prefsFile, prefs);
    await interaction.update(modelPanel(botKey, name, models, prefs[key], Number(targetChannel) || 0));
  });

  client.login(token);
  return client;
}

module.exports = { startBot, untilText, usageEmbed, resumePanel, messageFromContext, createDraft, createProgress, sendTurnError,
  isPrivateChannel, shouldAutoReply, shouldHandleMessageUpdate, modelPrefForChannel, saveModelPref, modelPanel,
  trackedChannelGuilds, reconcileDeletedChannels };
