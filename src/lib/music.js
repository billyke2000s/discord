// Per-guild music queue on top of Shoukaku (Lavalink client), plus the self-updating music panel.
const { Shoukaku, Connectors } = require('shoukaku');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits: P } = require('discord.js');
const { embed, fmtDuration, truncate, isBotAdmin } = require('./util');
const spotify = require('./spotify');
const { randomBytes } = require('node:crypto');
const { youtubePlaylist, bootstrapVideo, withoutBootstrap } = require('./playlist');
const { AudioMonitor } = require('./audio-monitor');

const SAVE_EVERY_MS = 5_000; // save queue changes within 5 s
const SAVE_POSITION_MS = 30_000; // and the song position at least every 30 s while playing
const RESUME_MAX_AGE_MS = 30 * 60_000; // don't resume a session saved more than 30 minutes ago
const IDLE_LEAVE_MS = 2 * 60 * 1000; // leave after 2 min with empty queue or empty channel
const MAX_QUEUE = 2000; // playback capacity, independent of the visible queue preview
const PANEL_REFRESH_MS = 5_000; // how often the panel's time + progress bar update (1 edit / 5 s)
const VOL_MIN = 10,
  VOL_MAX = 100;
const BRAND_COLOR = 0x5865f2;

// Staff can skip or stop without a vote. Staff = Moderate Members permission (Staff/Admin roles), the owner, or a bot admin.
function isStaff(member) {
  return member.id === member.guild.ownerId || isBotAdmin(member.id) || member.permissions.has(P.ModerateMembers);
}

