// Levelling commands: /rank and /leaderboard for everyone, /levels for admins.
// Messages earn XP through handleMessage(), called from events.js.
const { SlashCommandBuilder, PermissionFlagsBits: P, ChannelType, MessageFlags } = require('discord.js');
const { embed, truncate, log } = require('../lib/util');
const { getSettings, updateSettings } = require('../lib/db');
const levels = require('../lib/levels');
const { blockedReason } = require('./roles');

const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });
const num = (n) => Number(n).toLocaleString('en-GB');
const PAGE = 10;
const MAX_REWARDS = 25;

function bar(into, needed, size = 16) {
  const filled = Math.max(0, Math.min(size, Math.round((into / needed) * size)));
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
}

// Why the bot can't hand out this role as a level reward, or null.
function rewardProblem(role) {
  const why = blockedReason(role);
  if (why) return `${role} can't be a level reward: ${why}.`;
  const me = role.guild.members.me;
  if (me && me.roles.highest.comparePositionTo(role) <= 0)
    return `${role} is above my highest role. Move my role up first.`;
  return null;
}

// Give the member every reward role they've earned (and remove lower ones when rewards don't stack).
// Runs on each XP award, so roles added later and roles removed by mistake are corrected next time they chat.
async function syncRewards(member, level, cfg) {
  // Only rewards the bot can actually give count; otherwise a deleted or unsafe role could make a member
  // lose their other rewards (when not stacking) and get nothing in return.
  const usable = (cfg.rewards || [])
    .map((r) => ({ ...r, role: member.guild.roles.cache.get(r.roleId) }))
    .filter((r) => r.role && !rewardProblem(r.role));
  const want = levels.rewardsFor(usable, level, cfg.stackRewards);
  const wantIds = new Set(want.map((r) => r.roleId));
  const gained = [];
  for (const { role } of want) {
    if (member.roles.cache.has(role.id)) continue;
    await member.roles.add(role, `Level ${level} reward`).then(
      () => gained.push(role),
      (e) => console.error('[levels] could not give reward role:', e.message),
    );
  }
  if (!cfg.stackRewards) {
    for (const { role } of usable) {
      if (wantIds.has(role.id) || !member.roles.cache.has(role.id)) continue;
      await member.roles.remove(role, 'Replaced by a higher level reward').catch(() => {});
    }
  }
  return gained;
}

async function handleMessage(msg, settings) {
  const cfg = settings.levels;
  if (!cfg?.enabled || !msg.member || cfg.ignoredChannels.includes(msg.channelId)) return null;
  if (msg.channel?.isThread?.() && cfg.ignoredChannels.includes(msg.channel.parentId)) return null;
  const result = levels.award(msg.guild.id, msg.author.id);
  if (!result) return null;
  const gained = await syncRewards(msg.member, result.after, cfg);
  if (result.after > result.before && cfg.announce !== 'off') {
    const target = cfg.announce === 'channel' ? msg.guild.channels.cache.get(cfg.announceChannel) : msg.channel;
    const roles = gained.length ? ` You got ${gained.map((r) => `**${r.name}**`).join(', ')}.` : '';
    await target
      ?.send({
        content: `🎉 ${msg.author} reached **level ${result.after}**!${roles}`,
        allowedMentions: { users: [msg.author.id] },
      })
      .catch(() => {});
  }
  return result;
}

const rank = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Show your level and XP, or someone else’s')
    .addUserOption((o) => o.setName('user').setDescription('Whose rank (default: you)')),
  async execute(interaction) {
    if (!getSettings(interaction.guildId).levels.enabled)
      return interaction.reply(eph('Levelling is turned off in this server.'));
    const user = interaction.options.getUser('user') || interaction.user;
    if (user.bot) return interaction.reply(eph('Bots don’t earn XP.'));
    const st = levels.stats(interaction.guildId, user.id);
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const name = member?.displayName || user.username;
    const place = st.rank ? `Rank **#${st.rank}** of ${num(st.ranked)}` : 'Not ranked yet: chat to earn XP';
    await interaction.reply({
      embeds: [
        embed('info')
          .setAuthor({ name: truncate(name, 80), iconURL: (member || user).displayAvatarURL() })
          .setDescription(
            `**Level ${st.level}** · ${place}\n\`${bar(st.into, st.needed)}\` ${num(st.into)} / ${num(st.needed)} XP to level ${st.level + 1}\n` +
              `Total ${num(st.xp)} XP · ${num(st.messages)} messages`,
          ),
      ],
      allowedMentions: { parse: [] },
    });
  },
};

