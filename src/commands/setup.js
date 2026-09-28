// /setup: configure every feature from inside Discord. Admin only.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const { getSettings, updateSettings } = require('../lib/db');
const { embed, truncate, isOwner } = require('../lib/util');
const verify = require('./verify');
const tickets = require('./tickets');
const rebuild = require('../lib/rebuild');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

const P = PermissionFlagsBits;
const text = [ChannelType.GuildText];

// --- rebuild confirmation: button -> type the server name -> go ---
// After the first successful rebuild the command is locked for good. Only whoever controls the VPS can
// unlock it (ALLOW_REBUILD=yes in .env + restart), so nobody in Discord can wipe the server again.
const LOCKED_MSG = 'This server has already been set up, so `/setup rebuild` is locked. It can only be unlocked from the VPS (set `ALLOW_REBUILD=yes` in `.env`, then restart the bot).';
const { rebuildLocked, markRebuildDone, syncGuild } = require('../lib/commandsync');

async function rebuildConfirm(interaction) {
  if (!isOwner(interaction.user, interaction.guild)) return interaction.reply({ content: 'Owner or bot admin only.', flags: MessageFlags.Ephemeral });
  if (rebuildLocked(interaction.guildId)) return interaction.reply({ content: LOCKED_MSG, flags: MessageFlags.Ephemeral });
  await interaction.showModal(new ModalBuilder().setCustomId('rebuild:modal').setTitle('Confirm server rebuild').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name')
      .setLabel(`Type the server name: ${truncate(interaction.guild.name, 20)}`).setStyle(TextInputStyle.Short).setRequired(true)),
  ));
}

async function rebuildSubmit(interaction) {
  if (!isOwner(interaction.user, interaction.guild)) return interaction.reply({ content: 'Owner or bot admin only.', flags: MessageFlags.Ephemeral });
  if (rebuildLocked(interaction.guildId)) return interaction.reply({ content: LOCKED_MSG, flags: MessageFlags.Ephemeral });
  if (interaction.fields.getTextInputValue('name').trim() !== interaction.guild.name.trim())
    return interaction.reply({ content: 'Name didn’t match. Nothing was changed.', flags: MessageFlags.Ephemeral });
  if (rebuild.isRunning(interaction.guildId)) return interaction.reply({ content: 'Already running.', flags: MessageFlags.Ephemeral });
  // Check DMs work before destroying anything
  try {
    await interaction.user.send('Rebuild confirmed. Starting in 10 seconds. Progress will appear here.');
  } catch {
    return interaction.reply({ content: 'I can’t DM you. Turn on DMs from server members (Privacy Settings for this server), then try again. Nothing was changed.', flags: MessageFlags.Ephemeral });
  }
  await interaction.reply({ content: 'Confirmed. Starting in 10 seconds. Check your DMs.', flags: MessageFlags.Ephemeral });
  const guild = interaction.guild, owner = interaction.user;
  setTimeout(() => rebuild.run(guild, owner).catch((e) => console.error('[rebuild]', e)), 10_000);
}