// Links members may give to /play. Anything else would make the music server fetch an arbitrary
// address from the VPS (including private addresses), so it is refused before reaching Lavalink.
// Checked here too because automatic updates replace only the bot, not lavalink/application.yml.
const LINK_HOSTS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'soundcloud.com',
  'twitch.tv',
  'vimeo.com',
  'bandcamp.com',
];
function isSupportedLink(query) {
  let url;
  try {
    url = new URL(query);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return LINK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

// Embed builders throw on bad URLs; a bad artwork link from a source must never crash the bot.
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\/\S+$/i.test(u) ? u : null);

// ---------- Spotify -> YouTube matching ----------
const GOOD_MATCH = 70;
// Album words that say nothing about which album it is.
const ALBUM_FILLER = new Set([
  'the',
  'and',
  'original',
  'soundtrack',
  'ost',
  'set',
  'deluxe',
  'edition',
  'version',
  'ver',
  'remaster',
  'remastered',
  'digital',
  'expanded',
  'anniversary',
  'vol',
  'volume',
  'part',
  'disc',
  'music',
  'from',
  'motion',
  'picture',
  'game',
  'video',
  'series',
  'songs',
  'collection',
  'greatest',
  'hits',
  'best',
  'album',
  'single',
  'ep',
]);
const albumWords = (album) => [...new Set(words(album).filter((w) => w.length >= 4 && !ALBUM_FILLER.has(w)))];
// "Catherine & Catherine Full Body Soundtrack Set" -> "Catherine Full Body" (what fans put in upload titles)
const albumQuery = (album) => albumWords(album).slice(0, 4).join(' ');
// Versions people upload that are NOT the original song. Penalised unless the Spotify title has the word too.
const ALT_VERSION = [
  'sped up',
  'speed up',
  'slowed',
  'nightcore',
  'reverb',
  '8d',
  'bass boosted',
  'karaoke',
  'instrumental',
  'cover',
  'remix',
  'live',
  'acapella',
  'a cappella',
  '1 hour',
  '1hr',
  'hour',
  'loop',
  'looped',
  'extended',
  'reaction',
  'piano version',
  'lyrics video',
];
const norm = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
const words = (s) =>
  norm(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const compact = (s) => words(s).join('');

// 0-100ish: how likely YouTube result `r` is the exact Spotify song `want` (same artist, same title, same length).
function matchScore(want, r) {
  let score = 0;
  const ytTitle = norm(r.title),
    channel = compact(String(r.author || '').replace(/- topic$/i, ''));
  const artists = String(want.author || '')
    .split(',')
    .map(compact)
    .filter((a) => a.length >= 2);
  // Artist: the channel is the artist (YouTube Music / "Artist - Topic" / ArtistVEVO), or the artist is named in the title.
  if (artists.some((a) => channel && (channel.includes(a) || a.includes(channel)))) score += 40;
  else if (artists.some((a) => compact(r.title).includes(a))) score += 25;
  // Title: how many of the Spotify title's words appear in the YouTube title.
  const tw = words(want.title).filter((w) => w.length > 1 || /\p{N}/u.test(w));
  if (tw.length) score += 30 * (tw.filter((w) => ytTitle.includes(w)).length / tw.length);
  // Length: the same recording is within a few seconds.
  if (want.length && r.length) {
    const d = Math.abs(r.length - want.length) / 1000;
    score += d <= 3 ? 25 : d <= 8 ? 15 : d <= 15 ? 5 : d <= 30 ? -10 : -30;
  }
  // Album: fan uploads of soundtracks name the game/film/album instead of the artist.
  const aw = albumWords(want.album);
  if (aw.length) {
    const hay = ` ${words(`${r.title} ${r.author}`).join(' ')} `;
    const hit = aw.filter((w) => hay.includes(` ${w} `)).length;
    if (hit) score += 20 + 5 * (hit / aw.length);
  }
  // Sped up / slowed / cover / live... when the Spotify song isn't.
  const has = (text, phrase) => ` ${words(text).join(' ')} `.includes(` ${phrase} `); // whole words only ("live" but not "alive")
  for (const v of ALT_VERSION) if (has(r.title, v) && !has(want.title, v)) score -= 40;
  if (r.isStream) score -= 50;
  return score;
}

function progressBar(pos, len, size = 18) {
  const filled = Math.min(size, Math.max(0, Math.round((pos / len) * size)));
  return '━'.repeat(filled) + '●' + '─'.repeat(size - filled);
}

class GuildQueue {
  constructor(manager, guildId, player, textChannel, voiceChannelId) {
    this.manager = manager;
    this.guildId = guildId;
    this.sessionId = randomBytes(8).toString('hex');
    this.player = player;
    this.textChannel = textChannel; // where the panel goes: the voice channel's own chat if I can post there
    this.fallbackChannel = null; // the channel /play was used in, if the voice chat fails
    this.voiceChannelId = voiceChannelId;
    this.tracks = [];
    this.current = null;
    this.idleTimer = null; // queue empty: leave after IDLE_LEAVE_MS
    this.aloneTimer = null; // voice channel empty: leave after IDLE_LEAVE_MS (separate, see checkAlone)
    this.destroyed = false;
    this.transition = null;
    this.revision = 0;
    this.imports = new Set();
    this.preparing = new WeakMap();
    this.prefetching = false;
    this.volume = Number(process.env.DEFAULT_VOLUME || 60);
    this.votes = { skip: new Set(), stop: new Set(), previous: new Set(), shuffle: new Set() };
    this.history = [];
    this.playedCurrent = false;
    this.panelMsg = null;
    this.panelTimer = null;
    this.panelGeneration = 0;
    // Our own song clock. Lavalink only reports the position every 5 s, so between reports we
    // count forward from the last one (and stop counting while paused).
    this.clock = { base: 0, at: Date.now() };
    this.monitor = new AudioMonitor(guildId, manager.recordAudio);
    this.monitorTimer = setInterval(() => this.monitor.check(this.player.node?.stats), 5000);
    this.monitorTimer.unref();
    // Persistence: `changes` counts queue edits; persist() writes when it moved, or every 30 s for the position.
    this.changes = 0;
    this.savedChanges = -1;
    this.savedAt = 0;
    this.persistTimer = setInterval(() => this.persist(), SAVE_EVERY_MS);
    this.persistTimer.unref?.();

    player.on('update', (d) => {
      this.monitor.update(d?.state);
      if (typeof d?.state?.position === 'number') this.clock = { base: d.state.position, at: Date.now() };
    });
    player.on('start', (event) => {
      if (!this.matchesPlaybackEvent(event)) return;
      this.monitor.start();
      this.monitor.pause(this.player.paused);
      this.clock = { base: this.playback?.startAt || 0, at: Date.now() };
      this.votes.skip.clear();
      this.votes.stop.clear();
      this.votes.previous.clear();
      this.votes.shuffle.clear();
      this.postPanel();
    });
    player.on('end', (e) => {
      // 'replaced' = we called playTrack over it; 'cleanup' = player destroyed. Don't advance on those.
      if (e.reason === 'replaced' || e.reason === 'cleanup') return;
      if (!this.matchesPlaybackEvent(e)) return;
      this.monitor.stop(e.reason);
      this.advanceAfterEvent(e);
    });
    player.on('stuck', (e) => {
      if (!this.matchesPlaybackEvent(e)) return;
      this.monitor.emit('track-stuck');
      this.monitor.stop('stuck');
      this.advanceAfterEvent(e);
    });
    player.on('exception', (e) => {
      if (!this.matchesPlaybackEvent(e)) return;
      // Raw source error text may contain signed URLs or credentials: keep it out of public chat.
      // Only the event type is recorded; the error text goes to the private bot log.
      this.monitor.emit('track-exception');
      console.warn('[music] track exception:', truncate(e.exception?.message || 'unknown error', 300));
      this.send(
        embed('bad').setDescription(
          `Couldn't play **${truncate(this.current?.info.title || 'that track', 80)}**. Skipping to the next song.`,
        ),
      );
      this.advanceAfterEvent(e);
    });
    player.on('closed', () => {
      this.monitor.emit('voice-closed');
      this.destroy();
    });
  }

  // Where the song is right now, in ms.
  position() {
    const { base, at } = this.clock;
    return this.player.paused ? base : base + (Date.now() - at);
  }

  async setPaused(paused) {
    if (paused === this.player.paused) return;
    this.clock = { base: this.position(), at: Date.now() }; // freeze/restart the clock at the current spot
    await this.player.setPaused(paused);
    this.monitor.pause(paused);
    this.clock.at = Date.now();
  }

  get guild() {
    return this.manager.client.guilds.cache.get(this.guildId);
  }

  // Humans in the bot's voice channel (the bot and other bots don't count).
  listeners() {
    const ch = this.guild?.channels.cache.get(this.voiceChannelId);
    return ch ? ch.members.filter((m) => !m.user.bot) : new Map();
  }

  send(e) {
    return this.textChannel?.send({ embeds: [e] }).catch(() => {});
  }

  // ---------- votes ----------
  // kind: 'skip' | 'stop' | 'previous'. Returns { passed, count, needed, already }.
  vote(kind, userId) {
    const humans = this.listeners();
    const set = this.votes[kind];
    for (const id of set) if (!humans.has(id)) set.delete(id); // people who left don't count
    const already = set.has(userId);
    set.add(userId);
    const needed = Math.floor(humans.size / 2) + 1; // more than half
    return { passed: set.size >= needed, count: set.size, needed, already };
  }

  voteStatus(kind) {
    const humans = this.listeners();
    const count = [...this.votes[kind]].filter((id) => humans.has(id)).length;
    return { count, needed: Math.floor(humans.size / 2) + 1 };
  }

  // Someone left the channel: a vote that was one short might now have a majority.
  async recheckVotes() {
    if (!this.current || this.destroyed) return;
    const stop = this.voteStatus('stop');
    if (stop.count > 0 && stop.count >= stop.needed) {
      this.send(embed('grey').setDescription('⏹ Stopped by vote.'));
      return this.destroy();
    }
    const skip = this.voteStatus('skip');
    if (skip.count > 0 && skip.count >= skip.needed) {
      this.send(embed('grey').setDescription(`⏭ Skipped **${truncate(this.current.info.title, 80)}** by vote.`));
      return this.skip();
    }
    const previous = this.voteStatus('previous');
    if (previous.count > 0 && previous.count >= previous.needed && this.history.length) {
      this.send(embed('grey').setDescription('⏮ Going back to the previous song by vote.'));
      return this.previous();
    }
    const shuffle = this.voteStatus('shuffle');
    if (shuffle.count > 0 && shuffle.count >= shuffle.needed && this.tracks.length > 1) {
      this.send(embed('grey').setDescription('🔀 Queue shuffled by vote.'));
      this.shuffle();
      return this.refreshPanel();
    }
    if (stop.count || skip.count || previous.count || shuffle.count) this.refreshPanel();
  }

  // ---------- panel ----------
  panelPayload(state = 'playing') {
    const me = this.guild?.members.me;
    const brand = {
      name: `${me?.displayName || 'Music'} · Music`,
      iconURL: safeUrl(me?.displayAvatarURL()) || undefined,
    };
    const t = this.current;

    if (state !== 'playing' || !t) {
      const text =
        {
          stopped: '⏹ Music stopped.',
          restarting: '⏸ The bot is restarting. Music will carry on from here in a moment.',
          reconnecting: "⏸ Lost the music server. Music will carry on from here when it's back.",
        }[state] || '✅ Queue finished. Use `/play` to add more.';
      return { embeds: [embed(BRAND_COLOR).setAuthor(brand).setDescription(text)], components: [] };
    }

    const len = t.info.length,
      pos = Math.max(0, Math.min(this.position(), len || 0));
    const time = t.info.isStream
      ? '🔴 LIVE'
      : `\`${fmtDuration(pos)}\` ${progressBar(pos, len)} \`${fmtDuration(len)}\``;
    const next =
      this.tracks
        .slice(0, 3)
        .map((x, i) => `\`${i + 1}.\` ${truncate(x.info.title, 55)}`)
        .join('\n') || '*Nothing — add songs with `/play`*';
    const skip = this.voteStatus('skip'),
      stop = this.voteStatus('stop'),
      previous = this.voteStatus('previous'),
      shuffle = this.voteStatus('shuffle');
    const paused = this.player.paused;
    // Spotify songs: show which YouTube upload is really playing, so a wrong match is easy to spot.
    const pf = t.playedFrom,
      pfUrl = safeUrl(pf?.uri);
    const from = pf
      ? `\n▶ YouTube: ${pfUrl ? `[${truncate(pf.title, 70).replace(/[[\]]/g, '')}](${pfUrl})` : truncate(pf.title, 70)}${pf.author ? ` · ${truncate(pf.author, 40)}` : ''}`
      : '';

    const e = embed(BRAND_COLOR)
      .setAuthor(brand)
      .setTitle(truncate(t.info.title, 250))
      .setURL(safeUrl(t.info.uri))
      .setThumbnail(safeUrl(t.info.artworkUrl))
      .setDescription(`${t.info.author || ''}${from}\n\n${paused ? '⏸ **Paused**\n' : ''}${time}`)
      .addFields(
        { name: 'Requested by', value: `<@${t.requester}>`, inline: true },
        { name: 'Volume', value: `${this.volume}%`, inline: true },
        { name: 'In queue', value: String(this.tracks.length), inline: true },
        { name: 'Up next', value: next },
      )
      .setFooter({
        text: `Back, skip, stop and shuffle need a majority (${skip.needed} of ${this.listeners().size} listening). Staff can act instantly.`,
      });

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('music:previous')
        .setEmoji('⏮️')
        .setLabel(previous.count ? `Back ${previous.count}/${previous.needed}` : 'Vote go back')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!this.history.length),
      new ButtonBuilder()
        .setCustomId('music:skip')
        .setEmoji('⏭️')
        .setLabel(skip.count ? `Skip ${skip.count}/${skip.needed}` : 'Vote skip')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('music:stop')
        .setEmoji('⏹️')
        .setLabel(stop.count ? `Stop ${stop.count}/${stop.needed}` : 'Vote stop')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('music:shuffle')
        .setEmoji('🔀')
        .setLabel(shuffle.count ? `Shuffle ${shuffle.count}/${shuffle.needed}` : 'Vote shuffle')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(this.tracks.length < 2),
      new ButtonBuilder().setCustomId('music:queue').setEmoji('📜').setLabel('Queue').setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [e], components: [row1] };
  }

  // New song: delete the old panel and post a fresh one at the bottom of the chat.
  async postPanel() {
    if (this.destroyed || !this.textChannel) return;
    const generation = ++this.panelGeneration;
    const old = this.panelMsg;
    let payload;
    try {
      payload = this.panelPayload();
    } catch (e) {
      return console.error('[music panel]', e.message);
    }
    let message = await this.textChannel.send(payload).catch(() => null);
    if (this.destroyed || generation !== this.panelGeneration) {
      await message?.delete().catch(() => {});
      return;
    }
    if (!message && this.fallbackChannel && this.fallbackChannel !== this.textChannel) {
      this.textChannel = this.fallbackChannel; // voice chat didn't work: use the /play channel from now on
      message = await this.textChannel.send(payload).catch(() => null);
    }
    if (this.destroyed || generation !== this.panelGeneration) {
      await message?.delete().catch(() => {});
      return;
    }
    this.panelMsg = message;
    if (old) old.delete().catch(() => {});
    clearInterval(this.panelTimer);
    this.panelTimer = setInterval(() => this.refreshPanel(), PANEL_REFRESH_MS);
  }

  refreshPanel(state) {
    if (!this.panelMsg) return;
    let payload;
    try {
      payload = this.panelPayload(state);
    } catch (e) {
      return console.error('[music panel]', e.message);
    }
    return this.panelMsg.edit(payload).catch(() => {});
  }

  endPanel(state) {
    this.panelGeneration++;
    clearInterval(this.panelTimer);
    this.panelTimer = null;
    const p = this.refreshPanel(state);
    this.panelMsg = null;
    return p;
  }

  // ---------- queue control ----------
  add(tracks) {
    if (this.destroyed) return 0;
    // Replaying a previously imported song does not discard queued songs or
    // consume another import slot; the original interrupted song stays up next.
    const room =
      MAX_QUEUE - this.tracks.filter((t) => !t.replay).length - (this.current && !this.current.replay ? 1 : 0);
    const added = tracks.slice(0, Math.max(0, room));
    this.tracks.push(...added);
    this.changes++;
    this.prefetch();
    if (this.current) this.refreshPanel(); // "Up next" changed
    return added.length;
  }

  shuffle() {
    this.votes.shuffle.clear();
    const a = this.tracks;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    this.changes++;
  }

  // ---------- persistence ----------
  // A plain copy of one queue entry: enough to play it again after a restart.
  static entry(t) {
    if (!t) return null;
    const { encoded, search, album, requester, playedFrom, playbackInfo, replay } = t;
    const { title, author, length, uri, isStream, artworkUrl, identifier, sourceName } = t.info || {};
    return {
      encoded: encoded || null,
      search,
      album,
      requester,
      playedFrom,
      playbackInfo,
      replay,
      info: { title, author, length, uri, isStream, artworkUrl, identifier, sourceName },
    };
  }

  snapshot() {
    return {
      v: 1,
      voiceChannelId: this.voiceChannelId,
      textChannelId: this.textChannel?.id || null,
      fallbackChannelId: this.fallbackChannel?.id || null,
      volume: this.volume,
      current: GuildQueue.entry(this.current),
      tracks: this.tracks.map(GuildQueue.entry),
      savedAt: Date.now(),
    };
  }

  // Save if the queue changed, or the position is stale. force = save now (shutdown).
  persist(force = false) {
    const store = this.manager.store;
    if (!store || this.destroyed || this.restoring) return;
    const now = Date.now();
    const position = this.current && !this.current.info?.isStream ? this.position() : 0;
    try {
      if (force || this.changes !== this.savedChanges) {
        // Queue finished: nothing to resume, so a restart now must not bring old songs back.
        if (!this.current && !this.tracks.length) store.remove(this.guildId);
        else store.save(this.guildId, this.snapshot(), position);
        this.savedChanges = this.changes;
        this.savedAt = now;
      } else if (this.current && now - this.savedAt >= SAVE_POSITION_MS) {
        store.savePosition(this.guildId, position);
        this.savedAt = now;
      }
    } catch (err) {
      console.error('[music] could not save the queue:', err.message);
    }
  }

  // Leave without forgetting: used for bot shutdown and losing the music server. Music resumes later.
  async suspend(reason = 'restart') {
    if (this.destroyed) return;
    this.persist(true);
    await this.destroy({ keep: true, reason });
  }

  async setVolume(v) {
    this.volume = Math.min(VOL_MAX, Math.max(VOL_MIN, v));
    await this.player.setGlobalVolume(this.volume).catch(() => {});
  }

  async start() {
    if (this.current) return;
    await this.next();
  }

  // Resolve only two upcoming Spotify entries at a time, one request chain at a
  // time. The full metadata list is cheap; matching 200 songs eagerly is not.
  prepare(track) {
    if (track.encoded) return Promise.resolve(track);
    if (this.preparing.has(track)) return this.preparing.get(track);
    const revision = this.revision;
    const task = this.manager
      .findOnYouTube(track)
      .then((found) => {
        if (this.destroyed || revision !== this.revision || !found) return null;
        track.encoded = found.encoded;
        track.info.length = found.info.length || track.info.length;
        track.info.artworkUrl = found.info.artworkUrl || null;
        track.playedFrom = { title: found.info.title, author: found.info.author, uri: found.info.uri };
        track.playbackInfo = { identifier: found.info.identifier, sourceName: found.info.sourceName };
        return track;
      })
      .catch(() => null)
      .finally(() => this.preparing.delete(track));
    this.preparing.set(track, task);
    return task;
  }

  async prefetch() {
    if (this.prefetching || this.destroyed || !this.current) return;
    this.prefetching = true;
    try {
      for (const track of this.tracks.slice(0, 2)) {
        if (this.destroyed) break;
        await this.prepare(track);
      }
    } finally {
      this.prefetching = false;
    }
  }

  importRemaining(loader, first, requester, report) {
    // Keep a short track's empty queue alive until its import finishes. The separate
    // empty-voice-channel timer (aloneTimer) is unaffected, so leaving still ends the session.
    if (!this.current) this.clearIdle();
    const task = Promise.resolve().then(async () => {
      try {
        const result = await loader();
        if (this.destroyed) return;
        const tracks = withoutBootstrap(result.tracks, first);
        for (const t of tracks) t.requester = requester;
        const added = this.add(tracks);
        await this.start();
        await report({ added, omitted: tracks.length - added, playlist: result.playlist });
      } catch (err) {
        if (!this.destroyed) await report({ error: err.message });
      } finally {
        this.imports.delete(task);
        if (!this.destroyed && !this.current && !this.imports.size) this.scheduleIdleLeave();
      }
    });
    this.imports.add(task);
    task.catch((err) => console.error('[playlist import]', err.message));
    return task;
  }

  next() {
    if (this.transition) return this.transition;
    const task = this.advance().finally(() => {
      if (this.transition === task) this.transition = null;
    });
    this.transition = task;
    return task;
  }

  matchesPlaybackEvent(event) {
    if (this.destroyed || !this.current) return false;
    const track = event?.track;
    const id = track?.userData?.serverBotPlaybackId;
    if (id !== undefined) return id === this.playback?.id;
    // Compatibility for sources which omit userData: compare stable source identity
    // before encoded data, which can change when a server serializes a track.
    const info = this.current.playbackInfo || this.current.info;
    if (track?.info?.identifier && info.identifier) {
      return (
        track.info.identifier === info.identifier &&
        (!track.info.sourceName || !info.sourceName || track.info.sourceName === info.sourceName)
      );
    }
    return !track?.encoded || track.encoded === this.current.encoded;
  }

  advanceAfterEvent(event) {
    const ended = this.current;
    if (!this.matchesPlaybackEvent(event)) return;
    const playback = this.playback;
    const ending = playback?.id || ended;
    // A very short/failed track can end before the play REST request settles.
    // Preserve that event and coalesce duplicates for this exact queue entry.
    if (this.ending === ending) return;
    this.ending = ending;
    this.monitor.emit('queue-advance', { queued: this.tracks.length });
    Promise.resolve(this.transition)
      .then(() => {
        if (!this.destroyed && this.current === ended && this.playback === playback) return this.next();
      })
      .catch((err) => console.error('[music advance]', err.message))
      .finally(() => {
        if (this.ending === ending) this.ending = null;
      });
  }

  async advance() {
    if (this.destroyed) return;
    if (this.current && this.playedCurrent) {
      this.history.push(this.current);
      if (this.history.length > MAX_QUEUE) this.history.shift();
    }
    this.playedCurrent = false;
    for (;;) {
      this.current = this.tracks.shift() || null;
      this.changes++;
      if (!this.current) {
        this.endPanel('finished');
        if (!this.imports.size) this.scheduleIdleLeave();
        return;
      }
      const track = this.current;
      if (track.encoded) {
        this.clearIdle();
        this.playback = { id: randomBytes(12).toString('hex'), entry: track };
        // A song resumed after a restart continues from where it was.
        const resumeAt = track.resumeAt || 0;
        delete track.resumeAt;
        this.playback.startAt = resumeAt;
        try {
          await this.player.playTrack({
            track: { encoded: track.encoded, userData: { serverBotPlaybackId: this.playback.id } },
            position: resumeAt,
            endTime: null,
            paused: false,
          });
          if (this.destroyed) return;
          this.playedCurrent = true;
          this.prefetch();
          return;
        } catch (err) {
          this.monitor.emit('play-request-failed');
          console.warn('[music] play request failed:', truncate(err.message, 300));
          this.send(
            embed('bad').setDescription(
              `Couldn't start **${truncate(track.info.title, 80)}**. Skipping to the next song.`,
            ),
          );
          continue;
        }
      }
      // A Spotify song: find it on YouTube now that it's its turn.
      const found = await this.prepare(track);
      if (this.destroyed) return;
      if (found) {
        // Keep this entry at the head so the common play/error path handles it.
        this.tracks.unshift(track);
        continue;
      }
      this.send(
        embed('grey').setDescription(
          `Couldn't find **${truncate(this.current.info.title, 80)}** on YouTube, skipping it.`,
        ),
      );
    }
  }

  async skip() {
    const target = this.current;
    if (this.transition) await this.transition;
    if (this.destroyed || !target || this.current !== target) return;
    const playback = this.playback;
    await this.player.stopTrack();
    // REST success confirms the stop. Advance even if its websocket event is
    // delayed/missing, while coalescing an event that already triggered advance.
    if (!this.destroyed && this.current === target && this.playback === playback)
      this.advanceAfterEvent({ track: { userData: { serverBotPlaybackId: playback?.id } } });
  }

  previous() {
    if (this.previousTransition) return this.previousTransition;
    const target = this.current;
    const task = (async () => {
      if (this.transition) await this.transition;
      if (this.destroyed || !target || target !== this.current || !this.history.length) return false;
      const back = this.history.pop();
      this.tracks.unshift(target);
      this.tracks.unshift({ ...back, replay: true });
      this.playedCurrent = false;
      this.changes++;
      await this.next();
      return true;
    })().finally(() => {
      if (this.previousTransition === task) this.previousTransition = null;
    });
    this.previousTransition = task;
    return task;
  }

  scheduleIdleLeave() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.send(embed('grey').setDescription('Nothing playing for a while, leaving the channel.'));
      this.destroy();
    }, IDLE_LEAVE_MS);
  }

  clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  // Everyone left the voice channel. Starts the countdown once: later voice events anywhere in the
  // server (mutes, other channels) must not restart it, and a new song starting must not cancel it.
  startAloneTimer() {
    if (this.aloneTimer || this.destroyed) return;
    this.aloneTimer = setTimeout(() => {
      this.aloneTimer = null;
      if (this.destroyed || this.listeners().size) return;
      this.send(embed('grey').setDescription('Everyone left, so I did too.'));
      this.destroy();
    }, IDLE_LEAVE_MS);
    this.aloneTimer.unref?.();
  }

  clearAloneTimer() {
    if (this.aloneTimer) clearTimeout(this.aloneTimer);
    this.aloneTimer = null;
  }

  // keep = true leaves the saved session in place so it can resume (see suspend()).
  async destroy({ keep = false, reason } = {}) {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.monitorTimer);
    clearInterval(this.persistTimer);
    this.monitor.stop('session-destroyed');
    this.revision++;
    this.tracks.length = 0;
    this.history.length = 0;
    this.clearIdle();
    this.clearAloneTimer();
    this.manager.queues.delete(this.guildId);
    if (!keep) {
      try {
        this.manager.store?.remove(this.guildId);
      } catch (err) {
        console.error('[music] could not clear the saved queue:', err.message);
      }
    }
    await this.endPanel(keep ? (reason === 'music-server' ? 'reconnecting' : 'restarting') : 'stopped');
    await this.manager.shoukaku.leaveVoiceChannel(this.guildId).catch(() => {});
  }
}

