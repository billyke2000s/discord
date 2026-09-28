// Tickets: a panel with an "Open ticket" button creates a private channel for the user + staff.
// Closing logs who closed it, then deletes the channel.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { db, getSettings } = require('../lib/db');
const { embed, log } = require('../lib/util');

const P = PermissionFlagsBits;

function panel() {
  return {
    embeds: [embed('info').setTitle('Support').setDescription('Need help from staff? Click below to open a private ticket.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket:open').setLabel('Open ticket').setStyle(ButtonStyle.Primary).setEmoji('🎫'),
    )],
  };
}

async function open(interaction) {
  const { tickets } = getSettings(interaction.guildId);
  if (!tickets.staffRole) return interaction.reply({ content: 'Tickets are not set up yet.', flags: MessageFlags.Ephemeral });

  const existing = db.prepare('SELECT channel_id FROM tickets WHERE guild_id = ? AND user_id = ?').all(interaction.guildId, interaction.user.id)
    .find((r) => interaction.guild.channels.cache.has(r.channel_id));
  if (existing) return interaction.reply({ content: `You already have a ticket open: <#${existing.channel_id}>`, flags: MessageFlags.Ephemeral });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const g = interaction.guild;
  let ch;
  try {
    ch = await g.channels.create({
      name: `🎫・ticket-${interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '') || interaction.user.id}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent: tickets.categoryId || undefined,
      permissionOverwrites: [
        { id: g.roles.everyone.id, deny: [P.ViewChannel] },
        { id: interaction.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles] },
        { id: tickets.staffRole, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.ManageMessages] },
        { id: g.members.me.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels, P.EmbedLinks, P.AttachFiles] },
      ],
      reason: `Ticket for ${interaction.user.tag}`,
    });
  } catch (e) {
    return interaction.editReply(`Couldn’t create the ticket: ${e.message}`);
  }
  db.prepare('INSERT INTO tickets (channel_id, guild_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(ch.id, g.id, interaction.user.id, Date.now());

  await ch.send({
    content: `${interaction.user} <@&${tickets.staffRole}>`,
    allowedMentions: { users: [interaction.user.id], roles: [tickets.staffRole] },
    embeds: [embed('info').setDescription('Describe your issue and staff will be with you. Click **Close** when you’re done.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
    )],
  });
  await interaction.editReply(`Ticket opened: ${ch}`);
  await log(g, embed('info').setDescription(`🎫 ${interaction.user} opened ${ch}.`));
}

async function close(interaction) {
  await interaction.reply({
    content: 'Close this ticket?',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket:confirm').setLabel('Yes, close').setStyle(ButtonStyle.Danger),
    )],
    flags: MessageFlags.Ephemeral,
  });
}

async function confirm(interaction) {
  const row = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(interaction.channelId);
  if (!row) return interaction.reply({ content: 'This isn’t a ticket channel.', flags: MessageFlags.Ephemeral });
  await interaction.update({ content: 'Closing in 5 seconds…', components: [] });

  await log(interaction.guild,
    embed('grey').setDescription(`🔒 Ticket ${interaction.channel.name} (opened by <@${row.user_id}>) closed by ${interaction.user}.`));

  db.prepare('DELETE FROM tickets WHERE channel_id = ?').run(interaction.channelId);
  setTimeout(() => interaction.channel.delete('Ticket closed').catch(() => {}), 5000);
}

module.exports = {
  commands: [],
  components: { 'ticket:open': open, 'ticket:close': close, 'ticket:confirm': confirm },
  panel,
};
