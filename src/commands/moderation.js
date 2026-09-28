const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db } = require('../lib/db');
const { embed, log, canModerate, parseDuration, truncate } = require('../lib/util');
const antiRaid = require('../lib/antiraid');

const P = PermissionFlagsBits;
const MAX_TIMEOUT = 28 * 24 * 3600 * 1000; // Discord's limit

async function getTarget(interaction) {
  const user = interaction.options.getUser('user', true);
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  return { user, member };
}

async function modLog(interaction, color, action, user, reason, extra = '') {
  await log(interaction.guild, embed(color)
    .setTitle(action)
    .setDescription(`**User:** ${user} (${user.tag})\n**Mod:** ${interaction.user}\n**Reason:** ${truncate(reason, 1000)}${extra}`)
    .setFooter({ text: `User ID ${user.id}` }));
}

async function dm(user, text) {
  return user.send(text).then(() => true).catch(() => false);
}

const reasonOpt = (o) => o.setName('reason').setDescription('Reason').setMaxLength(500);

const warn = {
  data: new SlashCommandBuilder().setName('warn').setDescription('Warn a member')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption((o) => reasonOpt(o).setRequired(true)),
  async execute(interaction) {
    const { user, member } = await getTarget(interaction);
    if (!member) return interaction.reply({ content: 'That user is not in the server.', flags: MessageFlags.Ephemeral });
    const err = canModerate(interaction.member, member);
    if (err) return interaction.reply({ content: err, flags: MessageFlags.Ephemeral });
    const reason = interaction.options.getString('reason', true);
    await interaction.deferReply();
    db.prepare('INSERT INTO warnings (guild_id, user_id, mod_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(interaction.guildId, user.id, interaction.user.id, reason, Date.now());
    const count = db.prepare('SELECT COUNT(*) c FROM warnings WHERE guild_id = ? AND user_id = ?').get(interaction.guildId, user.id).c;
    const dmed = await dm(user, `You were warned in **${interaction.guild.name}**: ${reason}`);
    await modLog(interaction, 'warn', 'Warn', user, reason, `\n**Total warnings:** ${count}`);
    await interaction.editReply({ embeds: [embed('warn').setDescription(`⚠️ Warned ${user} (warning #${count}).${dmed ? '' : ' Could not DM them.'}`)] });
  },
};

const warnings = {
  data: new SlashCommandBuilder().setName('warnings').setDescription('List a member’s warnings')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
  async execute(interaction) {
    const user = interaction.options.getUser('user', true);
    const rows = db.prepare('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 25').all(interaction.guildId, user.id);
    if (!rows.length) return interaction.reply({ content: `${user.tag} has no warnings.`, flags: MessageFlags.Ephemeral });
    const lines = rows.map((r) => `\`#${r.id}\` <t:${Math.floor(r.created_at / 1000)}:d> by <@${r.mod_id}>: ${truncate(r.reason, 120)}`);
    await interaction.reply({ embeds: [embed('warn').setTitle(`Warnings for ${user.tag}`).setDescription(lines.join('\n'))], flags: MessageFlags.Ephemeral });
  },
};

const delwarn = {
  data: new SlashCommandBuilder().setName('delwarn').setDescription('Delete a warning, or all of a member’s warnings')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addIntegerOption((o) => o.setName('id').setDescription('Warning ID from /warnings'))
    .addUserOption((o) => o.setName('user').setDescription('Clear ALL warnings for this member')),
  async execute(interaction) {
    const id = interaction.options.getInteger('id');
    const user = interaction.options.getUser('user');
    if (!id && !user) return interaction.reply({ content: 'Give a warning id or a user.', flags: MessageFlags.Ephemeral });
    const r = id
      ? db.prepare('DELETE FROM warnings WHERE guild_id = ? AND id = ?').run(interaction.guildId, id)
      : db.prepare('DELETE FROM warnings WHERE guild_id = ? AND user_id = ?').run(interaction.guildId, user.id);
    await interaction.reply({ content: `Deleted ${r.changes} warning(s).`, flags: MessageFlags.Ephemeral });
  },
};

const timeout = {
  data: new SlashCommandBuilder().setName('timeout').setDescription('Time out a member (they can’t talk)')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 2h, 1d (max 28d)').setRequired(true))
    .addStringOption(reasonOpt),
  async execute(interaction) {
    const { user, member } = await getTarget(interaction);
    if (!member) return interaction.reply({ content: 'That user is not in the server.', flags: MessageFlags.Ephemeral });
    const err = canModerate(interaction.member, member);
    if (err) return interaction.reply({ content: err, flags: MessageFlags.Ephemeral });
    const ms = parseDuration(interaction.options.getString('duration', true));
    if (!ms || ms > MAX_TIMEOUT) return interaction.reply({ content: 'Duration must look like 10m, 2h, 1d, max 28d.', flags: MessageFlags.Ephemeral });
    const reason = interaction.options.getString('reason') || 'No reason given';
    await member.timeout(ms, `${interaction.user.tag}: ${reason}`);
    await dm(user, `You were timed out in **${interaction.guild.name}** until <t:${Math.floor((Date.now() + ms) / 1000)}:f>: ${reason}`);
    await interaction.reply({ embeds: [embed('warn').setDescription(`🔇 ${user} timed out until <t:${Math.floor((Date.now() + ms) / 1000)}:R>.`)] });
    await modLog(interaction, 'warn', 'Timeout', user, reason, `\n**Duration:** ${interaction.options.getString('duration')}`);
  },
};

const untimeout = {
  data: new SlashCommandBuilder().setName('untimeout').setDescription('Remove a timeout')
    .setDefaultMemberPermissions(P.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
  async execute(interaction) {
    const { user, member } = await getTarget(interaction);
    if (!member) return interaction.reply({ content: 'That user is not in the server.', flags: MessageFlags.Ephemeral });
    await member.timeout(null, `Removed by ${interaction.user.tag}`);
    await interaction.reply({ embeds: [embed('ok').setDescription(`🔊 Removed timeout for ${user}.`)] });
    await modLog(interaction, 'ok', 'Timeout removed', user, '-');
  },
};

const kick = {
  data: new SlashCommandBuilder().setName('kick').setDescription('Kick a member')
    .setDefaultMemberPermissions(P.KickMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(reasonOpt),
  async execute(interaction) {
    const { user, member } = await getTarget(interaction);
    if (!member) return interaction.reply({ content: 'That user is not in the server.', flags: MessageFlags.Ephemeral });
    const err = canModerate(interaction.member, member);
    if (err) return interaction.reply({ content: err, flags: MessageFlags.Ephemeral });
    const reason = interaction.options.getString('reason') || 'No reason given';
    await dm(user, `You were kicked from **${interaction.guild.name}**: ${reason}`);
    await member.kick(`${interaction.user.tag}: ${reason}`);
    await interaction.reply({ embeds: [embed('bad').setDescription(`👢 Kicked ${user.tag}.`)] });
    await modLog(interaction, 'bad', 'Kick', user, reason);
  },
};

const ban = {
  data: new SlashCommandBuilder().setName('ban').setDescription('Ban a user (works even if they left)')
    .setDefaultMemberPermissions(P.BanMembers)
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(reasonOpt)
    .addIntegerOption((o) => o.setName('delete_days').setDescription('Delete their messages from the last N days (0-7)').setMinValue(0).setMaxValue(7)),
  async execute(interaction) {
    const { user, member } = await getTarget(interaction);
    if (member) {
      const err = canModerate(interaction.member, member);
      if (err) return interaction.reply({ content: err, flags: MessageFlags.Ephemeral });
    }
    const reason = interaction.options.getString('reason') || 'No reason given';
    const days = interaction.options.getInteger('delete_days') ?? 0;
    if (member) await dm(user, `You were banned from **${interaction.guild.name}**: ${reason}`);
    await interaction.guild.bans.create(user.id, { reason: `${interaction.user.tag}: ${reason}`, deleteMessageSeconds: days * 86400 });
    await interaction.reply({ embeds: [embed('bad').setDescription(`🔨 Banned ${user.tag}.`)] });
    await modLog(interaction, 'bad', 'Ban', user, reason);
  },
};

const unban = {
  data: new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID')
    .setDefaultMemberPermissions(P.BanMembers)
    .addStringOption((o) => o.setName('user_id').setDescription('User ID').setRequired(true))
    .addStringOption(reasonOpt),
  async execute(interaction) {
    const id = interaction.options.getString('user_id', true).trim();
    const reason = interaction.options.getString('reason') || 'No reason given';
    try {
      const user = await interaction.guild.bans.remove(id, `${interaction.user.tag}: ${reason}`);
      await interaction.reply({ embeds: [embed('ok').setDescription(`Unbanned ${user?.tag || id}.`)] });
      if (user) await modLog(interaction, 'ok', 'Unban', user, reason);
    } catch {
      await interaction.reply({ content: 'That ID is not banned (or is not a valid ID).', flags: MessageFlags.Ephemeral });
    }
  },
};

const purge = {
  data: new SlashCommandBuilder().setName('purge').setDescription('Bulk delete recent messages (max 14 days old)')
    .setDefaultMemberPermissions(P.ManageMessages)
    .addIntegerOption((o) => o.setName('amount').setDescription('1-100').setMinValue(1).setMaxValue(100).setRequired(true))
    .addUserOption((o) => o.setName('user').setDescription('Only delete messages from this user')),
  async execute(interaction) {
    const amount = interaction.options.getInteger('amount', true);
    const user = interaction.options.getUser('user');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let msgs = await interaction.channel.messages.fetch({ limit: 100 });
    if (user) msgs = msgs.filter((m) => m.author.id === user.id);
    msgs = [...msgs.values()].slice(0, amount);
    const deleted = await interaction.channel.bulkDelete(msgs, true); // true = skip >14 day old
    await interaction.editReply(`Deleted ${deleted.size} message(s).${deleted.size < msgs.length ? ' Some were older than 14 days and Discord won’t bulk delete those.' : ''}`);
    await log(interaction.guild, embed('grey').setDescription(`🧹 ${interaction.user} purged ${deleted.size} messages in ${interaction.channel}${user ? ` from ${user}` : ''}.`));
  },
};

const slowmode = {
  data: new SlashCommandBuilder().setName('slowmode').setDescription('Set slowmode for this channel')
    .setDefaultMemberPermissions(P.ManageChannels)
    .addIntegerOption((o) => o.setName('seconds').setDescription('0 to turn off, max 21600').setMinValue(0).setMaxValue(21600).setRequired(true)),
  async execute(interaction) {
    const s = interaction.options.getInteger('seconds', true);
    await interaction.channel.setRateLimitPerUser(s);
    await interaction.reply(s ? `Slowmode set to ${s}s.` : 'Slowmode off.');
  },
};

const lockdown = {
  data: new SlashCommandBuilder().setName('lockdown').setDescription('Manually lock the server against new joins')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addSubcommand((s) => s.setName('on').setDescription('Kick new joiners until turned off')
      .addIntegerOption((o) => o.setName('minutes').setDescription('Auto-unlock after N minutes (blank = until /lockdown off)').setMinValue(1)))
    .addSubcommand((s) => s.setName('off').setDescription('End lockdown'))
    .addSubcommand((s) => s.setName('status').setDescription('Is the server locked?')),
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') {
      const info = antiRaid.lockInfo(interaction.guildId);
      return interaction.reply({
        content: antiRaid.isLocked(interaction.guildId)
          ? `🔒 Locked${info.until !== Infinity ? ` until <t:${Math.floor(info.until / 1000)}:t>` : ''}.`
          : '🔓 Not locked.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (sub === 'off') {
      antiRaid.unlock(interaction.guildId);
      await interaction.reply('🔓 Lockdown ended.');
      return log(interaction.guild, embed('ok').setDescription(`🔓 Lockdown ended by ${interaction.user}.`));
    }
    const minutes = interaction.options.getInteger('minutes') || 0;
    antiRaid.lock(interaction.guildId, minutes, () =>
      log(interaction.guild, embed('ok').setDescription('🔓 Lockdown expired.')));
    await interaction.reply(`🔒 Lockdown on${minutes ? ` for ${minutes} minutes` : ''}. New joiners will be kicked. (It stays on through bot restarts.)`);
    await log(interaction.guild, embed('bad').setDescription(`🔒 Lockdown started by ${interaction.user}.`));
  },
};

module.exports = { commands: [warn, warnings, delwarn, timeout, untimeout, kick, ban, unban, purge, slowmode, lockdown] };
