// Tickets: a panel with an "Open ticket" button creates a private channel for the user + staff.
// Closing saves a transcript to the log channel first, then deletes the channel.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  AttachmentBuilder,
} = require('discord.js');
const { db, getSettings } = require('../lib/db');
const { embed, log } = require('../lib/util');

const P = PermissionFlagsBits;
const opening = new Set(); // guildId:userId while a ticket channel is being created (stops double clicks making two)
const TRANSCRIPT_LIMIT = 1000;

function panel() {
  return {
    embeds: [
      embed('info').setTitle('Support').setDescription('Need help from staff? Click below to open a private ticket.'),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket:open')
          .setLabel('Open ticket')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🎫'),
      ),
    ],
  };
}

async function open(interaction) {
  const { tickets } = getSettings(interaction.guildId);
  if (!tickets.staffRole)
    return interaction.reply({ content: 'Tickets are not set up yet.', flags: MessageFlags.Ephemeral });

  const key = `${interaction.guildId}:${interaction.user.id}`;
  if (opening.has(key))
    return interaction.reply({ content: 'Your ticket is already being created.', flags: MessageFlags.Ephemeral });
  const existing = db
    .prepare('SELECT channel_id FROM tickets WHERE guild_id = ? AND user_id = ?')
    .all(interaction.guildId, interaction.user.id)
    .find((r) => interaction.guild.channels.cache.has(r.channel_id));
  if (existing)
    return interaction.reply({
      content: `You already have a ticket open: <#${existing.channel_id}>`,
      flags: MessageFlags.Ephemeral,
    });

  opening.add(key);
  try {
    await createTicket(interaction, tickets);
  } finally {
    opening.delete(key);
  }
}

async function createTicket(interaction, tickets) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const g = interaction.guild;
  let ch;
  try {
    ch = await g.channels.create({
      name: `🎫・ticket-${interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '') || interaction.user.id}`.slice(
        0,
        90,
      ),
      type: ChannelType.GuildText,
      parent: tickets.categoryId || undefined,
      permissionOverwrites: [
        { id: g.roles.everyone.id, deny: [P.ViewChannel] },
        { id: interaction.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles] },
        {
          id: tickets.staffRole,
          allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.ManageMessages],
        },
        {
          id: g.members.me.id,
          allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels, P.EmbedLinks, P.AttachFiles],
        },
      ],
      reason: `Ticket for ${interaction.user.tag}`,
    });
  } catch (e) {
    return interaction.editReply(`Couldn’t create the ticket: ${e.message}`);
  }
  db.prepare('INSERT INTO tickets (channel_id, guild_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(
    ch.id,
    g.id,
    interaction.user.id,
    Date.now(),
  );

  await ch.send({
    content: `${interaction.user} <@&${tickets.staffRole}>`,
    allowedMentions: { users: [interaction.user.id], roles: [tickets.staffRole] },
    embeds: [
      embed('info').setDescription('Describe your issue and staff will be with you. Click **Close** when you’re done.'),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
      ),
    ],
  });
  await interaction.editReply(`Ticket opened: ${ch}`);
  await log(g, embed('info').setDescription(`🎫 ${interaction.user} opened ${ch}.`));
}

// Who may close a ticket: the member who opened it, the ticket staff role, or anyone who can manage channels.
function canClose(interaction, row) {
  if (!row) return false;
  if (interaction.user.id === row.user_id) return true;
  if (interaction.memberPermissions?.has(P.ManageChannels)) return true;
  const staffRole = getSettings(interaction.guildId).tickets.staffRole;
  return !!staffRole && !!interaction.member?.roles?.cache?.has(staffRole);
}
const isStaff = (interaction) => {
  const staffRole = getSettings(interaction.guildId).tickets.staffRole;
  return (
    interaction.memberPermissions?.has(P.ManageChannels) ||
    (!!staffRole && !!interaction.member?.roles?.cache?.has(staffRole))
  );
};
const ticketRow = (channelId) => db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId);
const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });

