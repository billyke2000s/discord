// /diagnostics: the full admin check of every part of the bot, in plain English. Members use /status instead.
// Manage Server only, private reply, never shows tokens or passwords.
// The embed is a short summary; the attached text file has every number for whoever is debugging.
const fs = require('node:fs');
const {
  SlashCommandBuilder,
  PermissionFlagsBits: P,
  MessageFlags,
  ChannelType,
  AttachmentBuilder,
} = require('discord.js');
const {
  DiagnosticGate,
  sampleResources,
  speedTest,
  formatReport,
  describePlayback,
  fmtUptime,
  fmtAgo,
  LATENCY_SAMPLES,
} = require('../lib/diagnostic-tools');
const { db, getSettings } = require('../lib/db');
const { embed } = require('../lib/util');
const scamfilter = require('../lib/scamfilter');
const antiRaid = require('../lib/antiraid');
const backup = require('../lib/backup');
const { rebuildLocked } = require('../lib/commandsync');

// Everything the bot needs if Administrator is taken away after setup.
const NEEDED = {
  ViewChannel: 'View Channels',
  SendMessages: 'Send Messages',
  EmbedLinks: 'Embed Links',
  AttachFiles: 'Attach Files',
  ReadMessageHistory: 'Read Message History',
  AddReactions: 'Add Reactions',
  ManageMessages: 'Manage Messages',
  ManageChannels: 'Manage Channels',
  ManageRoles: 'Manage Roles',
  ManageThreads: 'Manage Threads',
  CreatePublicThreads: 'Create Public Threads',
  SendMessagesInThreads: 'Send Messages in Threads',
  KickMembers: 'Kick Members',
  BanMembers: 'Ban Members',
  ModerateMembers: 'Timeout Members',
  Connect: 'Connect',
  Speak: 'Speak',
  MoveMembers: 'Move Members',
};

// What to do when a check needs attention. Shown only for warnings, failures and missing readings.
const NEXT = {
  'Discord connection': 'Discord is slow to answer. If commands lag, run this again while it is happening.',
  'Bot permissions': 'Give my role the missing permissions in Server Settings → Roles.',
  'Role order': 'Drag my role higher in Server Settings → Roles.',
  Backups: 'Check the backups folder on the VPS has free space, then look for [backup] errors in the bot log.',
  Database: 'Look at the bot log on the VPS. If the database is damaged, restore a backup (README → Backups).',
  'Music server': 'Check the music container on the VPS: docker compose logs --tail 80 lavalink',
  'Music server CPU': 'The music server is very busy. Check what else is running on the VPS.',
  'Music server memory':
    'The music server is close to its memory limit. Restart it if music stutters: docker compose restart lavalink',
  'Audio smoothness': 'Audio is arriving late. Check VPS CPU and the music log while it is happening.',
  Playback: 'Save this report and the music-health log before restarting anything (README → Diagnostics).',
  'YouTube search':
    'Check the music and cipher logs on the VPS. The YouTube login may need renewing (README → Troubleshooting).',
  'Spotify links':
    'Spotify may have changed its page. Try another public link; if they all fail, the bot needs an update.',
  'YouTube helper': 'Check the cipher container on the VPS: docker compose logs --tail 80 yt-cipher',
  'Scam filter': 'The VPS could not download the scam lists. Mass-ping and cross-channel spam checks still work.',
  Lockdown: 'New members are being kicked. Turn it off with /lockdown off when the raid is over.',
  'Disk space': 'Free up space on the VPS. Keep a copy of the backups folder before deleting anything.',
  CPU: 'The VPS is very busy. Check what else is running on it (top).',
  'CPU waiting': 'The VPS keeps waiting for its disk or host. If this keeps happening, contact your VPS provider.',
  Load: 'More work is waiting than the VPS has cores. Check what else is running on it (top).',
  Memory: 'The VPS is low on memory. Check other services on it, or add RAM or swap.',
  'Bot container memory':
    'The bot is near its memory limit. Restart it with docker compose restart bot, and report it if it keeps happening.',
  'Bot responsiveness': 'The bot was briefly busy. Run this again during slow commands to compare.',
  Download: 'One slow or failed sample is normal. Run this again in a minute.',
  Upload: 'One slow or failed sample is normal. Run this again in a minute.',
  'Response time': 'One slow or failed sample is normal. Run this again in a minute.',
};
const FALLBACK =
  'Run this again in a minute. If it keeps failing, check the bot log on the VPS: docker compose logs --tail 80 bot';

