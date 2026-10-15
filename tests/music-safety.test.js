const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { EmbedBuilder, PermissionsBitField, PermissionFlagsBits } = require('discord.js');
require.cache[require.resolve('../src/lib/util')] = {
  exports: {
    embed: () => new EmbedBuilder(),
    truncate: (s, n) => String(s || '').slice(0, n),
    fmtDuration: () => '0:00',
    isBotAdmin: () => false,
  },
};
const { GuildQueue, isSupportedLink } = require('../src/lib/music');
const controls = require('../src/commands/music');

const track = (id) => ({ encoded: id, info: { identifier: id, title: id, length: 1000 } });
function queue() {
  const player = new EventEmitter();
  player.playTrack = async () => {};
  player.stopTrack = async () => {};
  const manager = { client: { guilds: { cache: new Map() } }, queues: new Map(),
    shoukaku: { leaveVoiceChannel: async () => {} }, recordAudio: () => {} };
  const q = new GuildQueue(manager, 'guild', player, null, 'voice');
  q.sent = [];
  q.send = (e) => q.sent.push(e.toJSON().description);
  return q;
}

test('/play links are limited to supported music hosts', () => {
  for (const ok of ['https://www.youtube.com/watch?v=abc', 'https://youtu.be/abc', 'https://music.youtube.com/watch?v=a',
    'https://soundcloud.com/a/b', 'https://www.twitch.tv/someone', 'https://vimeo.com/1', 'https://artist.bandcamp.com/track/x']) {
    assert.equal(isSupportedLink(ok), true, ok);
  }
  for (const bad of ['http://127.0.0.1:2333/version', 'http://169.254.169.254/latest', 'https://example.com/a.mp3',
    'https://youtube.com.evil.example/x', 'https://user:pw@youtube.com/x', 'https://youtube.com:8443/x', 'file:///etc/passwd',
    'http://yt-cipher:8001/']) {
    assert.equal(isSupportedLink(bad), false, bad);
  }
});

test('track errors are not posted to chat with the raw source message', async () => {
  const q = queue();
  q.add([track('one'), track('two')]);
  await q.start();
  const warn = console.warn; console.warn = () => {};
  try {
    q.player.emit('exception', { track: { info: { identifier: 'one' } }, exception: { message: 'https://signed.example/secret?token=abc' } });
  } finally { console.warn = warn; }
  assert.equal(q.sent.length, 1);
  assert.doesNotMatch(q.sent[0], /signed|token|https?:/);
  await q.destroy();
});

test('shuffle needs a majority vote; staff shuffle instantly', async () => {
  let shuffled = 0, reply;
  const q = { current: track('now'), tracks: [track('a'), track('b')], voiceChannelId: 'voice', history: [],
    vote: () => ({ passed: false, count: 1, needed: 2 }), refreshPanel: () => {}, shuffle: () => { shuffled++; } };
  const i = { guildId: 'g', user: { id: '1' }, client: { music: { get: () => q } }, reply: async (p) => { reply = p; },
    member: { id: '1', guild: { ownerId: 'owner' }, voice: { channelId: 'voice' }, permissions: new PermissionsBitField() } };
  await controls.components['music:shuffle'](i);
  assert.equal(shuffled, 0); assert.match(reply.content, /Shuffle votes: \*\*1\/2\*\*/);
  q.vote = () => ({ passed: true, count: 2, needed: 2 });
  await controls.components['music:shuffle'](i);
  assert.equal(shuffled, 1);
  i.member.permissions = new PermissionsBitField(PermissionFlagsBits.ModerateMembers);
  q.vote = () => { throw new Error('staff should not vote'); };
  await controls.components['music:shuffle'](i);
  assert.equal(shuffled, 2);
  q.tracks = [track('a')];
  await controls.components['music:shuffle'](i);
  assert.equal(shuffled, 2); assert.match(reply.content, /at least two songs/);
});

test('real queue shuffle vote passes on majority and clears its votes', async () => {
  const q = queue();
  q.listeners = () => new Map([['1', {}], ['2', {}], ['3', {}]]);
  q.add([track('one'), track('two'), track('three'), track('four')]);
  await q.start();
  assert.equal(q.vote('shuffle', '1').passed, false);
  assert.equal(q.vote('shuffle', '2').passed, true);
  q.shuffle();
  assert.equal(q.votes.shuffle.size, 0);
  const label = q.panelPayload().components[0].toJSON().components.find((c) => c.custom_id === 'music:shuffle').label;
  assert.equal(label, 'Vote shuffle');
  await q.destroy();
});