async function close(interaction) {
  const row = ticketRow(interaction.channelId);
  if (!row) return interaction.reply(eph('This isn’t a ticket channel.'));
  if (!canClose(interaction, row))
    return interaction.reply(eph('Only the person who opened this ticket or staff can close it.'));
  await interaction.reply({
    content: 'Close this ticket?',
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket:confirm').setLabel('Yes, close').setStyle(ButtonStyle.Danger),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

function deleteSoon(interaction) {
  db.prepare('DELETE FROM tickets WHERE channel_id = ?').run(interaction.channelId);
  setTimeout(() => interaction.channel.delete('Ticket closed').catch(() => {}), 5000);
}

// Close only once the transcript is safely in the log channel. If it can't be saved, the ticket stays open
// and staff get a "close without transcript" button, so a conversation is never lost by accident.
async function confirm(interaction) {
  const row = ticketRow(interaction.channelId);
  if (!row) return interaction.reply(eph('This isn’t a ticket channel.'));
  if (!canClose(interaction, row))
    return interaction.reply(eph('Only the person who opened this ticket or staff can close it.'));
  await interaction.update({ content: 'Saving a transcript…', components: [] });

  const transcript = await buildTranscript(interaction.channel).catch((e) => {
    console.error('[tickets] transcript failed:', e.message);
    return null;
  });
  let saved = false;
  if (transcript) {
    const file = new AttachmentBuilder(Buffer.from(transcript.text, 'utf8'), {
      name: `${interaction.channel.name.replace(/[^\w-]+/g, '') || 'ticket'}-transcript.txt`,
    });
    const cut = transcript.cut ? ` (only the last ${TRANSCRIPT_LIMIT})` : '';
    saved = await log(
      interaction.guild,
      embed('grey').setDescription(
        `🔒 Ticket ${interaction.channel.name} (opened by <@${row.user_id}>) closed by ${interaction.user}. Transcript of ${transcript.count} message(s) attached${cut}.`,
      ),
      { files: [file] },
    );
  }
  if (!saved) {
    const why = !getSettings(interaction.guildId).logChannel
      ? 'there’s no log channel set (`/setup logs`)'
      : transcript
        ? 'I couldn’t post in the log channel'
        : 'I couldn’t read this channel’s messages';
    return interaction.editReply({
      content: `⚠️ The ticket is **still open**: I couldn’t save the transcript because ${why}. Fix that and close again, or staff can close it without a transcript.`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('ticket:force')
            .setLabel('Close without transcript (staff)')
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    });
  }
  await interaction.editReply({ content: 'Transcript saved. Closing in 5 seconds…', components: [] });
  deleteSoon(interaction);
}

async function forceClose(interaction) {
  const row = ticketRow(interaction.channelId);
  if (!row) return interaction.reply(eph('This isn’t a ticket channel.'));
  if (!isStaff(interaction)) return interaction.reply(eph('Only staff can close a ticket without a transcript.'));
  await interaction.update({ content: 'Closing without a transcript in 5 seconds…', components: [] });
  await log(
    interaction.guild,
    embed('warn').setDescription(
      `🔒 Ticket ${interaction.channel.name} (opened by <@${row.user_id}>) closed by ${interaction.user} **without a transcript**.`,
    ),
  );
  deleteSoon(interaction);
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
    const files = m.attachments?.size
      ? ` [attachments: ${[...m.attachments.values()].map((a) => a.url).join(' ')}]`
      : '';
    const embeds =
      !m.content && m.embeds?.length
        ? ` [embed: ${m.embeds.map((e) => e.description || e.title || '').join(' | ')}]`
        : '';
    return `[${new Date(m.createdTimestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC] ${m.author?.tag || 'unknown'} (${m.author?.id || '?'}): ${m.content || ''}${embeds}${files}`;
  });
  return {
    text: `Ticket ${channel.name} (${channel.id})\n\n${lines.join('\n')}\n`,
    count: messages.length,
    cut: messages.length >= TRANSCRIPT_LIMIT,
  };
}

module.exports = {
  buildTranscript,
  commands: [],
  components: { 'ticket:open': open, 'ticket:close': close, 'ticket:confirm': confirm, 'ticket:force': forceClose },
  panel,
};
