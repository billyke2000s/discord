const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { EmbedBuilder, Collection } = require('discord.js');

// A throwaway database, so the real saved-session table and SQL are exercised.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'music-persist-'));
require.cache[require.resolve('../src/lib/util')] = {
  exports: {
    embed: () => new EmbedBuilder(),
    truncate: (s, n) => String(s || '').slice(0, n),
    fmtDuration: () => '0:00',
    isBotAdmin: () => false,
  },
};
const store = require('../src/lib/music-store');
const { db } = require('../src/lib/db');
const { GuildQueue, MusicManager } = require('../src/lib/music');

const track = (id, extra = {}) => ({
  encoded: `enc-${id}`,
  requester: 'u1',
  info: { identifier: id, title: `Song ${id}`, author: 'a', length: 200_000, uri: `https://youtu.be/${id}` },
  ...extra,
});
const sent = [];
function fakeManager() {
  const manager = {
    client: { guilds: { cache: new Map() } },
    queues: new Map(),
    creating: new Map(),
    store,
    restoring: null,
    shoukaku: { leaveVoiceChannel: async () => {}, getIdealNode: () => ({}) },
    recordAudio: () => {},
    findOnYouTube: async () => null,
  };
  manager.create = async (guild, vcId, textChannel) => {
    const q = newQueue(manager, guild.id, vcId);
    q.fallbackChannel = textChannel;
    manager.queues.set(guild.id, q);
    return q;
  };
  return manager;
}
function newQueue(manager, guildId = 'g1', vcId = 'vc') {
  const player = new EventEmitter();
  player.played = [];
  player.playTrack = async (p) => {
    player.played.push({ encoded: p.track.encoded, position: p.position });
  };
  player.stopTrack = async () => {};
  player.setGlobalVolume = async () => {};
  const q = new GuildQueue(
    manager,
    guildId,
    player,
    { id: 'text', send: async () => ({ delete: async () => {}, edit: async () => {} }) },
    vcId,
  );
  q.send = (e) => sent.push(e.toJSON().description);
  q.listeners = () => new Map([['human', {}]]);
  return q;
}
const rows = () => store.all();
beforeEach(() => {
  db.exec('DELETE FROM music_sessions');
  sent.length = 0;
});

test('queue changes are saved; the position is updated on its own; a finished queue clears the save', async () => {
  const q = newQueue(fakeManager());
  q.add([track('a'), track('b'), track('c')]);
  await q.start();
  q.persist();
  let [saved] = rows();
  assert.equal(saved.data.current.info.title, 'Song a');
  assert.deepEqual(
    saved.data.tracks.map((t) => t.info.identifier),
    ['b', 'c'],
  );
  assert.equal(saved.data.current.encoded, 'enc-a');
  assert.equal(saved.data.current.requester, 'u1');

  q.clock = { base: 90_000, at: Date.now() };
  q.savedAt = 0;
  const before = db.prepare('SELECT data FROM music_sessions').get().data;
  q.persist();
  [saved] = rows();
  assert.ok(saved.position >= 90_000 && saved.position < 92_000);
  assert.equal(
    db.prepare('SELECT data FROM music_sessions').get().data,
    before,
    'queue JSON not rewritten for position',
  );

  q.tracks.length = 0;
  q.current = null;
  q.changes++;
  q.persist();
  assert.equal(rows().length, 0);
  await q.destroy();
});

test('stopping music forgets it; a restart (suspend) keeps it with the position', async () => {
  const manager = fakeManager();
  const stopped = newQueue(manager);
  stopped.add([track('a'), track('b')]);
  await stopped.start();
  stopped.persist();
  await stopped.destroy();
  assert.equal(rows().length, 0);

  const restarting = newQueue(manager);
  restarting.add([track('a'), track('b')]);
  await restarting.start();
  restarting.clock = { base: 61_000, at: Date.now() };
  await restarting.suspend();
  const [saved] = rows();
  assert.equal(saved.data.current.info.identifier, 'a');
  assert.ok(saved.position >= 61_000);
  assert.equal(restarting.destroyed, true);
});

function guildWith({ humans = true } = {}) {
  const members = new Collection(humans ? [['h', { user: { bot: false } }]] : [['bot', { user: { bot: true } }]]);
  const channels = new Map([
    ['vc', { id: 'vc', members }],
    ['text', { id: 'text' }],
  ]);
  return { id: 'g1', channels: { cache: channels } };
}

test('after a restart, the song carries on from where it was and the rest of the queue follows', async () => {
  const manager = fakeManager();
  const before = newQueue(manager);
  before.add([track('a'), track('b'), track('c')]);
  await before.start();
  before.clock = { base: 75_000, at: Date.now() };
  await before.suspend();

  manager.client.guilds.cache.set('g1', guildWith());
  const resumed = await MusicManager.prototype.restoreAll.call(
    Object.assign(manager, {
      restoreAll: MusicManager.prototype.restoreAll,
      restoreOne: MusicManager.prototype.restoreOne,
    }),
  );
  assert.equal(resumed, 1);
  const q = manager.queues.get('g1');
  assert.equal(q.current.info.identifier, 'a');
  const played = q.player.played.at(-1);
  assert.equal(played.encoded, 'enc-a');
  assert.ok(played.position >= 75_000 && played.position < 77_000);
  assert.deepEqual(
    q.tracks.map((t) => t.info.identifier),
    ['b', 'c'],
  );
  assert.match(sent.at(-1), /Back after a restart/);
  q.player.emit('start', { track: { userData: { serverBotPlaybackId: q.playback.id } } });
  assert.ok(q.position() >= 75_000, 'panel clock starts at the resumed position');
  await q.destroy();
});

test('nothing is resumed into an empty channel, from an old save, or before the music server is ready', async () => {
  const manager = Object.assign(fakeManager(), {
    restoreAll: MusicManager.prototype.restoreAll,
    restoreOne: MusicManager.prototype.restoreOne,
  });
  const save = () =>
    store.save('g1', { v: 1, voiceChannelId: 'vc', current: GuildQueue.entry(track('a')), tracks: [] }, 1000);

  save();
  manager.client.guilds.cache.set('g1', guildWith({ humans: false }));
  assert.equal(await manager.restoreAll(), 0);
  assert.equal(rows().length, 0, 'empty channel: forgotten');

  save();
  db.prepare('UPDATE music_sessions SET updated_at = ?').run(Date.now() - 31 * 60_000);
  manager.client.guilds.cache.set('g1', guildWith());
  assert.equal(await manager.restoreAll(), 0);
  assert.equal(rows().length, 0, 'too old: forgotten');

  save();
  manager.shoukaku.getIdealNode = () => null;
  assert.equal(await manager.restoreAll(), 0);
  assert.equal(rows().length, 1, 'music server not ready: kept for later');

  manager.shoukaku.getIdealNode = () => ({});
  manager.queues.set('g1', {});
  assert.equal(await manager.restoreAll(), 0);
  assert.equal(rows().length, 1, 'already playing: left alone');
});

test('a damaged saved row is dropped without blocking the others', () => {
  db.prepare('INSERT INTO music_sessions (guild_id, data, position, updated_at) VALUES (?, ?, 0, ?)').run(
    'bad',
    '{nope',
    Date.now(),
  );
  store.save('good', { v: 1 });
  assert.deepEqual(
    store.all().map((r) => r.guildId),
    ['good'],
  );
  assert.equal(db.prepare('SELECT COUNT(*) c FROM music_sessions').get().c, 1);
});
