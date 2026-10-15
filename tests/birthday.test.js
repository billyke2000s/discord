const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'birthday-test-'));
process.env.DATA_DIR = dir;
delete process.env.GUILD_ID;
// Exercise the real SQL with Node's SQLite when the optional local native build is absent.
try { const Database = require('better-sqlite3'); const probe = new Database(':memory:'); probe.close(); }
catch {
  const { DatabaseSync } = require('node:sqlite');
  require.cache[require.resolve('better-sqlite3')] = { exports: class extends DatabaseSync {
    pragma(sql, options) { const rows = this.prepare(`PRAGMA ${sql}`).all(); return options?.simple ? Object.values(rows[0])[0] : rows; }
  } };
}
const { db, getSettings } = require('../src/lib/db');
db.exec('CREATE TABLE birthdays (guild_id TEXT NOT NULL,user_id TEXT NOT NULL,month INTEGER NOT NULL,day INTEGER NOT NULL,last_sent_year INTEGER,PRIMARY KEY(guild_id,user_id))');
db.prepare('INSERT INTO birthdays VALUES (?,?,?,?,?)').run('legacy','old',9,15,2025);
const birthday = require('../src/commands/birthday');
test('migration preserves saved dates and sent-year without inventing birth years',()=>{
 assert.deepEqual({...db.prepare('SELECT * FROM birthdays WHERE guild_id=?').get('legacy')},{guild_id:'legacy',user_id:'old',month:9,day:15,last_sent_year:2025,birth_year:null});
});
test('set and show are private and scoped to the caller; remove is not registered', async () => {
  const { MessageFlags } = require('discord.js');
  const command=birthday.commands[0];
  assert.deepEqual(command.data.toJSON().options.map(o=>o.name),['set','show']);
  let reply;
  const interaction=(user,sub)=>({guildId:'private',user:{id:user},options:{getSubcommand:()=>sub,getString:name=>name==='month'?'May':'12th',getInteger:()=>1990},reply:async r=>{reply=r;}});
  await command.execute(interaction('alice','set'));
  assert.equal(reply.flags,MessageFlags.Ephemeral);
  await command.execute(interaction('bob','show'));
  assert.match(reply.content,/No birthday saved/);assert.equal(reply.flags,MessageFlags.Ephemeral);
  await command.execute(interaction('alice','show'));
  assert.equal(reply.content,'Your birthday: 12 May 1990.');assert.equal(reply.flags,MessageFlags.Ephemeral);
  const invalid=interaction('alice','set');invalid.options.getString=n=>n==='month'?'February':'30';
  await command.execute(invalid);assert.match(reply.content,/real birth date/);assert.equal(reply.flags,MessageFlags.Ephemeral);
  const stored=db.prepare('SELECT month,day,birth_year FROM birthdays WHERE guild_id=? AND user_id=?').get('private','alice');
  assert.deepEqual({...stored},{month:5,day:12,birth_year:1990});
  db.prepare('DELETE FROM birthdays WHERE guild_id=?').run('private');
});
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
test('calendar validation accepts leap day but rejects impossible dates', () => {
  assert.equal(birthday.valid(2,29), true);
  for(const [m,d] of [[2,30],[4,31],[0,1],[13,1],[1,0],[1,1.5]])assert.equal(birthday.valid(m,d),false);
});
test('month/day formats, birth-year validation and friendly age messages', () => {
 for(const input of ['September','september','SEP','Sept','Sep.','9','09',' September '])assert.equal(birthday.parseMonth(input),9);
 for(const input of ['15','15th','15TH',' 15th '])assert.equal(birthday.parseDay(input),15);
 for(const input of ['2nd','02'])assert.equal(birthday.parseDay(input),2);
 for(const input of ['13','0','nonsense','9/15'])assert.equal(birthday.parseMonth(input),null);
 for(const input of ['1th','32','0','15.5'])assert.equal(birthday.parseDay(input),null);
 const now=new Date('2026-09-15T12:00:00Z');
 assert.equal(birthday.validBirthDate(2,29,2000,now),true);
 assert.equal(birthday.validBirthDate(2,29,2001,now),false);
 assert.equal(birthday.validBirthDate(9,16,2026,now),false);
 assert.equal(birthday.validBirthDate(9,15,2027,now),false);
 assert.equal(birthday.validBirthDate(9,15,1966,now),true);
 const row={month:9,day:15,birth_year:1966,user_id:'david'};
 assert.match(birthday.savedBirthday(row,now),/Happy birthday! You’re 60 today!/);
 assert.equal(birthday.birthdayMessage(row,2026),'🎂 Happy birthday, <@david>! You’re 60 today! 🎉 Wishing you a wonderful day and a brilliant year ahead. Enjoy your 👑 Birthday role for 24 hours!');
 assert.doesNotMatch(birthday.birthdayMessage({...row,birth_year:null},2026),/today|NaN/);
 assert.match(birthday.savedBirthday({...row,birth_year:null},now),/add your birth year/);
});
test('celebration is once yearly; expiry survives date deletion and retries failed removals', async () => {
  let adds=0,removes=0,sends=0,creates=0,failRemoval=true;
  const role={id:'role',managed:false,permissions:{bitfield:0n}};
  const channel={id:'channel',name:'🎂・birthdays',isTextBased:()=>true,send:async payload=>{sends++;assert.match(payload.content,/You’re 60 today!/);assert.match(payload.content,/wonderful day/);assert.deepEqual(payload.allowedMentions,{users:['u']});}};
  const member={roles:{add:async()=>{adds++;},remove:async()=>{if(failRemoval)throw Error('temporary');removes++;}}};
  const guild={id:'g',channels:{cache:new Map([['channel',channel]])},members:{fetch:async()=>member},
    roles:{fetch:async()=>role,create:async data=>{creates++;assert.deepEqual(data.permissions,[]);assert.equal(data.name,'👑 Birthday');return role;}}};
  const client={guilds:{cache:new Map([['g',guild]])}};
  db.prepare('INSERT INTO birthdays (guild_id,user_id,month,day) VALUES (?,?,?,?)').run('g','u',10,15);
  db.prepare('UPDATE birthdays SET birth_year=? WHERE guild_id=?').run(1966,'g');
  const now=new Date('2026-10-15T12:00:00Z');
  await birthday.sweep(client,now);await birthday.sweep(client,now);
  assert.equal(sends,1);assert.equal(adds,1);assert.equal(creates,1);
  assert.equal(getSettings('g').birthdayChannel,'channel');
  assert.equal(db.prepare('SELECT expires_at FROM birthday_grants').get().expires_at,now.getTime()+86400000);
  db.prepare('DELETE FROM birthdays').run();
  await birthday.sweep(client,new Date('2026-10-16T11:59:59Z'));assert.equal(removes,0);
  await birthday.sweep(client,new Date('2026-10-16T12:00:00Z'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM birthday_grants').get().n,1);
  failRemoval=false;
  await birthday.sweep(client,new Date('2026-10-16T12:01:00Z'));
  assert.equal(removes,1);assert.equal(db.prepare('SELECT count(*) AS n FROM birthday_grants').get().n,0);
  role.permissions.bitfield=8n;
  db.prepare('INSERT INTO birthdays (guild_id,user_id,month,day) VALUES (?,?,?,?)').run('g','u',10,16);
  await birthday.sweep(client,new Date('2026-10-16T12:02:00Z'));
  assert.equal(adds,1);assert.equal(sends,1);
});