class MusicManager {
  constructor(client, { store } = {}) {
    this.client = client;
    // Saved sessions (src/lib/music-store.js). Passed in so tests and tools can run without a database.
    this.store = store || null;
    this.restoring = null;
    this.queues = new Map();
    this.creating = new Map(); // guildId -> promise, so two quick /plays don't join twice
    this.playRequests = new Map();
    this.searchPrefix = process.env.SEARCH_PREFIX || 'ytsearch';
    this.nodeOptions = {
      name: 'main',
      url: `${process.env.LAVALINK_HOST || 'localhost'}:${process.env.LAVALINK_PORT || 2333}`,
      auth: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
      secure: false,
    };
    this.shoukaku = new Shoukaku(new Connectors.DiscordJS(client), [this.nodeOptions], {
      moveOnDisconnect: false,
      resume: false,
      reconnectTries: 10,
      reconnectInterval: 5,
    });
    this.shoukaku.on('ready', (name) => {
      console.log(`[lavalink] node ${name} ready`);
      if (this.client.isReady?.())
        this.restoreAll().catch((err) => console.error('[music] resume failed:', err.message));
    });
    this.shoukaku.on('error', (name, err) => console.error(`[lavalink] node ${name} error:`, err?.message || err));
    this.shoukaku.on('close', (name, code) => console.warn(`[lavalink] node ${name} closed (${code})`));

    // Watchdog. Shoukaku gives up on Lavalink for good if its first connection attempt fails, even when a later
    // attempt succeeds (happens after a VPS reboot: the bot usually starts before Lavalink is up). When that happens
    // the node disappears, so every 15s: if it's gone, drop the dead music sessions and add it again.
    this.watchdog = setInterval(() => this.ensureNode(), 15_000);
    this.watchdog.unref?.();
  }

