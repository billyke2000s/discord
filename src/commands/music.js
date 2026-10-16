const {
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  escapeMarkdown,
} = require('discord.js');
const { embed, fmtDuration, truncate } = require('../lib/util');
const { isStaff } = require('../lib/music');
const lyricsLib = require('../lib/lyrics');

const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });

// --- shared checks ---------------------------------------------------------

// Returns the queue if music is playing and the user is in the same voice channel, otherwise replies and returns null.
async function needQueue(interaction) {
  const vc = interaction.member.voice?.channelId || null;
  if (!vc) {
    await interaction.reply(eph('Join a voice channel first.'));
    return null;
  }
  const q = interaction.client.music.get(interaction.guildId);
  if (!q?.current) {
    await interaction.reply(eph('Nothing is playing.'));
    return null;
  }
  if (q.voiceChannelId !== vc) {
    await interaction.reply(eph(`I'm playing in <#${q.voiceChannelId}>. Join that channel to control the music.`));
    return null;
  }
  return q;
}

// Skip/stop: majority vote of the people in the VC. Staff skip or stop instantly.
async function doVote(interaction, q, kind) {
  if (kind === 'previous' && !q.history.length)
    return interaction.reply(eph('There is no previous song in this music session yet.'));
  if (kind === 'shuffle' && q.tracks.length < 2)
    return interaction.reply(eph('There need to be at least two songs queued to shuffle.'));
  const title = truncate(q.current.info.title, 80);
  if (isStaff(interaction.member)) {
    if (kind === 'skip') {
      await interaction.reply({
        embeds: [embed('grey').setDescription(`⏭ ${interaction.user} (staff) skipped **${title}**.`)],
      });
      return q.skip();
    }
    if (kind === 'previous') {
      await interaction.reply({
        embeds: [embed('grey').setDescription(`⏮ ${interaction.user} (staff) went back to the previous song.`)],
      });
      return q.previous();
    }
    if (kind === 'shuffle') {
      q.shuffle();
      await interaction.reply({
        embeds: [embed('grey').setDescription(`🔀 ${interaction.user} (staff) shuffled the queue.`)],
      });
      return q.refreshPanel();
    }
    await interaction.reply({
      embeds: [embed('grey').setDescription(`⏹ ${interaction.user} (staff) stopped the music.`)],
    });
    return q.destroy();
  }
  const v = q.vote(kind, interaction.user.id);
  if (v.passed) {
    if (kind === 'skip') {
      await interaction.reply({
        embeds: [embed('grey').setDescription(`⏭ Skipped **${title}** by vote (${v.count}/${v.needed}).`)],
      });
      return q.skip();
    }
    if (kind === 'previous') {
      await interaction.reply({
        embeds: [embed('grey').setDescription(`⏮ Going back to the previous song by vote (${v.count}/${v.needed}).`)],
      });
      return q.previous();
    }
    if (kind === 'shuffle') {
      q.shuffle();
      await interaction.reply({
        embeds: [embed('grey').setDescription(`🔀 Queue shuffled by vote (${v.count}/${v.needed}).`)],
      });
      return q.refreshPanel();
    }
    await interaction.reply({ embeds: [embed('grey').setDescription(`⏹ Stopped by vote (${v.count}/${v.needed}).`)] });
    return q.destroy();
  }
  const label = { skip: 'Skip', previous: 'Go back', stop: 'Stop', shuffle: 'Shuffle' }[kind];
  await interaction.reply(
    eph(
      `${v.already ? 'You already voted.' : 'Vote counted.'} ${label} votes: **${v.count}/${v.needed}** (needs more than half of the people in the channel).`,
    ),
  );
  q.refreshPanel();
}

