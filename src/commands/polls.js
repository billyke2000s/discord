const { SlashCommandBuilder, PermissionFlagsBits:P, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle }=require('discord.js');
const {db}=require('../lib/db');
db.exec(`CREATE TABLE IF NOT EXISTS community_polls (id INTEGER PRIMARY KEY AUTOINCREMENT,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,message_id TEXT,question TEXT NOT NULL,options_json TEXT NOT NULL,creator_id TEXT NOT NULL,closes_at INTEGER NOT NULL,closed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS community_poll_votes (poll_id INTEGER NOT NULL,user_id TEXT NOT NULL,choice INTEGER NOT NULL,PRIMARY KEY(poll_id,user_id))`);
const tally=(id,n)=>{const votes=Array(n).fill(0);for(const r of db.prepare('SELECT choice FROM community_poll_votes WHERE poll_id=?').all(id))if(r.choice>=0&&r.choice<n)votes[r.choice]++;return votes;};
const display=(r)=>{const opts=JSON.parse(r.options_json),counts=tally(r.id,opts.length);return {content:`📊 **${r.question}**\n${opts.map((o,n)=>`${n+1}. ${o} — **${counts[n]}**`).join('\n')}\n${r.closed?'🔒 Closed':`Closes <t:${Math.floor(r.closes_at/1000)}:R>`}`,components:r.closed?[]:[new ActionRowBuilder().addComponents(opts.map((o,n)=>new ButtonBuilder().setCustomId(`poll:vote:${r.id}:${n}`).setLabel(String(n+1)).setStyle(ButtonStyle.Primary)))],allowedMentions:{parse:[]}};};
const command={data:new SlashCommandBuilder().setName('poll').setDescription('Create and manage community polls')
 .addSubcommand(s=>s.setName('create').setDescription('Start a poll').addStringOption(o=>o.setName('question').setDescription('Question').setRequired(true).setMaxLength(180)).addStringOption(o=>o.setName('options').setDescription('2-5 options separated by |').setRequired(true).setMaxLength(450)).addIntegerOption(o=>o.setName('hours').setDescription('Open for 1-168 hours').setMinValue(1).setMaxValue(168)))
 .addSubcommand(s=>s.setName('close').setDescription('Close your poll (staff can close any)').addIntegerOption(o=>o.setName('id').setDescription('Poll ID').setRequired(true).setMinValue(1))),
 async execute(i){const sub=i.options.getSubcommand();if(sub==='create'){const question=i.options.getString('question',true),options=i.options.getString('options',true).split('|').map(x=>x.trim()).filter(Boolean);
  if(options.length<2||options.length>5||options.some(x=>x.length>80)||new Set(options.map(x=>x.toLowerCase())).size!==options.length)return i.reply({content:'Provide 2–5 unique options (max 80 characters each) separated by |.',flags:MessageFlags.Ephemeral});
  await i.deferReply({flags:MessageFlags.Ephemeral});const info=db.prepare('INSERT INTO community_polls (guild_id,channel_id,question,options_json,creator_id,closes_at) VALUES (?,?,?,?,?,?)').run(i.guildId,i.channelId,question,JSON.stringify(options),i.user.id,Date.now()+(i.options.getInteger('hours')||24)*3600000);
  const id=Number(info.lastInsertRowid),r=db.prepare('SELECT * FROM community_polls WHERE id=?').get(id);
  try{const msg=await i.channel.send(display(r));db.prepare('UPDATE community_polls SET message_id=? WHERE id=?').run(msg.id,id);return i.editReply(`Poll #${id} created.`);}catch(e){db.prepare('DELETE FROM community_polls WHERE id=?').run(id);throw e;}
 }
 const id=i.options.getInteger('id',true),r=db.prepare('SELECT * FROM community_polls WHERE id=? AND guild_id=?').get(id,i.guildId);
 if(!r)return i.reply({content:'Poll not found.',flags:MessageFlags.Ephemeral});
 if(r.creator_id!==i.user.id&&!i.memberPermissions.has(P.ManageMessages))return i.reply({content:'Only the creator or moderators can close this poll.',flags:MessageFlags.Ephemeral});
 await closePoll(i.client,r);return i.reply({content:`Poll #${id} closed.`,flags:MessageFlags.Ephemeral});
 }};
async function refresh(client,r){const channel=client.channels.cache.get(r.channel_id);if(!channel)return;const msg=await channel.messages.fetch(r.message_id).catch(()=>null);if(msg)await msg.edit(display(r)).catch(e=>console.error('[poll] Update failed:',e));}
async function closePoll(client,r){db.prepare('UPDATE community_polls SET closed=1 WHERE id=?').run(r.id);await refresh(client,{...r,closed:1});}
async function vote(i,id,choice){const r=db.prepare('SELECT * FROM community_polls WHERE id=? AND guild_id=?').get(id,i.guildId);if(!r||r.closed||Date.now()>=r.closes_at)return i.reply({content:'This poll is closed.',flags:MessageFlags.Ephemeral});const options=JSON.parse(r.options_json);if(!Number.isInteger(choice)||choice<0||choice>=options.length)return i.reply({content:'Invalid choice.',flags:MessageFlags.Ephemeral});
 db.prepare('INSERT INTO community_poll_votes (poll_id,user_id,choice) VALUES (?,?,?) ON CONFLICT(poll_id,user_id) DO UPDATE SET choice=excluded.choice').run(id,i.user.id,choice);
 await i.reply({content:`Vote recorded for **${options[choice]}**.`,flags:MessageFlags.Ephemeral});await refresh(i.client,r);}
async function sweep(client){for(const r of db.prepare('SELECT * FROM community_polls WHERE closed=0 AND closes_at<=?').all(Date.now()))await closePoll(client,r);}
module.exports={commands:[command],prefixComponents:{'poll:vote:':(i,rest)=>{const [id,n]=rest.split(':').map(Number);return vote(i,id,n);}},sweep,tally};