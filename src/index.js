require('dotenv').config({ quiet: true });
const { Client, GatewayIntentBits, Partials, Events, MessageFlags, Options } = require('discord.js');
const { MusicManager } = require('./lib/music');
const { commands, findComponent } = require('./commands');
const registerEvents = require('./events');
const voice = require('./commands/voice');
const verify = require('./commands/verify');
const birthday = require('./commands/birthday');
const updateBridge = require('./lib/update-bridge');
const scamfilter = require('./lib/scamfilter');
const antiRaid = require('./lib/antiraid');
const backup = require('./lib/backup');
const live = require('./lib/live');
const { embed, log } = require('./lib/util');
const { syncGuild } = require('./lib/commandsync');
const commandGuide = require('./lib/command-guide');
const { startHealth } = require('./lib/health');
const { hasCommandPermission } = require('./lib/permissions');
const { ensureConfiguredOwnerRole } = require('./lib/owner-role');
const { getSettings, updateSettings } = require('./lib/db');

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers, // privileged: enable "Server Members Intent" in the dev portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: enable "Message Content Intent" (for edit/delete logs + scam filter)
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
client.music = new MusicManager(client, { store: require('./lib/music-store') });
const stopHealth = startHealth(client);
registerEvents(client);

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
  // Register slash commands per server (and hide /setup rebuild where it's locked).
  for (const g of c.guilds.cache.values()) {
    if (process.env.GUILD_ID && g.id !== process.env.GUILD_ID) continue;
    await ensureConfiguredOwnerRole(g, getSettings(g.id), (patch) => updateSettings(g.id, patch)).catch((e) =>
      console.error('[owner display role]', e.message),
    );
    await syncGuild(g).catch((e) => console.error(`[commands] ${g.name}:`, e.message));
    await commandGuide.postGuide(g).catch((e) => console.error(`[command guide] ${g.name}:`, e.message));
  }
  await voice.sweep(client).catch((e) => console.error('[sweep]', e));
  // Music that was playing before the restart carries on (if the music server is already connected).
  client.music.restoreAll().catch((e) => console.error('[music resume]', e.message));
  scamfilter.start();
  const locked = antiRaid.restore((gid) => {
    const g = client.guilds.cache.get(gid);
    if (g) log(g, embed('ok').setDescription('🔓 Lockdown expired.'));
  });
  if (locked) console.log(`[lockdown] ${locked} lockdown(s) still active after restart`);
  backup.start();
  live.start(client, getSettings);
  updateBridge.start(client);
  birthday.sweep(client).catch((e) => console.error('[birthday]', e.message));
  setInterval(() => {
    birthday.sweep(client).catch((e) => console.error('[birthday]', e.message));
    verify.sweepUnverified(client).catch((e) => console.error('[verify sweep]', e));
    // empty join-to-create channels older than 10 min
    voice.sweep(client, 10 * 60_000).catch((e) => console.error('[vc sweep]', e));
  }, 60_000);
});

client.on(Events.GuildCreate, (g) => {
  if (process.env.GUILD_ID && g.id !== process.env.GUILD_ID) return;
  ensureConfiguredOwnerRole(g, getSettings(g.id), (patch) => updateSettings(g.id, patch)).catch((e) =>
    console.error('[owner display role]', e.message),
  );
  syncGuild(g).catch((e) => console.error(`[commands] ${g.name}:`, e.message));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inGuild()) return;
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = commands.get(interaction.commandName);
      // A command removed in an update can stay in Discord's list until the next sync: answer instead of timing out.
      if (!cmd)
        return interaction.reply({
          content: 'That command no longer exists. Discord may take a moment to refresh the command list.',
          flags: MessageFlags.Ephemeral,
        });
      // Default slash permissions are configurable in Discord; enforce the
      // command's required permissions again before performing privileged work.
      if (!hasCommandPermission(cmd, interaction.memberPermissions))
        return interaction.reply({
          content: 'You do not have permission to use this command.',
          flags: MessageFlags.Ephemeral,
        });
      await cmd.execute(interaction);
    } else if (interaction.isButton() || interaction.isModalSubmit() || interaction.isAnySelectMenu()) {
      const handler = findComponent(interaction.customId);
      if (handler) await handler(interaction);
    }
  } catch (err) {
    console.error(`[interaction ${interaction.commandName || interaction.customId}]`, err);
    const msg = {
      // Raw errors can contain internal details; the full error is in the bot log above.
      content:
        'Something went wrong with that. Try again, and if it keeps happening, tell staff (details are in the bot log).',
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

async function shutdown() {
  stopHealth();
  console.log('Shutting down...');
  // Save and leave rather than stop, so music carries on after the restart.
  for (const q of [...client.music.queues.values()]) await q.suspend();
  await client.destroy();
  try {
    require('./lib/db').db.close();
  } catch {} // writes everything into the main database file
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('Login failed:', e.message);
  process.exit(1);
});
