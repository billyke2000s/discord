const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EmbedBuilder, MessageFlags } = require('discord.js');

const logged = [];
require.cache[require.resolve('../src/lib/util')] = {
  exports: { embed: () => new EmbedBuilder(), log: async (_g, e) => logged.push(e.toJSON().description) },
};
const spotify = require('../src/lib/spotify');
const status = require('../src/commands/status');
const command = status.commands[0];

let searches, spotifyLoads, spotifyOk;
beforeEach(() => {
  status._reset();
  logged.length = 0;
  searches = 0;
  spotifyLoads = 0;
  spotifyOk = true;
  spotify.load = async () => {
    spotifyLoads++;
    if (!spotifyOk) throw new Error('changed');
    return { tracks: [{ title: 'x' }] };
  };
});

function interaction({
  node = true,
  youtube = true,
  playing = true,
  stuck = false,
  userId = 'u',
  memberVoice = 'vc',
} = {}) {
  const out = {};
  const monitor = {
    check() {},
    paused: false,
    active: true,
    alerts: new Set(stuck ? ['position-stalled'] : []),
    recent: [],
    last: { at: Date.now() },
  };
  const q = playing ? { current: {}, tracks: new Array(94), voiceChannelId: 'vc', monitor } : null;
  const ideal = node
    ? {
        stats: {},
        rest: {
          resolve: async () => {
            searches++;
            return youtube ? { loadType: 'search', data: [1] } : { loadType: 'empty', data: [] };
          },
        },
      }
    : null;
  return {
    out,
    i: {
      guildId: 'g',
      guild: {},
      user: { id: userId, toString: () => `<@${userId}>` },
      member: { voice: { channelId: memberVoice } },
      client: { ws: { ping: 47 }, music: { shoukaku: { getIdealNode: () => ideal }, get: () => q } },
      reply: async (p) => {
        out.reply = p;
      },
      deferReply: async (p) => {
        out.deferred = p;
      },
      editReply: async (p) => {
        out.embed = p.embeds[0].toJSON();
      },
    },
  };
}

test('anyone can run it, the reply is private, and it shows nothing about the VPS or other members', async () => {
  assert.equal(command.data.toJSON().default_member_permissions, undefined);
  const { i, out } = interaction();
  await command.execute(i);
  assert.equal(out.deferred.flags, MessageFlags.Ephemeral);
  assert.equal(out.embed.title, '✅ Everything is working');
  assert.match(out.embed.description, /Music here:\*\* Playing in <#vc> · 94 queued/);
  assert.match(out.embed.description, /can't hear it/);
  assert.doesNotMatch(out.embed.description, /CPU|memory|disk|GB|Mbps|Lavalink|version|<@/i);
  assert.equal(logged.length, 0);
});

test('music server down: says it is not the member, and tells staff once', async () => {
  const a = interaction({ node: false, userId: 'a' });
  await command.execute(a.i);
  assert.equal(a.out.embed.title, '❌ Music is down');
  assert.match(a.out.embed.description, /It's not you/);
  const b = interaction({ node: false, userId: 'b' });
  await command.execute(b.i);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Music is down/);
});

test('YouTube failing counts as down; Spotify failing only suggests another way to play', async () => {
  const yt = interaction({ youtube: false });
  await command.execute(yt.i);
  assert.equal(yt.out.embed.title, '❌ Music is down');
  status._reset();
  spotifyOk = false;
  const sp = interaction();
  await command.execute(sp.i);
  assert.match(sp.out.embed.title, /Spotify links aren't working/);
  assert.match(sp.out.embed.description, /song name or a YouTube link/);
});

test('stuck playback and listening from the wrong channel give the right advice', async () => {
  const stuck = interaction({ stuck: true });
  await command.execute(stuck.i);
  assert.equal(stuck.out.embed.title, '⚠️ Music may be stuck');
  status._reset();
  const elsewhere = interaction({ memberVoice: 'other' });
  await command.execute(elsewhere.i);
  assert.match(elsewhere.out.embed.description, /Join that channel to hear it/);
});

test('YouTube and Spotify checks are shared and cached between members; each member has a short cooldown', async () => {
  await command.execute(interaction({ userId: 'a' }).i);
  await Promise.all(['b', 'c', 'd'].map((u) => command.execute(interaction({ userId: u }).i)));
  assert.equal(searches, 1);
  assert.equal(spotifyLoads, 1);
  const again = interaction({ userId: 'a' });
  await command.execute(again.i);
  assert.match(again.out.reply.content, /You just checked/);
});

test('concurrent first checks share one request', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const work = async () => {
    calls++;
    await gate;
    return true;
  };
  const a = status.probe('x', work),
    b = status.probe('x', work);
  release();
  assert.deepEqual((await a).ok, (await b).ok);
  assert.equal(calls, 1);
});
