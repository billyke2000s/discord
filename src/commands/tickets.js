// Tickets: a panel with an "Open ticket" button creates a private channel for the user + staff.
// Closing logs who closed it, then deletes the channel.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, MessageFlags, AttachmentBuilder } = require('discord.js');
const { db, getSettings } = require('../lib/db');
const { embed, log } = require('../lib/util');

const P = PermissionFlagsBits;
const opening = new Set(); // guildId:userId while a ticket channel is being created (stops double clicks making two)
const TRANSCRIPT_LIMIT = 1000;

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

  const key = `${interaction.guildId}:${interaction.user.id}`;
  if (opening.has(key)) return interaction.reply({ content: 'Your ticket is already being created.', flags: MessageFlags.Ephemeral });
  const existing = db.prepare('SELECT channel_id FROM tickets WHERE guild_id = ? AND user_id = ?').all(interaction.guildId, interaction.user.id)
    .find((r) => interaction.guild.channels.cache.has(r.channel_id));
  if (existing) return interaction.reply({ content: `You already have a ticket open: <#${existing.channel_id}>`, flags: MessageFlags.Ephemeral });

  opening.add(key);
  try { await createTicket(interaction, tickets); } finally { opening.delete(key); }
}

async function createTicket(interaction, tickets) {
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
  await interaction.update({ content: 'Saving a transcript, then closing in 5 seconds…', components: [] });

  const transcript = await buildTranscript(interaction.channel).catch((e) => {
    console.error('[tickets] transcript failed:', e.message);
    return null;
  });
  const files = transcript ? [new AttachmentBuilder(Buffer.from(transcript.text, 'utf8'), { name: `${interaction.channel.name.replace(/[^\w-]+/g, '') || 'ticket'}-transcript.txt` })] : [];
  const note = transcript ? ` Transcript of ${transcript.count} message(s) attached${transcript.cut ? ` (only the last ${TRANSCRIPT_LIMIT})` : ''}.` : ' The transcript could not be saved.';
  await log(interaction.guild,
    embed('grey').setDescription(`🔒 Ticket ${interaction.channel.name} (opened by <@${row.user_id}>) closed by ${interaction.user}.${note}`), { files });

  db.prepare('DELETE FROM tickets WHERE channel_id = ?').run(interaction.channelId);
  setTimeout(() => interaction.channel.delete('Ticket closed').catch(() => {}), 5000);
}

// Plain-text record of the ticket, oldest message first, posted to the log channel before the channel is deleted.
async function buildTranscript(channel) {
  const messages = [];
  let before;
  while (messages.length < TRANSCRIPT_LIMIT) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  const lines = messages.reverse().map((m) => {
    const files = m.attachments?.size ? ` [attachments: ${[...m.attachments.values()].map((a) => a.url).join(' ')}]` : '';
    const embeds = !m.content && m.embeds?.length ? ` [embed: ${m.embeds.map((e) => e.description || e.title || '').join(' | ')}]` : '';
    return `[${new Date(m.createdTimestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC] ${m.author?.tag || 'unknown'} (${m.author?.id || '?'}): ${m.content || ''}${embeds}${files}`;
  });
  return { text: `Ticket ${channel.name} (${channel.id})\n\n${lines.join('\n')}\n`, count: messages.length, cut: messages.length >= TRANSCRIPT_LIMIT };
}

module.exports = {
  buildTranscript,
  commands: [],
  components: { 'ticket:open': open, 'ticket:close': close, 'ticket:confirm': confirm },
  panel,
};
