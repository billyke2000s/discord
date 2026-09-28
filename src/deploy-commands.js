// Registers slash commands with Discord. The bot also does this by itself every time it starts,
// so you normally never need to run this by hand.
// Commands are registered per server, and /setup rebuild is left out on servers where it's locked.
require('dotenv').config({ quiet: true });
const { REST, Routes } = require('discord.js');
const { commandBody, rebuildLocked } = require('./lib/commandsync');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Set DISCORD_TOKEN and CLIENT_ID in .env');
  process.exit(1);
}
const rest = new REST().setToken(DISCORD_TOKEN);

(async () => {
  // Clear any old global registration so commands don't show up twice.
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
  if (!GUILD_ID) {
    console.log('No GUILD_ID set: the bot registers commands in each server when it starts.');
    return;
  }
  const res = await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commandBody(GUILD_ID) });
  console.log(`Registered ${res.length} commands to server ${GUILD_ID}${rebuildLocked(GUILD_ID) ? ' (/setup rebuild hidden: locked)' : ''}.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
