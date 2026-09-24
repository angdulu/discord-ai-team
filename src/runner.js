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
  PermissionFlagsBits,
  OverwriteType,
} = require('discord.js');
const { attachmentsForTurn, imageAttachments, documentAttachments, saveImageAttachments } = require('./attachments');
const { documentContext } = require('./documents');
const { rememberSession, listResumableSessions, assignSession } = require('./session-history');

const MAX_CHUNK = 1900;
const RESET_COMMANDS = ['!new', '!reset'];
const MODEL_COMMANDS = ['!model', '!models'];
const RESUME_COMMANDS = ['!resume'];
const USAGE_COMMANDS = ['!usage'];
const STOP_COMMANDS = ['!stop'];
const FORWARD_WAIT_MS = 1500;

// sessions, model choices and the shared bot registry live here (git-ignored)
const STATE_DIR = path.join(__dirname, '..', 'state');
// every running bot records { name, id, role } here, so bots can find each other for debates
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
        const resets = b.resetsText ? `resets ${b.resetsText}` : `resets in ${untilText(b.resetsAt)}`;
        return `\`${b.label.padEnd(6)}\` ${usageBar(b.left)} **${Math.round(b.left)}%** left · ${resets}`;
      })
      .join('\n');
    embed.addFields({ name: s.name, value });
  }
  if (usage.note) embed.setFooter({ text: usage.note });
  return embed;
}

