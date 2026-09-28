// Gateway event handlers: joins (verification + lockdown), logging, voice.
const { Events } = require('discord.js');
const { db, getSettings } = require('./lib/db');
const { embed, log, truncate } = require('./lib/util');
const antiRaid = require('./lib/antiraid');
const voice = require('./commands/voice');
const verify = require('./commands/verify');
const scamfilter = require('./lib/scamfilter');

module.exports = function registerEvents(client) {
  // ---- member join: lockdown, account age flag, verification queue, welcome ----
  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.user.bot) return;
    const s = getSettings(member.guild.id);
    const g = member.guild;

    // Manual lockdown (/lockdown on)
    if (antiRaid.isLocked(g.id)) {
      await member.send(`**${g.name}** is temporarily locked to new members. Please try again later.`).catch(() => {});
      await member.kick('Server lockdown').catch(() => {});
      return log(g, embed('grey').setDescription(`🔒 Kicked ${member.user.tag} (lockdown).`));
    }

    // Log + account age
    const ageDays = (Date.now() - member.user.createdTimestamp) / 86400000;
    const young = s.verify.minAccountAgeDays && ageDays < s.verify.minAccountAgeDays;
    await log(g, embed(young ? 'warn' : 'ok')
      .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
      .setDescription(`📥 ${member} joined. Account created <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>.${young ? `\n⚠️ **New account** (under ${s.verify.minAccountAgeDays} days).` : ''}`)
      .setFooter({ text: `ID ${member.id} · member #${g.memberCount}` }));

    if (s.verify.enabled && s.verify.memberRole) {
      db.prepare('INSERT OR REPLACE INTO pending_verify (guild_id, user_id, joined_at) VALUES (?, ?, ?)').run(g.id, member.id, Date.now());
    } else {
      await verify.sendWelcome(member, s);
    }
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    db.prepare('DELETE FROM pending_verify WHERE guild_id = ? AND user_id = ?').run(member.guild.id, member.id);
    const roles = member.roles?.cache.filter((r) => r.id !== member.guild.id).map((r) => r.toString()).join(' ') || 'none';
    await log(member.guild, embed('grey')
      .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
      .setDescription(`📤 ${member.user} left.\n**Roles:** ${truncate(roles, 900)}`)
      .setFooter({ text: `ID ${member.id}` }));
  });

  // ---- channel rules: self-promo age limit, suggestions auto-vote ----
  client.on(Events.MessageCreate, async (msg) => {
    if (!msg.guild || msg.author.bot || msg.system) return;

    // Scam filter runs first on everything
    if (await scamfilter.check(msg).catch((e) => { console.error('[scamfilter]', e); return false; })) return;

    const s = getSettings(msg.guild.id);

    if (s.selfPromo.channel === msg.channelId && s.selfPromo.minDays) {
      const m = msg.member;
      const days = m?.joinedTimestamp ? (Date.now() - m.joinedTimestamp) / 86400000 : 0;
      if (m && !m.permissions.has('ManageMessages') && days < s.selfPromo.minDays) {
        await msg.delete().catch(() => {});
        await msg.author.send(`Your post in **${msg.guild.name}** #${msg.channel.name} was removed: you need to have been in the server ${s.selfPromo.minDays} days to self-promo. You can post <t:${Math.floor((m.joinedTimestamp + s.selfPromo.minDays * 86400000) / 1000)}:R>.`).catch(() => {});
        return;
      }
    }

    if (s.suggestions.channel === msg.channelId) {
      await msg.react('👍').catch(() => {});
      await msg.react('👎').catch(() => {});
      await msg.startThread({ name: truncate(`Discuss: ${msg.content || 'suggestion'}`, 90), autoArchiveDuration: 10080 }).catch(() => {});
    }
  });

  // ---- message logs ----
  client.on(Events.MessageDelete, async (msg) => {
    if (!msg.guild || msg.author?.bot) return;
    if (msg.partial && !msg.content) {
      return log(msg.guild, embed('bad').setDescription(`🗑️ A message was deleted in ${msg.channel} (not cached, content unknown).`));
    }
    const files = msg.attachments?.size ? `\n**Attachments:** ${[...msg.attachments.values()].map((a) => a.name).join(', ')}` : '';
    await log(msg.guild, embed('bad')
      .setAuthor({ name: msg.author.tag, iconURL: msg.author.displayAvatarURL() })
      .setDescription(`🗑️ **Message deleted in ${msg.channel}**\n${truncate(msg.content || '*(no text)*', 3500)}${files}`)
      .setFooter({ text: `User ${msg.author.id}` }));
  });

  client.on(Events.MessageBulkDelete, async (msgs, channel) => {
    await log(channel.guild, embed('bad').setDescription(`🗑️ ${msgs.size} messages bulk-deleted in ${channel}.`));
  });

  client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
    if (newMsg.partial) newMsg = await newMsg.fetch().catch(() => null);
    if (!newMsg?.guild || !newMsg.author || newMsg.author.bot) return;
    if (oldMsg.content === newMsg.content) return; // embed-only updates
    await log(newMsg.guild, embed('warn')
      .setAuthor({ name: newMsg.author.tag, iconURL: newMsg.author.displayAvatarURL() })
      .setDescription(`✏️ **Message edited in ${newMsg.channel}** [jump](${newMsg.url})\n**Before:** ${truncate(oldMsg.partial ? '*(not cached)*' : oldMsg.content || '*(empty)*', 1700)}\n**After:** ${truncate(newMsg.content || '*(empty)*', 1700)}`)
      .setFooter({ text: `User ${newMsg.author.id}` }));
  });

  // ---- voice: join-to-create + music auto-leave + log ----
  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const s = getSettings(newState.guild.id);
    await voice.handleVoiceState(oldState, newState, s).catch((e) => console.error('[voice]', e));
    client.music.checkAlone(newState.guild);

    // bot was disconnected/moved by someone: keep music state in sync
    if (newState.id === client.user.id) {
      const q = client.music.get(newState.guild.id);
      if (q && !newState.channelId) q.destroy();
      else if (q && newState.channelId) q.voiceChannelId = newState.channelId;
    }
  });

  // Edited messages can have scam links added after the fact
  client.on(Events.MessageUpdate, async (_old, msg) => {
    if (msg.partial) msg = await msg.fetch().catch(() => null);
    if (msg?.guild && !msg.author?.bot) await scamfilter.check(msg).catch(() => {});
  });

  // temp VC or ticket channel deleted by hand: clean the DB
  client.on(Events.ChannelDelete, (ch) => {
    db.prepare('DELETE FROM temp_vcs WHERE channel_id = ?').run(ch.id);
    db.prepare('DELETE FROM tickets WHERE channel_id = ?').run(ch.id);
  });
};
