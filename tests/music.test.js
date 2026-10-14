const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
// Isolate queue tests from SQLite and Discord login; keep real embed builders.
const { EmbedBuilder } = require('discord.js');
require.cache[require.resolve('../src/lib/util')] = { exports: {
  embed: () => new EmbedBuilder().setColor(0x5865f2),
  truncate: (s, n) => String(s || '').slice(0, n), fmtDuration: () => '0:00', isBotAdmin: () => false,
} };
const { GuildQueue, MusicManager, matchScore } = require('../src/lib/music');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const track = (id, encoded = id) => ({ encoded, search: id, info: { identifier: id, title: id, author: 'artist', length: 1000, uri: `https://youtube.com/watch?v=${id}` } });
function queue(find = async (t) => track(t.info.identifier)) {
  const player = new EventEmitter();
  player.played = [];
  player.playTrack = async (p) => { player.played.push(p.track.encoded); };
  player.stopTrack = async () => player.emit('end', { reason: 'stopped', track: { encoded: q.current.encoded } });
  const manager = { client: { guilds: { cache: new Map() } }, queues: new Map(),
    shoukaku: { leaveVoiceChannel: async () => {} }, findOnYouTube: find };
  const q = new GuildQueue(manager, 'guild', player, null, 'voice');
  manager.queues.set('guild', q);
  return q;
}
test('overlapping next calls resolve and play one track only', async () => {
  const pending = deferred(); let calls = 0;
  const q = queue(() => { calls++; return pending.promise; });
  q.add([track('one', null)]);
  const a = q.start(); const b = q.next();
  pending.resolve(track('one'));
  await Promise.all([a, b]);
  assert.equal(calls, 1); assert.deepEqual(q.player.played, ['one']);
  await q.destroy();
});
test('rejected playback advances to the next track', async () => {
  const q = queue(); q.add([track('bad'), track('good')]);
  const play = q.player.playTrack;
  q.player.playTrack = (p) => p.track.encoded === 'bad' ? Promise.reject(new Error('failed')) : play(p);
  await q.start(); assert.equal(q.current.info.identifier, 'good');
  await q.destroy();
});
test('destroy during resolution cannot play or repopulate queue', async () => {
  const pending = deferred(); const q = queue(() => pending.promise);
  q.add([track('one', null)]); const start = q.start();
  await q.destroy(); pending.resolve(track('one')); await start;
  assert.deepEqual(q.player.played, []); assert.equal(q.add([track('late')]), 0);
});
test('first track plays before 200-entry background import settles, without duplication', async () => {
  const q = queue(); const pending = deferred(); const first = track('0');
  q.add([first]); await q.start();
  const task = q.importRemaining(() => pending.promise, first, 'user', async () => {});
  assert.deepEqual(q.player.played, ['0']); assert.equal(q.tracks.length, 0);
  pending.resolve({ tracks: Array.from({ length: 200 }, (_, i) => track(String(i))) });
  await task;
  assert.equal(q.tracks.length, 199); assert.equal(q.tracks[0].info.identifier, '1');
  assert.ok(q.tracks.every((t) => t.requester === 'user')); await q.destroy();
});
test('late import is discarded after stop', async () => {
  const q = queue(); const pending = deferred(); let reports = 0;
  const task = q.importRemaining(() => pending.promise, track('0'), 'user', () => reports++);
  await q.destroy(); pending.resolve({ tracks: [track('0'), track('1')] }); await task;
  assert.equal(reports, 0); assert.equal(q.tracks.length, 0);
});
test('failed import preserves current track and reports failure', async () => {
  const q = queue(); const first = track('0'); q.add([first]); await q.start(); let result;
  await q.importRemaining(async () => { throw new Error('upstream'); }, first, 'user', async (r) => { result = r; });
  assert.equal(q.current, first); assert.equal(result.error, 'upstream'); await q.destroy();
});
test('queue cap applies to imported entries', async () => {
  const q = queue(); const first = track('0'); q.add([first]); await q.start(); let result;
  await q.importRemaining(async () => ({ tracks: Array.from({ length: 601 }, (_, i) => track(String(i))) }), first, 'user', async (r) => { result = r; });
  assert.equal(q.tracks.length, 500); assert.equal(result.omitted, 100); await q.destroy();
});
test('Spotify look-ahead is limited to two upcoming entries and reuses in-flight work', async () => {
  let calls = []; const q = queue(async (t) => { calls.push(t.info.identifier); return track(t.info.identifier); });
  q.add([track('first'), ...Array.from({ length: 200 }, (_, i) => track(String(i), null))]);
  await q.start();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(calls, ['0', '1']); await q.next();
  assert.equal(q.player.played[1], '0'); await q.destroy();
});
test('per-guild play requests preserve order; a failure does not poison later requests', async () => {
  const manager = { playRequests: new Map() }; const pending = deferred(); const order = [];
  const lock = MusicManager.prototype.withPlayLock.bind(manager);
  const a = lock('g', async () => { order.push(1); await pending.promise; throw new Error('bad'); });
  const rejected = assert.rejects(a, /bad/);
  const b = lock('g', async () => order.push(2));
  await Promise.resolve(); assert.deepEqual(order, []); // work starts on promise continuation
  pending.resolve(); await rejected; await b;
  assert.deepEqual(order, [1, 2]); assert.equal(manager.playRequests.size, 0);
});
test('late end event for previous encoded track does not skip current track', async () => {
  const q = queue(); q.add([track('one'), track('two'), track('three')]);
  await q.start(); await q.next(); q.player.emit('end', { reason: 'finished', track: { encoded: 'one' } });
  await Promise.resolve(); assert.equal(q.current.info.identifier, 'two'); await q.destroy();
});
test('matching keeps the original recording ahead of a cover', () => {
  const want = { title: 'Example', author: 'Artist', length: 180000 };
  assert.ok(matchScore(want, { ...want, author: 'Artist - Topic' }) > matchScore(want, { ...want, title: 'Example cover' }));
});
test('end arriving before play request settles advances once, even with duplicate stuck event', async () => {
  const q = queue(); const pending = deferred(); const play = q.player.playTrack;
  q.player.playTrack = (p) => p.track.encoded === 'one' ? pending.promise : play(p);
  q.add([track('one'), track('two'), track('three')]); const started = q.start();
  q.player.emit('end', { reason: 'finished', track: { encoded: 'one' } });
  q.player.emit('stuck', { track: { encoded: 'one' } });
  pending.resolve(); await started;
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(q.player.played, ['two']); await q.destroy();
});
test('bootstrap resolves one video and defers the playlist request until loader is called', async () => {
  const calls = []; const first = track('abcdefghijk');
  const manager = { resolve: async (query) => { calls.push(query); return query.includes('list=') ? { tracks: [first, track('other')] } : { tracks: [first] }; } };
  const result = await MusicManager.prototype.resolveForPlayback.call(manager, 'https://youtube.com/watch?v=abcdefghijk&list=PL123');
  assert.equal(calls.length, 1); assert.equal(result.tracks[0], first);
  assert.equal((await result.remaining()).tracks.length, 2); assert.equal(calls.length, 2);
});