// bot turns in the chain since the last human message (consecutive messages by one bot = one turn);
// Infinity if that human message was !stop, so the chain stays dead until someone mentions a bot again
// noticed: a bot already posted the limit notice in this chain (parallel branches can hit the limit twice)
const LIMIT_NOTICE = 'Agent-to-agent limit';
// latest: count the chain as it stands now (including messages after this one), for re-checking a queued turn
async function botTurnsSinceHuman(message, { latest = false } = {}) {
  let fetched;
  try {
    fetched = await message.channel.messages.fetch(latest ? { limit: 30 } : { limit: 30, before: message.id });
  } catch {
    return { turns: Infinity, noticed: true };
  }
  let turns = latest ? 0 : 1;
  let noticed = false;
  let lastAuthor = latest ? null : message.author.id;
  for (const m of fetched.values()) { // newest first
    if (!m.author.bot) {
      return STOP_COMMANDS.includes(m.content.trim().toLowerCase()) ? { turns: Infinity, noticed: true } : { turns, noticed };
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

function debatePreamble({ name, role, owner, maxBotTurns, peers }) {
  const peerList = peers
    .map((a) => `${a.name}${a.role ? ` (${a.role})` : ''} = <@${a.id}>`)
    .join(', ');
  return (
    `You are ${name}${role ? `, the ${role},` : ''} in a multi-agent discussion channel. Other agents: ${peerList || 'none'}. ` +
    `Keep the discussion going: end your reply by tagging one other agent (its tag exactly as written, e.g. <@id>) ` +
    `with a counterpoint or a question. Leave tags out only when you clearly agree and have nothing to add. ` +
    `At most ${maxBotTurns} agent turns run before ${owner} must step in. ` +
    `Final decisions belong to ${owner}: propose and argue, but don't declare anything settled. ` +
    `Agents not listed here only act when ${owner} calls them, so don't tag them.`
  );
}
// Explicit IDs stay supported. New channels can also become debate channels when each bot
// has been added to that channel's permissions (directly or through a non-everyone role).
function configuredDebatePeers(channelId, botKey) {
  return Object.entries(loadJson(REGISTRY_FILE))
    .filter(([key, agent]) => key !== botKey && (agent.debateChannelIds || []).includes(channelId))
    .map(([, agent]) => agent);
}

function explicitlyInvited(channel, member) {
  const overwrites = channel.permissionOverwrites && channel.permissionOverwrites.cache;
  if (!overwrites) return false;
  return [...overwrites.values()].some((overwrite) => {
    if (!overwrite.allow.has(PermissionFlagsBits.ViewChannel)) return false;
    if (overwrite.type === OverwriteType.Member) return overwrite.id === member.id;
    return overwrite.type === OverwriteType.Role &&
      overwrite.id !== channel.guild.id && member.roles.cache.has(overwrite.id);
  });
}

function canDebate(channel, member) {
  const permissions = channel.permissionsFor(member);
  return permissions && permissions.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
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

async function autoDebatePeers(channel, selfId, botKey) {
  if (!channel.guild || !channel.permissionOverwrites) return [];
  const candidates = Object.entries(loadJson(REGISTRY_FILE))
    .filter(([key, agent]) => key !== botKey && isRunningAgent(agent))
    .map(([, agent]) => agent);
  if (!candidates.length) return [];
  const self = await channel.guild.members.fetch(selfId).catch(() => null);
  if (!self || !explicitlyInvited(channel, self) || !canDebate(channel, self)) return [];
  const peers = await Promise.all(candidates.map(async (agent) => {
    const member = await channel.guild.members.fetch(agent.id).catch(() => null);
    return member && explicitlyInvited(channel, member) && canDebate(channel, member) ? agent : null;
  }));
  return peers.filter(Boolean);
}

function uniquePeers(...groups) {
  return [...new Map(groups.flat().map((agent) => [agent.id, agent])).values()];
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
    try {
      await message.channel.sendTyping();
    } catch {
      // ignore typing indicator failures
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
async function sendChunked(message, text) {
  let rest = cleanReply(text);
  while (rest.length > MAX_CHUNK) {
    let cut = rest.lastIndexOf('\n', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = rest.lastIndexOf(' ', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
    await message.channel.send(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) await message.channel.send(rest);
}

// key: the bots/<key>.env file name · allowedUserIds: empty = anyone who can post in allowed channels
function startBot({
  key: botKey, token, name, role, owner, runPrompt, providerId, models, getUsage,
  allowedChannelIds, allowedUserIds, debateChannelIds, maxBotTurns, historyLimit,
}) {
  const sessionsFile = path.join(STATE_DIR, `${botKey}.sessions.json`);
  const sessions = loadJson(sessionsFile);
  const historyFile = path.join(STATE_DIR, `${botKey}.history.json`);
  const prefsFile = path.join(STATE_DIR, `${botKey}.prefs.json`);
  const prefs = loadJson(prefsFile); // channelId -> { model, effort }
  const queues = {}; // channelId -> promise chain, so one channel's turns run in order
  const pendingForwards = {}; // `${channelId}:${authorId}` -> { text, at }
  const running = {}; // channelId -> AbortController for the in-flight CLI call
  const stopGen = {}; // channelId -> bumped by !stop so queued turns are dropped
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

  client.once('clientReady', () => {
    const registry = loadJson(REGISTRY_FILE);
    registry[botKey] = { name, id: client.user.id, role, debateChannelIds, pid: process.pid };
    saveJson(REGISTRY_FILE, registry);
    console.log(`[${name}] logged in as ${client.user.tag}`);
  });

  client.on('messageCreate', async (message) => {
    const isDM = !message.guild;
    if (!isDM && allowedChannelIds.length && !allowedChannelIds.includes(message.channelId)) return;
    if (!message.author.bot && !userAllowed(message.author.id)) return;
    const key = message.channelId;
    const configured = debateChannelIds.includes(key);
    const autoPeers = isDM ? [] : await autoDebatePeers(message.channel, client.user.id, botKey);
    const debatePeers = uniquePeers(
      configured ? configuredDebatePeers(key, botKey) : [],
      autoPeers,
    );
    const isDebate = !isDM && (configured || autoPeers.length > 0);

    if (message.author.bot) {
      // Only registered peers in an enabled debate channel can trigger another agent.
      if (!isDebate || !debatePeers.some((agent) => agent.id === message.author.id)) return;
      if (!message.mentions.has(client.user)) return;
      const { turns, noticed } = await botTurnsSinceHuman(message);
      if (turns >= maxBotTurns) {
        if (!noticed) await message.channel.send(`[${name}] ${LIMIT_NOTICE} (${maxBotTurns}) reached. Mention one of us to continue.`);
        return;
      }
    }

    async function sendUsage() {
      try {
        await message.channel.send({ embeds: [usageEmbed(name, await getUsage())] });
      } catch (err) {
        await message.channel.send(`[${name}] Couldn't read usage: ${String(err.message || err).slice(0, 500)}`);
      }
    }

    // !usage with no mention: every bot in the channel reports
    if (!message.author.bot && getUsage && USAGE_COMMANDS.includes(message.content.trim().toLowerCase())) {
      await sendUsage();
      return;
    }

    // !stop needs no mention: kills this bot's running call in the channel and drops queued turns
    if (!message.author.bot && STOP_COMMANDS.includes(message.content.trim().toLowerCase())) {
      stopGen[key] = (stopGen[key] || 0) + 1;
      const hadWork = Boolean(running[key]);
      if (running[key]) running[key].abort();
      if (hadWork || isDebate) await message.react('🛑').catch(() => {});
      return;
    }

    // a forward arrives with empty content (text lives in messageSnapshots) and can't carry a mention,
    // so in servers it's held briefly and attached to the same user's next @mention
    const fwdKey = `${message.channelId}:${message.author.id}`;
    const forwarded = forwardedText(message);
    const mentioned = message.mentions.has(client.user);
    if (forwarded && !isDM && !mentioned) {
      pendingForwards[fwdKey] = { text: forwarded, at: Date.now() };
      return;
    }
    if (!isDM && !mentioned) return;

    let prompt = message.content
      .replace(`<@${client.user.id}>`, '')
      .replace(`<@!${client.user.id}>`, '')
      .trim();
    if (forwarded) {
      prompt = `${prompt}\n\nForwarded message:\n${forwarded}`.trim();
    } else if (!isDM) {
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

    if (RESET_COMMANDS.includes(prompt.toLowerCase())) {
      if (sessions[key]) {
        const previous = resumableFor(message.author.id).find((entry) => entry.id === sessions[key]);
        rememberSession(historyFile, {
          id: sessions[key], ownerId: message.author.id, channelId: key,
          channelName: message.channel.name || 'DM', title: previous?.title || 'Previous conversation',
        });
      }
      delete sessions[key];
      saveJson(sessionsFile, sessions);
      await message.channel.send(`[${name}] New conversation — next message starts a fresh session`);
      return;
    }

    if (!message.author.bot && RESUME_COMMANDS.includes(prompt.toLowerCase())) {
      const entries = resumableFor(message.author.id);
      await message.reply({ ...resumePanel(botKey, name, key, message.author.id, entries, sessions[key]), allowedMentions: { parse: [], repliedUser: false } });
      return;
    }

    if (getUsage && USAGE_COMMANDS.includes(prompt.toLowerCase())) {
      await sendUsage();
      return;
    }

    if (models && MODEL_COMMANDS.includes(prompt.toLowerCase())) {
      await message.channel.send(modelPanel(botKey, name, models, prefs[key] || {}));
      return;
    }

    const gen = stopGen[key] || 0;
    const turn = (queues[key] || Promise.resolve()).then(async () => {
      if ((stopGen[key] || 0) !== gen) return;
      if (message.author.bot) {
        // a bot-triggered turn may have waited in the queue while the debate hit its limit
        const { turns, noticed } = await botTurnsSinceHuman(message, { latest: true });
        if (noticed || turns >= maxBotTurns) return;
      }
      try {
        await message.channel.sendTyping();
      } catch {
        // ignore typing indicator failures
      }

      let savedImages;
      try {
        const images = imageAttachments({ attachments: new Map(attachments.map((item, i) => [i, item])) });
        const documents = documentAttachments({ attachments: new Map(attachments.map((item, i) => [i, item])) });
        savedImages = await saveImageAttachments(images);
        const docsContext = await documentContext(documents);
        const modelId = models ? resolvePref(models, prefs[key] || {}).modelId : undefined;
        const history = isDM ? '' : await recentHistory(message, client.user.id, historyLimit);
        const waitFor = isDM ? [] : earlierMentionedBots(message, client.user.id);
        const handoff = waitFor.length ? await waitForReplies(message, waitFor, () => (stopGen[key] || 0) !== gen) : '';
        if ((stopGen[key] || 0) !== gen) return;
        const intro =
          `You are ${name}${role ? ` (${role})` : ''}, an AI agent answering in Discord. ` +
          `Your final text is posted to the channel automatically, so just answer; don't try to send messages yourself. ` +
          (isDM ? '' : `A message may @mention several agents. If it gives each agent its own part, do only yours (${name}); ` +
            `if it asks all of you the same thing, answer it yourself.`);
        const requestText = message.content.replace(/<@!?\d+>/g, '').trim()
          ? readableMentions(message.content, message, client.user.id).trim()
          : savedImages.paths.length ? 'Please inspect and describe the attached image(s).'
            : documents.length ? 'Please read and respond to the attached document(s).' : 'Please respond to the forwarded message.';
        const imageContext = savedImages.paths.length
          ? `Discord image attachments (temporary local files):\n${savedImages.paths.map((file, i) => `${i + 1}. ${file}`).join('\n')}\n` +
            'Inspect each image before answering. Do not infer its contents from the filename or reveal these temporary paths.'
          : '';
        const fullPrompt = [
          intro,
          history && `Recent messages in this Discord channel since your last reply (context only):\n${history}`,
          waitFor.length && `Replies from the agents mentioned before you in this request:\n${handoff || '(none arrived in time)'}`,
          imageContext,
          docsContext,
          `Request from ${message.author.username}:\n${requestText}` +
            (prompt.includes('Forwarded message:') ? `\n\n${prompt.slice(prompt.indexOf('Forwarded message:'))}` : ''),
        ].filter(Boolean).join('\n\n---\n');
        const ctrl = new AbortController();
        running[key] = ctrl;
        let result;
        try {
          const preamble = isDebate ? `${debatePreamble({ name, role, owner, maxBotTurns, peers: debatePeers })}\n\n` : '';
          result = await runPrompt(preamble + fullPrompt, sessions[key], modelId, ctrl.signal, savedImages.paths);
        } catch (err) {
          if (ctrl.signal.aborted) return;
          throw err;
        } finally {
          if (running[key] === ctrl) delete running[key];
        }
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
        if (message.author.bot) {
          // the debate may have hit its limit while this answer was being written; don't post past it
          const { turns, noticed } = await botTurnsSinceHuman(message, { latest: true });
          if (noticed || turns >= maxBotTurns) {
            console.log(`[${name}] dropped a late debate reply (limit reached while it ran)`);
            return;
          }
        }
        await sendChunked(message, text || '(empty response)');
      } catch (err) {
        await message.channel.send(`[${name}] Error: ${String(err.message || err).slice(0, 1800)}`);
      } finally {
        if (savedImages) await savedImages.cleanup().catch(() => {});
      }
    });
    queues[key] = turn;
  });

  client.on('interactionCreate', async (interaction) => {
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
        await interaction.editReply({ content: `[${name}] That conversation is no longer available. Run !resume again.`, components: [] });
        return;
      }
      const oldChannel = Object.keys(sessions).find((id) => id !== targetChannel && sessions[id] === chosen.id);
      const pending = [queues[targetChannel], oldChannel && queues[oldChannel]].filter(Boolean);
      const switchTurn = Promise.all(pending).then(() => {
        assignSession(sessions, targetChannel, chosen.id);
        saveJson(sessionsFile, sessions);
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

module.exports = { startBot, untilText, usageEmbed, resumePanel };
