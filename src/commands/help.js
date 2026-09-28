const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits: P } = require('discord.js');
const { embed, isOwner } = require('../lib/util');
const { rebuildLocked } = require('../lib/commandsync');

// Only lists what the person asking can actually use.
const help = {
  data: new SlashCommandBuilder().setName('help').setDescription('What this bot can do'),
  async execute(interaction) {
    const m = interaction.member;
    const fields = [
      { name: '🎵 Music', value: '`/play` (song name, YouTube or Spotify link/playlist) · `/queue` · `/nowplaying` brings the panel back\nThe panel (in the voice channel’s chat) has pause, vote skip, vote stop, shuffle, queue and volume. Skip and stop need more than half of the people in the channel.' },
      { name: '🔊 Your voice channel', value: 'Join ➕・Join to Create to get your own, then `/vc lock` `unlock` `limit` `rename` `kick` `transfer`' },
    ];
    if (m.permissions.has(P.ModerateMembers) || isOwner(interaction.user, interaction.guild))
      fields.push({ name: '🛡️ Staff', value: '`/warn` `/warnings` `/delwarn` `/timeout` `/untimeout` `/kick` `/ban` `/unban` `/purge` `/slowmode` · music: skip or stop without a vote' });
    if (m.permissions.has(P.ManageGuild) || isOwner(interaction.user, interaction.guild)) {
      let admin = '`/setup show|logs|welcome|verify|verify-off|verify-existing|joinvoice|joinvoice-off|tickets|scamfilter` · `/buttonroles` · `/lockdown` · `/diagnostics` (checks everything is working)';
      if (isOwner(interaction.user, interaction.guild)) {
        const locked = rebuildLocked(interaction.guildId);
        admin += locked ? '\nOwner: `/setup restyle` (`/setup rebuild` is locked)' : '\nOwner: `/setup restyle` `/setup rebuild`';
      }
      fields.push({ name: '⚙️ Admin', value: admin });
    }
    await interaction.reply({ flags: MessageFlags.Ephemeral, embeds: [embed('info').setTitle('Commands').addFields(fields)] });
  },
};

module.exports = { commands: [help] };
