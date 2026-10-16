const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits: P } = require('discord.js');
const { embed, isOwner } = require('../lib/util');
const { rebuildLocked } = require('../lib/commandsync');

// Only lists what the person asking can actually use.
const help = {
  data: new SlashCommandBuilder().setName('help').setDescription('What this bot can do'),
  async execute(interaction) {
    const m = interaction.member;
    const fields = [
      {
        name: '🎂 Birthdays',
        value:
          '`/birthday set` · `/birthday show` — a birthday announcement and 👑 Birthday role for 24 hours (UTC dates).',
      },
      {
        name: '🏅 Levels',
        value: '`/rank` your level and XP · `/leaderboard` the most active members. Chatting earns XP (once a minute).',
      },
      {
        name: '🎵 Music',
        value:
          '`/play` (song name, YouTube or Spotify link/playlist) · `/queue` · `/nowplaying` brings the panel back · `/lyrics` the words, privately, following the song · `/status` checks whether music is working or down\nThe panel (in the voice channel’s chat) has vote back, skip, stop and shuffle, and a queue with page arrows. Votes need more than half of the people in the channel.',
      },
      {
        name: '🔊 Your voice channel',
        value: 'Join ➕・Join to Create to get your own, and use the control panel in its chat (or `/vc`)',
      },
    ];
    if (m.permissions.has(P.ModerateMembers) || isOwner(interaction.user, interaction.guild))
      fields.push({
        name: '🛡️ Staff',
        value:
          '`/warn` `/warnings` `/delwarn` `/timeout` `/untimeout` `/kick` `/ban` `/unban` `/purge` `/slowmode` · music: back, skip, stop or shuffle without a vote',
      });
    if (m.permissions.has(P.ManageGuild) || isOwner(interaction.user, interaction.guild)) {
      let admin =
        '`/setup show|logs|welcome|verify|verify-off|verify-existing|joinvoice|joinvoice-off|tickets|scamfilter|commands` · `/buttonroles` · `/levels` · `/automod` · `/live` · `/lockdown` · `/diagnostics` (full check of the bot and VPS, says what to fix; once a minute)';
      if (isOwner(interaction.user, interaction.guild)) {
        const locked = rebuildLocked(interaction.guildId);
        admin += locked
          ? '\nOwner: `/setup restyle` (`/setup rebuild` is locked)'
          : '\nOwner: `/setup restyle` `/setup rebuild`';
      }
      if (interaction.user.id === interaction.guild.ownerId)
        admin +=
          '\nServer owner only: `/update` checks versions and requests the latest bot release; `/update check-only:true` only checks.';
      fields.push({ name: '⚙️ Admin', value: admin });
    }
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [embed('info').setTitle('Commands').addFields(fields)],
    });
  },
};

module.exports = { commands: [help] };
