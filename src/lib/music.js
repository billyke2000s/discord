// Per-guild music queue on top of Shoukaku (Lavalink client), plus the self-updating music panel.
const { Shoukaku, Connectors } = require('shoukaku');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits: P } = require('discord.js');
const { embed, fmtDuration, truncate, isBotAdmin } = require('./util');
const spotify = require('./spotify');

const IDLE_LEAVE_MS = 2 * 60 * 1000; // leave after 2 min with empty queue or empty channel
const MAX_QUEUE = 500;
const PANEL_REFRESH_MS = 5_000;      // how often the panel's time + progress bar update (1 edit / 5 s)
const VOL_STEP = 10, VOL_MIN = 10, VOL_MAX = 100;
const BRAND_COLOR = 0x5865f2;

// Staff can skip or stop without a vote. Staff = Moderate Members permission (Staff/Admin roles), the owner, or a bot admin.
function isStaff(member) {
  return member.id === member.guild.ownerId || isBotAdmin(member.id) || member.permissions.has(P.ModerateMembers);
}

// Embed builders throw on bad URLs; a bad artwork link from a source must never crash the bot.
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\/\S+$/i.test(u) ? u : null);

function progressBar(pos, len, size = 18) {
  const filled = Math.min(size, Math.max(0, Math.round((pos / len) * size)));
  return '━'.repeat(filled) + '●' + '─'.repeat(size - filled);
}

class GuildQueue {
  constructor(manager, guildId, player, textChannel, voiceChannelId) {
    this.manager = manager;
    this.guildId = guildId;
    this.player = player;
    this.textChannel = textChannel;       // where the panel goes: the voice channel's own chat if I can post there
    this.fallbackChannel = null;          // the channel /play was used in, if the voice chat fails
    this.voiceChannelId = voiceChannelId;
    this.tracks = [];
    this.current = null;
    this.idleTimer = null;
    this.destroyed = false;
    this.volume = Number(process.env.DEFAULT_VOLUME || 60);
    this.votes = { skip: new Set(), stop: new Set() };
    this.panelMsg = null;
    this.panelTimer = null;
    // Our own song clock. Lavalink only reports the position every 5 s, so between reports we
    // count forward from the last one (and stop counting while paused).
    this.clock = { base: 0, at: Date.now() };

    player.on('update', (d) => {
      if (typeof d?.state?.position === 'number') this.clock = { base: d.state.position, at: Date.now() };
    });
    player.on('start', () => {
      this.clock = { base: 0, at: Date.now() };
      this.votes.skip.clear();
      this.votes.stop.clear();
      this.postPanel();
    });
    player.on('end', (e) => {
      // 'replaced' = we called playTrack over it; 'cleanup' = player destroyed. Don't advance on those.
      if (e.reason === 'replaced' || e.reason === 'cleanup') return;
      this.next();
    });
    player.on('stuck', () => this.next());
    player.on('exception', (e) => {
      this.send(embed('bad').setDescription(`Couldn't play **${truncate(this.current?.info.title || 'that track', 80)}**: ${truncate(e.exception?.message || 'unknown error', 200)}. Moving on.`));
    });
    player.on('closed', () => this.destroy());
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
  // kind: 'skip' | 'stop'. Returns { passed, count, needed, already }.
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
    if (stop.count || skip.count) this.refreshPanel(); // vote counts on the buttons changed
  }

