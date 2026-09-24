const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { REST, Routes } = require('discord.js');
const { commandDefinitions } = require('../src/commands');

const root = path.join(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'bots')).filter((file) => file.endsWith('.env'));

async function main() {
  const plans = [];
  for (const file of files) {
    const env = dotenv.parse(fs.readFileSync(path.join(root, 'bots', file)));
    if (!env.DISCORD_BOT_TOKEN) throw new Error(`${file}: DISCORD_BOT_TOKEN is missing`);
    const botName = env.BOT_NAME || path.basename(file, '.env');
    const definitions = commandDefinitions(botName);
    const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
    const application = await rest.get(Routes.oauth2CurrentApplication());
    const route = Routes.applicationCommands(application.id);
    const existing = await rest.get(route);
    const wanted = new Set(definitions.map((command) => `${command.type}:${command.name}`));
    const unrelated = existing.filter((command) => !wanted.has(`${command.type}:${command.name}`));
    if (unrelated.length) {
      throw new Error(`${file}: found other global commands; refusing to replace them: ${unrelated.map((command) => command.name).join(', ')}`);
    }
    const guildPlans = [];
    const guilds = await rest.get(Routes.userGuilds());
    for (const guild of guilds) {
      const guildRoute = Routes.applicationGuildCommands(application.id, guild.id);
      const guildExisting = await rest.get(guildRoute);
      const guildUnrelated = guildExisting.filter((command) => !wanted.has(`${command.type}:${command.name}`));
      if (guildUnrelated.length) {
        throw new Error(`${file}: found other commands in ${guild.name}; refusing to replace them: ${guildUnrelated.map((command) => command.name).join(', ')}`);
      }
      guildPlans.push({ name: guild.name, route: guildRoute });
    }
    plans.push({ botName, rest, route, definitions, guildPlans });
  }
  for (const plan of plans) {
    await plan.rest.put(plan.route, { body: plan.definitions });
    for (const guild of plan.guildPlans) {
      await plan.rest.put(guild.route, { body: plan.definitions });
    }
    console.log(`${plan.botName}: registered ${plan.definitions.length} commands globally and in ${plan.guildPlans.length} server(s)`);
  }
}

main().catch((error) => {
  console.error(String(error.message || error));
  process.exitCode = 1;
});
