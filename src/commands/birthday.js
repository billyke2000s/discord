const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { db, getSettings } = require('../lib/db');
db.exec(`CREATE TABLE IF NOT EXISTS birthdays (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12), day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 31), last_sent_year INTEGER, PRIMARY KEY(guild_id,user_id))`);
const valid = (m,d) => Number.isInteger(m) && Number.isInteger(d) && m>=1 && m<=12 && d>=1 && d<=new Date(Date.UTC(2024,m,0)).getUTCDate();
const command = { data: new SlashCommandBuilder().setName('birthday').setDescription('Opt in to birthday announcements')
 .addSubcommand(s=>s.setName('set').setDescription('Set your birthday (no birth year stored)').addIntegerOption(o=>o.setName('month').setDescription('1-12').setRequired(true).setMinValue(1).setMaxValue(12)).addIntegerOption(o=>o.setName('day').setDescription('Day of month').setRequired(true).setMinValue(1).setMaxValue(31)))
 .addSubcommand(s=>s.setName('remove').setDescription('Remove your birthday'))
 .addSubcommand(s=>s.setName('show').setDescription('Show your saved birthday')),
 async execute(i) { const sub=i.options.getSubcommand(), g=i.guildId, u=i.user.id;
  if(sub==='set'){const m=i.options.getInteger('month',true),d=i.options.getInteger('day',true);if(!valid(m,d))return i.reply({content:'That date is invalid.',flags:MessageFlags.Ephemeral});
    db.prepare('INSERT INTO birthdays (guild_id,user_id,month,day,last_sent_year) VALUES (?,?,?,?,NULL) ON CONFLICT(guild_id,user_id) DO UPDATE SET month=excluded.month,day=excluded.day,last_sent_year=NULL').run(g,u,m,d);
    return i.reply({content:`Birthday saved: ${d}/${m}. Your birth year is not stored.`,flags:MessageFlags.Ephemeral});}
  if(sub==='remove'){db.prepare('DELETE FROM birthdays WHERE guild_id=? AND user_id=?').run(g,u);return i.reply({content:'Birthday removed.',flags:MessageFlags.Ephemeral});}
  const row=db.prepare('SELECT month,day FROM birthdays WHERE guild_id=? AND user_id=?').get(g,u);
  return i.reply({content:row?`Your birthday: ${row.day}/${row.month}.`:'No birthday saved.',flags:MessageFlags.Ephemeral});
 }};
async function sweep(client,now=new Date()){const month=now.getUTCMonth()+1,day=now.getUTCDate(),year=now.getUTCFullYear();
 for(const row of db.prepare('SELECT * FROM birthdays WHERE month=? AND day=? AND (last_sent_year IS NULL OR last_sent_year != ?)').all(month,day,year)){
  const guild=client.guilds.cache.get(row.guild_id);if(!guild)continue;
  const id=getSettings(guild.id).birthdayChannel;if(!id)continue;
  const channel=guild.channels.cache.get(id);if(!channel?.isTextBased())continue;
  try{await channel.send({content:`🎂 Happy birthday, <@${row.user_id}>! 🎉`,allowedMentions:{users:[row.user_id]}});db.prepare('UPDATE birthdays SET last_sent_year=? WHERE guild_id=? AND user_id=?').run(year,row.guild_id,row.user_id);}
  catch(e){console.error('[birthday] Announcement failed:',e);}
 }}
module.exports={commands:[command],sweep,valid};