const setup = {
  data: new SlashCommandBuilder().setName('setup').setDescription('Configure the bot')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addSubcommand((s) => s.setName('show').setDescription('Show current settings'))
    .addSubcommand((s) => s.setName('logs').setDescription('Where mod actions, deletes, edits, joins get logged')
      .addChannelOption((o) => o.setName('channel').setDescription('Log channel (blank = off)').addChannelTypes(...text)))
    .addSubcommand((s) => s.setName('welcome').setDescription('Welcome message (sent after verification if that is on)')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel (blank = off)').addChannelTypes(...text))
      .addStringOption((o) => o.setName('message').setDescription('Use {user} {username} {server} {count}').setMaxLength(1000)))
    .addSubcommand((s) => s.setName('verify').setDescription('Set up captcha verification and post the panel')
      .addChannelOption((o) => o.setName('channel').setDescription('The only channel unverified people can see').addChannelTypes(...text).setRequired(true))
      .addRoleOption((o) => o.setName('member_role').setDescription('Role given after passing; should unlock the server').setRequired(true))
      .addIntegerOption((o) => o.setName('kick_after_minutes').setDescription('Kick if not verified in N min (0 = never). Default 15').setMinValue(0).setMaxValue(1440))
      .addIntegerOption((o) => o.setName('flag_accounts_younger_than_days').setDescription('Flag new accounts in logs. Default 3').setMinValue(0).setMaxValue(365)))
    .addSubcommand((s) => s.setName('verify-off').setDescription('Turn verification off'))
    .addSubcommand((s) => s.setName('verify-existing').setDescription('Give the member role to everyone already in the server (do this BEFORE locking channels)'))
    .addSubcommand((s) => s.setName('joinvoice').setDescription('Set the join-to-create lobby voice channel')
      .addChannelOption((o) => o.setName('lobby').setDescription('Voice channel people join to get their own').addChannelTypes(ChannelType.GuildVoice).setRequired(true))
      .addChannelOption((o) => o.setName('category').setDescription('Category for new channels (default: lobby’s category)').addChannelTypes(ChannelType.GuildCategory))
      .addIntegerOption((o) => o.setName('default_limit').setDescription('Default user limit (0 = none)').setMinValue(0).setMaxValue(99)))
    .addSubcommand((s) => s.setName('joinvoice-off').setDescription('Turn join-to-create off'))
    .addSubcommand((s) => s.setName('tickets').setDescription('Set up tickets and post the panel')
      .addChannelOption((o) => o.setName('panel_channel').setDescription('Where the "Open ticket" button goes').addChannelTypes(...text).setRequired(true))
      .addRoleOption((o) => o.setName('staff_role').setDescription('Who can see tickets').setRequired(true))
      .addChannelOption((o) => o.setName('category').setDescription('Category for ticket channels').addChannelTypes(ChannelType.GuildCategory)))
    .addSubcommand((s) => s.setName('scamfilter').setDescription('Scam link / hacked account filter')
      .addBooleanOption((o) => o.setName('enabled').setDescription('On/off'))
      .addIntegerOption((o) => o.setName('timeout_hours').setDescription('Timeout for scam posters (0 = just delete). Default 24').setMinValue(0).setMaxValue(672))
      .addBooleanOption((o) => o.setName('block_mass_ping_links').setDescription('Delete non-staff @everyone/@here + link. Default on'))
      .addIntegerOption((o) => o.setName('cross_channel_spam').setDescription('Same message in N channels in 30s = spam (0 = off). Default 3').setMinValue(0).setMaxValue(10))
      .addStringOption((o) => o.setName('allow').setDescription('Never flag this domain, e.g. mysite.com'))
      .addStringOption((o) => o.setName('unallow').setDescription('Remove a domain from the allow list')))
    .addSubcommand((s) => s.setName('restyle').setDescription('Rename the rebuilt channels to the emoji・name style (nothing is deleted)'))
    .addSubcommand((s) => s.setName('rebuild').setDescription('⚠️ OWNER/BOT ADMIN ONLY: back up, delete ALL channels + roles, build the new layout')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const g = interaction.guildId;
    const opt = interaction.options;
    const done = (msg) => interaction.reply({ embeds: [embed('ok').setDescription(msg)], flags: MessageFlags.Ephemeral });

    switch (sub) {
      case 'show': {
        const s = getSettings(g);
        const c = (id) => (id ? `<#${id}>` : '*off*');
        const r = (id) => (id ? `<@&${id}>` : '*none*');
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [embed('info').setTitle('Settings').addFields(
            { name: 'Logs', value: c(s.logChannel), inline: true },
            { name: 'Welcome', value: c(s.welcomeChannel), inline: true },
            { name: 'Verification', value: s.verify.enabled ? `on · role ${r(s.verify.memberRole)} · kick after ${s.verify.timeoutMinutes || 'never'} min · flag <${s.verify.minAccountAgeDays}d accounts` : '*off*' },
            { name: 'Join-to-create', value: s.jtc.lobbyChannel ? `${c(s.jtc.lobbyChannel)} · limit ${s.jtc.defaultLimit || 'none'}` : '*off*' },
            { name: 'Scam filter', value: s.scamFilter.enabled ? `on · ${s.scamFilter.timeoutHours}h timeout` : '*off*', inline: true },
            { name: 'Tickets', value: s.tickets.staffRole ? `staff ${r(s.tickets.staffRole)}` : '*off*' },
          )],
        });
      }
      case 'logs': {
        const ch = opt.getChannel('channel');
        updateSettings(g, { logChannel: ch?.id || null });
        return done(ch ? `Logging to ${ch}.` : 'Logging off.');
      }
      case 'welcome': {
        const ch = opt.getChannel('channel');
        const msg = opt.getString('message');
        updateSettings(g, { welcomeChannel: ch?.id || null, ...(msg ? { welcomeMessage: msg } : {}) });
        return done(ch ? `Welcome messages go to ${ch}.` : 'Welcome messages off.');
      }
      case 'verify': {
        const ch = opt.getChannel('channel', true);
        const role = opt.getRole('member_role', true);
        const me = interaction.guild.members.me;
        if (role.managed || role.id === g) return interaction.reply({ content: 'Pick a normal role, not @everyone or a bot role.', flags: MessageFlags.Ephemeral });
        if (me.roles.highest.comparePositionTo(role) <= 0)
          return interaction.reply({ content: `My role must be above ${role} in Server Settings → Roles.`, flags: MessageFlags.Ephemeral });
        const patch = { enabled: true, memberRole: role.id };
        if (opt.getInteger('kick_after_minutes') !== null) patch.timeoutMinutes = opt.getInteger('kick_after_minutes');
        if (opt.getInteger('flag_accounts_younger_than_days') !== null) patch.minAccountAgeDays = opt.getInteger('flag_accounts_younger_than_days');
        updateSettings(g, { verify: patch });
        await ch.send(verify.panel());
        return done(
          `Verification on. Panel posted in ${ch}.\n\n**You still need to set channel permissions yourself:**\n` +
          `1. For **@everyone**: turn off *View Channels* on every category/channel except ${ch}.\n` +
          `2. For ${role}: turn *View Channels* on for those categories.\n` +
          `3. In ${ch}: @everyone can view but not send messages; ${role} cannot view (optional, keeps it clean).\n\n` +
          'Existing members don’t have the role yet. Run `/setup verify-existing` BEFORE locking channels, or they’ll lose access.'
        );
      }
      case 'verify-existing': {
        const { memberRole } = getSettings(g).verify;
        if (!memberRole) return interaction.reply({ content: 'Run `/setup verify` first.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const members = await interaction.guild.members.fetch();
        const todo = members.filter((m) => !m.user.bot && !m.roles.cache.has(memberRole));
        let ok = 0, fail = 0;
        for (const m of todo.values()) {
          // discord.js queues these to respect rate limits; big servers take a while
          await m.roles.add(memberRole, 'Existing member, verified by admin').then(() => ok++, () => fail++);
        }
        return interaction.editReply(`Gave the member role to ${ok} member(s).${fail ? ` ${fail} failed (check my role is above it).` : ''}`);
      }
      case 'verify-off':
        updateSettings(g, { verify: { enabled: false } });
        return done('Verification off. (Channel permissions are unchanged.)');
      case 'joinvoice': {
        const lobby = opt.getChannel('lobby', true);
        const cat = opt.getChannel('category');
        updateSettings(g, { jtc: { lobbyChannel: lobby.id, categoryId: cat?.id || null, defaultLimit: opt.getInteger('default_limit') ?? 0 } });
        return done(`Join ${lobby} to get your own channel. Owners use \`/vc\` to control it.`);
      }
      case 'joinvoice-off':
        updateSettings(g, { jtc: { lobbyChannel: null } });
        return done('Join-to-create off.');
      case 'tickets': {
        const ch = opt.getChannel('panel_channel', true);
        const role = opt.getRole('staff_role', true);
        const cat = opt.getChannel('category');
        updateSettings(g, { tickets: { staffRole: role.id, categoryId: cat?.id || null } });
        await ch.send(tickets.panel());
        return done(`Ticket panel posted in ${ch}.`);
      }
      case 'scamfilter': {
        const cur = getSettings(g).scamFilter;
        const patch = {};
        if (opt.getBoolean('enabled') !== null) patch.enabled = opt.getBoolean('enabled');
        if (opt.getInteger('timeout_hours') !== null) patch.timeoutHours = opt.getInteger('timeout_hours');
        if (opt.getBoolean('block_mass_ping_links') !== null) patch.blockMassPingLinks = opt.getBoolean('block_mass_ping_links');
        if (opt.getInteger('cross_channel_spam') !== null) patch.crossChannelSpam = opt.getInteger('cross_channel_spam');
        const clean = (d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
        let allow = [...cur.allow];
        if (opt.getString('allow')) allow = [...new Set([...allow, clean(opt.getString('allow'))])];
        if (opt.getString('unallow')) allow = allow.filter((d) => d !== clean(opt.getString('unallow')));
        patch.allow = allow;
        const s2 = updateSettings(g, { scamFilter: patch });
        const st = require('../lib/scamfilter').stats();
        return done(`Scam filter **${s2.scamFilter.enabled ? 'on' : 'off'}** · timeout ${s2.scamFilter.timeoutHours}h · mass-ping links ${s2.scamFilter.blockMassPingLinks ? 'blocked' : 'allowed'} · cross-channel spam ${s2.scamFilter.crossChannelSpam || 'off'}\n` +
          `Known scam domains loaded: **${st.size}**${st.lastLoaded ? ` (updated <t:${Math.floor(st.lastLoaded / 1000)}:R>)` : ''}\nAllow list: ${s2.scamFilter.allow.join(', ') || 'none'}`);
      }
      case 'restyle': {
        if (!isOwner(interaction.user, interaction.guild))
          return interaction.reply({ content: 'Only the server owner or a bot admin can do this.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        // "💬・general" / "general" / "💬 Chat" all normalise to the part from the first letter or digit, lowercased
        const norm = (n) => n.replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
        const wanted = [];
        for (const cat of rebuild.LAYOUT) {
          wanted.push({ name: cat.name, type: ChannelType.GuildCategory });
          for (const ch of cat.channels) wanted.push({ name: ch.name, type: ch.type });
        }
        let renamed = 0, skipped = 0, matched = 0;
        for (const ch of interaction.guild.channels.cache.values()) {
          const w = wanted.find((x) => x.type === ch.type && norm(x.name) === norm(ch.name));
          if (!w) continue;
          matched++;
          if (ch.name === w.name) continue;
          await ch.setName(w.name, 'Restyle').then(() => renamed++, () => skipped++);
        }
        // A server that already has the rebuilt layout (e.g. rebuilt before the lock existed) gets locked too.
        let lockNote = '';
        if (matched >= Math.ceil(wanted.length / 2) && !rebuildLocked(g)) {
          markRebuildDone(g);
          await syncGuild(interaction.guild).catch((e) => console.error('[commands]', e.message));
          lockNote = '\n`/setup rebuild` is now **locked** and removed from the command list (unlock only from the VPS: `ALLOW_REBUILD=yes` in `.env`).';
        }
        return interaction.editReply(`Renamed ${renamed} channel(s).${skipped ? ` ${skipped} couldn’t be renamed (check my permissions).` : ''}${lockNote}`);
      }
      case 'rebuild': {
        if (!isOwner(interaction.user, interaction.guild))
          return interaction.reply({ content: 'Only the server owner or a bot admin can do this.', flags: MessageFlags.Ephemeral });
        if (rebuildLocked(g)) return interaction.reply({ content: LOCKED_MSG, flags: MessageFlags.Ephemeral });
        if (!interaction.guild.members.me.permissions.has(P.Administrator))
          return interaction.reply({ content: 'I need the **Administrator** permission for a rebuild (I have to delete/create every channel and role). Give it to my role, then run this again. You can remove it after.', flags: MessageFlags.Ephemeral });
        if (rebuild.isRunning(g)) return interaction.reply({ content: 'A rebuild is already running.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const p = await rebuild.plan(interaction.guild);
        const list = (arr, fmt) => truncate(arr.map(fmt).join(', ') || 'none', 900);
        const newLayout = rebuild.LAYOUT.map((cat) => `**${cat.name}**${cat.channels.length ? ': ' + cat.channels.map((c) => c.name).join(', ') : ''}`).join('\n');
        return interaction.editReply({
          embeds: [embed('bad').setTitle('⚠️ Server rebuild: read this').setDescription(
            `**Will be DELETED (${p.channels.length} channels):** ${list(p.channels, (c) => c.name)}\n\n` +
            `**Roles DELETED (${p.deletable.length}):** ${list(p.deletable, (r) => r.name)}\n` +
            (p.stuck.length ? `**Can’t delete (above my role), will stay:** ${list(p.stuck, (r) => r.name)}\n` : '') +
            `**Left alone (bot/booster roles):** ${list(p.managed, (r) => r.name)}\n\n` +
            `**New layout:**\n${newLayout}\n\n` +
            `**New roles:** ${rebuild.ROLES.map((r) => r.name).join(', ')}\n\n` +
            '**What happens:**\n' +
            '1. Every channel with messages is backed up (last 2000 messages each) and DMed to you as a zip, with a list of who had which role.\n' +
            '2. Everything above is deleted and the new layout is built.\n' +
            '3. Everyone gets **Member**. Anyone who had mod/admin permissions gets **Staff**.\n' +
            '4. Verification, logs, join-to-create, tickets and welcome are all set up automatically.\n\n' +
            '**Deleted messages cannot be restored into Discord.** The backup is text only.\n' +
            'Make sure your DMs are open. Progress comes by DM because this channel will be deleted.',
          )],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('rebuild:confirm').setLabel('I understand, continue').setStyle(ButtonStyle.Danger),
          )],
        });
      }
    }
  },
};

module.exports = { commands: [setup], components: { 'rebuild:confirm': rebuildConfirm, 'rebuild:modal': rebuildSubmit } };
