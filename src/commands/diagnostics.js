// /diagnostics: checks every part of the bot and reports what passed and what failed.
// Admins only, only the person who runs it sees the result, and it never shows tokens or passwords.
const fs = require('node:fs');
const { SlashCommandBuilder, PermissionFlagsBits: P, MessageFlags, ChannelType, AttachmentBuilder } = require('discord.js');
const { DiagnosticGate, sampleResources, speedTest, formatReport, describePlayback } = require('../lib/diagnostic-tools');
const { db, getSettings } = require('../lib/db');
const { embed, fmtDuration } = require('../lib/util');
const scamfilter = require('../lib/scamfilter');
const antiRaid = require('../lib/antiraid');
const backup = require('../lib/backup');
const { rebuildLocked } = require('../lib/commandsync');

// Everything the bot needs if Administrator is taken away after setup.
const NEEDED = {
  ViewChannel: 'View Channels', SendMessages: 'Send Messages', EmbedLinks: 'Embed Links', AttachFiles: 'Attach Files',
  ReadMessageHistory: 'Read Message History', AddReactions: 'Add Reactions', ManageMessages: 'Manage Messages',
  ManageChannels: 'Manage Channels', ManageRoles: 'Manage Roles', ManageThreads: 'Manage Threads',
  CreatePublicThreads: 'Create Public Threads', SendMessagesInThreads: 'Send Messages in Threads',
  KickMembers: 'Kick Members', BanMembers: 'Ban Members', ModerateMembers: 'Timeout Members',
  Connect: 'Connect', Speak: 'Speak', MoveMembers: 'Move Members',
};

const gate = new DiagnosticGate();
const withTimeout = async (p, ms = 8000) => {
  let timer;
  try { return await Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), ms); })]); }
  finally { clearTimeout(timer); }
};
const NEXT = {
  'Discord connection': 'If commands feel slow, compare this response time during the problem.',
  'Bot permissions': 'Give the missing permissions to the bot role in Server Settings → Roles.',
  'Role order': 'Move the bot role above the roles it needs to manage.',
  'Backups': 'Check the backups folder is writable and has space; make a manual backup before updating.',
  'Database': 'Check private bot logs. Restore a known-good backup if the database check fails.',
  'Lavalink (music server)': 'Check the music container and its logs on the VPS.',
  'Audio smoothness': 'Keep music playing for a minute and rerun; missing counters cannot confirm smooth audio.',
  'Playback observations': 'If a cutout is happening, save the attached report and music-health logs before restarting.',
  'YouTube search': 'Check the YouTube plugin and cipher helper logs; a search test does not test audio streaming.',
  'Spotify links': 'Try a public Spotify link; private or changed embed pages may be unavailable.',
  'YouTube cipher helper': 'Check the yt-cipher container on the VPS.',
  'Scam filter': 'Check outbound access to the scam lists. Existing cached protection may still be available.',
};
const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;

