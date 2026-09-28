const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { embed, fmtDuration, truncate } = require('../lib/util');
const { isStaff } = require('../lib/music');

const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });

// --- shared checks ---------------------------------------------------------

// Returns the queue if music is playing and the user is in the same voice channel, otherwise replies and returns null.
async function needQueue(interaction) {
  const vc = interaction.member.voice?.channelId || null;
  if (!vc) { await interaction.reply(eph('Join a voice channel first.')); return null; }
  const q = interaction.client.music.get(interaction.guildId);
  if (!q?.current) { await interaction.reply(eph('Nothing is playing.')); return null; }
  if (q.voiceChannelId !== vc) { await interaction.reply(eph(`I'm playing in <#${q.voiceChannelId}>. Join that channel to control the music.`)); return null; }
  return q;
}

// Skip/stop: majority vote of the people in the VC. Staff skip or stop instantly.
async function doVote(interaction, q, kind) {
  const title = truncate(q.current.info.title, 80);
  if (isStaff(interaction.member)) {
    if (kind === 'skip') {
      await interaction.reply({ embeds: [embed('grey').setDescription(`⏭ ${interaction.user} (staff) skipped **${title}**.`)] });
      return q.skip();
    }
    await interaction.reply({ embeds: [embed('grey').setDescription(`⏹ ${interaction.user} (staff) stopped the music.`)] });
    return q.destroy();
  }
  const v = q.vote(kind, interaction.user.id);
  if (v.passed) {
    if (kind === 'skip') {
      await interaction.reply({ embeds: [embed('grey').setDescription(`⏭ Skipped **${title}** by vote (${v.count}/${v.needed}).`)] });
      return q.skip();
    }
    await interaction.reply({ embeds: [embed('grey').setDescription(`⏹ Stopped by vote (${v.count}/${v.needed}).`)] });
    return q.destroy();
  }
  await interaction.reply(eph(`${v.already ? 'You already voted.' : 'Vote counted.'} ${kind === 'skip' ? 'Skip' : 'Stop'} votes: **${v.count}/${v.needed}** (needs more than half of the people in the channel).`));
  q.refreshPanel();
}

function queueEmbed(q, page = 1) {
  const per = 10;
  const pages = Math.max(1, Math.ceil(q.tracks.length / per));
  page = Math.min(Math.max(1, page), pages);
  const slice = q.tracks.slice((page - 1) * per, page * per);
  const lines = slice.map((t, i) => `\`${(page - 1) * per + i + 1}.\` ${truncate(t.info.title, 60)} · ${t.info.isStream ? 'LIVE' : fmtDuration(t.info.length)}`);
  const total = q.tracks.reduce((a, t) => a + (t.info.isStream ? 0 : t.info.length), 0);
  return embed('info')
    .setTitle('📜 Queue')
    .setDescription(`**Now:** ${truncate(q.current.info.title, 80)}\n\n${lines.join('\n') || '*Nothing up next*'}`)
    .setFooter({ text: `Page ${page}/${pages} · ${q.tracks.length} tracks · ${fmtDuration(total)}` });
}

// --- commands --------------------------------------------------------------

const play = {
  data: new SlashCommandBuilder().setName('play').setDescription('Play a song or add it to the queue')
    .addStringOption((o) => o.setName('query').setDescription('Song name, YouTube or Spotify link (playlists work too)').setRequired(true)),
  async execute(interaction) {
    const music = interaction.client.music;
    const vc = interaction.member.voice?.channel;
    if (!vc) return interaction.reply(eph('Join a voice channel first.'));
    const existing = music.get(interaction.guildId);
    if (existing && existing.voiceChannelId !== vc.id)
      return interaction.reply(eph(`I'm already playing in <#${existing.voiceChannelId}>. Join that channel.`));
    const perms = vc.permissionsFor(interaction.guild.members.me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]))
      return interaction.reply(eph(`I don't have permission to join or speak in ${vc}.`));

    const query = interaction.options.getString('query', true);

    await interaction.deferReply();
    let result;
    try {
      result = await music.resolve(query);
    } catch (e) {
      return interaction.editReply(`Couldn't load that: ${truncate(e.message, 300)}`);
    }
    if (!result.tracks.length) return interaction.editReply('No results found.');
    for (const t of result.tracks) t.requester = interaction.user.id;

    let q;
    try {
      q = await music.create(interaction.guild, vc.id, interaction.channel);
    } catch (e) {
      return interaction.editReply(`Couldn't join voice: ${truncate(e.message, 300)}`);
    }
    if (q.voiceChannelId !== vc.id) return interaction.editReply(`I just joined <#${q.voiceChannelId}> for someone else. Join that channel.`);
    const added = q.add(result.tracks);
    const wasIdle = !q.current;
    await q.start();
    const where = q.textChannel && q.textChannel.id !== interaction.channelId ? ` · controls in ${q.textChannel}` : '';

    if (result.playlist) {
      const cut = result.tracks.length - added;
      await interaction.editReply({ embeds: [embed('ok').setDescription(`Queued **${added}** tracks from **${truncate(result.playlist, 80)}**${cut > 0 ? ` (${cut} left out: the queue is full)` : ''}${where}`)] });
    } else {
      const t = result.tracks[0];
      await interaction.editReply({
        embeds: [embed('ok').setDescription(`${wasIdle ? 'Playing' : 'Queued'} **[${truncate(t.info.title, 90)}](${t.info.uri})** · ${t.info.isStream ? 'LIVE' : fmtDuration(t.info.length)}${where}`)],
      });
    }
  },
};

