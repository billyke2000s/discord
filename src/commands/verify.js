// Captcha verification. Setup model:
//   - @everyone can ONLY see the verify channel.
//   - The "member role" unlocks the rest of the server.
//   - New joiners click Verify -> get an image captcha -> type the code in a modal -> get the role.
// This way if the bot is offline, new people stay locked out instead of getting in unchecked.
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, MessageFlags,
} = require('discord.js');
const captcha = require('../lib/captcha');
const { db, getSettings } = require('../lib/db');
const { embed, log } = require('../lib/util');
const antiRaid = require('../lib/antiraid');

function panel() {
  return {
    embeds: [embed('info')
      .setTitle('Verification')
      .setDescription('Click **Verify** and type the code from the image to get access to the server.')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify:start').setLabel('Verify').setStyle(ButtonStyle.Success).setEmoji('✅'),
    )],
  };
}

async function start(interaction) {
  const s = getSettings(interaction.guildId);
  if (!s.verify.enabled || !s.verify.memberRole)
    return interaction.reply({ content: 'Verification is not set up yet. Ask a moderator.', flags: MessageFlags.Ephemeral });
  if (interaction.member.roles.cache.has(s.verify.memberRole))
    return interaction.reply({ content: 'You are already verified.', flags: MessageFlags.Ephemeral });
  if (antiRaid.isLocked(interaction.guildId))
    return interaction.reply({ content: 'The server is in lockdown right now. Try again in a few minutes.', flags: MessageFlags.Ephemeral });

  const png = captcha.newChallenge(interaction.guildId, interaction.user.id);
  // "New image" is clicked on our own ephemeral message: edit it in place instead of stacking new ones
  const isRefresh = interaction.message?.flags?.has(MessageFlags.Ephemeral);
  await interaction[isRefresh ? 'update' : 'reply']({
    ...(isRefresh ? { attachments: [] } : { flags: MessageFlags.Ephemeral }),
    embeds: [embed('info').setDescription('Type the characters in the image. Not case sensitive. You have 5 minutes and 3 tries.').setImage('attachment://captcha.png')],
    files: [new AttachmentBuilder(png, { name: 'captcha.png' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify:enter').setLabel('Enter code').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('verify:start').setLabel('New image').setStyle(ButtonStyle.Secondary),
    )],
  });
}

async function enter(interaction) {
  const modal = new ModalBuilder().setCustomId('verify:modal').setTitle('Verification').addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('code').setLabel('Code from the image').setStyle(TextInputStyle.Short)
        .setMinLength(4).setMaxLength(8).setRequired(true),
    ),
  );
  await interaction.showModal(modal);
}

async function submit(interaction) {
  const s = getSettings(interaction.guildId);
  const result = captcha.check(interaction.guildId, interaction.user.id, interaction.fields.getTextInputValue('code'));

  if (result === 'wrong') return interaction.reply({ content: '❌ Wrong code, try again.', flags: MessageFlags.Ephemeral });
  if (result === 'expired') return interaction.reply({ content: 'That code expired. Click **New image**.', flags: MessageFlags.Ephemeral });
  if (result === 'locked') {
    await interaction.reply({ content: 'Too many wrong tries. Click **New image** to start again.', flags: MessageFlags.Ephemeral });
    return log(interaction.guild, embed('warn').setDescription(`⚠️ ${interaction.user} failed the captcha ${captcha.MAX_ATTEMPTS} times.`));
  }

  // passed
  try {
    await interaction.member.roles.add(s.verify.memberRole, 'Passed captcha');
  } catch (e) {
    return interaction.reply({ content: 'You passed, but I could not give you the role. A moderator needs to move my role above the member role.', flags: MessageFlags.Ephemeral });
  }
  db.prepare('DELETE FROM pending_verify WHERE guild_id = ? AND user_id = ?').run(interaction.guildId, interaction.user.id);
  await interaction.reply({ content: '✅ Verified. Welcome in!', flags: MessageFlags.Ephemeral });
  await log(interaction.guild, embed('ok').setDescription(`✅ ${interaction.user} passed verification.`));
  await sendWelcome(interaction.member, s);
}

async function sendWelcome(member, s) {
  if (!s.welcomeChannel) return;
  const ch = member.guild.channels.cache.get(s.welcomeChannel);
  if (!ch?.isTextBased()) return;
  const text = s.welcomeMessage
    .replaceAll('{user}', `${member}`)
    .replaceAll('{username}', member.user.username)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{count}', String(member.guild.memberCount));
  await ch.send({
    embeds: [embed('ok').setDescription(text).setThumbnail(member.user.displayAvatarURL({ size: 128 }))],
  }).catch(() => {});
}

// Kick people who never verified. Runs every minute from index.js.
async function sweepUnverified(client) {
  const rows = db.prepare('SELECT * FROM pending_verify').all();
  for (const row of rows) {
    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) { db.prepare('DELETE FROM pending_verify WHERE guild_id = ?').run(row.guild_id); continue; }
    const s = getSettings(guild.id);
    if (!s.verify.enabled || !s.verify.timeoutMinutes) continue;
    if (Date.now() - row.joined_at < s.verify.timeoutMinutes * 60_000) continue;

    db.prepare('DELETE FROM pending_verify WHERE guild_id = ? AND user_id = ?').run(row.guild_id, row.user_id);
    const member = await guild.members.fetch(row.user_id).catch(() => null);
    if (!member || member.roles.cache.has(s.verify.memberRole)) continue;
    await member.send(`You were removed from **${guild.name}** because you didn't verify within ${s.verify.timeoutMinutes} minutes. You can rejoin and try again.`).catch(() => {});
    await member.kick('Did not verify in time').catch(() => {});
    await log(guild, embed('grey').setDescription(`👢 ${member.user.tag} kicked: did not verify in ${s.verify.timeoutMinutes} min.`));
  }
}

module.exports = {
  commands: [],
  components: { 'verify:start': start, 'verify:enter': enter, 'verify:modal': submit },
  panel, sendWelcome, sweepUnverified,
};
