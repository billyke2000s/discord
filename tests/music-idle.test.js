const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { EmbedBuilder } = require('discord.js');
require.cache[require.resolve('../src/lib/util')] = {
  exports: {
    embed: () => new EmbedBuilder(),
    truncate: (s, n) => String(s || '').slice(0, n),
    fmtDuration: () => '0:00',
    isBotAdmin: () => false,
  },
};
const { GuildQueue, MusicManager } = require('../src/lib/music');

const TWO_MIN = 2 * 60 * 1000;
const track = (id) => ({ encoded: `enc-${id}`, requester: 'u', info: { identifier: id, title: id, length: 600_000 } });

function setup() {
  const manager = {
    client: { guilds: { cache: new Map() } },
    queues: new Map(),
    store: null,
    shoukaku: { leaveVoiceChannel: async () => {} },
    recordAudio: () => {},
    findOnYouTube: async () => null,
  };
  const player = new EventEmitter();
  player.playTrack = async () => {};
  player.stopTrack = async () => {};
  player.setGlobalVolume = async () => {};
  const q = new GuildQueue(manager, 'g1', player, null, 'vc');
  q.send = () => {};
  let humans = 1;
  q.listeners = () => new Map(Array.from({ length: humans }, (_, i) => [`h${i}`, {}]));
  manager.queues.set('g1', q);
  const checkAlone = () => MusicManager.prototype.checkAlone.call(manager, { id: 'g1' });
  return { q, setHumans: (n) => (humans = n), checkAlone };
}

test('unrelated voice events do not restart the everyone-left countdown', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { q, setHumans, checkAlone } = setup();
    setHumans(0);
    checkAlone(); // everyone left
    mock.timers.tick(TWO_MIN - 1000);
    checkAlone(); // someone mutes in another channel
    mock.timers.tick(1000);
    assert.equal(q.destroyed, true, 'should leave 2 minutes after the channel emptied');
  } finally {
    mock.timers.reset();
  }
});

test('a new song starting while alone does not cancel the countdown', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { q, setHumans, checkAlone } = setup();
    q.add([track('a'), track('b')]);
    await q.start();
    setHumans(0);
    checkAlone();
    await q.skip(); // next song starts with nobody listening
    mock.timers.tick(TWO_MIN);
    assert.equal(q.destroyed, true);
  } finally {
    mock.timers.reset();
  }
});

test('someone coming back cancels the countdown', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { q, setHumans, checkAlone } = setup();
    q.add([track('a')]);
    await q.start();
    setHumans(0);
    checkAlone();
    mock.timers.tick(60_000);
    setHumans(1);
    checkAlone();
    mock.timers.tick(TWO_MIN);
    assert.equal(q.destroyed, false);
    await q.destroy();
  } finally {
    mock.timers.reset();
  }
});
