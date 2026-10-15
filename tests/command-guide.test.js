const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChannelType, Collection } = require('discord.js');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-'));
const { db, getSettings, updateSettings } = require('../src/lib/db');
const guide = require('../src/lib/command-guide');

beforeEach(() => db.exec('DELETE FROM guild_settings'));

const text = (e) => JSON.stringify(e.toJSON());

test('the guide lists only member commands, and only for features that are on', () => {
  const all = text(guide.guideEmbed({ ...getSettings('g'), jtc: { lobbyChannel: 'lobby' } }));
  for (const cmd of [
    '/play',
    '/queue',
    '/skip',
    '/stop',
    '/nowplaying',
    '/status',
    '/rank',
    '/leaderboard',
    '/birthday',
    '/vc',
    '/help',
  ])
    assert.ok(all.includes(cmd), cmd);
  for (const cmd of [
    '/warn',
    '/ban',
    '/kick ',
    '/timeout',
    '/purge',
    '/setup',
    '/diagnostics',
    '/levels',
    '/automod',
    '/live',
    '/lockdown',
    '/update',
    '/buttonroles',
  ])
    assert.ok(!all.includes(cmd), `${cmd} must not be listed`);
  const minimal = text(
    guide.guideEmbed({ ...getSettings('g'), levels: { enabled: false }, jtc: { lobbyChannel: null } }),
  );
  assert.ok(!minimal.includes('/rank'));
  assert.ok(!minimal.includes('/vc'));
});

function fakeGuild(names) {
  const sent = [],
    edits = [],
    pins = [];
  const channels = new Collection(
    names.map((name, i) => {
      const id = `c${i}`;
      return [
        id,
        {
          id,
          name,
          type: ChannelType.GuildText,
          permissionsFor: () => ({ has: () => true }),
          send: async (p) => {
            const m = { id: `m${sent.length}`, pin: async () => pins.push(id), edit: async (q) => edits.push(q) };
            sent.push({ id, p, m });
            return m;
          },
          messages: { fetch: async (mid) => sent.find((x) => x.m.id === mid)?.m || null },
        },
      ];
    }),
  );
  return { guild: { id: 'g', members: { me: {} }, channels: { cache: channels } }, sent, edits, pins };
}

test('finds the bot-commands channel, posts and pins once, then edits the same message', async () => {
  const { guild, sent, edits, pins } = fakeGuild(['general', '🤖・bot-commands']);
  const first = await guide.postGuide(guild);
  assert.equal(first.reason, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 'c1');
  assert.deepEqual(pins, ['c1']);
  await guide.postGuide(guild);
  assert.equal(sent.length, 1, 'no second post');
  assert.equal(edits.length, 1);
});

test('no channel, two candidates, or switched off: nothing is posted', async () => {
  assert.equal((await guide.postGuide(fakeGuild(['general']).guild)).reason, 'no bot-commands channel');
  assert.equal(
    (await guide.postGuide(fakeGuild(['bot-commands', 'old-bot-commands']).guild)).reason,
    'no bot-commands channel',
  );
  const one = fakeGuild(['bot-commands']);
  updateSettings('g', { commandsGuide: { channel: 'off' } });
  await guide.postGuide(one.guild);
  assert.equal(one.sent.length, 0);
});
