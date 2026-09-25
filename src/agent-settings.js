const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const FILE = path.join(__dirname, '..', 'state', 'agent-settings.json');
const IDLE_DEFAULTS = { claude: null, codex: null, gemini: 5 };
const DEFAULT_DEBATE_TURNS = 4;
const DEFAULT_DEBATE_ENABLED = true;
const DEFAULT_HISTORY_LIMIT = 20;
const PERMISSION_MODES = ['read-only', 'edit', 'full'];

function readSettings(file = FILE) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function updateSettings(change, file = FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let fd;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock);
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (fd === undefined) throw new Error('Settings are busy; please try again');
  try {
    const settings = readSettings(file);
    const result = change(settings);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return result;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

function guildSettings(settings, guildId) {
  settings.guilds ||= {};
  return settings.guilds[guildId] ||= {};
}

function channelSettings(settings, guildId, channelId) {
  const guild = guildSettings(settings, guildId);
  guild.channels ||= {};
  return guild.channels[channelId] ||= {};
}

function stamp(target, user) {
  target.updatedAt = Date.now();
  target.updatedBy = { id: user.id, name: user.globalName || user.username };
}

function debateSetting(settings, guildId, channelId) {
  const saved = settings.guilds?.[guildId]?.channels?.[channelId]?.debate;
  const maxTurns = Number(saved?.maxTurns);
  const explicit = saved?.enabled === true || saved?.mode === 'on' ? true
    : saved?.enabled === false || saved?.mode === 'off' ? false : null;
  return {
    enabled: explicit ?? DEFAULT_DEBATE_ENABLED,
    source: explicit === null ? 'default' : 'channel',
    maxTurns: Number.isInteger(maxTurns) && maxTurns >= 1 && maxTurns <= 20 ? maxTurns : DEFAULT_DEBATE_TURNS,
  };
}

function promptSetting(settings, guildId, channelId, botKey) {
  const guild = settings.guilds?.[guildId] || {};
  const channel = guild.channels?.[channelId] || {};
  const local = channel.agents?.[botKey]?.prompt;
  const server = guild.agents?.[botKey]?.prompt;
  const serverText = server?.text || '';
  const channelText = local?.text || '';
  return { text: [serverText, channelText].filter(Boolean).join('\n\n'), serverText, channelText,
    source: [serverText && 'server', channelText && 'channel'].filter(Boolean).join('+') || 'default',
    changed: local || server || null };
}

function agentNameSetting(settings, botKey, defaultName) {
  const saved = settings.agentNames?.[botKey]?.name;
  const custom = typeof saved === 'string' && saved.trim().length > 0;
  return { name: custom ? saved : defaultName, source: custom ? 'custom' : 'provider default' };
}

function historySetting(settings, guildId, channelId, botKey, fallback = DEFAULT_HISTORY_LIMIT) {
  const saved = settings.guilds?.[guildId]?.channels?.[channelId]?.agents?.[botKey]?.historyLimit;
  const valid = (value) => Number.isInteger(value) && value >= 1 && value <= 100;
  return { limit: valid(saved) ? saved : valid(fallback) ? fallback : DEFAULT_HISTORY_LIMIT,
    source: valid(saved) ? 'channel' : 'default' };
}

function permissionSetting(settings, botKey, fallback = 'read-only') {
  const saved = settings.permissions?.[botKey]?.mode;
  const defaultMode = PERMISSION_MODES.includes(fallback) ? fallback : 'read-only';
  return { mode: PERMISSION_MODES.includes(saved) ? saved : defaultMode,
    source: PERMISSION_MODES.includes(saved) ? 'discord' : 'default' };
}

function idleSetting(settings, botKey, providerId) {
  const saved = settings.idle?.[botKey];
  const fallback = IDLE_DEFAULTS[providerId] ?? null;
  return { enabled: saved?.enabled ?? fallback !== null, minutes: saved?.minutes ?? fallback ?? 10,
    source: saved ? 'agent' : 'default', changed: saved || null };
}

function idleTimeoutMs(settings, botKey, providerId) {
  const idle = idleSetting(settings, botKey, providerId);
  return idle.enabled ? idle.minutes * 60000 : null;
}

module.exports = {
  FILE, readSettings, updateSettings, guildSettings, channelSettings, stamp,
  DEFAULT_DEBATE_TURNS, DEFAULT_DEBATE_ENABLED, DEFAULT_HISTORY_LIMIT, debateSetting, promptSetting, agentNameSetting,
  PERMISSION_MODES, historySetting, permissionSetting, idleSetting, idleTimeoutMs,
};