  ensureNode() {
    if (!this.client.isReady?.() || this.shoukaku.nodes.has(this.nodeOptions.name)) return false;
    if (this.queues.size)
      console.warn(`[lavalink] lost the music server, pausing ${this.queues.size} music session(s)`);
    for (const q of [...this.queues.values()]) q.suspend('music-server');
    console.warn('[lavalink] not connected: trying again');
    this.shoukaku.addNode(this.nodeOptions);
    return true;
  }

  get(guildId) {
    return this.queues.get(guildId);
  }

  async withPlayLock(guildId, work) {
    const previous = this.playRequests.get(guildId) || Promise.resolve();
    const task = previous.catch(() => {}).then(work);
    this.playRequests.set(guildId, task);
    try {
      return await task;
    } finally {
      if (this.playRequests.get(guildId) === task) this.playRequests.delete(guildId);
    }
  }

  async resolve(query) {
    const node = this.shoukaku.getIdealNode();
    if (!node) throw new Error('Music server (Lavalink) is not connected.');
    if (spotify.isSpotifyUrl(query)) {
      // Spotify: read the song list from Spotify's public embed page; each song is found on YouTube when it plays.
      const sp = await spotify.load(query);
      const tracks = sp.tracks.map((t) => ({
        encoded: null,
        search: `${t.title} ${t.artist}`.trim(),
        album: sp.type === 'album' ? sp.name : undefined, // playlists/single songs: looked up only if needed
        info: {
          title: t.title,
          author: t.artist,
          length: t.length,
          uri: spotify.openUrl(t.uri),
          isStream: false,
          artworkUrl: null,
        },
      }));
      return sp.type === 'track' ? { tracks } : { tracks, playlist: sp.name };
    }
    const isUrl = /^https?:\/\//i.test(query);
    if (isUrl && !isSupportedLink(query)) {
      throw new Error('only YouTube, Spotify, SoundCloud, Twitch, Vimeo and Bandcamp links are supported');
    }
    const res = await node.rest.resolve(isUrl ? query : `${this.searchPrefix}:${query}`);
    if (!res) return { tracks: [] };
    switch (res.loadType) {
      case 'track':
        return { tracks: [res.data] };
      case 'search':
        return { tracks: res.data.slice(0, 1) };
      case 'playlist':
        return { tracks: res.data.tracks, playlist: res.data.info.name };
      case 'error':
        throw new Error(res.data?.message || 'Lavalink could not load that.');
      default:
        return { tracks: [] };
    }
  }

