// Full server rebuild: back up, wipe channels + roles, build the new layout, wire up every bot feature.
// Only the server owner can trigger it (see /setup rebuild), and only after typing the server name.
const path = require('node:path');
const fs = require('node:fs');
const { zipSync, strToU8 } = require('fflate');
const {
  ChannelType, PermissionFlagsBits: P, AttachmentBuilder,
} = require('discord.js');
const { db, updateSettings } = require('./db');
const { embed, truncate, isBotAdmin } = require('./util');

// ---- the new layout -------------------------------------------------------------
// Roles are created top to bottom in this order (Discord puts each new role at the bottom,
// so the first one created ends up highest).
const ROLES = [
  // Admin: full Administrator. Given to BOT_ADMIN_IDS and anyone who had Administrator before the rebuild.
  { key: 'admin', name: 'Admin', color: 0xe67e22, hoist: true, perms: [P.Administrator] },
  { key: 'staff', name: 'Staff', color: 0xed4245, hoist: true, perms: [P.KickMembers, P.BanMembers, P.ModerateMembers, P.ManageMessages, P.ManageNicknames, P.ManageThreads, P.MoveMembers, P.MuteMembers, P.DeafenMembers, P.ViewAuditLog] },
  { key: 'member', name: 'Member', color: 0x57f287 },
];

// @everyone's base permissions: safe defaults. Visibility is controlled per category below.
const EVERYONE_PERMS = [
  P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads,
  P.AddReactions, P.EmbedLinks, P.AttachFiles, P.UseExternalEmojis, P.UseExternalStickers, P.UseApplicationCommands,
  P.Connect, P.Speak, P.UseVAD, P.Stream, P.ChangeNickname, P.CreateInstantInvite,
];

// Visibility presets. Each returns permission overwrites given the role ids.
const V = {
  // everyone can read, nobody but staff can post
  readOnly: (r, g) => [{ id: g, allow: [P.ViewChannel], deny: [P.SendMessages, P.CreatePublicThreads] }, { id: r.staff, allow: [P.SendMessages] }],
  // members only
  members: (r, g) => [{ id: g, deny: [P.ViewChannel] }, { id: r.member, allow: [P.ViewChannel] }, { id: r.staff, allow: [P.ViewChannel] }],
  // members can read, not post
  membersReadOnly: (r, g) => [{ id: g, deny: [P.ViewChannel] }, { id: r.member, allow: [P.ViewChannel], deny: [P.SendMessages] }, { id: r.staff, allow: [P.ViewChannel, P.SendMessages] }],
  // only unverified people see it
  verify: (r, g) => [{ id: g, allow: [P.ViewChannel], deny: [P.SendMessages, P.AddReactions] }, { id: r.member, deny: [P.ViewChannel] }, { id: r.staff, allow: [P.ViewChannel] }],
  // members can sit here but not talk (Discord moves idle people here)
  afk: (r, g) => [{ id: g, deny: [P.ViewChannel] }, { id: r.member, allow: [P.ViewChannel, P.Connect], deny: [P.Speak, P.Stream] }, { id: r.staff, allow: [P.ViewChannel] }],
  staff: (r, g) => [{ id: g, deny: [P.ViewChannel] }, { id: r.staff, allow: [P.ViewChannel] }],
  staffReadOnly: (r, g) => [{ id: g, deny: [P.ViewChannel] }, { id: r.staff, allow: [P.ViewChannel], deny: [P.SendMessages] }],
};