function queueEmbed(q, page = 1) {
  const per = 10;
  const visible = Math.min(q.tracks.length, 99);
  const pages = Math.max(1, Math.ceil(visible / per));
  page = Math.min(Math.max(1, page), pages);
  const slice = q.tracks.slice((page - 1) * per, Math.min(page * per, visible));
  const lines = slice.map(
    (t, i) =>
      `\`${(page - 1) * per + i + 1}.\` ${truncate(t.info.title, 60)} · ${t.info.isStream ? 'LIVE' : fmtDuration(t.info.length)}`,
  );
  const total = q.tracks.reduce((a, t) => a + (t.info.isStream ? 0 : t.info.length), 0);
  return embed('info')
    .setTitle('📜 Queue')
    .setDescription(`**Now:** ${truncate(q.current.info.title, 80)}\n\n${lines.join('\n') || '*Nothing up next*'}`)
    .setFooter({
      text: `Page ${page}/${pages} · showing ${visible} of ${q.tracks.length} queued tracks · ${fmtDuration(total)}${q.tracks.length > 99 ? ' · the rest still play' : ''}`,
    });
}

// --- commands --------------------------------------------------------------
function queuePayload(q, userId, page = 1) {
  const pages = Math.max(1, Math.ceil(Math.min(q.tracks.length, 99) / 10));
  page = Math.min(Math.max(1, page), pages);
  let index = 0;
  const button = (label, target, disabled) =>
    new ButtonBuilder()
      .setCustomId(`music:queuepage:${q.sessionId}:${userId}:${target}:${index++}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);
  return {
    embeds: [queueEmbed(q, page)],
    components: [
      new ActionRowBuilder().addComponents(
        button('⏮ First', 1, page === 1),
        button('◀ Previous', Math.max(1, page - 1), page === 1),
        button(`Page ${page}/${pages}`, page, true),
        button('Next ▶', Math.min(pages, page + 1), page === pages),
        button('Last ⏭', pages, page === pages),
      ),
    ],
  };
}
async function queuePage(i, suffix) {
  const match = /^([a-f0-9]{16}):(\d+):(\d{1,2}):[0-4]$/.exec(suffix);
  if (!match) return i.reply(eph('This queue control is invalid. Open /queue again.'));
  if (i.user.id !== match[2]) return i.reply(eph('Open /queue to browse your own queue view.'));
  const q = i.client.music.get(i.guildId);
  if (!q?.current || q.destroyed || q.sessionId !== match[1])
    return i.update({
      content: 'This music session has ended. Open /queue for the current session.',
      embeds: [],
      components: [],
    });
  return i.update(queuePayload(q, i.user.id, Number(match[3])));
}

// --- lyrics (private, follows the song) ------------------------------------
const LYRICS_LIVE_MS = 14 * 60_000; // Discord lets the bot edit a private reply for 15 minutes
const LYRICS_EVERY_MS = 4_000;
const LYRICS_LINES = 15; // lines shown at once
const LYRICS_BEFORE = 3; // of which this many already sung
const LYRICS_MAX_LIVE = 25; // live views at once across the bot; more get a still view
const liveLyrics = new Map(); // guildId:userId -> stop()

// The private lyrics view for `track` at the queue's current position. `key` changes only when the
// view would look different, so unchanged views aren't re-sent.
function lyricsView(q, track, found, { ended = false } = {}) {
  const name = truncate(track.info.title, 80);
  const trackKey = `${q.sessionId}:${track.info.identifier || track.info.uri || track.info.title}`;
  const tail = ended ? ' · Stopped following the song: run /lyrics again' : '';
  if (!found) {
    return {
      key: `${trackKey}:none`,
      payload: {
        embeds: [
          embed('grey')
            .setTitle('🎤 Lyrics')
            .setDescription(`No lyrics found for **${escapeMarkdown(name)}**.`)
            .setFooter({ text: `Only you can see this${tail}` }),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setStyle(ButtonStyle.Link)
              .setLabel('Search the web')
              .setURL(lyricsLib.searchUrl(track)),
          ),
        ],
      },
    };
  }
  const title = truncate(`🎤 ${found.title || track.info.title}${found.artist ? ` — ${found.artist}` : ''}`, 250);
  let description, key, note;
  if (found.instrumental && !found.synced && !found.plain) {
    description = '🎹 Instrumental: no lyrics.';
    key = `${trackKey}:inst`;
    note = '';
  } else if (found.synced) {
    const lines = found.synced;
    const at = lyricsLib.indexAt(lines, q.position());
    const start = Math.max(0, Math.min(at - LYRICS_BEFORE, lines.length - LYRICS_LINES));
    description = lines
      .slice(start, start + LYRICS_LINES)
      .map((l, n) => {
        const text = escapeMarkdown(truncate(l.text || '♪', 200));
        return start + n === at ? `**▶ ${text}**` : text;
      })
      .join('\n');
    if (at < 0) description = `*♪ starting…*\n${description}`;
    key = `${trackKey}:${at}`;
    note = ' · Synced';
  } else {
    description = escapeMarkdown(found.plain);
    key = `${trackKey}:plain`;
    note = ' · Not synced for this song';
  }
  return {
    key: `${key}${ended ? ':end' : ''}`,
    payload: {
      embeds: [
        embed('info')
          .setTitle(title)
          .setDescription(truncate(description, 4000))
          .setFooter({ text: `Only you can see this · Lyrics from LRCLIB${note}${tail}` }),
      ],
      components: [],
    },
  };
}

// /lyrics and the panel's 📝 button: a private view that follows the song (and the next songs) for 14 minutes.
async function openLyrics(i) {
  const music = i.client.music;
  let q = music.get(i.guildId);
  if (!q?.current) return i.reply(eph('Nothing is playing.'));
  if (!music.findLyrics) return i.reply(eph('Lyrics are turned off on this bot.'));
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const id = `${i.guildId}:${i.user.id}`;
  liveLyrics.get(id)?.(); // one live view per person: the newest replaces the old
  let track = q.current;
  let found = await q.lyricsFor(track);
  let view = lyricsView(q, track, found);
  await i.editReply(view.payload);
  if (liveLyrics.size >= LYRICS_MAX_LIVE) return;

  const started = Date.now();
  let last = view.key,
    busy = false;
  const stop = () => {
    clearInterval(timer);
    if (liveLyrics.get(id) === stop) liveLyrics.delete(id);
  };
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      q = music.get(i.guildId);
      if (!q?.current) {
        stop();
        return await i.editReply({ content: '⏹ The music stopped.', embeds: [], components: [] });
      }
      if (q.current !== track) {
        track = q.current;
        found = await q.lyricsFor(track);
      }
      const ended = Date.now() - started >= LYRICS_LIVE_MS;
      view = lyricsView(q, track, found, { ended });
      if (view.key !== last) {
        last = view.key;
        await i.editReply(view.payload);
      }
      if (ended) stop();
    } catch {
      stop(); // dismissed, expired or Discord refused: nothing more to update
    } finally {
      busy = false;
    }
  }, LYRICS_EVERY_MS);
  timer.unref?.();
  liveLyrics.set(id, stop);
}

const lyricsCommand = {
  data: new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Lyrics of the song playing now, only for you, following along as it plays'),
  execute: openLyrics,
};

const play = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or add it to the queue')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song name, YouTube or Spotify link (playlists work too)').setRequired(true),
    ),
  async execute(interaction) {
    const music = interaction.client.music;
    const vc = interaction.member.voice?.channel;
    if (!vc) return interaction.reply(eph('Join a voice channel first.'));
    const existing = music.get(interaction.guildId);
    if (!existing && music.updatePending)
      return interaction.reply(
        eph(
          'A bot update is being installed between songs right now. The music comes back in about a minute: try again then.',
        ),
      );
    if (existing && existing.voiceChannelId !== vc.id)
      return interaction.reply(eph(`I'm already playing in <#${existing.voiceChannelId}>. Join that channel.`));
    const perms = vc.permissionsFor(interaction.guild.members.me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]))
      return interaction.reply(eph(`I don't have permission to join or speak in ${vc}.`));

    const query = interaction.options.getString('query', true);

    await interaction.deferReply();
    return music.withPlayLock(interaction.guildId, async () => {
      // Recheck after waiting behind another import, including a concurrent join.
      const active = music.get(interaction.guildId);
      if (interaction.member.voice?.channelId !== vc.id)
        return interaction.editReply('You left the voice channel before this request could be queued.');
      if (active && active.voiceChannelId !== vc.id)
        return interaction.editReply(`I'm now playing in <#${active.voiceChannelId}>.`);
      let result;
      try {
        result = await music.resolveForPlayback(query);
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
      if (q.voiceChannelId !== vc.id)
        return interaction.editReply(`I just joined <#${q.voiceChannelId}> for someone else. Join that channel.`);
      const added = q.add(result.tracks);
      const wasIdle = !q.current;
      await q.start();
      if (q.destroyed) return interaction.editReply('This music session ended before playback could start.');
      const where =
        q.textChannel && q.textChannel.id !== interaction.channelId ? ` · controls in ${q.textChannel}` : '';

      if (result.remaining && added) {
        await interaction.editReply('First track queued; loading the rest of the playlist in the background.');
        await q.importRemaining(result.remaining, result.tracks[0], interaction.user.id, async (r) => {
          const message = r.error
            ? `First track kept, but the rest of the playlist could not load: ${truncate(r.error, 200)}`
            : `Added **${r.added}** more tracks from **${truncate(r.playlist || 'YouTube playlist', 80)}**${r.omitted ? ` (${r.omitted} left out: queue full)` : ''}${where}`;
          await interaction.editReply(message).catch(() => {});
        });
      } else if (result.playlist) {
        const cut = result.tracks.length - added;
        await interaction.editReply({
          embeds: [
            embed('ok').setDescription(
              `Queued **${added}** tracks from **${truncate(result.playlist, 80)}**${cut > 0 ? ` (${cut} left out: the queue is full)` : ''}${where}`,
            ),
          ],
        });
      } else {
        const t = result.tracks[0];
        await interaction.editReply({
          embeds: [
            embed('ok').setDescription(
              `${wasIdle ? 'Playing' : 'Queued'} **[${truncate(t.info.title, 90)}](${t.info.uri})** · ${t.info.isStream ? 'LIVE' : fmtDuration(t.info.length)}${where}`,
            ),
          ],
        });
      }
    });
  },
};