  async resolveForPlayback(query) {
    if (spotify.isSpotifyUrl(query)) {
      const sp = await spotify.loadForPlayback(query);
      const tracks = sp.tracks.map((t) => ({
        encoded: null,
        search: `${t.title} ${t.artist}`.trim(),
        album: sp.type === 'album' && !sp.remaining ? sp.name : undefined,
        info: {
          title: t.title,
          author: t.artist,
          length: t.length,
          uri: spotify.openUrl(t.uri),
          isStream: false,
          artworkUrl: null,
        },
      }));
      return {
        tracks,
        ...(sp.type === 'track' ? {} : { playlist: sp.name }),
        ...(sp.remaining
          ? {
              remaining: async () => {
                const rest = await sp.remaining();
                return {
                  playlist: rest.name,
                  tracks: rest.tracks.map((t) => ({
                    encoded: null,
                    search: `${t.title} ${t.artist}`.trim(),
                    album: rest.type === 'album' ? rest.name : undefined,
                    info: {
                      title: t.title,
                      author: t.artist,
                      length: t.length,
                      uri: spotify.openUrl(t.uri),
                      isStream: false,
                      artworkUrl: null,
                    },
                  })),
                };
              },
            }
          : {}),
      };
    }
    const playlist = youtubePlaylist(query);
    if (playlist) {
      try {
        const video = await bootstrapVideo(playlist);
        if (video) {
          const first = await this.resolve(`https://www.youtube.com/watch?v=${video}`);
          if (first.tracks.length)
            return { ...first, playlist: 'YouTube playlist', remaining: () => this.resolve(query) };
        }
      } catch (err) {
        console.warn('[playlist bootstrap] falling back:', err.message);
      }
    }
    return this.resolve(query);
  }

