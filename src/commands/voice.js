// Join-to-create voice channels: /vc commands for owners of temp channels.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { db } = require('../lib/db');
const { embed, truncate, isBotAdmin } = require('../lib/util');

const getVc = db.prepare('SELECT * FROM temp_vcs WHERE channel_id = ?');
const setOwner = db.prepare('UPDATE temp_vcs SET owner_id = ? WHERE channel_id = ?');

// Returns { channel, row } if the user is in a temp VC, else replies with an error and returns null.
async function ownedChannel(interaction) {
  const channel = interaction.member.voice.channel;
  const row = channel && getVc.get(channel.id);
  if (!row) {
    await interaction.reply({ content: 'You need to be in a channel made by the join-to-create lobby.', flags: MessageFlags.Ephemeral });
    return null;
  }
  const override = isBotAdmin(interaction.user.id) || interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);
  if (!override && row.owner_id !== interaction.user.id) {
    await interaction.reply({ content: `Only the owner (<@${row.owner_id}>) can do that.`, flags: MessageFlags.Ephemeral });
    return null;
  }
  return { channel, row };
}

const vc = {
  data: new SlashCommandBuilder().setName('vc').setDescription('Control your own voice channel')
    .addSubcommand((s) => s.setName('lock').setDescription('Stop new people joining'))
    .addSubcommand((s) => s.setName('unlock').setDescription('Let people join again'))
    .addSubcommand((s) => s.setName('limit').setDescription('Set user limit (0 = none)')
      .addIntegerOption((o) => o.setName('number').setDescription('0-99').setMinValue(0).setMaxValue(99).setRequired(true)))
    .addSubcommand((s) => s.setName('rename').setDescription('Rename the channel (Discord allows 2 renames per 10 min)')
      .addStringOption((o) => o.setName('name').setDescription('New name').setMaxLength(100).setRequired(true)))
    .addSubcommand((s) => s.setName('kick').setDescription('Kick someone out and block them from rejoining')
      .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
    .addSubcommand((s) => s.setName('transfer').setDescription('Give ownership to someone in the channel')
      .addUserOption((o) => o.setName('user').setDescription('New owner').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const everyone = interaction.guild.roles.everyone;

    const r = await ownedChannel(interaction); if (!r) return;
    const { channel } = r;

    try {
      switch (sub) {
        case 'lock':
          await channel.permissionOverwrites.edit(everyone, { Connect: false });
          // let everyone already inside stay/rejoin
          for (const m of channel.members.values()) await channel.permissionOverwrites.edit(m.id, { Connect: true });
          return interaction.reply({ embeds: [embed('ok').setDescription('🔒 Locked.')] });
        case 'unlock':
          await channel.permissionOverwrites.edit(everyone, { Connect: null });
          return interaction.reply({ embeds: [embed('ok').setDescription('🔓 Unlocked.')] });
        case 'limit': {
          const n = interaction.options.getInteger('number', true);
          await channel.setUserLimit(n);
          return interaction.reply({ embeds: [embed('ok').setDescription(n ? `Limit set to ${n}.` : 'Limit removed.')] });
        }
        case 'rename': {
          const name = interaction.options.getString('name', true);
          await interaction.deferReply();
          // Discord rate limits channel renames hard (2 per 10 min). Don't hang forever waiting.
          const done = await Promise.race([
            channel.setName(name).then(() => true),
            new Promise((res) => setTimeout(() => res(false), 5000)),
          ]);
          return interaction.editReply(done
            ? `Renamed to **${truncate(name, 100)}**.`
            : 'Discord is rate-limiting renames (max 2 per 10 minutes). It will apply when the limit clears.');
        }
        case 'kick': {
          const u = interaction.options.getUser('user', true);
          if (u.id === interaction.user.id) return interaction.reply({ content: 'You can’t kick yourself.', flags: MessageFlags.Ephemeral });
          const target = await interaction.guild.members.fetch(u.id).catch(() => null);
          if (target?.permissions.has(PermissionFlagsBits.MoveMembers))
            return interaction.reply({ content: 'You can’t kick a moderator.', flags: MessageFlags.Ephemeral });
          await channel.permissionOverwrites.edit(u.id, { Connect: false });
          if (target?.voice.channelId === channel.id) await target.voice.disconnect('Kicked from temp VC by owner');
          return interaction.reply({ embeds: [embed('ok').setDescription(`${u} was kicked and can’t rejoin.`)] });
        }
        case 'transfer': {
          const u = interaction.options.getUser('user', true);
          if (!channel.members.has(u.id)) return interaction.reply({ content: 'They need to be in the channel.', flags: MessageFlags.Ephemeral });
          if (u.bot) return interaction.reply({ content: 'Bots can’t own channels.', flags: MessageFlags.Ephemeral });
          setOwner.run(u.id, channel.id);
          await channel.permissionOverwrites.edit(u.id, { Connect: true, ManageChannels: true, MoveMembers: true });
          await channel.permissionOverwrites.edit(interaction.user.id, { ManageChannels: null, MoveMembers: null });
          return interaction.reply(`${u} now owns ${channel}.`);
        }
      }
    } catch (e) {
      const msg = `Failed: ${e.message}. Check I have **Manage Channels** and **Move Members** in this category.`;
      return interaction.deferred || interaction.replied ? interaction.editReply(msg) : interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
  },
};

// Called from voiceStateUpdate
async function handleVoiceState(oldState, newState, settings) {
  const { lobbyChannel, categoryId, defaultLimit } = settings.jtc;
  const guild = newState.guild;

  // Joined the lobby -> make a channel
  if (lobbyChannel && newState.channelId === lobbyChannel && oldState.channelId !== lobbyChannel) {
    const member = newState.member;
    const lobby = newState.channel;
    // one temp channel per person: if they already own one, move them there
    const existing = db.prepare('SELECT channel_id FROM temp_vcs WHERE guild_id = ? AND owner_id = ?').all(guild.id, member.id)
      .map((r) => guild.channels.cache.get(r.channel_id)).find(Boolean);
    if (existing) return member.voice.setChannel(existing).catch(() => {});

    try {
      const ch = await guild.channels.create({
        name: truncate(`🔊・${member.displayName}'s channel`, 100),
        type: ChannelType.GuildVoice,
        parent: categoryId || lobby.parentId || undefined,
        userLimit: defaultLimit || 0,
        bitrate: Math.min(lobby.bitrate, guild.maximumBitrate),
        permissionOverwrites: buildOverwrites(categoryId ? guild.channels.cache.get(categoryId) : lobby.parent, member.id, guild),
        reason: `Join-to-create for ${member.user.tag}`,
      });
      db.prepare('INSERT INTO temp_vcs (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?)').run(ch.id, guild.id, member.id, Date.now());
      await member.voice.setChannel(ch).catch(async () => {
        // they left the lobby before we could move them
        await ch.delete().catch(() => {});
        db.prepare('DELETE FROM temp_vcs WHERE channel_id = ?').run(ch.id);
      });
    } catch (e) {
      console.error('[jtc] create failed:', e.message);
    }
  }

  // Left a temp channel -> delete if empty
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    await cleanupIfEmpty(guild, oldState.channelId);
  }
}

// Copy the category's permissions (so hidden/private categories stay private), then give
// the owner and the bot control. Keyed by id so we never send duplicate overwrites.
function buildOverwrites(parent, ownerId, guild) {
  const map = new Map();
  for (const o of parent?.permissionOverwrites.cache.values() ?? []) {
    map.set(o.id, { id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield });
  }
  const give = (id, type, bits) => {
    const cur = map.get(id) || { id, type, allow: 0n, deny: 0n };
    const add = bits.reduce((a, b) => a | b, 0n);
    cur.allow |= add;
    cur.deny &= ~add;
    map.set(id, cur);
  };
  const P = PermissionFlagsBits;
  give(ownerId, 1, [P.ViewChannel, P.Connect, P.ManageChannels, P.MoveMembers]);
  give(guild.members.me.id, 1, [P.ViewChannel, P.Connect, P.ManageChannels, P.MoveMembers]);
  return [...map.values()];
}

async function cleanupIfEmpty(guild, channelId) {
  const row = getVc.get(channelId);
  if (!row) return;
  const ch = guild.channels.cache.get(channelId);
  // only bots left (e.g. the music bot) counts as empty
  if (ch && ch.members.some((m) => !m.user.bot)) return;
  db.prepare('DELETE FROM temp_vcs WHERE channel_id = ?').run(channelId);
  if (ch) await ch.delete('Temp voice channel empty').catch(() => {});
}

// Delete temp channels that are empty. Runs on startup (catches ones that emptied while the
// bot was offline) and every minute as a safety net.
// minAgeMs stops us deleting a channel in the second between creating it and moving someone in.
async function sweep(client, minAgeMs = 0) {
  for (const row of db.prepare('SELECT * FROM temp_vcs').all()) {
    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) continue;
    if (Date.now() - row.created_at < minAgeMs) continue;
    await cleanupIfEmpty(guild, row.channel_id);
  }
}

module.exports = { commands: [vc], handleVoiceState, sweep };