const skip = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Vote to skip the current song (staff skip instantly)'),
  async execute(interaction) {
    const q = await needQueue(interaction);
    if (!q) return;
    await doVote(interaction, q, 'skip');
  },
};

const stop = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Vote to stop the music and clear the queue (staff stop instantly)'),
  async execute(interaction) {
    const q = await needQueue(interaction);
    if (!q) return;
    await doVote(interaction, q, 'stop');
  },
};

const removedControl = (i) =>
  i.reply(eph('Pause/resume and volume controls have been removed. Open /nowplaying for the current controls.'));

const queue = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the queue')
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  async execute(interaction) {
    const q = interaction.client.music.get(interaction.guildId);
    if (!q?.current) return interaction.reply(eph('Nothing is playing.'));
    await interaction.reply(queuePayload(q, interaction.user.id, interaction.options.getInteger('page') || 1));
  },
};

const nowplaying = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Bring the music panel back to the bottom of the chat'),
  async execute(interaction) {
    const q = await needQueue(interaction);
    if (!q) return;
    await q.postPanel();
    await interaction.reply(
      eph(q.panelMsg ? `Music panel: ${q.panelMsg.url}` : 'Couldn’t post the panel (check my permissions).'),
    );
  },
};

// --- panel buttons ---------------------------------------------------------

const components = {
  'music:toggle': removedControl,
  'music:previous': async (i) => {
    const q = await needQueue(i);
    if (q) await doVote(i, q, 'previous');
  },
  'music:skip': async (i) => {
    const q = await needQueue(i);
    if (q) await doVote(i, q, 'skip');
  },
  'music:stop': async (i) => {
    const q = await needQueue(i);
    if (q) await doVote(i, q, 'stop');
  },
  'music:shuffle': async (i) => {
    const q = await needQueue(i);
    if (q) await doVote(i, q, 'shuffle');
  },
  'music:lyrics': openLyrics,
  'music:queue': async (i) => {
    const q = i.client.music.get(i.guildId);
    if (!q?.current) return i.reply(eph('Queue is empty.'));
    await i.reply({ ...queuePayload(q, i.user.id), flags: MessageFlags.Ephemeral });
  },
  'music:voldown': removedControl,
  'music:volup': removedControl,
};

module.exports = {
  commands: [play, skip, stop, queue, nowplaying, lyricsCommand],
  components,
  prefixComponents: { 'music:queuepage:': queuePage },
  queueEmbed,
  queuePayload,
  lyricsView,
  _liveLyrics: liveLyrics,
};
