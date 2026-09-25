const fs = require('fs');
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
const { resolvePeerMentions } = require('./peer-mentions');

const MAX_CHUNK = 1900;
const FORWARD_WAIT_MS = 500;
const TYPING_REFRESH_MS = 8000;
const DRAFT_REFRESH_MS = 2000;

// sessions, model choices and the shared bot registry live here (git-ignored)
const STATE_DIR = path.join(__dirname, '..', 'state');
// every running bot records its name and ID here, so bots can find each other for debates
const REGISTRY_FILE = path.join(STATE_DIR, 'agents.json');

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

function modelPanel(key, name, models, pref) {
  const { model, effort, modelId } = resolvePref(models, pref);
  const modelMenu = new StringSelectMenuBuilder()
    .setCustomId(`${key}:model`)
    .setPlaceholder('Select model')
    .addOptions(models.map((m) => ({ label: m.label, value: m.key, default: m.key === model.key })));
  const effortMenu = new StringSelectMenuBuilder().setCustomId(`${key}:effort`);
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
  return {
    content: `[${name}] Current model: **${model.label}**${effort ? ` · ${effort}` : ''} (\`${modelId}\`)`,
    components: [
      new ActionRowBuilder().addComponents(modelMenu),
      new ActionRowBuilder().addComponents(effortMenu),
    ],
  };
}

function resumePanel(botKey, name, channelId, userId, entries, currentId, page = 0) {
  if (!entries.length) return { content: `[${name}] No previous Discord bot conversations to resume.`, components: [] };
  const pages = Math.ceil(entries.length / 25);
  const index = Math.min(Math.max(0, page), pages - 1);
  const choices = entries.slice(index * 25, (index + 1) * 25);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${botKey}:resume:${channelId}:${userId}:${index}`)
    .setPlaceholder('Select a conversation to resume')
    .addOptions(choices.map((entry) => ({
      label: (entry.title || 'Previous conversation').slice(0, 100),
      description: `${entry.channelName ? `#${entry.channelName} · ` : ''}${entry.updatedAt ? new Date(entry.updatedAt).toLocaleString('en-US') : 'Date unknown'} · ${entry.id.slice(0, 8)}`.slice(0, 100),
      value: entry.id,
      default: entry.id === currentId,
    })));
  const components = [new ActionRowBuilder().addComponents(menu)];
  if (pages > 1) components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${botKey}:resume-page:${channelId}:${userId}:${index - 1}`)
      .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId(`${botKey}:resume-page:${channelId}:${userId}:${index + 1}`)
      .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(index === pages - 1),
  ));
  return { content: `[${name}] Select a previous Discord bot conversation. (Page ${index + 1}/${pages})`, components };
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