  // ---------- panel ----------
  panelPayload(state = 'playing') {
    const me = this.guild?.members.me;
    const brand = { name: `${me?.displayName || 'Music'} · Music`, iconURL: safeUrl(me?.displayAvatarURL()) || undefined };
    const t = this.current;

    if (state !== 'playing' || !t) {
      const text = state === 'stopped' ? '⏹ Music stopped.' : '✅ Queue finished. Use `/play` to add more.';
      return { embeds: [embed(BRAND_COLOR).setAuthor(brand).setDescription(text)], components: [] };
    }

    const len = t.info.length, pos = Math.max(0, Math.min(this.position(), len || 0));
    const time = t.info.isStream ? '🔴 LIVE' : `\`${fmtDuration(pos)}\` ${progressBar(pos, len)} \`${fmtDuration(len)}\``;
    const next = this.tracks.slice(0, 3).map((x, i) => `\`${i + 1}.\` ${truncate(x.info.title, 55)}`).join('\n') || '*Nothing — add songs with `/play`*';
    const skip = this.voteStatus('skip'), stop = this.voteStatus('stop');
    const paused = this.player.paused;

    const e = embed(BRAND_COLOR)
      .setAuthor(brand)
      .setTitle(truncate(t.info.title, 250))
      .setURL(safeUrl(t.info.uri))
      .setThumbnail(safeUrl(t.info.artworkUrl))
      .setDescription(`${t.info.author || ''}\n\n${paused ? '⏸ **Paused**\n' : ''}${time}`)
      .addFields(
        { name: 'Requested by', value: `<@${t.requester}>`, inline: true },
        { name: 'Volume', value: `${this.volume}%`, inline: true },
        { name: 'In queue', value: String(this.tracks.length), inline: true },
        { name: 'Up next', value: next },
      )
      .setFooter({ text: `Skip and stop are majority votes (${skip.needed} of ${this.listeners().size} listening). Staff can skip or stop instantly.` });

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music:toggle').setEmoji(paused ? '▶️' : '⏸️').setLabel(paused ? 'Resume' : 'Pause').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music:skip').setEmoji('⏭️').setLabel(skip.count ? `Skip ${skip.count}/${skip.needed}` : 'Vote skip').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('music:stop').setEmoji('⏹️').setLabel(stop.count ? `Stop ${stop.count}/${stop.needed}` : 'Vote stop').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('music:shuffle').setEmoji('🔀').setLabel('Shuffle').setStyle(ButtonStyle.Secondary).setDisabled(this.tracks.length < 2),
      new ButtonBuilder().setCustomId('music:queue').setEmoji('📜').setLabel('Queue').setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music:voldown').setEmoji('🔉').setLabel(`-${VOL_STEP}%`).setStyle(ButtonStyle.Secondary).setDisabled(this.volume <= VOL_MIN),
      new ButtonBuilder().setCustomId('music:volup').setEmoji('🔊').setLabel(`+${VOL_STEP}%`).setStyle(ButtonStyle.Secondary).setDisabled(this.volume >= VOL_MAX),
    );
    return { embeds: [e], components: [row1, row2] };
  }

  // New song: delete the old panel and post a fresh one at the bottom of the chat.
  async postPanel() {
    if (this.destroyed || !this.textChannel) return;
    const old = this.panelMsg;
    let payload;
    try { payload = this.panelPayload(); } catch (e) { return console.error('[music panel]', e.message); }
    this.panelMsg = await this.textChannel.send(payload).catch(() => null);
    if (!this.panelMsg && this.fallbackChannel && this.fallbackChannel !== this.textChannel) {
      this.textChannel = this.fallbackChannel; // voice chat didn't work: use the /play channel from now on
      this.panelMsg = await this.textChannel.send(payload).catch(() => null);
    }
    if (old) old.delete().catch(() => {});
    clearInterval(this.panelTimer);
    this.panelTimer = setInterval(() => this.refreshPanel(), PANEL_REFRESH_MS);
  }

  refreshPanel(state) {
    if (!this.panelMsg) return;
    let payload;
    try { payload = this.panelPayload(state); } catch (e) { return console.error('[music panel]', e.message); }
    return this.panelMsg.edit(payload).catch(() => {});
  }

  endPanel(state) {
    clearInterval(this.panelTimer);
    this.panelTimer = null;
    const p = this.refreshPanel(state);
    this.panelMsg = null;
    return p;
  }

  // ---------- queue control ----------
  add(tracks) {
    const room = MAX_QUEUE - this.tracks.length;
    const added = tracks.slice(0, Math.max(0, room));
    this.tracks.push(...added);
    if (this.current) this.refreshPanel(); // "Up next" changed
    return added.length;
  }

  shuffle() {
    const a = this.tracks;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
  }

  async setVolume(v) {
    this.volume = Math.min(VOL_MAX, Math.max(VOL_MIN, v));
    await this.player.setGlobalVolume(this.volume).catch(() => {});
  }

  async start() {
    if (this.current) return;
    await this.next();
  }

  async next() {
    if (this.destroyed) return;
    for (;;) {
      this.current = this.tracks.shift() || null;
      if (!this.current) {
        this.endPanel('finished');
        return this.scheduleIdleLeave();
      }
      if (this.current.encoded) break;
      // A Spotify song: find it on YouTube now that it's its turn.
      const found = await this.manager.findOnYouTube(this.current).catch(() => null);
      if (this.destroyed) return;
      if (found) {
        this.current.encoded = found.encoded;
        this.current.info.length = found.info.length || this.current.info.length;
        this.current.info.artworkUrl = found.info.artworkUrl || null;
        break;
      }
      this.send(embed('grey').setDescription(`Couldn't find **${truncate(this.current.info.title, 80)}** on YouTube, skipping it.`));
    }
    this.clearIdle();
    await this.player.playTrack({ track: { encoded: this.current.encoded } }).catch((err) => {
      this.send(embed('bad').setDescription(`Could not play that track: ${err.message}`));
    });
  }

  async skip() {
    // stopTrack fires 'end' with reason 'stopped', which calls next().
    await this.player.stopTrack();
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

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearIdle();
    await this.endPanel('stopped');
    this.manager.queues.delete(this.guildId);
    await this.manager.shoukaku.leaveVoiceChannel(this.guildId).catch(() => {});
  }
}

