// Button roles: /buttonroles posts a message with up to 10 role buttons. Clicking toggles the role.
const { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags } = require('discord.js');
const { embed, truncate, isOwner } = require('../lib/util');
const { getSettings } = require('../lib/db');

const MAX = 10;
const P = PermissionFlagsBits;
// A role with any of these can never be handed out by a button.
const POWERS = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers,
  P.ModerateMembers, P.ManageMessages, P.MentionEveryone, P.ManageWebhooks, P.ManageNicknames, P.MoveMembers, P.MuteMembers, P.DeafenMembers];

// Why a role must not be on a public button, or null if it's fine. Checked when the button is made AND on every click,
// so a role that gains powers later (or becomes the Member/Staff role) stops being given out.
function blockedReason(role) {
  const s = getSettings(role.guild.id);
  if (role.managed || role.id === role.guild.id) return 'it is a bot/integration role or @everyone';
  if (role.id === s.verify?.memberRole) return 'it is the verification Member role (that would skip the captcha)';
  if (role.id === s.tickets?.staffRole) return 'it is the Staff role';
  if (POWERS.some((p) => role.permissions.has(p))) return 'it has moderator/admin permissions';
  return null;
}

const buttonroles = {
  data: (() => {
    const b = new SlashCommandBuilder().setName('buttonroles').setDescription('Post a message where people pick their own roles')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addStringOption((o) => o.setName('title').setDescription('Title').setMaxLength(100).setRequired(true))
      .addRoleOption((o) => o.setName('role1').setDescription('Role').setRequired(true));
    for (let i = 2; i <= MAX; i++) b.addRoleOption((o) => o.setName(`role${i}`).setDescription('Role'));
    b.addStringOption((o) => o.setName('description').setDescription('Text under the title').setMaxLength(1000));
    return b;
  })(),

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel', true);
    const me = interaction.guild.members.me;
    const roles = [];
    for (let i = 1; i <= MAX; i++) {
      const r = interaction.options.getRole(`role${i}`);
      if (!r) continue;
      const why = blockedReason(r);
      if (why) return interaction.reply({ content: `${r} can't go on a button: ${why}.`, flags: MessageFlags.Ephemeral });
      if (me.roles.highest.comparePositionTo(r) <= 0) return interaction.reply({ content: `${r} is above my highest role. Move my role up first.`, flags: MessageFlags.Ephemeral });
      if (!isOwner(interaction.user, interaction.guild) && interaction.member.roles.highest.comparePositionTo(r) <= 0)
        return interaction.reply({ content: `${r} is at or above your highest role.`, flags: MessageFlags.Ephemeral });
      if (!roles.find((x) => x.id === r.id)) roles.push(r);
    }

    const rows = [];
    for (let i = 0; i < roles.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(roles.slice(i, i + 5).map((r) =>
        new ButtonBuilder().setCustomId(`role:${r.id}`).setLabel(truncate(r.name, 80)).setStyle(ButtonStyle.Secondary))));
    }
    const desc = interaction.options.getString('description') || 'Click a button to get the role. Click again to remove it.';
    await channel.send({ embeds: [embed('info').setTitle(interaction.options.getString('title', true)).setDescription(desc)], components: rows });
    await interaction.reply({ content: `Posted in ${channel}.`, flags: MessageFlags.Ephemeral });
  },
};

async function toggle(interaction, roleId) {
  const role = interaction.guild.roles.cache.get(roleId);
  if (!role) return interaction.reply({ content: 'That role no longer exists.', flags: MessageFlags.Ephemeral });
  const why = blockedReason(role);
  if (why) return interaction.reply({ content: `This button is disabled: ${role} can't be self-assigned because ${why}. Ask an admin to remake the role buttons.`, flags: MessageFlags.Ephemeral });
  const has = interaction.member.roles.cache.has(roleId);
  try {
    if (has) await interaction.member.roles.remove(roleId, 'Button role');
    else await interaction.member.roles.add(roleId, 'Button role');
  } catch {
    return interaction.reply({ content: 'I couldn’t change that role. A mod needs to move my role above it.', flags: MessageFlags.Ephemeral });
  }
  await interaction.reply({ content: has ? `Removed ${role}.` : `Added ${role}.`, flags: MessageFlags.Ephemeral });
}

module.exports = { commands: [buttonroles], prefixComponents: { 'role:': toggle } };
