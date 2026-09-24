// Usage: node src/bot.js <name>   — runs the bot configured in bots/<name>.env
const path = require('path');

const key = (process.argv[2] || '').trim().toLowerCase();
if (!/^[a-z0-9_-]+$/.test(key)) {
  console.error('usage: node src/bot.js <name>   (reads bots/<name>.env)');
  process.exit(1);
}
const envFile = path.join(__dirname, '..', 'bots', `${key}.env`);
const loaded = require('dotenv').config({ path: envFile });
if (loaded.error) {
  console.error(`can't read ${envFile}: copy one of bots/*.env.example to bots/${key}.env and fill it in`);
  process.exit(1);
}

const { startBot } = require('./runner');

function csv(name) {
  return (process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function required(name) {
  const value = (process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is not set in bots/${key}.env`);
  return value;
}

const PROVIDERS = {
  claude: 'claude', anthropic: 'claude',
  codex: 'codex', chatgpt: 'codex', openai: 'codex',
  gemini: 'gemini', antigravity: 'gemini', google: 'gemini',
};
const providerId = PROVIDERS[required('PROVIDER').toLowerCase()];
if (!providerId) throw new Error(`PROVIDER must be claude, codex or gemini (got "${process.env.PROVIDER}")`);

// read-only (default) | edit | full
const permission = (process.env.PERMISSIONS || 'read-only').trim().toLowerCase();
if (!['read-only', 'edit', 'full'].includes(permission)) {
  throw new Error(`PERMISSIONS must be read-only, edit or full (got "${permission}")`);
}

const provider = require(`./providers/${providerId}`)({ workdir: required('WORKSPACE_DIR'), permission });

startBot({
  key,
  token: required('DISCORD_BOT_TOKEN'),
  name: (process.env.BOT_NAME || '').trim() || provider.defaultName,
  role: (process.env.ROLE || '').trim(),
  owner: (process.env.OWNER_NAME || '').trim() || 'the user',
  runPrompt: provider.run,
  providerId,
  models: provider.models,
  getUsage: provider.usage,
  allowedChannelIds: csv('ALLOWED_CHANNEL_IDS'),
  allowedUserIds: csv('ALLOWED_USER_IDS'),
  debateChannelIds: csv('DEBATE_CHANNEL_IDS'),
  maxBotTurns: Number(process.env.MAX_BOT_TURNS) || 4,
  historyLimit: Number(process.env.HISTORY_LIMIT) || 20,
});