const T = ChannelType.GuildText, VC = ChannelType.GuildVoice;
const LAYOUT = [
  { name: '📌 INFO', vis: 'readOnly', channels: [
    { key: 'rules', name: '📜・rules', type: T, topic: 'Read these before chatting.' },
    { key: 'announcements', name: '📢・announcements', type: T },
    { key: 'verify', name: '✅・verify', type: T, vis: 'verify', topic: 'Click Verify to get into the server.' },
    { key: 'partnerships', name: '🤝・partnerships', type: T },
    { key: 'support', name: '🎫・support', type: T, vis: 'membersReadOnly', topic: 'Open a private ticket with staff. Reports go here.' },
  ] },
  { name: '💬 CHAT', vis: 'members', channels: [
    { key: 'general', name: '💬・general', type: T },
    { key: 'intros', name: '👋・introductions', type: T, topic: 'New here? Say hi: who you are, what you play.' },
    { key: 'offtopic', name: '💭・off-topic', type: T, topic: 'Pets, food, hobbies, selfies, anything not gaming.' },
    { key: 'shower', name: '🚿・shower-thoughts', type: T },
    { key: 'memes', name: '😂・memes', type: T },
    { key: 'clips', name: '🎬・clips-and-media', type: T, topic: 'Clips, screenshots, plays.' },
    { key: 'setups', name: '🖥️・setups', type: T, topic: 'Show off your PC, console or desk setup.' },
    { key: 'politics', name: '🗳️・politics', type: T },
    { key: 'suggestions', name: '💡・suggestions', type: T, topic: 'One suggestion per message. Vote with the reactions, discuss in the thread.' },
    { key: 'selfpromo', name: '📣・self-promo', type: T, topic: 'Your streams, videos, socials. Must have been here 7+ days to post.' },
    { key: 'giveaways', name: '🎁・giveaways', type: T, vis: 'membersReadOnly' },
    { key: 'birthdays', name: '🎂・birthdays', type: T, topic: 'Wish people happy birthday here.' },
  ] },
  { name: '🎮 VOICE', vis: 'members', channels: [
    { key: 'lfg', name: '🎮・lfg', type: T, topic: 'Looking for group: post what you’re playing and how many you need.' },
    { key: 'botcmds', name: '🤖・bot-commands', type: T, topic: 'Music and other bot commands go here.' },
    { key: 'vcGeneral', name: '🔊・General', type: VC },
    { key: 'vcJtc', name: '➕・Join to Create', type: VC },
    { key: 'vcMusic', name: '🎵・Music', type: VC },
    { key: 'vcLive', name: '🔴・Live Streaming', type: VC },
    { key: 'vcAfk', name: '💤・AFK', type: VC, vis: 'afk' },
  ] },
  { key: 'catTickets', name: '🎫 TICKETS', vis: 'staff', channels: [] },
  { name: '🔒 STAFF', vis: 'staff', channels: [
    { key: 'staffchat', name: '🛡️・staff-chat', type: T },
    { key: 'modlogs', name: '📋・mod-logs', type: T, vis: 'staffReadOnly' },
  ] },
];

const running = new Set();

// ---- planning (dry run) --------------------------------------------------------

async function plan(guild) {
  await guild.channels.fetch();
  await guild.roles.fetch();
  const me = guild.members.me;
  const channels = [...guild.channels.cache.values()].filter((c) => !c.isThread());
  const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id);
  const deletable = roles.filter((r) => !r.managed && me.roles.highest.comparePositionTo(r) > 0);
  const stuck = roles.filter((r) => !deletable.includes(r) && !r.managed);
  return { channels, deletable, stuck, managed: roles.filter((r) => r.managed) };
}

// ---- backup --------------------------------------------------------------------