const skip = {
  data: new SlashCommandBuilder().setName('skip').setDescription('Vote to skip the current song (staff skip instantly)'),
  async execute(interaction) {
    const q = await needQueue(interaction); if (!q) return;
    await doVote(interaction, q, 'skip');
  },
};

const stop = {
  data: new SlashCommandBuilder().setName('stop').setDescription('Vote to stop the music and clear the queue (staff stop instantly)'),
  async execute(interaction) {
    const q = await needQueue(interaction); if (!q) return;
    await doVote(interaction, q, 'stop');
  },
};

async function setPaused(q, paused) {
  await q.setPaused(paused);
  if (paused) q.scheduleIdleLeave(); else q.clearIdle();
  q.refreshPanel();
}

const pause = {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  async execute(interaction) {
    const q = await needQueue(interaction); if (!q) return;
    await setPaused(q, true);
    await interaction.reply('⏸ Paused. (I leave if paused for 2 minutes.)');
  },
};

const resume = {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  async execute(interaction) {
    const q = await needQueue(interaction); if (!q) return;
    await setPaused(q, false);
    await interaction.reply('▶️ Resumed.');
  },
};

const queue = {
  data: new SlashCommandBuilder().setName('queue').setDescription('Show the queue')
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  async execute(interaction) {
    const q = interaction.client.music.get(interaction.guildId);
    if (!q?.current) return interaction.reply(eph('Nothing is playing.'));
    await interaction.reply({ embeds: [queueEmbed(q, interaction.options.getInteger('page') || 1)] });
  },
};

const nowplaying = {
  data: new SlashCommandBuilder().setName('nowplaying').setDescription('Bring the music panel back to the bottom of the chat'),
  async execute(interaction) {
    const q = await needQueue(interaction); if (!q) return;
    await q.postPanel();
    await interaction.reply(eph(q.panelMsg ? `Music panel: ${q.panelMsg.url}` : 'Couldn’t post the panel (check my permissions).'));
  },
};

// --- panel buttons ---------------------------------------------------------

const components = {
  'music:toggle': async (i) => {
    const q = await needQueue(i); if (!q) return;
    await i.deferUpdate();
    await setPaused(q, !q.player.paused);
  },
  'music:skip': async (i) => { const q = await needQueue(i); if (q) await doVote(i, q, 'skip'); },
  'music:stop': async (i) => { const q = await needQueue(i); if (q) await doVote(i, q, 'stop'); },
  'music:shuffle': async (i) => {
    const q = await needQueue(i); if (!q) return;
    q.shuffle();
    await i.reply({ embeds: [embed('grey').setDescription(`🔀 ${i.user} shuffled the queue.`)] });
    q.refreshPanel();
  },
  'music:queue': async (i) => {
    const q = i.client.music.get(i.guildId);
    if (!q?.current) return i.reply(eph('Queue is empty.'));
    await i.reply({ embeds: [queueEmbed(q)], flags: MessageFlags.Ephemeral });
  },
  'music:voldown': async (i) => {
    const q = await needQueue(i); if (!q) return;
    await i.deferUpdate();
    await q.setVolume(q.volume - 10);
    q.refreshPanel();
  },
  'music:volup': async (i) => {
    const q = await needQueue(i); if (!q) return;
    await i.deferUpdate();
    await q.setVolume(q.volume + 10);
    q.refreshPanel();
  },
};

module.exports = { commands: [play, skip, stop, pause, resume, queue, nowplaying], components };