const leaderboard = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('The most active members by XP')
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  async execute(interaction) {
    if (!getSettings(interaction.guildId).levels.enabled)
      return interaction.reply(eph('Levelling is turned off in this server.'));
    const total = levels.ranked(interaction.guildId);
    if (!total) return interaction.reply(eph('Nobody has earned XP yet. Start chatting!'));
    const pages = Math.ceil(total / PAGE);
    const page = Math.min(interaction.options.getInteger('page') || 1, pages);
    const rows = levels.top(interaction.guildId, PAGE, (page - 1) * PAGE);
    const medal = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, i) => {
      const n = (page - 1) * PAGE + i;
      return `${medal[n] || `\`${n + 1}.\``} <@${r.user_id}> · Level ${levels.levelFromXp(r.xp).level} · ${num(r.xp)} XP`;
    });
    const me = levels.stats(interaction.guildId, interaction.user.id);
    await interaction.reply({
      embeds: [
        embed('info')
          .setTitle(`🏆 ${truncate(interaction.guild.name, 60)} leaderboard`)
          .setDescription(lines.join('\n'))
          .setFooter({ text: `Page ${page}/${pages}${me.rank ? ` · You're #${me.rank} (level ${me.level})` : ''}` }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};

const admin = {
  data: new SlashCommandBuilder()
    .setName('levels')
    .setDescription('Set up levelling')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addSubcommand((s) => s.setName('show').setDescription('Current levelling settings'))
    .addSubcommand((s) =>
      s
        .setName('toggle')
        .setDescription('Turn levelling on or off')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('announce')
        .setDescription('Where level-up messages go')
        .addStringOption((o) =>
          o
            .setName('where')
            .setDescription('Where to post')
            .setRequired(true)
            .addChoices(
              { name: 'Where they chatted', value: 'here' },
              { name: 'One channel', value: 'channel' },
              { name: 'Nowhere', value: 'off' },
            ),
        )
        .addChannelOption((o) =>
          o.setName('channel').setDescription('The channel, if "One channel"').addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('reward-add')
        .setDescription('Give a role when members reach a level')
        .addIntegerOption((o) =>
          o.setName('level').setDescription('Level').setMinValue(1).setMaxValue(levels.MAX_LEVEL).setRequired(true),
        )
        .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('reward-remove')
        .setDescription('Stop giving a role at a level (members keep it)')
        .addIntegerOption((o) => o.setName('level').setDescription('Level').setMinValue(1).setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('stack')
        .setDescription('Keep lower reward roles when reaching a higher one?')
        .addBooleanOption((o) =>
          o.setName('keep').setDescription('true = keep all, false = only the highest').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('ignore')
        .setDescription('Turn XP off or back on in a channel')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Channel')
            .setRequired(true)
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildVoice,
              ChannelType.GuildAnnouncement,
              ChannelType.GuildForum,
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set a member’s level (e.g. moving over from another bot)')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('level').setDescription('Level').setMinValue(0).setMaxValue(levels.MAX_LEVEL).setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('reset')
        .setDescription('Reset a member’s XP to zero')
        .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)),
    ),
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const g = interaction.guildId;
    const cfg = getSettings(g).levels;
    const save = (patch) => updateSettings(g, { levels: patch }).levels;
    const done = (text) =>
      interaction.reply({ embeds: [embed('ok').setDescription(text)], flags: MessageFlags.Ephemeral });
    switch (sub) {
      case 'show': {
        const where = {
          here: 'where they chatted',
          channel: cfg.announceChannel ? `<#${cfg.announceChannel}>` : 'a channel that isn’t set',
          off: 'nowhere',
        }[cfg.announce];
        const rewards =
          [...cfg.rewards]
            .sort((a, b) => a.level - b.level)
            .map((r) => `Level ${r.level}: <@&${r.roleId}>`)
            .join('\n') || 'none';
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          embeds: [
            embed('info')
              .setTitle('Levelling')
              .addFields(
                { name: 'Levelling', value: cfg.enabled ? 'on' : 'off', inline: true },
                { name: 'Level-up messages', value: where, inline: true },
                {
                  name: 'Reward roles',
                  value: `${rewards}\n${cfg.stackRewards ? 'Members keep lower rewards.' : 'Members keep only the highest reward.'}`,
                },
                { name: 'No XP in', value: cfg.ignoredChannels.map((id) => `<#${id}>`).join(', ') || 'none' },
                {
                  name: 'How XP works',
                  value: `${levels.XP_MIN}–${levels.XP_MAX} XP per message, at most once a minute.`,
                },
              ),
          ],
        });
      }
      case 'toggle': {
        const on = interaction.options.getBoolean('enabled', true);
        save({ enabled: on });
        return done(
          on
            ? 'Levelling is **on**.'
            : 'Levelling is **off**. Nobody earns XP, and /rank and /leaderboard are hidden. XP is kept.',
        );
      }
      case 'announce': {
        const where = interaction.options.getString('where', true);
        const ch = interaction.options.getChannel('channel');
        if (where === 'channel' && !ch) return interaction.reply(eph('Pick the channel too.'));
        save({ announce: where, ...(where === 'channel' ? { announceChannel: ch.id } : {}) });
        return done(
          {
            here: 'Level-ups are posted where the member chatted.',
            channel: `Level-ups are posted in ${ch}.`,
            off: 'Level-ups aren’t announced.',
          }[where],
        );
      }
      case 'reward-add': {
        const level = interaction.options.getInteger('level', true);
        const role = interaction.options.getRole('role', true);
        const problem = rewardProblem(role);
        if (problem) return interaction.reply(eph(problem));
        const rewards = cfg.rewards.filter((r) => r.level !== level && r.roleId !== role.id);
        if (rewards.length >= MAX_REWARDS)
          return interaction.reply(eph(`There can be at most ${MAX_REWARDS} reward roles.`));
        save({ rewards: [...rewards, { level, roleId: role.id }].sort((a, b) => a.level - b.level) });
        await log(
          interaction.guild,
          embed('info').setDescription(`🏅 ${interaction.user} set ${role} as the level ${level} reward.`),
        );
        return done(
          `Members who reach **level ${level}** get ${role}. Members already past it get it next time they chat.`,
        );
      }
      case 'reward-remove': {
        const level = interaction.options.getInteger('level', true);
        const rewards = cfg.rewards.filter((r) => r.level !== level);
        if (rewards.length === cfg.rewards.length)
          return interaction.reply(eph(`There’s no reward at level ${level}.`));
        save({ rewards });
        return done(`Removed the level ${level} reward. Members who already have the role keep it.`);
      }
      case 'stack': {
        const keep = interaction.options.getBoolean('keep', true);
        save({ stackRewards: keep });
        return done(
          keep
            ? 'Members keep every reward role they’ve earned.'
            : 'Members keep only their highest reward role; lower ones are removed next time they chat.',
        );
      }
      case 'ignore': {
        const ch = interaction.options.getChannel('channel', true);
        const ignored = cfg.ignoredChannels.includes(ch.id);
        save({
          ignoredChannels: ignored ? cfg.ignoredChannels.filter((id) => id !== ch.id) : [...cfg.ignoredChannels, ch.id],
        });
        return done(ignored ? `Messages in ${ch} earn XP again.` : `Messages in ${ch} no longer earn XP.`);
      }
      case 'set': {
        const user = interaction.options.getUser('user', true);
        if (user.bot) return interaction.reply(eph('Bots don’t earn XP.'));
        const level = interaction.options.getInteger('level', true);
        levels.setXp(g, user.id, levels.xpForLevel(level));
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (member) await syncRewards(member, level, cfg);
        await log(
          interaction.guild,
          embed('warn').setDescription(`🏅 ${interaction.user} set ${user}'s level to ${level}.`),
        );
        return done(`${user} is now **level ${level}**.`);
      }
      case 'reset': {
        const user = interaction.options.getUser('user', true);
        const changed = levels.reset(g, user.id);
        if (changed)
          await log(interaction.guild, embed('warn').setDescription(`🏅 ${interaction.user} reset ${user}'s XP.`));
        return done(
          changed ? `Reset ${user}'s XP. They keep any reward roles they already have.` : `${user} had no XP.`,
        );
      }
    }
  },
};

module.exports = { commands: [rank, leaderboard, admin], handleMessage, syncRewards, rewardProblem, bar };
