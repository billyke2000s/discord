const { test } = require('node:test');
const assert = require('node:assert/strict');
// Loading the command for permission/gate tests must not open a live database.
const stub = (path, exports) => { require.cache[require.resolve(path)] = { exports }; };
stub('../src/lib/db', { db: {}, getSettings: () => ({}) });
stub('../src/lib/util', { embed: () => {}, fmtDuration: () => '' }); stub('../src/lib/scamfilter', {}); stub('../src/lib/antiraid', {}); stub('../src/lib/backup', {}); stub('../src/lib/commandsync', { rebuildLocked: () => false });
const { commands } = require('../src/commands/diagnostics');
test('diagnosis alias preserves permission requirements and shares the same execution/gate', async () => {
  assert.deepEqual(commands.map(c => c.data.name), ['diagnostics', 'diagnosis']);
  assert.equal(commands[0].execute, commands[1].execute);
  assert.equal(commands[0].data.toJSON().default_member_permissions, commands[1].data.toJSON().default_member_permissions);
  await assert.rejects(commands[0].execute({ deferReply: async () => { throw new Error('Discord failed'); } }), /Discord failed/);
  let response;
  await commands[1].execute({ reply: async r => { response = r; } });
  assert.match(response.content, /Please wait/);
});
test('complete report groups results, attaches full details and stays within Discord limits', async () => {
  const { EmbedBuilder, Collection } = require('discord.js');
  const realTools = require('../src/lib/diagnostic-tools');
  stub('../src/lib/diagnostic-tools', { ...realTools,
    sampleResources: async () => ({ cpu: { busy: 2, ioWait: 0, steal: 0 }, memory: { total: 4e9, available: 3e9, swapTotal: 0 },
      load: .1, hostCores: 3, botCpu: .1, botRss: 1e8, containerMemory: 1e8, containerLimit: 384e6, cpuLimit: null, loopMaxMs: 20 }),
    speedTest: async () => ({ downloadMbps: 100, uploadMbps: 50, latencyMs: 20, variationMs: 5, errors: [] }),
  });
  stub('../src/lib/util', { embed: () => new EmbedBuilder().setColor(0x5865f2), fmtDuration: () => '1:00' });
  stub('../src/lib/db', { db: { pragma: () => 'ok', exec: () => {}, prepare: () => ({ run: () => {} }) },
    getSettings: () => ({ verify: { enabled: false }, tickets: {}, jtc: {}, selfPromo: {}, suggestions: {}, scamFilter: { enabled: false } }) });
  stub('../src/lib/backup', { latest: () => null }); stub('../src/lib/antiraid', { isLocked: () => false });
  stub('../src/lib/scamfilter', { stats: () => ({}) });
  delete require.cache[require.resolve('../src/commands/diagnostics')];
  const updated = require('../src/commands/diagnostics').commands[0];
  const fetchBefore = global.fetch; global.fetch = async () => new Response('ok');
  const spotify = require('../src/lib/spotify'); const loadBefore = spotify.load;
  spotify.load = async () => ({ tracks: [{ title: 'test' }] });
  let final;
  try {
    await updated.execute({ guild: { id: 'guild', members: { me: { permissions: { has: () => true }, roles: { highest: {} } } },
      roles: { cache: new Collection() }, channels: { cache: new Collection() } },
      client: { ws: { ping: 20 }, music: { shoukaku: { getIdealNode: () => null }, get: () => null } },
      deferReply: async () => {}, editReply: async r => { if (typeof r === 'object') final = r; } });
    const data = final.embeds[0].toJSON();
    assert.equal(data.fields.length, 6); assert.equal(final.files[0].name, 'bot-diagnostics.txt');
    const total = data.title.length + data.description.length + data.footer.text.length + data.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    assert.ok(total < 6000); assert.ok(data.fields.every(f => f.value.length <= 1024));
    assert.match(data.description, /Lavalink/); assert.doesNotMatch(data.title, /passed/);
  } finally { global.fetch = fetchBefore; spotify.load = loadBefore; }
});
