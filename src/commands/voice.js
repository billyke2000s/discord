// Join-to-create voice channels. The owner controls their channel from a panel the bot posts in the
// channel's own chat (like the music panel), or with /vc. Only the owner and staff can use either.
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { db } = require('../lib/db');
const { embed, truncate, isBotAdmin } = require('../lib/util');

const P = PermissionFlagsBits;
// Older databases don't have the panel column yet.
if (
  !db
    .prepare('PRAGMA table_info(temp_vcs)')
    .all()
    .some((c) => c.name === 'panel_id')
)
  db.exec('ALTER TABLE temp_vcs ADD COLUMN panel_id TEXT');
const getVc = db.prepare('SELECT * FROM temp_vcs WHERE channel_id = ?');
const creating = new Set(); // guildId:userId while their channel is being created (stops quick rejoins making two)
const setOwner = db.prepare('UPDATE temp_vcs SET owner_id = ? WHERE channel_id = ?');
const setPanel = db.prepare('UPDATE temp_vcs SET panel_id = ? WHERE channel_id = ?');
const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });
const FAIL_HINT = 'Check I have **Manage Channels** and **Move Members** in this category.';

const canControl = (userId, permissions, row) =>
  row.owner_id === userId || isBotAdmin(userId) || !!permissions?.has(P.ManageChannels);
const isLocked = (channel) =>
  !!channel.permissionOverwrites?.cache?.get(channel.guild.roles.everyone.id)?.deny?.has(P.Connect);

// ---------- actions (shared by the panel and /vc) ----------
async function lock(channel) {
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { Connect: false });
  // everyone already inside can stay, and leave and rejoin
  for (const m of channel.members.values()) await channel.permissionOverwrites.edit(m.id, { Connect: true });
}
const unlock = (channel) => channel.permissionOverwrites.edit(channel.guild.roles.everyone, { Connect: null });
const setLimit = (channel, n) => channel.setUserLimit(n);
// Discord allows 2 renames per channel every 10 minutes; don't hang waiting for the limit to clear.
const rename = (channel, name) =>
  Promise.race([channel.setName(name).then(() => true), new Promise((res) => setTimeout(() => res(false), 5000))]);
// Returns an error message, or null when done.
async function kick(channel, actorId, userId) {
  if (userId === actorId) return 'You can’t kick yourself.';
  if (userId === channel.guild.members.me?.id) return 'I can’t kick myself.';
  const target = await channel.guild.members.fetch(userId).catch(() => null);
  if (target?.permissions.has(P.MoveMembers)) return 'You can’t kick a moderator.';
  await channel.permissionOverwrites.edit(userId, { Connect: false });
  if (target?.voice.channelId === channel.id) await target.voice.disconnect('Kicked from temp VC by owner');
  return null;
}
async function transfer(channel, row, userId, isBot) {
  if (!channel.members.has(userId)) return 'They need to be in the channel.';
  if (isBot) return 'Bots can’t own channels.';
  // Give the new owner control in Discord first; only then record them as owner, so a failed
  // permission change can't leave the database and the channel disagreeing.
  await channel.permissionOverwrites.edit(userId, { Connect: true, ManageChannels: true, MoveMembers: true });
  setOwner.run(userId, channel.id);
  if (row.owner_id !== userId) {
    await channel.permissionOverwrites
      .edit(row.owner_id, { ManageChannels: null, MoveMembers: null })
      .catch((e) => console.error('[vc] could not remove old owner controls:', e.message));
  }
  return null;
}

// ---------- the panel ----------
function panelPayload(channel, row) {
  const locked = isLocked(channel);
  const humans = channel.members.filter((m) => !m.user.bot).size;
  const id = channel.id;
  return {
    content: '',
    embeds: [
      embed(locked ? 'warn' : 'info')
        .setTitle('🔊 Your voice channel')
        .setDescription(
          `**Owner:** <@${row.owner_id}>\n` +
            `**Status:** ${locked ? '🔒 Locked: only people already here can join' : '🔓 Open: anyone can join'}\n` +
            `**Limit:** ${channel.userLimit ? `${humans}/${channel.userLimit}` : `none (${humans} here)`}`,
        )
        .setFooter({ text: 'Only the owner and staff can use these. The channel is deleted when everyone leaves.' }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        locked
          ? new ButtonBuilder()
              .setCustomId(`vcp:unlock:${id}`)
              .setEmoji('🔓')
              .setLabel('Unlock')
              .setStyle(ButtonStyle.Success)
          : new ButtonBuilder()
              .setCustomId(`vcp:lock:${id}`)
              .setEmoji('🔒')
              .setLabel('Lock')
              .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`vcp:limit:${id}`)
          .setEmoji('👥')
          .setLabel('Limit')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`vcp:rename:${id}`)
          .setEmoji('✏️')
          .setLabel('Rename')
          .setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`vcp:kick:${id}`)
          .setPlaceholder('👢 Kick someone and block them from rejoining'),
      ),
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`vcp:transfer:${id}`)
          .setPlaceholder('👑 Give the channel to someone else'),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

