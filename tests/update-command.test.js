const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const bridge=require('../src/lib/update-bridge');
const command=require('../src/commands/update').commands[0];
test('release checks accept only the repository-compatible manifest and fixed asset location',async t=>{
 const manifest={repository:'billyke2000s/discord',tag:'v-new',deployment:1,commit:'a'.repeat(40),image:'ghcr.io/billyke2000s/discord@sha256:'+'b'.repeat(64)};
 t.mock.method(globalThis,'fetch',async url=>new Response(JSON.stringify(url.includes('api.github.com')?
 {tag_name:'v-new',assets:[{name:'update.json',browser_download_url:'https://github.com/billyke2000s/discord/releases/download/v-new/update.json'}]}:manifest)));
 assert.deepEqual(await bridge.latestRelease(),{version:'v-new',commit:'a'.repeat(40)});
 manifest.image='ghcr.io/another/image:latest';
 await assert.rejects(bridge.latestRelease(),/manual installer/);
});
test('only the actual owner checks versions or requests an update; check-only and music guards',async t=>{
 let time=100000000; t.mock.method(Date,'now',()=>time+=20000);
 let checks=0,requests=0,reply;
 t.mock.method(bridge,'latestRelease',async()=>{checks++;return{version:'v-new',commit:'a'.repeat(40)};});
 t.mock.method(bridge,'status',async()=>null);
 t.mock.method(bridge,'request',async()=>{requests++;});
 const i={guild:{fetch:async()=>({id:'12345678901234567',ownerId:'22222222222222222'})},user:{id:'33333333333333333'},
 deferReply:async p=>{assert.equal(p.flags,64);},editReply:async s=>{reply=s;},
 options:{getBoolean:()=>false},client:{music:{queues:new Map()}}};
 await command.execute(i);assert.match(reply,/Only the actual Discord server owner/);assert.equal(checks,0);assert.equal(requests,0);
 i.user.id='22222222222222222';i.options.getBoolean=()=>true;
 await command.execute(i);assert.match(reply,/Latest published release: \*\*v-new/);assert.equal(requests,0);
 i.options.getBoolean=()=>false;i.client.music.queues.set('g',{});
 await command.execute(i);assert.match(reply,/End the music session/);assert.equal(requests,0);
 i.client.music.queues.clear();await command.execute(i);assert.equal(requests,1);assert.match(reply,/Update requested/);
});
test('bridge requires fresh enabled heartbeat and writes only a fixed request; duplicates are rejected',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'update-bridge-'));
 const oldReq=process.env.UPDATE_REQUEST_DIR,oldStatus=process.env.UPDATE_STATUS_DIR;
 process.env.UPDATE_REQUEST_DIR=path.join(dir,'requests');process.env.UPDATE_STATUS_DIR=path.join(dir,'status');
 await fs.mkdir(process.env.UPDATE_REQUEST_DIR);await fs.mkdir(process.env.UPDATE_STATUS_DIR);
 const heartbeat=path.join(process.env.UPDATE_STATUS_DIR,'heartbeat.json');
 try{
  await assert.rejects(bridge.request('12345678901234567','22222222222222222'),/bridge is not running/);
  await fs.writeFile(heartbeat,JSON.stringify({schema:1,at:Date.now()/1000,enabled:false}));
  await assert.rejects(bridge.request('12345678901234567','22222222222222222'),/disabled/);
  await fs.writeFile(heartbeat,JSON.stringify({schema:1,at:Date.now()/1000,enabled:true}));
  const request=await bridge.request('12345678901234567','22222222222222222');
  assert.deepEqual(Object.keys(request).sort(),['createdAt','guildId','id','ownerId']);
  assert.match(request.id,/^[a-f0-9]{32}$/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(process.env.UPDATE_REQUEST_DIR,'request.json'),'utf8')),request);
  await assert.rejects(bridge.request('12345678901234567','22222222222222222'),/already waiting/);
 }finally{
  if(oldReq===undefined)delete process.env.UPDATE_REQUEST_DIR;else process.env.UPDATE_REQUEST_DIR=oldReq;
  if(oldStatus===undefined)delete process.env.UPDATE_STATUS_DIR;else process.env.UPDATE_STATUS_DIR=oldStatus;
  await fs.rm(dir,{recursive:true,force:true});
 }
});

