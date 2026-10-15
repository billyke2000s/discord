// /live: admins set where live and new-video alerts go and which accounts to follow (Manage Server only).
const { SlashCommandBuilder, PermissionFlagsBits: P, ChannelType, MessageFlags } = require('discord.js');
const { embed, log } = require('../lib/util');
const { getSettings, updateSettings } = require('../lib/db');
const live = require('../lib/live');

const platformChoices = Object.entries(live.PLATFORMS).map(([value, name]) => ({ name, value }));
const LIVE_CHANNEL_NAME = '📺・live';
const accountLink = (r) =>
  r.platform === 'youtube'
    ? `https://www.youtube.com/channel/${r.ext_id}`
    : r.platform === 'kick'
      ? `https://kick.com/${r.account}`
      : `https://www.twitch.tv/${r.account}`;

// Make the live channel in the INFO category: everyone can read, only the bot posts.
async function createLiveChannel(guild) {
  const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === LIVE_CHANNEL_NAME);
  if (existing) return existing;
  const info = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && /info/i.test(c.name));
  // Start from the category's permissions (so hidden-to-unverified stays hidden), then make it read-only.
  const map = new Map();
  for (const o of info?.permissionOverwrites.cache.values() ?? [])
    map.set(o.id, { id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield });
  const change = (id, type, allow, deny) => {
    const cur = map.get(id) || { id, type, allow: 0n, deny: 0n };
    cur.allow = (cur.allow | allow) & ~deny;
    cur.deny = (cur.deny | deny) & ~allow;
    map.set(id, cur);
  };
  change(guild.roles.everyone.id, 0, 0n, P.SendMessages | P.CreatePublicThreads | P.CreatePrivateThreads);
  change(guild.members.me.id, 1, P.ViewChannel | P.SendMessages | P.EmbedLinks | P.MentionEveryone, 0n);
  return guild.channels.create({
    name: LIVE_CHANNEL_NAME,
    type: ChannelType.GuildText,
    parent: info?.id,
    topic: 'Live streams and new videos.',
    permissionOverwrites: [...map.values()],
    reason: 'Live alerts channel (/live setup)',
  });
}