// Post the panel in the voice channel's own chat, or refresh the one already there.
async function refreshPanel(channel) {
  const row = getVc.get(channel.id);
  if (!row || !channel.isTextBased?.()) return null;
  const payload = panelPayload(channel, row);
  if (row.panel_id) {
    const msg = await channel.messages.fetch(row.panel_id).catch(() => null);
    if (msg) return msg.edit(payload).catch(() => null);
  }
  const me = channel.guild.members.me;
  if (me && !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) return null;
  const msg = await channel
    .send({ ...payload, content: `<@${row.owner_id}>`, allowedMentions: { users: [row.owner_id] } })
    .catch(() => null);
  if (msg) setPanel.run(msg.id, channel.id);
  return msg;
}

// Panel buttons, menus and pop-up forms. customId: vcp:<action>:<channelId> or vcpm:<action>:<channelId>.
async function onPanel(interaction, suffix) {
  const [action, channelId] = suffix.split(':');
  const channel = interaction.guild.channels.cache.get(channelId);
  const row = channel && getVc.get(channelId);
  if (!row) return interaction.reply(eph('This channel no longer exists.'));
  if (!canControl(interaction.user.id, interaction.memberPermissions, row))
    return interaction.reply(eph(`Only the owner (<@${row.owner_id}>) or staff can use these.`));
  try {
    if (action === 'limit')
      return interaction.showModal(
        new ModalBuilder()
          .setCustomId(`vcpm:limit:${channelId}`)
          .setTitle('User limit')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('n')
                .setLabel('How many people? (0 = no limit, max 99)')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(2)
                .setRequired(true)
                .setValue(String(channel.userLimit || 0)),
            ),
          ),
      );
    if (action === 'rename')
      return interaction.showModal(
        new ModalBuilder()
          .setCustomId(`vcpm:rename:${channelId}`)
          .setTitle('Rename channel')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('name')
                .setLabel('New name (2 renames per 10 minutes)')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(100)
                .setRequired(true)
                .setValue(channel.name.slice(0, 100)),
            ),
          ),
      );
    let note = null;
    if (action === 'lock') await lock(channel);
    else if (action === 'unlock') await unlock(channel);
    else if (action === 'kick') {
      note =
        (await kick(channel, interaction.user.id, interaction.values[0])) ||
        `<@${interaction.values[0]}> was kicked and can’t rejoin.`;
    } else if (action === 'transfer') {
      const user = interaction.users?.get(interaction.values[0]);
      note =
        (await transfer(channel, row, interaction.values[0], !!user?.bot)) ||
        `<@${interaction.values[0]}> now owns this channel.`;
    } else return interaction.reply(eph('That control isn’t available any more.'));
    await interaction.update(panelPayload(channel, getVc.get(channelId)));
    if (note) await interaction.followUp(eph(note));
  } catch (e) {
    const msg = `That didn’t work: ${truncate(e.message, 150)}. ${FAIL_HINT}`;
    return interaction.replied || interaction.deferred ? interaction.followUp(eph(msg)) : interaction.reply(eph(msg));
  }
}

async function onPanelForm(interaction, suffix) {
  const [action, channelId] = suffix.split(':');
  const channel = interaction.guild.channels.cache.get(channelId);
  const row = channel && getVc.get(channelId);
  if (!row) return interaction.reply(eph('This channel no longer exists.'));
  if (!canControl(interaction.user.id, interaction.memberPermissions, row))
    return interaction.reply(eph(`Only the owner (<@${row.owner_id}>) or staff can use these.`));
  let note = null;
  try {
    if (action === 'limit') {
      const n = Number(interaction.fields.getTextInputValue('n').trim());
      if (!Number.isInteger(n) || n < 0 || n > 99)
        return interaction.reply(eph('The limit has to be a number from 0 to 99.'));
      await setLimit(channel, n);
    } else if (action === 'rename') {
      const name = interaction.fields.getTextInputValue('name').trim();
      if (!name) return interaction.reply(eph('The name can’t be empty.'));
      if (!(await rename(channel, name)))
        note = 'Discord only allows 2 renames every 10 minutes. It will change when that clears.';
    } else return interaction.reply(eph('That form isn’t available any more.'));
    const payload = panelPayload(channel, row);
    if (interaction.isFromMessage?.()) await interaction.update(payload);
    else {
      await interaction.reply(eph('Done.'));
      await refreshPanel(channel);
    }
    if (note) await interaction.followUp(eph(note));
  } catch (e) {
    const msg = `That didn’t work: ${truncate(e.message, 150)}. ${FAIL_HINT}`;
    return interaction.replied || interaction.deferred ? interaction.followUp(eph(msg)) : interaction.reply(eph(msg));
  }
}