  // Find a Spotify song on YouTube: YouTube Music first (official audio), then normal YouTube.
  // Prefers a result whose length is within 15 seconds of the Spotify song, so covers/live/extended versions lose.
  // Spotify song -> the best YouTube match. Scores every result on artist, title, album and length instead of
  // trusting the first result. 1) "title artist" on YouTube Music, then YouTube. 2) Still unsure (e.g. a game
  // soundtrack that only exists as fan uploads)? Look up the album name and search "title album" too.
  async findOnYouTube(t) {
    const node = this.shoukaku.getIdealNode();
    if (!node) return null;
    let best = null;
    const tryQuery = async (prefix, q) => {
      const res = await node.rest.resolve(`${prefix}:${q}`).catch(() => null);
      for (const r of res?.loadType === 'search' ? res.data.slice(0, 8) : []) {
        const score = matchScore({ ...t.info, album: t.album }, r.info) + (prefix === 'ytmsearch' ? 3 : 0);
        if (!best || score > best.score) best = { track: r, score };
      }
      return best && best.score >= GOOD_MATCH;
    };
    if (this.searchPrefix === 'scsearch') {
      await tryQuery('scsearch', t.search);
      return best?.track || null;
    }
    if ((await tryQuery('ytmsearch', t.search)) || (await tryQuery('ytsearch', t.search))) return best.track;
    if (t.album === undefined) t.album = t.info.uri ? await spotify.albumOf(t.info.uri) : null;
    const album = albumQuery(t.album);
    if (album) {
      // re-score what we already have now that the album is known, then search with it
      if (best) best.score = matchScore({ ...t.info, album: t.album }, best.track.info);
      await tryQuery('ytsearch', `${t.info.title} ${album}`);
    }
    return best?.track || null;
  }