const command = {
  data: new SlashCommandBuilder()
    .setName('live')
    .setDescription('Live stream and new video alerts')
    .setDefaultMemberPermissions(P.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('setup')
        .setDescription('Choose (or create) the alerts channel and who gets pinged')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Leave empty to create 📺・live in the info category')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addRoleOption((o) => o.setName('ping').setDescription('Role to ping with each alert'))
        .addBooleanOption((o) => o.setName('no_ping').setDescription('Stop pinging a role')),
    )
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Follow an account')
        .addStringOption((o) =>
          o
            .setName('platform')
            .setDescription('Where')
            .setRequired(true)
            .addChoices(...platformChoices),
        )
        .addStringOption((o) =>
          o.setName('account').setDescription('Username, @handle or link').setRequired(true).setMaxLength(200),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Stop following an account')
        .addStringOption((o) =>
          o
            .setName('platform')
            .setDescription('Where')
            .setRequired(true)
            .addChoices(...platformChoices),
        )
        .addStringOption((o) =>
          o.setName('account').setDescription('Username, @handle or link').setRequired(true).setMaxLength(200),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Followed accounts and where alerts go'))
    .addSubcommand((s) => s.setName('check').setDescription('Check every account now and post anything new')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const g = interaction.guild;
    const cfg = getSettings(g.id).live;
    const done = (text) => interaction.editReply({ embeds: [embed('ok').setDescription(text)] });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    switch (sub) {
      case 'setup': {
        let channel = interaction.options.getChannel('channel');
        if (!channel) {
          channel = await createLiveChannel(g).catch((e) => {
            interaction.editReply(
              `I couldn't create the channel: ${e.message}. Give my role Manage Channels, or pick an existing channel.`,
            );
            return null;
          });
          if (!channel) return;
        }
        const perms = channel.permissionsFor(g.members.me);
        if (!perms?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]))
          return interaction.editReply(
            `I can't post in ${channel}. Let my role view it, send messages and embed links.`,
          );
        const role = interaction.options.getRole('ping');
        const noPing = interaction.options.getBoolean('no_ping');
        const pingRole = noPing ? null : role ? role.id : cfg.pingRole;
        updateSettings(g.id, { live: { channel: channel.id, pingRole } });
        await log(
          g,
          embed('info').setDescription(
            `📺 ${interaction.user} set live alerts to ${channel}${pingRole ? ` pinging <@&${pingRole}>` : ''}.`,
          ),
        );
        const next = live.count(g.id) ? '' : '\nNow add your accounts with `/live add`.';
        return done(`Live and new-video alerts go to ${channel}${pingRole ? `, pinging <@&${pingRole}>` : ''}.${next}`);
      }
      case 'add': {
        if (live.count(g.id) >= live.MAX_ACCOUNTS)
          return interaction.editReply(`You can follow up to ${live.MAX_ACCOUNTS} accounts.`);
        const platform = interaction.options.getString('platform', true);
        let added;
        try {
          added = await live.add(g.id, platform, interaction.options.getString('account', true));
        } catch (e) {
          return interaction.editReply(e.message.endsWith('.') ? e.message : `Couldn't add that: ${e.message}.`);
        }
        await log(
          g,
          embed('info').setDescription(`📺 ${interaction.user} added ${live.PLATFORMS[platform]}: ${added.label}.`),
        );
        const where = cfg.channel ? `Alerts go to <#${cfg.channel}>.` : 'Set where alerts go with `/live setup`.';
        const what = platform === 'youtube' ? 'when they go live and when they post a new video' : 'when they go live';
        return done(
          `Following **${added.label}** on ${live.PLATFORMS[platform]}. I'll post ${what} (checked every 2 minutes). ${where}`,
        );
      }
      case 'remove': {
        const platform = interaction.options.getString('platform', true);
        let account;
        try {
          account = live.parseAccount(platform, interaction.options.getString('account', true)).account;
        } catch (e) {
          return interaction.editReply(e.message);
        }
        const match = live
          .list(g.id)
          .find((r) => r.platform === platform && (r.account === account || r.ext_id === account));
        if (!match || !live.remove(g.id, platform, match.account))
          return interaction.editReply('I’m not following that account.');
        await log(
          g,
          embed('info').setDescription(`📺 ${interaction.user} removed ${live.PLATFORMS[platform]}: ${match.label}.`),
        );
        return done(`Stopped following **${match.label}** on ${live.PLATFORMS[platform]}.`);
      }
      case 'list': {
        const rows = live.list(g.id);
        const lines = rows.map(
          (r) => `${r.is_live ? '🔴' : '⚫'} **${live.PLATFORMS[r.platform]}** · [${r.label}](${accountLink(r)})`,
        );
        return interaction.editReply({
          embeds: [
            embed('info')
              .setTitle('Live alerts')
              .setDescription(
                `${cfg.channel ? `Posting in <#${cfg.channel}>` : '⚠️ No alerts channel yet: run `/live setup`'}${cfg.pingRole ? `, pinging <@&${cfg.pingRole}>` : ''}.\n\n` +
                  (lines.join('\n') || 'Not following anyone yet. Use `/live add`.'),
              )
              .setFooter({
                text: `Checked every 2 minutes · ${process.env.TWITCH_CLIENT_ID ? 'Twitch via its API' : 'Twitch via its public page'}`,
              }),
          ],
        });
      }
      case 'check': {
        const channel = cfg.channel && g.channels.cache.get(cfg.channel);
        if (!channel) return interaction.editReply('Set the alerts channel first with `/live setup`.');
        const rows = live.list(g.id);
        if (!rows.length) return interaction.editReply('Not following anyone yet. Use `/live add`.');
        const lines = [];
        for (const row of rows) {
          const { status, events } = await live.checkAccount(row, channel, cfg);
          const error = events.find((e) => e.type === 'error');
          const state = status
            ? status.live
              ? '🔴 live'
              : '⚫ offline'
            : `❔ couldn't check (${error?.message || 'unknown error'})`;
          const posted = events.filter((e) => e.type === 'live' || e.type === 'video').length;
          lines.push(
            `**${live.PLATFORMS[row.platform]}** · ${row.label}: ${state}${posted ? ` · posted ${posted}` : ''}`,
          );
        }
        return interaction.editReply({
          embeds: [embed('info').setTitle('Live check').setDescription(lines.join('\n'))],
        });
      }
    }
  },
};

module.exports = { commands: [command], createLiveChannel };
