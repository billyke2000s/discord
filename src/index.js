require('dotenv').config({ quiet: true });
const { Client, GatewayIntentBits, Partials, Events, MessageFlags, Options } = require('discord.js');
const { MusicManager } = require('./lib/music');
const { commands, findComponent } = require('./commands');
const registerEvents = require('./events');
const voice = require('./commands/voice');
const verify = require('./commands/verify');
const scamfilter = require('./lib/scamfilter');
const antiRaid = require('./lib/antiraid');
const backup = require('./lib/backup');
const { embed, log } = require('./lib/util');
const { syncGuild } = require('./lib/commandsync');

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,     // privileged: enable "Server Members Intent" in the dev portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,   // privileged: enable "Message Content Intent" (for edit/delete logs + scam filter)
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  allowedMentions: { parse: ['users'], repliedUser: false },
  // Keep less in memory. Low-memory servers remember fewer recent messages per channel
  // (used to show the old text in edit/delete logs).
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: process.env.LOW_MEMORY === 'yes' ? 50 : 150,
    ReactionManager: 0,
    ReactionUserManager: 0,
    GuildEmojiManager: 0,
    GuildStickerManager: 0,
    PresenceManager: 0,
    StageInstanceManager: 0,
  }),
});

// Shoukaku must be created before login so it can catch the READY packet.
client.music = new MusicManager(client);
registerEvents(client);

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
  // Register slash commands per server (and hide /setup rebuild where it's locked).
  for (const g of c.guilds.cache.values()) {
    if (process.env.GUILD_ID && g.id !== process.env.GUILD_ID) continue;
    await syncGuild(g).catch((e) => console.error(`[commands] ${g.name}:`, e.message));
  }
  await voice.sweep(client).catch((e) => console.error('[sweep]', e));
  scamfilter.start();
  const locked = antiRaid.restore((gid) => {
    const g = client.guilds.cache.get(gid);
    if (g) log(g, embed('ok').setDescription('🔓 Lockdown expired.'));
  });
  if (locked) console.log(`[lockdown] ${locked} lockdown(s) still active after restart`);
  backup.start();
  setInterval(() => {
    verify.sweepUnverified(client).catch((e) => console.error('[verify sweep]', e));
    // empty join-to-create channels older than 10 min
    voice.sweep(client, 10 * 60_000).catch((e) => console.error('[vc sweep]', e));
  }, 60_000);
});

client.on(Events.GuildCreate, (g) => {
  if (process.env.GUILD_ID && g.id !== process.env.GUILD_ID) return;
  syncGuild(g).catch((e) => console.error(`[commands] ${g.name}:`, e.message));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inGuild()) return;
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = commands.get(interaction.commandName);
      if (cmd) await cmd.execute(interaction);
    } else if (interaction.isButton() || interaction.isModalSubmit()) {
      const handler = findComponent(interaction.customId);
      if (handler) await handler(interaction);
    }
  } catch (err) {
    console.error(`[interaction ${interaction.commandName || interaction.customId}]`, err);
    const msg = { content: `Something went wrong: ${String(err.message).slice(0, 300)}`, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

async function shutdown() {
  console.log('Shutting down...');
  for (const q of [...client.music.queues.values()]) await q.destroy();
  await client.destroy();
  try { require('./lib/db').db.close(); } catch {} // writes everything into the main database file
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('Login failed:', e.message);
  process.exit(1);
});
