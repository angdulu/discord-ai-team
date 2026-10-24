const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { REST, Routes } = require('discord.js');
const { refreshControlPanels } = require('../src/panel-migration');
const { readSettings, agentNameSetting } = require('../src/agent-settings');

async function main() {
  const root = path.join(__dirname, '..');
  const targets = process.argv.slice(2);
  const files = fs.readdirSync(path.join(root, 'bots')).filter((file) =>
    file.endsWith('.env') && (!targets.length || targets.includes(path.basename(file, '.env'))));
  if (!files.length) throw new Error('No matching bot configurations.');
  for (const file of files) {
    const env = dotenv.parse(fs.readFileSync(path.join(root, 'bots', file)));
    if (!env.DISCORD_BOT_TOKEN) throw new Error(`${file}: Discord token is missing`);
    const botKey = path.basename(file, '.env');
    const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
    const self = await rest.get(Routes.user('@me'));
    const channelIds = new Set();
    const allowed = (env.ALLOWED_CHANNEL_IDS || '').split(',').map((id) => id.trim()).filter(Boolean);
    for (const guild of await rest.get(Routes.userGuilds())) {
      for (const channel of await rest.get(Routes.guildChannels(guild.id))) {
        if ([0, 5].includes(channel.type)) channelIds.add(channel.id);
      }
    }
    for (const suffix of ['sessions', 'channels']) {
      const stateFile = path.join(root, 'state', `${botKey}.${suffix}.json`);
      if (fs.existsSync(stateFile)) for (const id of Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8')))) channelIds.add(id);
    }
    const name = agentNameSetting(readSettings(), botKey, self.username).name;
    const result = await refreshControlPanels({ rest, botId: self.id, name,
      channelIds: [...channelIds].filter((id) => !allowed.length || allowed.includes(id)) });
    console.log(`${botKey}: updated ${result.updated} existing panels; skipped ${result.inaccessible} inaccessible channels`);
  }
}

main().catch((error) => { console.error(error.message || 'Could not refresh panels'); process.exitCode = 1; });
