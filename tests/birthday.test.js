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
const birthday = require('../src/commands/birthday');
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
test('calendar validation accepts leap day but rejects impossible dates', () => {
  assert.equal(birthday.valid(2,29), true);
  for(const [m,d] of [[2,30],[4,31],[0,1],[13,1],[1,0],[1,1.5]])assert.equal(birthday.valid(m,d),false);
});
test('celebration is once yearly; expiry survives date deletion and retries failed removals', async () => {
  let adds=0,removes=0,sends=0,creates=0,failRemoval=true;
  const role={id:'role',managed:false,permissions:{bitfield:0n}};
  const channel={id:'channel',name:'🎂・birthdays',isTextBased:()=>true,send:async()=>{sends++;}};
  const member={roles:{add:async()=>{adds++;},remove:async()=>{if(failRemoval)throw Error('temporary');removes++;}}};
  const guild={id:'g',channels:{cache:new Map([['channel',channel]])},members:{fetch:async()=>member},
    roles:{fetch:async()=>role,create:async data=>{creates++;assert.deepEqual(data.permissions,[]);assert.equal(data.name,'👑 Birthday');return role;}}};
  const client={guilds:{cache:new Map([['g',guild]])}};
  db.prepare('INSERT INTO birthdays VALUES (?,?,?,?,NULL)').run('g','u',10,15);
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
  db.prepare('INSERT INTO birthdays VALUES (?,?,?,?,NULL)').run('g','u',10,16);
  await birthday.sweep(client,new Date('2026-10-16T12:02:00Z'));
  assert.equal(adds,1);assert.equal(sends,1);
});