async function sendChunked(message, text, draft) {
  const chunks = replyChunks(text);
  for (const [index, chunk] of chunks.entries()) {
    if (index === 0 && draft) {
      try {
        await draft.edit({ content: chunk, allowedMentions: { parse: [] } });
      } catch {
        await draft.delete().catch(() => {});
        await message.channel.send(chunk);
      }
    } else {
      await message.channel.send(chunk);
    }
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

function createDraft(channel) {
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
      if (message) await message.edit({ content, allowedMentions: { parse: [] } });
      else message = await channel.send({ content, allowedMentions: { parse: [] } });
    }).catch(() => {});
  }

  return {
    update(text) {
      if (closed) return;
      latest = cleanReply(text).trim();
      if (!latest) return;
      const remaining = DRAFT_REFRESH_MS - (Date.now() - lastSentAt);
      if (remaining <= 0) flush();
      else if (!timer) timer = setTimeout(flush, remaining);
    },
    async finish(request, text) {
      closed = true;
      clearTimeout(timer);
      await pending;
      await sendChunked(request, text, message);
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
  providerId, workdir, permission, models, getUsage,
  allowedChannelIds, allowedUserIds, historyLimit,
}) {
  const sessionsFile = path.join(STATE_DIR, `${botKey}.sessions.json`);
  const sessions = loadJson(sessionsFile);
  const historyFile = path.join(STATE_DIR, `${botKey}.history.json`);
  const prefsFile = path.join(STATE_DIR, `${botKey}.prefs.json`);
  const prefs = loadJson(prefsFile); // channelId -> { model, effort }
  const queues = {}; // channelId -> promise chain, so one channel's turns run in order
  const pendingForwards = {}; // `${channelId}:${authorId}` -> { text, at }
  const running = {}; // channelId -> AbortController for the in-flight CLI call
  const stopGen = {}; // channelId -> bumped by slash stop commands so queued turns are dropped
  const stopped = {}; // channelId -> stop bot-to-bot turns until a human mentions an agent
  const lastHumanMentionAt = {};
  function stopChannel(channelId, at = Date.now()) {
    if (at <= (lastHumanMentionAt[channelId] || 0)) return;
    stopGen[channelId] = (stopGen[channelId] || 0) + 1;
    stopped[channelId] = true;
    if (running[channelId]) running[channelId].abort();
  }
  function interruptAllTurns() {
    for (const channelId of new Set([...Object.keys(queues), ...Object.keys(running)])) {
      stopGen[channelId] = (stopGen[channelId] || 0) + 1;
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
    partials: [Partials.Channel],
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
    for (const key of Object.keys(pendingForwards)) {
      if (key.startsWith(`${id}:`)) delete pendingForwards[key];
    }
    delete queues[id];
    delete stopped[id];
    delete lastHumanMentionAt[id];
    if (channel.guild && readSettings().guilds?.[channel.guild.id]?.channels?.[id]) {
      updateSettings((settings) => {
        delete settings.guilds?.[channel.guild.id]?.channels?.[id];
      }).catch((error) => console.error(`[${name}] Could not clear deleted channel settings:`, error));
    }
  }

  client.on('channelDelete', forgetChannel);
  client.on('threadDelete', forgetChannel);

  client.once('clientReady', () => {
    const registry = loadJson(REGISTRY_FILE);
    registry[botKey] = { name, id: client.user.id, providerId, allowedChannelIds, pid: process.pid };
    saveJson(REGISTRY_FILE, registry);
    console.log(`[${name}] logged in as ${client.user.tag}`);
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
    const turn = (queues[key] || Promise.resolve()).then(async () => {
      if ((stopGen[key] || 0) !== gen || (message.author.bot && stopped[key])) return;
      if (message.author.bot) {
        // a bot-triggered turn may have waited in the queue while the debate hit its limit
        if (!debateSetting(readSettings(), message.guild.id, key).enabled) return;
        const { turns, noticed } = await botTurnsSinceHuman(message, { latest: true });
        if (noticed || turns >= debateSetting(readSettings(), message.guild.id, key).maxTurns) return;
      }
      const stopTyping = startTyping(message.channel);
      let savedImages;
      let draft;
      try {
        const images = imageAttachments({ attachments: new Map(attachments.map((item, i) => [i, item])) });
        const documents = documentAttachments({ attachments: new Map(attachments.map((item, i) => [i, item])) });
        savedImages = await saveImageAttachments(images);
        const docsContext = await documentContext(documents);
        const modelId = models ? resolvePref(models, prefs[key] || {}).modelId : undefined;
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
          history && `Recent messages in this Discord channel since your last reply (context only):\n${history}`,
          waitFor.length && `Replies from the agents mentioned before you in this request:\n${handoff || '(none arrived in time)'}`,
          imageContext,
          docsContext,
          `Request from ${message.author.username}:\n${requestText}` +
            (prompt.includes('Forwarded message:') ? `\n\n${prompt.slice(prompt.indexOf('Forwarded message:'))}` : ''),
        ].filter(Boolean).join('\n\n---\n');
        const ctrl = new AbortController();
        running[key] = ctrl;
        const streamReply = !isDebate && !message.author.bot &&
          (isDM || autoReply || [...message.mentions.users.values()].filter((user) => user.bot).length === 1);
        if (streamReply) draft = createDraft(message.channel);
        let result;
        const runStartedAt = Date.now();
        try {
          result = await runPrompt(fullPrompt, sessions[key], modelId, ctrl.signal, savedImages.paths, draft?.update);
        } catch (err) {
          if (ctrl.signal.aborted) return;
          throw err;
        } finally {
          if (running[key] === ctrl) delete running[key];
        }
        const runFinishedAt = Date.now();
        if ((stopGen[key] || 0) !== gen) return;
        const text = typeof result === 'string' ? result : result.text;
        if (result && result.sessionId && result.sessionId !== sessions[key]) {
          sessions[key] = result.sessionId;
          saveJson(sessionsFile, sessions);
        }
        if (result && result.sessionId) rememberSession(historyFile, {
          id: result.sessionId,
          ownerId: message.author.bot ? (allowedUserIds.length === 1 ? allowedUserIds[0] : null) : message.author.id,
          channelId: key,
          channelName: message.channel.name || 'DM',
          title: requestText,
        });
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
        const reply = isDebate ? resolvePeerMentions(text || '(empty response)', debatePeers) : text || '(empty response)';
        if (draft) await draft.finish(message, reply);
        else await sendChunked(message, reply);
        console.log(`[${name}] latency: prepare=${runStartedAt - receivedAt}ms cli=${runFinishedAt - runStartedAt}ms post=${Date.now() - runFinishedAt}ms`);
      } catch (err) {
        stopTyping();
        if (draft) await draft.cancel();
        await message.channel.send(`[${name}] Error: ${String(err.message || err).slice(0, 1800)}`);
      } finally {
        stopTyping();
        if (draft) await draft.cancel();
        if (savedImages) await savedImages.cleanup().catch(() => {});
      }
    });
    queues[key] = turn;
  }
  client.on('messageCreate', onMessage);
  client.on('messageUpdate', (before, after) => {
    if (before.partial || after.partial || after.author.bot) return;
    if (before.mentions.has(client.user) || !after.mentions.has(client.user)) return;
    onMessage(after);
  });

  function agentViewArgs(interaction, settings = readSettings()) {
    return { settings, guildId: interaction.guildId, channelId: interaction.channelId,
      channelName: interaction.channel.name || 'channel', botKey, name, defaultName,
      discordUsername: client.user.username, providerId,
      requester: interaction.user.id, allowedChannelIds, allowedUserIds, historyFallback: historyLimit,
      workdir, permissionFallback: permission, tokenConfigured: Boolean(token) };
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
    if (!interaction.guild || !userAllowed(interaction.user.id)) {
      await interaction.reply({ content: 'This setting is only available to allowed users in a server.', flags: MessageFlags.Ephemeral });
      return;
    }
    const parts = interaction.customId.split(':');
    const [, action, requester, scope] = parts;
    if (parts.length !== 3 && !(parts.length === 4 && ['prompt-save', 'idle-save', 'history-save'].includes(action))) {
      await interaction.reply({ content: 'This settings panel is outdated. Run /agent settings again.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (requester !== interaction.user.id || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
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
        await interaction.reply({ content: 'This settings panel is outdated. Run /agent settings again.', flags: MessageFlags.Ephemeral });
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
      const registry = loadJson(REGISTRY_FILE);
      if (registry[botKey]?.id === client.user.id) {
        registry[botKey].name = nextName;
        saveJson(REGISTRY_FILE, registry);
      }
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
      await interaction.reply({ content: 'This settings panel is outdated. Run /agent settings again.', flags: MessageFlags.Ephemeral });
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
      await interaction.reply({ content: 'This settings panel is outdated. Run /debate settings again.', flags: MessageFlags.Ephemeral });
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
      await interaction.reply({ content: 'This settings panel is outdated. Run /debate settings again.', flags: MessageFlags.Ephemeral });
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

  client.on('interactionCreate', async (interaction) => {
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
      if (interaction.commandName !== 'rename' || !userAllowed(interaction.user.id)) {
        await interaction.respond([]);
        return;
      }
      const query = String(interaction.options.getFocused()).toLowerCase();
      const matches = resumableFor(interaction.user.id)
        .filter((entry) => `${entry.title} ${entry.channelName} ${entry.id}`.toLowerCase().includes(query))
        .slice(0, 25)
        .map((entry) => ({ name: entry.title.slice(0, 100), value: entry.id }));
      await interaction.respond(matches);
      return;
    }

    if (interaction.isMessageContextMenuCommand()) {
      if (!userAllowed(interaction.user.id) ||
          (interaction.guild && allowedChannelIds.length && !allowedChannelIds.includes(interaction.channelId))) {
        await interaction.reply({ content: `[${name}] This channel or user is not allowed.`, flags: MessageFlags.Ephemeral });
        return;
      }
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
      const management = interaction.commandName === 'agent' || interaction.commandName === 'debate';
      if (!userAllowed(interaction.user.id) ||
          (!management && interaction.guild && allowedChannelIds.length && !allowedChannelIds.includes(interaction.channelId))) {
        await interaction.reply({ content: `[${name}] This channel or user is not allowed.`, flags: MessageFlags.Ephemeral });
        return;
      }
      const channelId = interaction.channelId;
      if (interaction.commandName === 'agent' || interaction.commandName === 'debate') {
        if (!interaction.guild) {
          await interaction.reply({ content: 'Agent settings are available in server channels.', flags: MessageFlags.Ephemeral });
          return;
        }
        const isAgent = interaction.commandName === 'agent';
        if (interaction.options.getSubcommand() !== 'settings') {
          await interaction.reply({ content: 'This command is outdated. Use /agent settings or /debate settings.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({ content: 'Manage Server permission is required to change settings.', flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({ ...(isAgent ? agentPanel(interaction) : await debatePanel(interaction)),
          flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.commandName === 'new') {
        const oldSessionId = sessions[channelId];
        if (sessions[channelId]) {
          const previous = resumableFor(interaction.user.id).find((entry) => entry.id === sessions[channelId]);
          rememberSession(historyFile, {
            id: sessions[channelId], ownerId: interaction.user.id, channelId,
            channelName: interaction.channel.name || 'DM', title: previous?.title || 'Previous conversation',
          });
        }
        stopGen[channelId] = (stopGen[channelId] || 0) + 1;
        if (running[channelId]) running[channelId].abort();
        delete stopped[channelId];
        delete sessions[channelId];
        saveJson(sessionsFile, sessions);
        releaseSession(oldSessionId);
        await interaction.reply({ content: `[${name}] New conversation started in this channel.`, flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.commandName === 'resume') {
        await interaction.reply({
          ...resumePanel(botKey, name, channelId, interaction.user.id, resumableFor(interaction.user.id), sessions[channelId]),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (interaction.commandName === 'rename') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const selectedId = interaction.options.getString('conversation') || sessions[channelId];
        const entry = resumableFor(interaction.user.id).find((candidate) => candidate.id === selectedId);
        if (!entry) {
          await interaction.editReply(`[${name}] No eligible conversation found. Use /resume or choose one in the conversation option.`);
          return;
        }
        try {
          const title = renameSession(historyFile, entry, interaction.options.getString('name', true), interaction.user.id);
          await interaction.editReply(`[${name}] Conversation named **${title}**.`);
        } catch (error) {
          await interaction.editReply(`[${name}] Could not rename it: ${String(error.message || error).slice(0, 500)}`);
        }
        return;
      }
      if (interaction.commandName === 'model') {
        await interaction.reply({ ...modelPanel(botKey, name, models, prefs[channelId] || {}), flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.commandName === 'usage') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await interaction.editReply({ embeds: [usageEmbed(name, await getUsage())] });
        } catch (error) {
          await interaction.editReply(`[${name}] Could not read usage: ${String(error.message || error).slice(0, 500)}`);
        }
        return;
      }
      if (interaction.commandName === 'usage-all') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const agents = Object.values(loadJson(REGISTRY_FILE)).filter((agent) =>
          isRunningAgent(agent) && ['claude', 'codex', 'gemini'].includes(agent.providerId));
        const results = await Promise.allSettled(agents.map(async (agent) => {
          const reader = require(`./providers/${agent.providerId}`)({ workdir, permission });
          return usageEmbed(agent.name, await reader.usage());
        }));
        const embeds = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
        const errors = results.flatMap((result, index) => result.status === 'rejected'
          ? [`${agents[index].name}: ${String(result.reason.message || result.reason).slice(0, 300)}`] : []);
        await interaction.editReply({
          content: errors.length ? `Could not read some usage data:\n${errors.join('\n').slice(0, 1800)}` : embeds.length ? '' : 'No running agents found.',
          embeds: embeds.slice(0, 10),
        });
        for (let index = 10; index < embeds.length; index += 10) {
          await interaction.followUp({ embeds: embeds.slice(index, index + 10), flags: MessageFlags.Ephemeral });
        }
        return;
      }
      if (interaction.commandName === 'stop' || interaction.commandName === 'stop-all') {
        stopChannel(channelId);
        if (interaction.commandName === 'stop-all') publishStop(channelId);
        await interaction.reply({
          content: interaction.commandName === 'stop-all' ? 'Stopped all agents in this channel.' : `[${name}] Stopped work in this channel.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      return;
    }

    if (!interaction.isStringSelectMenu() && !interaction.isButton()) return;
    const [bot, field, targetChannel, requester, pageText] = interaction.customId.split(':');
    if (bot !== botKey) return;
    if (!userAllowed(interaction.user.id)) {
      await interaction.reply({ content: `[${name}] You're not on this bot's user list.`, ephemeral: true });
      return;
    }

    if (field === 'resume' || field === 'resume-page') {
      if (interaction.user.id !== requester || interaction.channelId !== targetChannel ||
          (interaction.guild && allowedChannelIds.length && !allowedChannelIds.includes(targetChannel))) {
        await interaction.reply({ content: `[${name}] This menu can only be used by its requester in the original channel.`, ephemeral: true });
        return;
      }
      await interaction.deferUpdate();
      const entries = resumableFor(requester);
      if (field === 'resume-page') {
        await interaction.editReply(resumePanel(botKey, name, targetChannel, requester, entries, sessions[targetChannel], Number(pageText)));
        return;
      }
      const chosen = entries.find((entry) => entry.id === interaction.values[0]);
      if (!chosen) {
        await interaction.editReply({ content: `[${name}] That conversation is no longer available. Run /resume again.`, components: [] });
        return;
      }
      const oldChannel = Object.keys(sessions).find((id) => id !== targetChannel && sessions[id] === chosen.id);
      const pending = [queues[targetChannel], oldChannel && queues[oldChannel]].filter(Boolean);
      const switchTurn = Promise.all(pending).then(() => {
        const oldSessionId = sessions[targetChannel];
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

    if (!models || !interaction.isStringSelectMenu()) return;

    const key = interaction.channelId;
    const pref = { ...(prefs[key] || {}) };
    if (field === 'model') pref.model = interaction.values[0];
    if (field === 'effort') pref.effort = interaction.values[0];
    const { model, effort } = resolvePref(models, pref);
    prefs[key] = { model: model.key, effort: effort || pref.effort };
    saveJson(prefsFile, prefs);
    await interaction.update(modelPanel(botKey, name, models, prefs[key]));
  });

  client.login(token);
  return client;
}

module.exports = { startBot, untilText, usageEmbed, resumePanel, messageFromContext, createDraft,
  isPrivateChannel, shouldAutoReply };