class MusicManager {
  constructor(client) {
    this.client = client;
    this.queues = new Map();
    this.creating = new Map(); // guildId -> promise, so two quick /plays don't join twice
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
    this.shoukaku.on('ready', (name) => console.log(`[lavalink] node ${name} ready`));
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
    if (this.queues.size) console.warn(`[lavalink] lost the music server, ending ${this.queues.size} music session(s)`);
    for (const q of [...this.queues.values()]) q.destroy();
    console.warn('[lavalink] not connected: trying again');
    this.shoukaku.addNode(this.nodeOptions);
    return true;
  }

  get(guildId) {
    return this.queues.get(guildId);
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
        info: { title: t.title, author: t.artist, length: t.length, uri: spotify.openUrl(t.uri), isStream: false, artworkUrl: null },
      }));
      return sp.type === 'track' ? { tracks } : { tracks, playlist: sp.name };
    }
    const isUrl = /^https?:\/\//i.test(query);
    const res = await node.rest.resolve(isUrl ? query : `${this.searchPrefix}:${query}`);
    if (!res) return { tracks: [] };
    switch (res.loadType) {
      case 'track': return { tracks: [res.data] };
      case 'search': return { tracks: res.data.slice(0, 1) };
      case 'playlist': return { tracks: res.data.tracks, playlist: res.data.info.name };
      case 'error': throw new Error(res.data?.message || 'Lavalink could not load that.');
      default: return { tracks: [] };
    }
  }

  // Find a Spotify song on YouTube: YouTube Music first (official audio), then normal YouTube.
  // Prefers a result whose length is within 15 seconds of the Spotify song, so covers/live/extended versions lose.
  async findOnYouTube(t) {
    const node = this.shoukaku.getIdealNode();
    if (!node) return null;
    const prefixes = this.searchPrefix === 'scsearch' ? ['scsearch'] : ['ytmsearch', 'ytsearch'];
    let fallback = null;
    for (const prefix of prefixes) {
      const res = await node.rest.resolve(`${prefix}:${t.search}`).catch(() => null);
      const results = res?.loadType === 'search' ? res.data.slice(0, 5) : [];
      const close = t.info.length ? results.find((r) => Math.abs((r.info.length || 0) - t.info.length) <= 15_000) : null;
      if (close) return close;
      fallback ||= results[0] || null;
    }
    return fallback;
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
      const q = new GuildQueue(this, guild.id, player, this.panelChannel(guild, voiceChannelId, textChannel), voiceChannelId);
      q.fallbackChannel = textChannel;
      this.queues.set(guild.id, q);
      await player.setGlobalVolume(q.volume).catch(() => {});
      return q;
    })().finally(() => this.creating.delete(guild.id));
    this.creating.set(guild.id, p);
    return p;
  }

  // Called from voiceStateUpdate: leave if the bot is alone, and re-count votes when people leave.
  checkAlone(guild) {
    const q = this.queues.get(guild.id);
    if (!q) return;
    const humans = q.listeners().size;
    if (humans === 0) {
      q.clearIdle();
      q.idleTimer = setTimeout(() => {
        if (q.listeners().size === 0) {
          q.send(embed('grey').setDescription('Everyone left, so I did too.'));
          q.destroy();
        }
      }, IDLE_LEAVE_MS);
    } else {
      if (q.current) q.clearIdle();
      q.recheckVotes();
    }
  }
}

module.exports = { MusicManager, isStaff };
