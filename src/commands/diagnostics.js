// /diagnostics: checks every part of the bot and reports what passed and what failed.
// Admins only, only the person who runs it sees the result, and it never shows tokens or passwords.
const fs = require('node:fs');
const os = require('node:os');
const { SlashCommandBuilder, PermissionFlagsBits: P, MessageFlags, ChannelType } = require('discord.js');
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

const withTimeout = (p, ms = 8000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);

const diagnostics = {
  data: new SlashCommandBuilder().setName('diagnostics').setDescription('Check every part of the bot is working (admins only)')
    .setDefaultMemberPermissions(P.ManageGuild),
  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const g = interaction.guild, me = g.members.me, s = getSettings(g.id), client = interaction.client;
    const results = []; // { status: 'ok'|'warn'|'fail', name, detail }
    const add = (status, name, detail = '') => results.push({ status, name, detail });
    const check = async (name, fn) => {
      try { await fn(); } catch (e) { add('fail', name, e.message); }
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
    const chan = (id, label, needSend = true) => {
      if (!id) return add('warn', label, 'not set up');
      const ch = g.channels.cache.get(id);
      if (!ch) return add('fail', label, 'the channel was deleted: set it up again with /setup');
      if (needSend && ch.type !== ChannelType.GuildCategory && ch.type !== ChannelType.GuildVoice && !ch.permissionsFor(me).has([P.ViewChannel, P.SendMessages, P.EmbedLinks]))
        return add('fail', label, `${ch}: I can't post there`);
      add('ok', label, `${ch}`);
    };
    const role = (id, label) => {
      if (!id) return add('warn', label, 'not set up');
      add(g.roles.cache.has(id) ? 'ok' : 'fail', label, g.roles.cache.has(id) ? `<@&${id}>` : 'the role was deleted: set it up again with /setup');
    };
    chan(s.logChannel, 'Log channel');
    chan(s.welcomeChannel, 'Welcome channel');
    if (s.verify.enabled) role(s.verify.memberRole, 'Verification Member role'); else add('warn', 'Verification', 'turned off');
    role(s.tickets.staffRole, 'Ticket staff role');
    if (s.tickets.categoryId) chan(s.tickets.categoryId, 'Ticket category', false);
    chan(s.jtc.lobbyChannel, 'Join-to-create lobby', false);
    if (s.selfPromo.channel) chan(s.selfPromo.channel, 'Self-promo channel', false);
    if (s.suggestions.channel) chan(s.suggestions.channel, 'Suggestions channel', false);

    // --- database + backups ---
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
          add('ok', 'Music server load', `CPU: Lavalink ${pct(st.cpu.lavalinkLoad)}, whole VPS ${pct(st.cpu.systemLoad)} (${st.cpu.cores} core${st.cpu.cores === 1 ? '' : 's'}) · RAM ${Math.round((st.memory?.used || 0) / 1e6)} MB`);
        }
        // Lavalink sends 50 audio frames a second = 3000 a minute per player. Missing/late frames = stutter.
        if (st?.frameStats) {
          const lost = (st.frameStats.nulled || 0) + Math.max(0, st.frameStats.deficit || 0);
          const lostPct = (lost / 3000) * 100;
          add(lostPct < 1 ? 'ok' : lostPct < 5 ? 'warn' : 'fail', 'Audio smoothness (last minute)',
            `${lostPct.toFixed(1)}% of audio frames missing or late${lostPct < 1 ? ' (smooth)' : lostPct < 5 ? ' (small hiccups)' : ' (stuttering: the VPS is too busy)'}`);
        } else {
          add('ok', 'Audio smoothness', 'nothing playing right now: play a song for a minute, then run /diagnostics again');
        }
        const has = (n) => plugins.some((p) => p.toLowerCase().includes(n));
        add(has('youtube') ? 'ok' : 'fail', 'YouTube plugin', has('youtube') ? plugins.find((p) => p.toLowerCase().includes('youtube')) : 'not loaded');
      });
      await check('YouTube search', async () => {
        const res = await withTimeout(node.rest.resolve('ytsearch:lofi hip hop'), 15000);
        const n = res?.loadType === 'search' ? res.data.length : 0;
        add(n ? 'ok' : 'fail', 'YouTube search', n ? `${n} results` : `no results (${res?.loadType || 'no reply'}${res?.data?.message ? `: ${res.data.message}` : ''})`);
      });
    }
    await check('YouTube cipher helper', async () => {
      // Any HTTP answer means the yt-cipher container is up (it may say 401/404 without the password; that's fine).
      await withTimeout(fetch('http://yt-cipher:8001/', { signal: AbortSignal.timeout(5000) }), 6000);
      add('ok', 'YouTube cipher helper', 'running');
    });
    await check('Spotify links', async () => {
      // A long-standing public song. Checks Spotify's embed page can still be read (no account/helper involved).
      const sp = await withTimeout(require('../lib/spotify').load('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), 15000);
      add(sp.tracks.length ? 'ok' : 'fail', 'Spotify links', sp.tracks.length ? `reading Spotify works (test song: ${sp.tracks[0].title})` : 'no songs read');
    });
    const q = client.music.get(g.id);
    add('ok', 'Music right now', q?.current ? `playing in <#${q.voiceChannelId}> · ${q.tracks.length} queued` : 'idle');

    // --- protection ---
    const st = scamfilter.stats();
    if (!s.scamFilter.enabled) add('warn', 'Scam filter', 'turned off');
    else if (!st.size) add('fail', 'Scam filter', 'no scam list loaded (the @everyone and cross-channel checks still work)');
    else add(Date.now() - st.lastLoaded < 13 * 3600e3 ? 'ok' : 'warn', 'Scam filter', `${st.size} domains, updated ${st.lastLoaded ? `<t:${Math.floor(st.lastLoaded / 1000)}:R>` : 'from cache'}`);
    add('ok', 'Lockdown', antiRaid.isLocked(g.id) ? '🔒 ON' : 'off');

    // --- VPS ---
    await check('Disk space', () => {
      const f = fs.statfsSync('/');
      const freeGb = (f.bavail * f.bsize) / 1e9;
      add(freeGb > 2 ? 'ok' : freeGb > 0.5 ? 'warn' : 'fail', 'Disk space', `${freeGb.toFixed(1)} GB free`);
    });
    const freeMem = os.freemem() / 1e9, totalMem = os.totalmem() / 1e9;
    add(freeMem > 0.3 ? 'ok' : 'warn', 'Memory (VPS)', `${freeMem.toFixed(1)} of ${totalMem.toFixed(1)} GB free · bot using ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
    add('ok', 'Bot uptime', fmtDuration(process.uptime() * 1000));

    // --- report ---
    const icon = { ok: '✅', warn: '⚠️', fail: '❌' };
    const passed = results.filter((r) => r.status === 'ok').length;
    const fails = results.filter((r) => r.status === 'fail').length;
    const lines = results.map((r) => `${icon[r.status]} **${r.name}**${r.detail ? ` · ${r.detail}` : ''}`);
    let desc = lines.join('\n');
    if (desc.length > 4000) desc = `${desc.slice(0, 3990)}…`;
    await interaction.editReply({
      embeds: [embed(fails ? 'bad' : results.some((r) => r.status === 'warn') ? 'warn' : 'ok')
        .setTitle(`Diagnostics: ${passed}/${results.length} passed${fails ? ` · ${fails} failed` : ''}`)
        .setDescription(desc)
        .setFooter({ text: '⚠️ = not set up or worth a look · ❌ = broken' })],
    });
  },
};

module.exports = { commands: [diagnostics] };