  // The panel lives in the voice channel's built-in text chat, so the controls sit with the people listening.
  // Falls back to the channel /play was used in if I can't post in the voice chat.
  panelChannel(guild, voiceChannelId, fallback) {
    const vc = guild.channels.cache.get(voiceChannelId);
    const perms = vc?.permissionsFor(guild.members.me);
    const ok = vc?.isTextBased?.() && perms?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]);
    return ok ? vc : fallback;
  }

  async create(guild, voiceChannelId, textChannel) {
    const existing = this.queues.get(guild.id);
    if (existing) return existing;
    if (this.creating.has(guild.id)) return this.creating.get(guild.id);
    const p = (async () => {
      const player = await this.shoukaku.joinVoiceChannel({
        guildId: guild.id,
        channelId: voiceChannelId,
        shardId: guild.shardId,
        deaf: true,
      });
      const q = new GuildQueue(
        this,
        guild.id,
        player,
        this.panelChannel(guild, voiceChannelId, textChannel),
        voiceChannelId,
      );
      q.fallbackChannel = textChannel;
      this.queues.set(guild.id, q);
      await player.setGlobalVolume(q.volume).catch(() => {});
      return q;
    })().finally(() => this.creating.delete(guild.id));
    this.creating.set(guild.id, p);
    return p;
  }

  // Pick saved sessions back up: after a restart, an update, or the music server coming back.
  // Skips servers already playing, sessions older than 30 minutes, and voice channels nobody is in.
  restoreAll() {
    if (!this.store) return Promise.resolve(0);
    if (this.restoring) return this.restoring;
    this.restoring = (async () => {
      let resumed = 0;
      for (const saved of this.store.all()) {
        try {
          if (await this.restoreOne(saved)) resumed++;
        } catch (err) {
          console.error(`[music] could not resume in ${saved.guildId}:`, err.message);
          this.store.remove(saved.guildId);
        }
      }
      if (resumed) console.log(`[music] resumed ${resumed} music session(s)`);
      return resumed;
    })().finally(() => {
      this.restoring = null;
    });
    return this.restoring;
  }

  async restoreOne({ guildId, data, position, updatedAt }) {
    if (this.queues.has(guildId) || this.creating.has(guildId)) return false;
    if (!this.shoukaku.getIdealNode()) return false; // try again when the music server is ready
    const guild = this.client.guilds.cache.get(guildId);
    const forget = () => {
      this.store.remove(guildId);
      return false;
    };
    if (!guild || data?.v !== 1 || Date.now() - updatedAt > RESUME_MAX_AGE_MS) return forget();
    const vc = guild.channels.cache.get(data.voiceChannelId);
    if (!vc || !vc.members?.some((m) => !m.user.bot)) return forget();
    const tracks = [data.current, ...(data.tracks || [])].filter((t) => t?.info?.title);
    if (!tracks.length) return forget();
    if (data.current && tracks[0] === data.current && position > 0) tracks[0].resumeAt = position;
    const fallback =
      guild.channels.cache.get(data.fallbackChannelId) || guild.channels.cache.get(data.textChannelId) || null;
    const q = await this.create(guild, vc.id, fallback);
    q.restoring = true;
    try {
      if (Number.isFinite(data.volume) && data.volume !== q.volume) await q.setVolume(data.volume);
      q.tracks.push(...tracks.slice(0, MAX_QUEUE));
      q.changes++;
      q.send(
        embed('grey').setDescription(
          `▶️ Back after a restart. Carrying on with **${truncate(tracks[0].info.title, 80)}**.`,
        ),
      );
    } finally {
      q.restoring = false;
    }
    await q.start();
    return true;
  }

  // Called from voiceStateUpdate: leave if the bot is alone, and re-count votes when people leave.
  checkAlone(guild) {
    const q = this.queues.get(guild.id);
    if (!q) return;
    if (q.listeners().size === 0) {
      q.startAloneTimer();
    } else {
      q.clearAloneTimer();
      q.recheckVotes();
    }
  }
}

module.exports = { MusicManager, GuildQueue, isStaff, matchScore, albumQuery, isSupportedLink };
