const {SlashCommandBuilder,PermissionFlagsBits:P,ChannelType,MessageFlags}=require('discord.js');
const {getSettings,updateSettings}=require('../lib/db');
const command={data:new SlashCommandBuilder().setName('birthday-channel').setDescription('Set birthday announcement channel (admins)').setDefaultMemberPermissions(P.ManageGuild)
.addChannelOption(o=>o.setName('channel').setDescription('Announcement channel; omit to disable').addChannelTypes(ChannelType.GuildText)),
async execute(i){if(!i.memberPermissions.has(P.ManageGuild))return i.reply({content:'Manage Server permission required.',flags:MessageFlags.Ephemeral});
const channel=i.options.getChannel('channel');updateSettings(i.guildId,{birthdayChannel:channel?.id||null});
return i.reply({content:channel?`Birthday announcements will go to ${channel} (UTC dates).`:'Birthday announcements disabled.',flags:MessageFlags.Ephemeral});}};
module.exports={commands:[command]};