async function backup(guild, progress) {
  const files = {};
  const when = new Date().toISOString().replace(/[:.]/g, '-');
  const channels = [...guild.channels.cache.values()].filter((c) => c.isTextBased() && !c.isThread());
  let i = 0;
  for (const ch of channels) {
    i++;
    if (i % 5 === 0) await progress(`Backing up messages… ${i}/${channels.length} channels`);
    const all = [];
    let before;
    for (let n = 0; n < 20; n++) { // up to 2000 messages per channel
      const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!batch?.size) break;
      all.push(...batch.values());
      before = batch.last().id;
      if (batch.size < 100) break; // reached the start of the channel
    }
    if (!all.length) continue;
    all.reverse();
    const text = all.map((m) => `[${m.createdAt.toISOString()}] ${m.author?.tag ?? 'unknown'}: ${m.content}` +
      (m.attachments.size ? ' ' + [...m.attachments.values()].map((a) => a.url).join(' ') : '') +
      (m.embeds.length ? ' [embed]' : '')).join('\n');
    const cat = ch.parent ? ch.parent.name.replace(/[^\w-]+/g, '_') + '/' : '';
    files[`channels/${cat}${ch.name.replace(/[^\w-]+/g, '_')}.txt`] = strToU8(text);
  }

  const members = await guild.members.fetch();
  const structure = {
    guild: { id: guild.id, name: guild.name, backedUpAt: new Date().toISOString() },
    roles: [...guild.roles.cache.values()].sort((a, b) => b.position - a.position).map((r) => ({
      id: r.id, name: r.name, color: r.hexColor, position: r.position, permissions: r.permissions.toArray(),
      hoist: r.hoist, mentionable: r.mentionable, managed: r.managed,
    })),
    channels: [...guild.channels.cache.values()].filter((c) => !c.isThread()).sort((a, b) => a.rawPosition - b.rawPosition).map((c) => ({
      id: c.id, name: c.name, type: ChannelType[c.type], parent: c.parent?.name ?? null, topic: c.topic ?? null,
      overwrites: [...(c.permissionOverwrites?.cache.values() ?? [])].map((o) => ({
        id: o.id, target: guild.roles.cache.get(o.id)?.name ?? members.get(o.id)?.user.tag ?? o.id, allow: o.allow.toArray(), deny: o.deny.toArray(),
      })),
    })),
    memberRoles: [...members.values()].filter((m) => !m.user.bot).map((m) => ({
      id: m.id, tag: m.user.tag, roles: m.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.name),
    })),
  };
  files['structure.json'] = strToU8(JSON.stringify(structure, null, 2));

  const zip = zipSync(files, { level: 9 });
  const dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rebuild-${guild.id}-${when}.zip`);
  fs.writeFileSync(file, zip);
  return { file, zip, name: path.basename(file), members };
}

// ---- the rebuild ---------------------------------------------------------------

async function run(guild, owner) {
  if (running.has(guild.id)) throw new Error('A rebuild is already running.');
  running.add(guild.id);
  const report = [];
  let dm, statusMsg;
  const progress = (t) => statusMsg.edit(`🔧 ${t}`).catch(() => {});

  try {
    dm = await owner.createDM();
    statusMsg = await dm.send('🔧 Rebuild started. Don’t touch server settings until I say it’s done.');
    // 1. Backup
    await progress('Backing up messages, roles and channels…');
    const bk = await backup(guild, progress);
    const members = bk.members;
    if (bk.zip.length < 8 * 1024 * 1024) {
      await dm.send({ content: 'Backup of the old server (message transcripts, roles, who had which role):', files: [new AttachmentBuilder(Buffer.from(bk.zip), { name: bk.name })] });
    } else {
      await dm.send(`Backup is too big to DM (${(bk.zip.length / 1048576).toFixed(1)} MB). It’s saved on the VPS in the bot’s data volume as \`backups/${bk.name}\`.`);
    }

    // 2. Remember who was staff before roles go
    const staffPerms = [P.Administrator, P.ManageGuild, P.BanMembers, P.KickMembers, P.ModerateMembers];
    const humans = [...members.values()].filter((m) => !m.user.bot);
    const adminIds = humans.filter((m) => m.id !== guild.ownerId && (isBotAdmin(m.id) || m.permissions.has(P.Administrator))).map((m) => m.id);
    const staffIds = humans.filter((m) => m.id !== guild.ownerId && !adminIds.includes(m.id) && staffPerms.some((p) => m.permissions.has(p))).map((m) => m.id);

    const oldChannels = [...guild.channels.cache.values()].filter((c) => !c.isThread());
    const me = guild.members.me;
    const oldRoles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed && me.roles.highest.comparePositionTo(r) > 0);

    // 3. New roles
    await progress('Creating roles…');
    const r = {};
    for (const def of ROLES) {
      const role = await guild.roles.create({
        name: def.name, colors: { primaryColor: def.color }, hoist: !!def.hoist, mentionable: !!def.mentionable,
        permissions: [...EVERYONE_PERMS, ...(def.perms || [])], reason: 'Server rebuild',
      });
      r[def.key] = role.id;
    }
    await guild.roles.everyone.setPermissions(EVERYONE_PERMS, 'Server rebuild: safe defaults').catch((e) => report.push(`⚠️ Couldn’t reset @everyone permissions: ${e.message}`));

    // 4. Categories + channels
    await progress('Creating channels…');
    const c = {};
    const botOw = { id: me.id, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory, P.AddReactions, P.CreatePublicThreads, P.SendMessagesInThreads, P.ManageChannels, P.ManageMessages, P.Connect, P.Speak, P.MoveMembers] };
    for (const cat of LAYOUT) {
      const catCh = await guild.channels.create({
        name: cat.name, type: ChannelType.GuildCategory,
        permissionOverwrites: [...V[cat.vis](r, guild.id), botOw], reason: 'Server rebuild',
      });
      if (cat.key) c[cat.key] = catCh.id;
      for (const def of cat.channels) {
        const ch = await guild.channels.create({
          name: def.name, type: def.type, parent: catCh.id, topic: def.type === T ? def.topic : undefined, rateLimitPerUser: def.slowmode,
          permissionOverwrites: [...V[def.vis || cat.vis](r, guild.id), botOw], reason: 'Server rebuild',
        });
        c[def.key] = ch.id;
      }
    }

    // 5. Community servers must always have a rules + updates channel: point them at the new ones first
    const edit = { systemChannel: null, afkChannel: c.vcAfk, afkTimeout: 900 }; // idle 15 min -> AFK channel
    if (guild.features.includes('COMMUNITY')) {
      Object.assign(edit, { rulesChannel: c.rules, publicUpdatesChannel: c.modlogs, safetyAlertsChannel: c.modlogs });
    }
    await guild.edit(edit).catch((e) => report.push(`⚠️ Couldn’t update server channel settings: ${e.message}`));

    // 6. Delete old channels (children before categories)
    await progress('Deleting old channels…');
    const ordered = oldChannels.sort((a, b) => (a.type === ChannelType.GuildCategory) - (b.type === ChannelType.GuildCategory));
    for (const ch of ordered) {
      await ch.delete('Server rebuild').catch((e) => report.push(`⚠️ Couldn’t delete #${ch.name}: ${e.message}`));
    }

    // 7. Delete old roles
    await progress('Deleting old roles…');
    for (const role of oldRoles) {
      await role.delete('Server rebuild').catch((e) => report.push(`⚠️ Couldn’t delete role ${role.name}: ${e.message}`));
    }

    // 8. Give roles back: everyone -> Member, old staff -> Staff
    let n = 0;
    for (const m of humans) {
      n++;
      if (n % 25 === 0) await progress(`Giving roles… ${n}/${humans.length}`);
      const add = [r.member, ...(adminIds.includes(m.id) ? [r.admin] : []), ...(staffIds.includes(m.id) ? [r.staff] : [])];
      await m.roles.add(add, 'Server rebuild').catch(() => report.push(`⚠️ Couldn’t give roles to ${m.user.tag}`));
    }

    // 9. Wire up the bot's features to the new channels. Clear rows pointing at deleted channels.
    for (const t of ['temp_vcs', 'tickets', 'pending_verify']) db.prepare(`DELETE FROM ${t} WHERE guild_id = ?`).run(guild.id);
    updateSettings(guild.id, {
      logChannel: c.modlogs,
      welcomeChannel: c.general,
      welcomeMessage: `Welcome {user} to **{server}**! Say hi in <#${c.intros}>.`,
      verify: { enabled: true, memberRole: r.member },
      jtc: { lobbyChannel: c.vcJtc, categoryId: null, defaultLimit: 0 },
      tickets: { staffRole: r.staff, categoryId: c.catTickets },
      selfPromo: { channel: c.selfpromo },
      suggestions: { channel: c.suggestions },
    });

    // 10. Panels
    await progress('Posting panels…');
    const post = async (key, payload) => guild.channels.cache.get(c[key])?.send(payload).catch((e) => report.push(`⚠️ Couldn’t post in #${key}: ${e.message}`));
    await post('verify', require('../commands/verify').panel());
    await post('support', require('../commands/tickets').panel());
    await post('suggestions', {
      embeds: [embed('info').setTitle('Suggestions').setDescription('Post one idea per message. The bot adds 👍/👎 and opens a thread for discussion.')],
    });

    require('./commandsync').markRebuildDone(guild.id); // lock /setup rebuild from now on (database + lock file)
    // remove /setup rebuild from this server's command list
    await require('./commandsync').syncGuild(guild).catch((e) => report.push(`⚠️ Couldn’t update the command list: ${e.message}`));
    await statusMsg.edit('✅ Rebuild done.');
    await dm.send({
      embeds: [embed(report.length ? 'warn' : 'ok').setTitle(`Rebuild of ${guild.name} finished`).setDescription(
        `Created ${ROLES.length} roles and ${Object.keys(c).length} channels.\n` +
        `Gave **Member** to ${humans.length} people, **Admin** to ${adminIds.length} (bot admins + anyone who had Administrator) and **Staff** to ${staffIds.length} (people who had mod permissions).\n\n` +
        '**Still for you to do:**\n' +
        `• Write your rules in <#${c.rules}>\n` +
        '• Give yourself any roles you want (you’re the owner, so you have every permission anyway)\n' +
        '• Re-add other bots’ settings if they pointed at deleted channels\n' +
        '• `/setup rebuild` is now **locked** and removed from the command list, so it can’t be run again (Discord may need a restart, Ctrl+R, to stop showing it)\n' +
        `• Check <#${c.modlogs}> works\n` +
        (report.length ? `\n**Problems (${report.length}):**\n${truncate(report.join('\n'), 2500)}` : ''),
      )],
    });
  } catch (e) {
    console.error('[rebuild]', e);
    await dm?.send(`❌ Rebuild stopped with an error: ${e.message}\nThe backup (if it finished) is in the bot’s data volume under \`backups/\`. Some channels/roles may be half-made. Tell whoever runs the bot.`).catch(() => {});
  } finally {
    running.delete(guild.id);
  }
}

module.exports = { plan, run, LAYOUT, ROLES, isRunning: (id) => running.has(id) };