const diagnostics = {
  data: new SlashCommandBuilder().setName('diagnostics').setDescription('Check every part of the bot is working (admins only)')
    .setDefaultMemberPermissions(P.ManageGuild),
  async execute(interaction) {
    const lease = gate.acquire();
    if (!lease.ok) return interaction.reply({ content: lease.message, flags: MessageFlags.Ephemeral });
    try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply('Checking the bot, server and music connections. A small internet speed test is included; please give me a moment.');
    const g = interaction.guild, me = g.members.me, s = getSettings(g.id), client = interaction.client;
    const results = [];
    let group = 'Discord & permissions';
    const add = (status, name, detail = '', action = NEXT[name]) => results.push({ status, name, detail, action, group });
    const check = async (name, fn) => {
      try { await fn(); } catch { add('unknown', name, 'check could not complete', NEXT[name] || 'Check the related container logs on the VPS.'); }
    };

    // --- Discord ---
    add(client.ws.ping >= 0 && client.ws.ping < 1000 ? 'ok' : 'warn', 'Discord connection', `${client.ws.ping} ms`);
    await check('Bot permissions', () => {
      if (me.permissions.has(P.Administrator)) return add('ok', 'Bot permissions', 'has Administrator (you can take it away once setup is done)');
      const missing = Object.entries(NEEDED).filter(([k]) => !me.permissions.has(P[k])).map(([, v]) => v);
      add(missing.length ? 'fail' : 'ok', 'Bot permissions', missing.length ? `missing: ${missing.join(', ')}` : 'all present');
    });
    await check('Role order', () => {
      const top = me.roles.highest;
      const cant = g.roles.cache.filter((r) => r.id !== g.id && !r.managed && r.comparePositionTo(top) >= 0);
      const important = [s.verify.memberRole, s.tickets.staffRole].filter(Boolean).filter((id) => cant.has(id));
      if (important.length) return add('fail', 'Role order', `my role is below ${important.map((id) => `<@&${id}>`).join(', ')}: I can't give those out. Drag my role above them.`);
      add(cant.size ? 'warn' : 'ok', 'Role order', cant.size ? `I can't manage or moderate people with: ${[...cant.values()].slice(0, 8).map((r) => r.toString()).join(', ')}${cant.size > 8 ? '…' : ''}` : 'my role is above every other role');
    });

    // --- configured channels/roles still exist and are usable ---
    group = 'Server features';
    const chan = (id, label, needSend = true) => {
      if (!id) return add('off', label, 'not configured');
      const ch = g.channels.cache.get(id);
      if (!ch) return add('fail', label, 'the channel was deleted: set it up again with /setup');
      if (needSend && ch.type !== ChannelType.GuildCategory && ch.type !== ChannelType.GuildVoice && !ch.permissionsFor(me).has([P.ViewChannel, P.SendMessages, P.EmbedLinks]))
        return add('fail', label, `${ch}: I can't post there`);
      add('ok', label, `${ch}`);
    };
    const role = (id, label) => {
      if (!id) return add('off', label, 'not configured');
      add(g.roles.cache.has(id) ? 'ok' : 'fail', label, g.roles.cache.has(id) ? `<@&${id}>` : 'the role was deleted: set it up again with /setup');
    };
    chan(s.logChannel, 'Log channel');
    chan(s.welcomeChannel, 'Welcome channel');
    if (s.verify.enabled) role(s.verify.memberRole, 'Verification Member role'); else add('off', 'Verification', 'turned off');
    role(s.tickets.staffRole, 'Ticket staff role');
    if (s.tickets.categoryId) chan(s.tickets.categoryId, 'Ticket category', false);
    chan(s.jtc.lobbyChannel, 'Join-to-create lobby', false);
    if (s.selfPromo.channel) chan(s.selfPromo.channel, 'Self-promo channel', false);
    if (s.suggestions.channel) chan(s.suggestions.channel, 'Suggestions channel', false);

    // --- database + backups ---
    group = 'Storage & protection';
    await check('Database', () => {
      const r = db.pragma('quick_check', { simple: true });
      db.exec('CREATE TABLE IF NOT EXISTS _diag (x INTEGER)'); db.prepare('INSERT INTO _diag VALUES (1)').run(); db.exec('DROP TABLE _diag');
      add(r === 'ok' ? 'ok' : 'fail', 'Database', r === 'ok' ? 'healthy, read/write OK' : r);
    });
    await check('Backups', () => {
      const last = backup.latest();
      if (!last) return add('warn', 'Backups', 'no backup yet (the first one is made within an hour of starting)');
      const age = Date.now() - fs.statSync(`${backup.DIR}/${last.file}`).mtimeMs;
      add(age < 26 * 3600e3 ? 'ok' : 'fail', 'Backups', `latest ${last.file} (${Math.round(age / 3600e3)}h ago)`);
    });
    add('ok', 'Server rebuild', rebuildLocked(g.id) ? 'locked (can’t be run again)' : 'not used yet (owner can run /setup rebuild once)');

    // --- music ---
    group = 'Music & voice';
    const node = client.music.shoukaku.getIdealNode();
    if (!node) add('fail', 'Lavalink (music server)', 'not connected: check `docker compose logs lavalink`');
    else {
      await check('Lavalink (music server)', async () => {
        const info = await withTimeout(node.rest.getLavalinkInfo());
        const plugins = (info?.plugins || []).map((p) => `${p.name} ${p.version}`);
        add('ok', 'Lavalink (music server)', `v${info?.version?.semver || '?'} · ${node.stats?.players ?? 0} player(s)`);
        const st = node.stats;
        if (st?.cpu) {
          const pct = (x) => `${Math.round((x || 0) * 100)}%`;
          add(st.cpu.lavalinkLoad >= .85 ? 'warn' : 'ok', 'Music CPU', `${pct(st.cpu.lavalinkLoad)} (latest Lavalink sample)`, 'Compare CPU and playback observations during a cutout.');
          if (st.memory?.used && st.memory?.allocated) add('ok', 'Music Java memory', `${mb(st.memory.used)} used / ${mb(st.memory.allocated)} allocated heap; not container RAM`);
          else add('unknown', 'Music Java memory', 'heap measurements unavailable');
        }
        // Lavalink sends 50 audio frames a second = 3000 a minute per player. Missing/late frames = stutter.
        if (st?.frameStats) {
          const lost = (st.frameStats.nulled || 0) + Math.max(0, st.frameStats.deficit || 0);
          const lostPct = (lost / (3000 * Math.max(1, st.playingPlayers || 1))) * 100;
          add(lostPct < 1 ? 'ok' : lostPct < 5 ? 'warn' : 'fail', 'Audio smoothness (last minute)',
            `${lostPct.toFixed(1)}% of audio frames missing or late${lostPct < 1 ? ' (low loss)' : ' (check CPU, GC pauses, network and source failures; cause is not determined)'}`);
        } else {
          add('unknown', 'Audio smoothness', 'no frame counters received; audible quality cannot be assessed');
        }
        const has = (n) => plugins.some((p) => p.toLowerCase().includes(n));
        add(has('youtube') ? 'ok' : 'fail', 'YouTube plugin', has('youtube') ? plugins.find((p) => p.toLowerCase().includes('youtube')) : 'not loaded');
      });
      await check('YouTube search', async () => {
        const res = await withTimeout(node.rest.resolve('ytsearch:lofi hip hop'), 15000);
        const n = res?.loadType === 'search' ? res.data.length : 0;
        add(n ? 'ok' : 'fail', 'YouTube search', n ? `song lookup works (${n} results)` : `no results (${res?.loadType || 'no reply'})`);
      });
    }
    await check('YouTube cipher helper', async () => {
      // Any HTTP answer means the yt-cipher container is up (it may say 401/404 without the password; that's fine).
      const response = await withTimeout(fetch('http://yt-cipher:8001/', { signal: AbortSignal.timeout(5000) }), 6000);
      await response.body?.cancel();
      add(response.status >= 500 ? 'warn' : 'ok', 'YouTube cipher helper', `reachable (HTTP ${response.status}); stream decoding not tested`);
    });
    await check('Spotify links', async () => {
      // A long-standing public song. Checks Spotify's embed page can still be read (no account/helper involved).
      const sp = await withTimeout(require('../lib/spotify').load('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), 15000);
      add(sp.tracks.length ? 'ok' : 'fail', 'Spotify links', sp.tracks.length ? `reading Spotify works (test song: ${sp.tracks[0].title})` : 'no songs read');
    });
    const q = client.music.get(g.id);
    if (q?.monitor) {
      q.monitor.check(node?.stats);
      const playback = describePlayback(q.monitor);
      add(playback.status, 'Playback observations', playback.detail);
    }
    add('ok', 'Music right now', q?.current ? `playing in <#${q.voiceChannelId}> · ${q.tracks.length} queued` : 'idle');

    // --- protection ---
    group = 'Storage & protection';
    const st = scamfilter.stats();
    if (!s.scamFilter.enabled) add('off', 'Scam filter', 'turned off');
    else if (!st.size) add('fail', 'Scam filter', 'no scam list loaded (the @everyone and cross-channel checks still work)');
    else add(Date.now() - st.lastLoaded < 13 * 3600e3 ? 'ok' : 'warn', 'Scam filter', `${st.size} domains, updated ${st.lastLoaded ? `<t:${Math.floor(st.lastLoaded / 1000)}:R>` : 'from cache'}`);
    add('ok', 'Lockdown', antiRaid.isLocked(g.id) ? '🔒 ON' : 'off');

    // --- VPS ---
    group = 'Server resources';
    await check('Disk space', () => {
      const f = fs.statfsSync(process.env.DATA_DIR || '/');
      const freeGb = (f.bavail * f.bsize) / 1e9;
      const totalGb = (f.blocks * f.bsize) / 1e9;
      add(freeGb > 2 ? 'ok' : freeGb > 0.5 ? 'warn' : 'fail', 'Data disk', `${freeGb.toFixed(1)} / ${totalGb.toFixed(1)} GB free`, 'Free space on the data disk; keep backups before deleting anything.');
    });
    await check('Server resource sample', async () => {
      const r = await sampleResources();
      const threshold = (value) => value >= 95 ? 'fail' : value >= 85 ? 'warn' : 'ok';
      if (r.cpu) {
        add(threshold(r.cpu.busy), 'VPS CPU', `${r.cpu.busy.toFixed(1)}% busy across ${r.hostCores} visible cores (1-second sample)`, 'Check whether other VPS workloads spike at the same time as cutouts.');
        add(r.cpu.steal >= 10 || r.cpu.ioWait >= 10 ? 'warn' : 'ok', 'CPU waiting', `${r.cpu.ioWait.toFixed(1)}% disk wait · ${r.cpu.steal.toFixed(1)}% hypervisor wait`, 'Compare these waits during the problem; they do not identify its cause by themselves.');
      } else add('unknown', 'VPS CPU', 'host counters unavailable');
      add(r.load > r.hostCores ? 'warn' : 'ok', 'Load average', `${r.load.toFixed(2)} tasks over 1 minute / ${r.hostCores} visible cores`, 'Check competing tasks if the average remains above the available core count.');
      if (r.memory) {
        const used = 100 * (1 - r.memory.available / r.memory.total);
        add(threshold(used), 'VPS memory', `${gb(r.memory.available)} available / ${gb(r.memory.total)} total`, 'Check other services and the host memory usage during a cutout.');
        add('ok', 'Swap', r.memory.swapTotal ? `${mb(r.memory.swapUsed || 0)} used / ${mb(r.memory.swapTotal)} total` : 'not configured');
      } else add('unknown', 'VPS memory & swap', 'host counters unavailable');
      add(r.botCpu >= 85 ? 'warn' : 'ok', 'Bot CPU & memory', `${r.botCpu.toFixed(1)}% of one core · ${mb(r.botRss)} process RAM${r.cpuLimit ? ` · CPU quota ${r.cpuLimit.toFixed(2)} cores` : ''}`, 'Compare bot CPU and timer delay during slow commands.');
      if (r.containerLimit && r.containerMemory !== null) add(threshold(r.containerMemory / r.containerLimit * 100), 'Bot container RAM', `${mb(r.containerMemory)} / ${mb(r.containerLimit)} limit`, 'Review the container limit if usage regularly approaches it.');
      else add('unknown', 'Bot container RAM', 'limit unavailable or unlimited; process RAM shown above');
      add(r.loopMaxMs === null ? 'unknown' : r.loopMaxMs >= 200 ? 'warn' : 'ok', 'Bot responsiveness', r.loopMaxMs === null ? 'no event-loop sample' : `longest timer delay ${r.loopMaxMs.toFixed(0)} ms (short sample)`, 'Save this report during slow commands; CPU-intensive bot work may delay responses.');
    });
    add('off', 'Other containers', 'cipher CPU/RAM and music container RAM are not exposed; Java heap is shown separately');
    const uptime = process.uptime();
    add('ok', 'Bot uptime', `${Math.floor(uptime / 86400)} days ${fmtDuration((uptime % 86400) * 1000)}`);

    group = 'Internet speed';
    await check('Speed test', async () => {
      const speed = await speedTest();
      const rate = (value) => value === null ? 'unavailable' : `${value.toFixed(1)} Mbps sampled`;
      add(speed.downloadMbps === null ? 'unknown' : speed.downloadMbps < 2 ? 'warn' : 'ok', 'Download', rate(speed.downloadMbps), 'Small HTTPS sample to Cloudflare; compare repeated reports, not your advertised line speed.');
      add(speed.uploadMbps === null ? 'unknown' : speed.uploadMbps < 2 ? 'warn' : 'ok', 'Upload', rate(speed.uploadMbps), 'Small generated-data sample to Cloudflare; this is not a Discord voice-path test.');
      add(speed.latencyMs === null ? 'unknown' : speed.latencyMs >= 500 ? 'warn' : 'ok', 'HTTP response time', speed.latencyMs === null ? 'unavailable' : `${speed.latencyMs.toFixed(0)} ms average · ${speed.variationMs.toFixed(0)} ms variation (3 requests)`, 'This includes HTTPS/server overhead. It does not measure UDP packet loss.');
      add(speed.errors.length ? 'unknown' : 'off', 'Test scope', `${speed.errors.join('; ') || '2 MiB download + 256 KiB upload; 12-second limit'}. No packet-loss measurement.`, speed.errors.length ? 'Endpoint failure does not establish a server fault; try again after the cooldown.' : undefined);
    });

    // --- report ---
    const report = formatReport(results);
    await interaction.editReply({
      embeds: [embed(report.color).setTitle(report.title).setDescription(report.description.slice(0, 700)).addFields(report.fields)
        .setFooter({ text: '✅ checked · ⚠️ review · ❌ failed · ❔ unmeasured · ➖ off/info. Shared cooldown: 1 minute.' })],
      files: [new AttachmentBuilder(Buffer.from(`Bot diagnostic snapshot\n${new Date().toISOString()}\n\n${report.fullText}\n\nAudible quality and packet loss are not measured.`, 'utf8'), { name: 'bot-diagnostics.txt' })],
    });
    } finally { lease.release(); }
  },
};

const diagnosis = { ...diagnostics, data: new SlashCommandBuilder().setName('diagnosis').setDescription('Check the bot, music, server load and internet speed (admins only)').setDefaultMemberPermissions(P.ManageGuild) };
module.exports = { commands: [diagnostics, diagnosis] };