// ---------- /vc (same actions, for people who prefer typing) ----------
async function ownedChannel(interaction) {
  const channel = interaction.member.voice.channel;
  const row = channel && getVc.get(channel.id);
  if (!row) {
    await interaction.reply(eph('You need to be in a channel made by the join-to-create lobby.'));
    return null;
  }
  if (!canControl(interaction.user.id, interaction.member.permissions, row)) {
    await interaction.reply(eph(`Only the owner (<@${row.owner_id}>) can do that.`));
    return null;
  }
  return { channel, row };
}

const vc = {
  data: new SlashCommandBuilder()
    .setName('vc')
    .setDescription('Control your own voice channel')
    .addSubcommand((s) => s.setName('panel').setDescription('Bring the control panel back to the bottom of the chat'))
    .addSubcommand((s) => s.setName('lock').setDescription('Stop new people joining'))
    .addSubcommand((s) => s.setName('unlock').setDescription('Let people join again'))
    .addSubcommand((s) =>
      s
        .setName('limit')
        .setDescription('Set user limit (0 = none)')
        .addIntegerOption((o) =>
          o.setName('number').setDescription('0-99').setMinValue(0).setMaxValue(99).setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('rename')
        .setDescription('Rename the channel (Discord allows 2 renames per 10 min)')
        .addStringOption((o) => o.setName('name').setDescription('New name').setMaxLength(100).setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('kick')
        .setDescription('Kick someone out and block them from rejoining')
        .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('transfer')
        .setDescription('Give ownership to someone in the channel')
        .addUserOption((o) => o.setName('user').setDescription('New owner').setRequired(true)),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const r = await ownedChannel(interaction);
    if (!r) return;
    const { channel, row } = r;
    const ok = (text) => interaction.reply({ embeds: [embed('ok').setDescription(text)] });
    try {
      switch (sub) {
        case 'panel': {
          if (row.panel_id) {
            const old = await channel.messages.fetch(row.panel_id).catch(() => null);
            await old?.delete().catch(() => {});
            setPanel.run(null, channel.id);
          }
          const msg = await refreshPanel(channel);
          return interaction.reply(
            eph(msg ? 'Panel posted below.' : 'I couldn’t post in this channel’s chat. Check my permissions.'),
          );
        }
        case 'lock':
          await lock(channel);
          await ok('🔒 Locked.');
          break;
        case 'unlock':
          await unlock(channel);
          await ok('🔓 Unlocked.');
          break;
        case 'limit': {
          const n = interaction.options.getInteger('number', true);
          await setLimit(channel, n);
          await ok(n ? `Limit set to ${n}.` : 'Limit removed.');
          break;
        }
        case 'rename': {
          const name = interaction.options.getString('name', true);
          await interaction.deferReply();
          const done = await rename(channel, name);
          await interaction.editReply(
            done
              ? `Renamed to **${truncate(name, 100)}**.`
              : 'Discord is rate-limiting renames (max 2 per 10 minutes). It will apply when the limit clears.',
          );
          break;
        }
        case 'kick': {
          const u = interaction.options.getUser('user', true);
          const err = await kick(channel, interaction.user.id, u.id);
          if (err) return interaction.reply(eph(err));
          await ok(`${u} was kicked and can’t rejoin.`);
          break;
        }
        case 'transfer': {
          const u = interaction.options.getUser('user', true);
          const err = await transfer(channel, row, u.id, u.bot);
          if (err) return interaction.reply(eph(err));
          await interaction.reply(`${u} now owns ${channel}.`);
          break;
        }
      }
      await refreshPanel(channel);
    } catch (e) {
      const msg = `Failed: ${e.message}. ${FAIL_HINT}`;
      return interaction.deferred || interaction.replied ? interaction.editReply(msg) : interaction.reply(eph(msg));
    }
  },
};

// Called from voiceStateUpdate
async function handleVoiceState(oldState, newState, settings) {
  const { lobbyChannel, categoryId, defaultLimit } = settings.jtc;
  const guild = newState.guild;

  // Joined the lobby -> make a channel
  if (lobbyChannel && newState.channelId === lobbyChannel && oldState.channelId !== lobbyChannel) {
    const member = newState.member;
    const lobby = newState.channel;
    // one temp channel per person: if they already own one, move them there
    const existing = db
      .prepare('SELECT channel_id FROM temp_vcs WHERE guild_id = ? AND owner_id = ?')
      .all(guild.id, member.id)
      .map((r) => guild.channels.cache.get(r.channel_id))
      .find(Boolean);
    if (existing) return member.voice.setChannel(existing).catch(() => {});
    const key = `${guild.id}:${member.id}`;
    if (creating.has(key)) return;
    creating.add(key);

    try {
      const ch = await guild.channels.create({
        name: truncate(`🔊・${member.displayName}'s channel`, 100),
        type: ChannelType.GuildVoice,
        parent: categoryId || lobby.parentId || undefined,
        userLimit: defaultLimit || 0,
        bitrate: Math.min(lobby.bitrate, guild.maximumBitrate),
        permissionOverwrites: buildOverwrites(
          categoryId ? guild.channels.cache.get(categoryId) : lobby.parent,
          member.id,
          guild,
        ),
        reason: `Join-to-create for ${member.user.tag}`,
      });
      db.prepare('INSERT INTO temp_vcs (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?)').run(
        ch.id,
        guild.id,
        member.id,
        Date.now(),
      );
      const moved = await member.voice.setChannel(ch).then(
        () => true,
        async () => {
          // they left the lobby before we could move them
          await ch.delete().catch(() => {});
          db.prepare('DELETE FROM temp_vcs WHERE channel_id = ?').run(ch.id);
          return false;
        },
      );
      if (moved) await refreshPanel(ch).catch((e) => console.error('[jtc] panel failed:', e.message));
    } catch (e) {
      console.error('[jtc] create failed:', e.message);
    } finally {
      creating.delete(key);
    }
  }

  // Left a temp channel -> delete if empty
  if (oldState.channelId && oldState.channelId !== newState.channelId) {
    await cleanupIfEmpty(guild, oldState.channelId);
  }
}

// Copy the category's permissions (so hidden/private categories stay private), then give
// the owner and the bot control. Keyed by id so we never send duplicate overwrites.
function buildOverwrites(parent, ownerId, guild) {
  const map = new Map();
  for (const o of parent?.permissionOverwrites.cache.values() ?? []) {
    map.set(o.id, { id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield });
  }
  const give = (id, type, bits) => {
    const cur = map.get(id) || { id, type, allow: 0n, deny: 0n };
    const add = bits.reduce((a, b) => a | b, 0n);
    cur.allow |= add;
    cur.deny &= ~add;
    map.set(id, cur);
  };
  const P = PermissionFlagsBits;
  give(ownerId, 1, [P.ViewChannel, P.Connect, P.ManageChannels, P.MoveMembers]);
  give(guild.members.me.id, 1, [P.ViewChannel, P.Connect, P.ManageChannels, P.MoveMembers]);
  return [...map.values()];
}

async function cleanupIfEmpty(guild, channelId) {
  const row = getVc.get(channelId);
  if (!row) return;
  const ch = guild.channels.cache.get(channelId);
  // only bots left (e.g. the music bot) counts as empty
  if (ch && ch.members.some((m) => !m.user.bot)) return;
  db.prepare('DELETE FROM temp_vcs WHERE channel_id = ?').run(channelId);
  if (ch) await ch.delete('Temp voice channel empty').catch(() => {});
}

// Delete temp channels that are empty. Runs on startup (catches ones that emptied while the
// bot was offline) and every minute as a safety net.
// minAgeMs stops us deleting a channel in the second between creating it and moving someone in.
async function sweep(client, minAgeMs = 0) {
  for (const row of db.prepare('SELECT * FROM temp_vcs').all()) {
    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) continue;
    if (Date.now() - row.created_at < minAgeMs) continue;
    await cleanupIfEmpty(guild, row.channel_id);
  }
}

module.exports = {
  commands: [vc],
  prefixComponents: { 'vcp:': onPanel, 'vcpm:': onPanelForm },
  handleVoiceState,
  sweep,
  panelPayload,
  refreshPanel,
};