const gate = new DiagnosticGate();
const withTimeout = async (p, ms = 8000) => {
  let timer;
  try {
    return await Promise.race([
      p,
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
const pct = (x) => `${Math.round(x)}%`;

const diagnostics = {
  data: new SlashCommandBuilder()
    .setName('diagnostics')
    .setDescription('Check every part of the bot is working (Manage Server only)')
    .setDefaultMemberPermissions(P.ManageGuild),
  async execute(interaction) {
    const lease = gate.acquire();
    if (!lease.ok) return interaction.reply({ content: lease.message, flags: MessageFlags.Ephemeral });
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply('Checking the bot, music, server and internet. This takes about 15 seconds.');
      const g = interaction.guild,
        me = g.members.me,
        s = getSettings(g.id),
        client = interaction.client;
      const results = [];
      const summaries = {};
      let group = 'Bot';
      const add = (status, name, detail = '', action = NEXT[name]) =>
        results.push({
          status,
          name,
          detail,
          group,
          action: ['warn', 'fail', 'unknown'].includes(status) ? action || FALLBACK : undefined,
        });
      const check = async (name, fn) => {
        try {
          await fn();
        } catch {
          add('unknown', name, 'the check could not finish');
        }
      };

      // --- Bot ---
      const ping = client.ws.ping;
      add(ping >= 0 && ping < 1000 ? 'ok' : 'warn', 'Discord connection', `${ping} ms`);
      await check('Bot permissions', () => {
        if (me.permissions.has(P.Administrator)) {
          if (!rebuildLocked(g.id))
            return add('off', 'Bot permissions', 'has Administrator (needed for /setup rebuild; remove it afterwards)');
          add(
            'warn',
            'Bot permissions',
            'has Administrator, which is more than it needs',
            'Setup is done: give my role the permissions listed in the attached file, then remove Administrator.',
          );
          return add('off', 'Permissions to give instead', Object.values(NEEDED).join(', '));
        }
        const missing = Object.entries(NEEDED)
          .filter(([k]) => !me.permissions.has(P[k]))
          .map(([, v]) => v);
        add(
          missing.length ? 'fail' : 'ok',
          'Bot permissions',
          missing.length ? `missing: ${missing.join(', ')}` : 'has everything it needs',
        );
      });
      await check('Role order', () => {
        const top = me.roles.highest;
        const cant = g.roles.cache.filter((r) => r.id !== g.id && !r.managed && r.comparePositionTo(top) >= 0);
        const important = [s.verify.memberRole, s.tickets.staffRole].filter(Boolean).filter((id) => cant.has(id));
        if (important.length)
          return add(
            'fail',
            'Role order',
            `my role is below ${important.map((id) => `<@&${id}>`).join(', ')}, so I can't give those out`,
          );
        add(
          cant.size ? 'warn' : 'ok',
          'Role order',
          cant.size
            ? `I can't manage people with: ${[...cant.values()]
                .slice(0, 8)
                .map((r) => r.toString())
                .join(', ')}${cant.size > 8 ? '…' : ''}`
            : 'my role is at the top',
        );
      });
      const uptime = fmtUptime(process.uptime());
      add('ok', 'Uptime', `running for ${uptime}`);

      // --- Setup: configured channels/roles still exist and are usable ---
      group = 'Setup';
      const chan = (id, label, needSend = true) => {
        if (!id) return add('off', label, 'not set up');
        const ch = g.channels.cache.get(id);
        if (!ch) return add('fail', label, 'the channel was deleted', 'Set it up again with /setup.');
        if (
          needSend &&
          ch.type !== ChannelType.GuildCategory &&
          ch.type !== ChannelType.GuildVoice &&
          !ch.permissionsFor(me).has([P.ViewChannel, P.SendMessages, P.EmbedLinks])
        )
          return add(
            'fail',
            label,
            `I can't post in ${ch}`,
            `Let my role view, send messages and embed links in ${ch}.`,
          );
        add('ok', label, `${ch}`);
      };
      const role = (id, label) => {
        if (!id) return add('off', label, 'not set up');
        if (g.roles.cache.has(id)) add('ok', label, `<@&${id}>`);
        else add('fail', label, 'the role was deleted', 'Set it up again with /setup.');
      };
      chan(s.logChannel, 'Log channel');
      chan(s.welcomeChannel, 'Welcome channel');
      if (s.verify.enabled) role(s.verify.memberRole, 'Verified member role');
      else add('off', 'Verification', 'turned off');
      role(s.tickets.staffRole, 'Ticket staff role');
      if (s.tickets.categoryId) chan(s.tickets.categoryId, 'Ticket category', false);
      chan(s.jtc.lobbyChannel, 'Join-to-create lobby', false);
      if (s.selfPromo.channel) chan(s.selfPromo.channel, 'Self-promo channel', false);
      if (s.suggestions.channel) chan(s.suggestions.channel, 'Suggestions channel', false);
      if (s.levels?.enabled && s.levels.announce === 'channel') chan(s.levels.announceChannel, 'Level-up channel');
      const setupOk = results.filter((r) => r.group === 'Setup' && r.status === 'ok').length;
      summaries.Setup = `${setupOk} channels and roles in place`;

      // --- Data & protection ---
      group = 'Data & protection';
      await check('Database', () => {
        const r = db.pragma('quick_check', { simple: true });
        db.exec('CREATE TABLE IF NOT EXISTS _diag (x INTEGER)');
        db.prepare('INSERT INTO _diag VALUES (1)').run();
        db.exec('DROP TABLE _diag');
        add(r === 'ok' ? 'ok' : 'fail', 'Database', r === 'ok' ? 'healthy, can read and write' : r);
      });
      let backupAgo = null;
      await check('Backups', () => {
        const last = backup.latestScheduled();
        if (!last) return add('warn', 'Backups', 'no daily backup yet (the first is made within an hour of starting)');
        const age = Date.now() - fs.statSync(`${backup.DIR}/${last.file}`).mtimeMs;
        backupAgo = fmtAgo(age);
        add(age < 26 * 3600e3 ? 'ok' : 'fail', 'Backups', `last daily backup ${backupAgo} (${last.file})`);
      });
      const st = scamfilter.stats();
      let scamAgo = null;
      if (!s.scamFilter.enabled) add('off', 'Scam filter', 'turned off');
      else if (!st.size) add('fail', 'Scam filter', 'no scam list loaded');
      else {
        scamAgo = st.lastLoaded ? fmtAgo(Date.now() - st.lastLoaded) : null;
        add(
          st.lastLoaded && Date.now() - st.lastLoaded < 13 * 3600e3 ? 'ok' : 'warn',
          'Scam filter',
          `${st.size} scam domains, updated ${scamAgo || 'from the saved copy'}`,
        );
      }
      const rulesOn = Object.entries(s.automod?.rules || {}).filter(([, r]) => r.enabled).length;
      add(rulesOn ? 'ok' : 'off', 'Automod', rulesOn ? `${rulesOn} rule(s) on` : 'no rules on');
      if (antiRaid.isLocked(g.id)) add('warn', 'Lockdown', 'ON: new members are kicked when they join');
      else add('ok', 'Lockdown', 'off');
      add(
        'off',
        'Server rebuild',
        rebuildLocked(g.id) ? 'used and locked' : 'not used yet (owner can run /setup rebuild once)',
      );
      summaries['Data & protection'] = [
        'database OK',
        backupAgo && `backed up ${backupAgo}`,
        scamAgo && `scam list updated ${scamAgo}`,
      ]
        .filter(Boolean)
        .join(' · ');

      // --- Music ---
      group = 'Music';
      let smooth = null;
      const q = client.music.get(g.id);
      const node = client.music.shoukaku.getIdealNode();
      if (!node) add('fail', 'Music server', 'not connected');
      else {
        await check('Music server', async () => {
          const info = await withTimeout(node.rest.getLavalinkInfo());
          const plugins = (info?.plugins || []).map((p) => `${p.name} ${p.version}`);
          add(
            'ok',
            'Music server',
            `connected · Lavalink v${info?.version?.semver || '?'} · ${node.stats?.players ?? 0} player(s)`,
          );
          const stats = node.stats;
          if (stats?.cpu)
            add(
              stats.cpu.lavalinkLoad >= 0.85 ? 'warn' : 'ok',
              'Music server CPU',
              pct((stats.cpu.lavalinkLoad || 0) * 100),
            );
          const mem = stats?.memory;
          if (mem?.used && (mem.reservable || mem.allocated)) {
            const max = mem.reservable || mem.allocated;
            add(
              mem.used / max >= 0.85 ? 'warn' : 'ok',
              'Music server memory',
              `${mb(mem.used)} of ${mb(max)} ${mem.reservable ? 'max' : 'allocated'}`,
            );
          } else add('unknown', 'Music server memory', 'not reported');
          // Lavalink sends 50 audio frames a second = 3000 a minute per playing player. Missing/late frames = stutter.
          if (stats?.frameStats) {
            const lost = (stats.frameStats.nulled || 0) + Math.max(0, stats.frameStats.deficit || 0);
            const lostPct = (lost / (3000 * Math.max(1, stats.playingPlayers || 1))) * 100;
            smooth = lostPct < 1;
            add(
              lostPct < 1 ? 'ok' : lostPct < 5 ? 'warn' : 'fail',
              'Audio smoothness',
              `${lostPct.toFixed(1)}% of audio missing or late in the last minute${lostPct < 1 ? '' : " (the cause isn't known from this alone)"}`,
            );
          } else {
            if (q?.current)
              add(
                'unknown',
                'Audio smoothness',
                'the music server sent no audio counters',
                'Keep music playing for a minute, then run this again.',
              );
            else add('off', 'Audio smoothness', 'nothing playing, so nothing to measure');
          }
          const yt = plugins.find((p) => p.toLowerCase().includes('youtube'));
          add(
            yt ? 'ok' : 'fail',
            'YouTube plugin',
            yt || 'not loaded',
            'Run the latest installer on the VPS to reinstall the YouTube plugin.',
          );
        });
        await check('YouTube search', async () => {
          const res = await withTimeout(node.rest.resolve('ytsearch:lofi hip hop'), 15000);
          const n = res?.loadType === 'search' ? res.data.length : 0;
          add(
            n ? 'ok' : 'fail',
            'YouTube search',
            n ? `works (${n} results)` : `no results (${res?.loadType || 'no reply'})`,
          );
        });
      }
      await check('YouTube helper', async () => {
        // Any HTTP answer means the yt-cipher container is up (it may say 401/404 without the password; that's fine).
        const response = await withTimeout(
          fetch('http://yt-cipher:8001/', { signal: AbortSignal.timeout(5000) }),
          6000,
        );
        await response.body?.cancel();
        add(response.status >= 500 ? 'warn' : 'ok', 'YouTube helper', `reachable (HTTP ${response.status})`);
      });
      await check('Spotify links', async () => {
        // A long-standing public song. Checks Spotify's embed page can still be read (no account/helper involved).
        const sp = await withTimeout(
          require('../lib/spotify').load('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'),
          15000,
        );
        add(
          sp.tracks.length ? 'ok' : 'fail',
          'Spotify links',
          sp.tracks.length ? 'can read Spotify links' : 'no songs read',
        );
      });
      if (q?.monitor) {
        q.monitor.check(node?.stats);
        const playback = describePlayback(q.monitor);
        add(playback.status, 'Playback', playback.detail);
      }
      if (q?.current) {
        add('ok', 'Now playing', `in <#${q.voiceChannelId}> · ${q.tracks.length} queued`);
        summaries.Music = [
          `playing in <#${q.voiceChannelId}>`,
          smooth === true && 'no stutters',
          `${q.tracks.length} queued`,
        ]
          .filter(Boolean)
          .join(' · ');
      } else {
        add('off', 'Now playing', 'nothing');
        summaries.Music = 'ready · nothing playing';
      }

      // --- Server (the VPS) ---
      group = 'Server';
      let cpuBusy = null,
        memFree = null,
        diskFree = null;
      await check('Disk space', () => {
        const f = fs.statfsSync(process.env.DATA_DIR || '/');
        const free = f.bavail * f.bsize,
          total = f.blocks * f.bsize;
        diskFree = gb(free);
        add(free > 2e9 ? 'ok' : free > 0.5e9 ? 'warn' : 'fail', 'Disk space', `${gb(free)} free of ${gb(total)}`);
      });
      await check('CPU', async () => {
        const r = await sampleResources();
        const level = (value) => (value >= 95 ? 'fail' : value >= 85 ? 'warn' : 'ok');
        if (r.cpu) {
          cpuBusy = r.cpu.busy;
          add(level(r.cpu.busy), 'CPU', `${pct(r.cpu.busy)} busy across ${r.hostCores} cores (1-second sample)`);
          add(
            r.cpu.steal >= 10 || r.cpu.ioWait >= 10 ? 'warn' : 'ok',
            'CPU waiting',
            `${pct(r.cpu.ioWait)} waiting for disk · ${pct(r.cpu.steal)} waiting for the host`,
          );
        } else add('unknown', 'CPU', 'not readable');
        add(
          r.load > r.hostCores ? 'warn' : 'ok',
          'Load',
          `${r.load.toFixed(2)} over the last minute (${r.hostCores} cores)`,
        );
        if (r.memory) {
          memFree = gb(r.memory.available);
          add(
            level(100 * (1 - r.memory.available / r.memory.total)),
            'Memory',
            `${gb(r.memory.available)} free of ${gb(r.memory.total)}`,
          );
          add(
            'ok',
            'Swap',
            r.memory.swapTotal ? `${mb(r.memory.swapUsed || 0)} used of ${mb(r.memory.swapTotal)}` : 'not set up',
          );
        } else add('unknown', 'Memory', 'not readable');
        add(
          r.botCpu >= 85 ? 'warn' : 'ok',
          'Bot CPU',
          `${pct(r.botCpu)} of one core${r.cpuLimit ? ` (limit ${r.cpuLimit.toFixed(2)} cores)` : ''}`,
        );
        // The two memory figures are counted differently: the process figure includes shared program files,
        // the container figure only what is charged to the container. The limit applies to the container figure.
        add('ok', 'Bot memory', `${mb(r.botRss)} used by the bot process (includes shared program files)`);
        if (r.containerLimit && r.containerMemory !== null)
          add(
            level((r.containerMemory / r.containerLimit) * 100),
            'Bot container memory',
            `${mb(r.containerMemory)} of its ${mb(r.containerLimit)} limit`,
          );
        else add('off', 'Bot container memory', 'no limit set');
        add(
          r.loopMaxMs === null ? 'unknown' : r.loopMaxMs >= 200 ? 'warn' : 'ok',
          'Bot responsiveness',
          r.loopMaxMs === null ? 'no sample' : `slowest reaction ${Math.round(r.loopMaxMs)} ms`,
        );
      });
      summaries.Server =
        [
          cpuBusy !== null && `CPU ${pct(cpuBusy)}`,
          memFree && `${memFree} memory free`,
          diskFree && `${diskFree} disk free`,
        ]
          .filter(Boolean)
          .join(' · ') || 'fine';
      summaries.Bot = `online · up ${uptime} · Discord ${ping} ms`;

      // --- Internet ---
      group = 'Internet';
      await check('Speed test', async () => {
        const speed = await speedTest();
        const rate = (value) => (value === null ? 'unavailable' : `${value.toFixed(1)} Mbps`);
        add(
          speed.downloadMbps === null ? 'unknown' : speed.downloadMbps < 2 ? 'warn' : 'ok',
          'Download',
          rate(speed.downloadMbps),
        );
        add(
          speed.uploadMbps === null ? 'unknown' : speed.uploadMbps < 2 ? 'warn' : 'ok',
          'Upload',
          rate(speed.uploadMbps),
        );
        add(
          speed.latencyMs === null ? 'unknown' : speed.latencyMs >= 500 ? 'warn' : 'ok',
          'Response time',
          speed.latencyMs === null
            ? 'unavailable'
            : `${Math.round(speed.latencyMs)} ms typical (range ${Math.round(speed.variationMs)} ms over ${LATENCY_SAMPLES} requests)`,
        );
        if (speed.downloadMbps !== null && speed.uploadMbps !== null) {
          const fast = speed.downloadMbps >= 20 && speed.uploadMbps >= 5;
          summaries.Internet = `${fast ? 'fast' : 'working'} · ${Math.round(speed.downloadMbps)} Mbps down, ${Math.round(speed.uploadMbps)} up`;
        }
      });

      // --- report ---
      const report = formatReport(results, {
        summaries,
        names: { channel: (id) => g.channels.cache.get(id)?.name, role: (id) => g.roles.cache.get(id)?.name },
      });
      const file = `${report.fullText}\n\nSpeed test: ${LATENCY_SAMPLES} response-time requests, a 2 MiB download and a 256 KiB upload to Cloudflare, 12-second limit.`;
      await interaction.editReply({
        content: '',
        embeds: [
          embed(report.color).setTitle(report.title).setDescription(report.description).setFooter({
            text: "Every number is in the attached file. I can't hear the audio: if music cuts out, run this while it's happening.",
          }),
        ],
        files: [new AttachmentBuilder(Buffer.from(file, 'utf8'), { name: 'bot-diagnostics.txt' })],
      });
    } finally {
      lease.release();
    }
  },
};

module.exports = { commands: [diagnostics] };
