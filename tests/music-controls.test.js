const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EmbedBuilder, MessageFlags } = require('discord.js');
require.cache[require.resolve('../src/lib/util')] = {
  exports: {
    embed: () => new EmbedBuilder(),
    fmtDuration: () => '1:00',
    truncate: (s, n) => String(s || '').slice(0, n),
    isBotAdmin: () => false,
  },
};
const controls = require('../src/commands/music');
const track = (n) => ({ info: { title: `Song ${n}`, length: 60000 } });
function queue() {
  return {
    sessionId: '0123456789abcdef',
    current: track('now'),
    tracks: Array.from({ length: 200 }, (_, i) => track(i)),
  };
}
test('queue arrows have unique IDs, show pages, clamp shrinkage and retain all tracks', () => {
  const q = queue();
  const first = controls.queuePayload(q, '123', 1),
    last = controls.queuePayload(q, '123', 10);
  const buttons = first.components[0].toJSON().components;
  assert.equal(new Set(buttons.map((b) => b.custom_id)).size, 5);
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, true);
  assert.equal(buttons[3].disabled, false);
  assert.equal(last.components[0].toJSON().components[3].disabled, true);
  assert.match(last.embeds[0].toJSON().footer.text, /Page 10\/10/);
  assert.equal(q.tracks.length, 200);
  q.tracks.length = 3;
  assert.match(controls.queuePayload(q, '123', 10).embeds[0].toJSON().footer.text, /Page 1\/1/);
});
test('queue paging updates the same view and rejects another user or expired session', async () => {
  const q = queue(),
    handler = controls.prefixComponents[0][1];
  let response, updated;
  const i = {
    user: { id: '123' },
    guildId: 'g',
    client: { music: { get: () => q } },
    reply: async (p) => {
      response = p;
    },
    update: async (p) => {
      updated = p;
    },
  };
  await handler(i, `${q.sessionId}:123:2:3`);
  assert.match(updated.embeds[0].toJSON().footer.text, /Page 2\/10/);
  i.user.id = '456';
  updated = null;
  await handler(i, `${q.sessionId}:123:2:3`);
  assert.equal(updated, null);
  assert.equal(response.flags, MessageFlags.Ephemeral);
  i.user.id = '123';
  q.sessionId = 'fedcba9876543210';
  await handler(i, '0123456789abcdef:123:2:3');
  assert.deepEqual(updated.components, []);
  assert.match(updated.content, /session has ended/);
});
test('removed controls cannot be used through old buttons or registered slash commands', async () => {
  const names = controls.commands.map((c) => c.data.name);
  assert.ok(!names.includes('pause'));
  assert.ok(!names.includes('resume'));
  for (const id of ['music:toggle', 'music:volup', 'music:voldown']) {
    let response;
    await controls.components[id]({
      reply: async (p) => {
        response = p;
      },
    });
    assert.equal(response.flags, MessageFlags.Ephemeral);
    assert.match(response.content, /removed/);
  }
});
test('go-back button enforces voice membership, majority votes and staff bypass', async () => {
  let back = 0,
    reply;
  const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
  const q = {
    current: track('two'),
    voiceChannelId: 'voice',
    history: [track('one')],
    vote: () => ({ passed: false, count: 1, needed: 2 }),
    refreshPanel: () => {},
    previous: async () => {
      back++;
    },
  };
  const i = {
    guildId: 'g',
    guild: { ownerId: 'owner' },
    user: { id: '1' },
    member: {
      id: '1',
      guild: { ownerId: 'owner' },
      voice: { channelId: 'elsewhere' },
      permissions: new PermissionsBitField(),
    },
    client: { music: { get: () => q } },
    reply: async (p) => {
      reply = p;
    },
  };
  await controls.components['music:previous'](i);
  assert.equal(back, 0);
  assert.match(reply.content, /Join that channel/);
  i.member.voice.channelId = 'voice';
  await controls.components['music:previous'](i);
  assert.equal(back, 0);
  assert.match(reply.content, /1\/2/);
  q.vote = () => ({ passed: true, count: 2, needed: 2 });
  await controls.components['music:previous'](i);
  assert.equal(back, 1);
  i.member.permissions = new PermissionsBitField(PermissionFlagsBits.ModerateMembers);
  q.vote = () => {
    throw Error('Staff should bypass voting');
  };
  await controls.components['music:previous'](i);
  assert.equal(back, 2);
});
