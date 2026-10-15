const {SlashCommandBuilder,MessageFlags,PermissionFlagsBits}=require('discord.js');
const bridge=require('../lib/update-bridge');
let checking=false,lastCheck=0;
const command={data:new SlashCommandBuilder().setName('update').setDescription('Server owner: check the bot version and install the latest release')
 .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
 .addBooleanOption(o=>o.setName('check-only').setDescription('Show installed/latest versions without updating')),
 async execute(i){
  await i.deferReply({flags:MessageFlags.Ephemeral});
  const guild=await i.guild.fetch();
  if(i.user.id!==guild.ownerId)return i.editReply('Only the actual Discord server owner can use /update. Admin roles and bot-admin IDs do not grant access.');
  if(checking||Date.now()-lastCheck<15000)return i.editReply('Wait 15 seconds before checking again.');
  checking=true;lastCheck=Date.now();
  try{
   const latest=await bridge.latestRelease();
   const current=process.env.BOT_BUILD_VERSION||'unknown (older/development image)';
   let message=`Installed: **${current}**\nLatest published release: **${latest.version}**`;
   const result=await bridge.status();
   if(result?.guildId===guild.id && result.ownerId===i.user.id)message+=`\nLast request: ${bridge.resultText(result)}`;
   if(latest.commit===process.env.BOT_BUILD_COMMIT)return i.editReply(`${message}\nYou are already on this release.`);
   if(i.options.getBoolean('check-only'))return i.editReply(`${message}\nRun /update to install it.`);
   if(i.client.music.queues.size)return i.editReply(`${message}\nEnd the music session with /stop, then run /update again.`);
   await bridge.request(guild.id,i.user.id);
   return i.editReply(`${message}\nUpdate requested. The VPS checks within about 15 seconds, backs up, and briefly restarts the bot if the update is eligible. I’ll DM the result; if DMs are blocked, use /update check-only:true afterwards. This updates the bot image, not Lavalink or host configuration.`);
  }catch(e){return i.editReply(`Update not confirmed: ${e.message}`);}
  finally{checking=false;}
 }};
module.exports={commands:[command]};

