const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { db, getSettings, updateSettings } = require('../lib/db');
db.exec(`CREATE TABLE IF NOT EXISTS birthdays (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12), day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 31), last_sent_year INTEGER, PRIMARY KEY(guild_id,user_id))`);
db.exec(`CREATE TABLE IF NOT EXISTS birthday_grants (
 guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL,
 expires_at INTEGER NOT NULL, PRIMARY KEY(guild_id,user_id)
);
CREATE TABLE IF NOT EXISTS birthday_announcements (
 guild_id TEXT NOT NULL, user_id TEXT NOT NULL, year INTEGER NOT NULL,
 PRIMARY KEY(guild_id,user_id,year)
)`);
const valid = (m,d) => Number.isInteger(m) && Number.isInteger(d) && m>=1 && m<=12 && d>=1 && d<=new Date(Date.UTC(2024,m,0)).getUTCDate();
const command = { data: new SlashCommandBuilder().setName('birthday').setDescription('Opt in to birthday announcements')
 .addSubcommand(s=>s.setName('set').setDescription('Set your birthday (no birth year stored)').addIntegerOption(o=>o.setName('month').setDescription('1-12').setRequired(true).setMinValue(1).setMaxValue(12)).addIntegerOption(o=>o.setName('day').setDescription('Day of month').setRequired(true).setMinValue(1).setMaxValue(31)))
 .addSubcommand(s=>s.setName('show').setDescription('Show your saved birthday')),
 async execute(i) { const sub=i.options.getSubcommand(), g=i.guildId, u=i.user.id;
  if(sub==='set'){const m=i.options.getInteger('month',true),d=i.options.getInteger('day',true);if(!valid(m,d))return i.reply({content:'That date is invalid.',flags:MessageFlags.Ephemeral});
    db.prepare('INSERT INTO birthdays (guild_id,user_id,month,day,last_sent_year) VALUES (?,?,?,?,NULL) ON CONFLICT(guild_id,user_id) DO UPDATE SET month=excluded.month,day=excluded.day').run(g,u,m,d);
    return i.reply({content:`Birthday saved: ${d}/${m}. Birthdays use UTC. On the day you get an announcement and the 👑 Birthday role for 24 hours. Your birth year is not stored.`,flags:MessageFlags.Ephemeral});}
  const row=db.prepare('SELECT month,day FROM birthdays WHERE guild_id=? AND user_id=?').get(g,u);
  return i.reply({content:row?`Your birthday: ${row.day}/${row.month}.`:'No birthday saved.',flags:MessageFlags.Ephemeral});
 }};
let sweeping = false;
async function sweep(client,now=new Date()){
 if(sweeping)return;
 sweeping=true;
 try { await runSweep(client,now); } finally { sweeping=false; }
}
async function runSweep(client,now){const month=now.getUTCMonth()+1,day=now.getUTCDate(),year=now.getUTCFullYear();
 // Expiry is independent of the birthday record: editing/removing a date cannot strand a role.
 for(const grant of db.prepare('SELECT * FROM birthday_grants WHERE expires_at<=?').all(now.getTime())){
  const guild=client.guilds.cache.get(grant.guild_id);if(!guild)continue;
  try {
   const member=await guild.members.fetch(grant.user_id).catch(e=>{if(e.code===10007)return null;throw e;});
   const role=await guild.roles.fetch(grant.role_id);
   if(member && role)await member.roles.remove(role,'Birthday role expired after 24 hours');
   db.prepare('DELETE FROM birthday_grants WHERE guild_id=? AND user_id=?').run(grant.guild_id,grant.user_id);
  }catch(e){console.error('[birthday] Role expiry failed:',e.message);}
 }
 for(const row of db.prepare('SELECT * FROM birthdays WHERE month=? AND day=? AND (last_sent_year IS NULL OR last_sent_year != ?)').all(month,day,year)){
  const guild=client.guilds.cache.get(row.guild_id);if(!guild)continue;
  if(process.env.GUILD_ID && guild.id!==process.env.GUILD_ID)continue;
  const settings=getSettings(guild.id);
  // Older rebuilds created this channel without saving its ID. Only accept an exact, unique match.
  let id=settings.birthdayChannel;
  if(!id){const matches=[...guild.channels.cache.values()].filter(c=>c.name==='🎂・birthdays' && c.isTextBased());
   if(matches.length===1){id=matches[0].id;updateSettings(guild.id,{birthdayChannel:id});}}
  if(!id)continue;
  const channel=guild.channels.cache.get(id);if(!channel?.isTextBased())continue;
  try{
   const member=await guild.members.fetch(row.user_id).catch(e=>{if(e.code===10007)return null;throw e;});
   if(!member)continue;
   let role=settings.birthdayRole?await guild.roles.fetch(settings.birthdayRole):null;
   if(role && (role.managed || role.permissions.bitfield!==0n))throw Error('Birthday role must have no permissions and must not be managed.');
   if(!role){role=await guild.roles.create({name:'👑 Birthday',permissions:[],hoist:true,mentionable:false,reason:'Birthday celebration'});updateSettings(guild.id,{birthdayRole:role.id});}
   let grant=db.prepare('SELECT * FROM birthday_grants WHERE guild_id=? AND user_id=?').get(guild.id,row.user_id);
   if(!grant){db.prepare('INSERT INTO birthday_grants VALUES (?,?,?,?)').run(guild.id,row.user_id,role.id,now.getTime()+86400000);}
   await member.roles.add(role,'Birthday celebration for 24 hours');
   // Persist the attempt first: a crash after sending cannot repeatedly ping members.
   const claimed=db.prepare('INSERT OR IGNORE INTO birthday_announcements VALUES (?,?,?)').run(guild.id,row.user_id,year).changes;
   if(claimed)await channel.send({content:`🎂 Happy birthday, <@${row.user_id}>! 🎉 Enjoy your 👑 Birthday role for 24 hours!`,allowedMentions:{users:[row.user_id]}});
   db.prepare('UPDATE birthdays SET last_sent_year=? WHERE guild_id=? AND user_id=?').run(year,row.guild_id,row.user_id);
  }
  catch(e){console.error('[birthday] Celebration failed:',e.message);}
 }}
module.exports={commands:[command],sweep,valid};

