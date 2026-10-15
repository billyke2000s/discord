const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EmbedBuilder, Collection, PermissionsBitField } = require('discord.js');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'levels-'));
const logged = [];
const realUtil = require('../src/lib/util');
require.cache[require.resolve('../src/lib/util')] = {
  exports: { ...realUtil, embed: () => new EmbedBuilder(), log: async (_g, e) => logged.push(e.toJSON().description) },
};
const { db, updateSettings, getSettings } = require('../src/lib/db');
const levels = require('../src/lib/levels');
const cmd = require('../src/commands/levels');

beforeEach(() => {
  db.exec('DELETE FROM levels; DELETE FROM guild_settings;');
  logged.length = 0;
});

test('the level curve matches the usual 5n² + 50n + 100 and round-trips', () => {
  assert.equal(levels.xpToNext(0), 100);
  assert.equal(levels.xpToNext(1), 155);
  assert.deepEqual(levels.levelFromXp(0), { level: 0, into: 0, needed: 100 });
  assert.deepEqual(levels.levelFromXp(99), { level: 0, into: 99, needed: 100 });
  assert.deepEqual(levels.levelFromXp(100), { level: 1, into: 0, needed: 155 });
  for (const n of [0, 1, 5, 20, 50]) assert.equal(levels.levelFromXp(levels.xpForLevel(n)).level, n);
});

test('XP is given at most once a minute; messages are still counted', () => {
  const t = 1_000_000;
  assert.equal(levels.award('g', 'u', t, () => 20).gained, 20);
  assert.equal(
    levels.award('g', 'u', t + 30_000, () => 20),
    null,
  );
  assert.equal(levels.award('g', 'u', t + 60_000, () => 25).xp, 45);
  const st = levels.stats('g', 'u');
  assert.equal(st.xp, 45);
  assert.equal(st.messages, 3);
  assert.equal(st.rank, 1);
});

test('rank and leaderboard order by XP', () => {
  levels.setXp('g', 'a', 500);
  levels.setXp('g', 'b', 1500);
  levels.setXp('g', 'c', 50);
  assert.deepEqual(
    levels.top('g').map((r) => r.user_id),
    ['b', 'a', 'c'],
  );
  assert.equal(levels.stats('g', 'a').rank, 2);
  assert.equal(levels.ranked('g'), 3);
  assert.equal(levels.stats('g', 'nobody').rank, null);
});

test('reward roles stack by default or keep only the highest', () => {
  const rewards = [
    { level: 10, roleId: 'r10' },
    { level: 5, roleId: 'r5' },
    { level: 20, roleId: 'r20' },
  ];
  assert.deepEqual(
    levels.rewardsFor(rewards, 12).map((r) => r.roleId),
    ['r5', 'r10'],
  );
  assert.deepEqual(
    levels.rewardsFor(rewards, 12, false).map((r) => r.roleId),
    ['r10'],
  );
  assert.deepEqual(levels.rewardsFor(rewards, 2), []);
});

function fakeRole(id, name, { position = 1, perms = 0n } = {}) {
  return {
    id,
    name,
    managed: false,
    position,
    permissions: new PermissionsBitField(perms),
    toString: () => `<@&${id}>`,
    guild: null,
  };
}
function fakeGuild(roles) {
  const guild = {
    id: 'g',
    roles: { cache: new Collection(roles.map((r) => [r.id, r])) },
    channels: { cache: new Map() },
  };
  for (const r of roles) r.guild = guild;
  guild.members = { me: { roles: { highest: { comparePositionTo: (r) => 10 - r.position } } } };
  return guild;
}
function fakeMessage(guild, channelId = 'chat') {
  const have = new Collection();
  const sent = [];
  const member = {
    guild,
    roles: {
      cache: have,
      add: async (r) => {
        have.set(r.id, r);
      },
      remove: async (r) => {
        have.delete(r.id);
      },
    },
  };
  return {
    sent,
    member,
    msg: {
      guild,
      member,
      channelId,
      author: { id: 'u', toString: () => '<@u>' },
      channel: { isThread: () => false, send: async (p) => sent.push(p) },
    },
  };
}

test('levelling up posts a message and gives the reward role; ignored channels earn nothing', async () => {
  const reward = fakeRole('r1', 'Regular');
  const guild = fakeGuild([reward]);
  updateSettings('g', { levels: { rewards: [{ level: 1, roleId: 'r1' }] } });
  levels.setXp('g', 'u', 95);
  const { msg, sent, member } = fakeMessage(guild);
  const result = await cmd.handleMessage(msg, getSettings('g'));
  assert.equal(result.after, 1);
  assert.ok(member.roles.cache.has('r1'));
  assert.match(sent[0].content, /<@u> reached \*\*level 1\*\*! You got \*\*Regular\*\*/);
  assert.deepEqual(sent[0].allowedMentions, { users: ['u'] });

  updateSettings('g', { levels: { ignoredChannels: ['quiet'] } });
  db.exec('UPDATE levels SET last_xp_at = 0');
  assert.equal(await cmd.handleMessage(fakeMessage(guild, 'quiet').msg, getSettings('g')), null);
  updateSettings('g', { levels: { ignoredChannels: [], enabled: false } });
  assert.equal(await cmd.handleMessage(fakeMessage(guild).msg, getSettings('g')), null);
});

test('announcements can go to one channel or nowhere', async () => {
  const guild = fakeGuild([]);
  const channelSent = [];
  guild.channels.cache.set('levelups', { send: async (p) => channelSent.push(p) });
  updateSettings('g', { levels: { announce: 'channel', announceChannel: 'levelups' } });
  levels.setXp('g', 'u', 99);
  const a = fakeMessage(guild);
  await cmd.handleMessage(a.msg, getSettings('g'));
  assert.equal(a.sent.length, 0);
  assert.equal(channelSent.length, 1);

  updateSettings('g', { levels: { announce: 'off' } });
  levels.setXp('g', 'u', levels.xpForLevel(2) - 1);
  db.exec('UPDATE levels SET last_xp_at = 0');
  const b = fakeMessage(guild);
  await cmd.handleMessage(b.msg, getSettings('g'));
  assert.equal(b.sent.length, 0);
  assert.equal(channelSent.length, 1);
});

test('dangerous or too-high roles can’t be rewards; non-stacking removes lower rewards', async () => {
  const mod = fakeRole('mod', 'Mod', { perms: PermissionsBitField.Flags.BanMembers });
  const high = fakeRole('high', 'High', { position: 50 });
  const low = fakeRole('low', 'Low'),
    mid = fakeRole('mid', 'Mid');
  const guild = fakeGuild([mod, high, low, mid]);
  assert.match(cmd.rewardProblem(mod), /moderator\/admin permissions/);
  assert.match(cmd.rewardProblem(high), /above my highest role/);
  assert.equal(cmd.rewardProblem(low), null);

  const { member } = fakeMessage(guild);
  const cfg = {
    rewards: [
      { level: 1, roleId: 'low' },
      { level: 5, roleId: 'mid' },
      { level: 9, roleId: 'mod' },
    ],
    stackRewards: false,
  };
  await cmd.syncRewards(member, 1, cfg);
  assert.deepEqual([...member.roles.cache.keys()], ['low']);
  await cmd.syncRewards(member, 9, cfg);
  assert.deepEqual([...member.roles.cache.keys()], ['mid'], 'mod role never given; low removed');
});

test('/levels needs Manage Server; /rank and /leaderboard are for everyone', () => {
  const [rank, leaderboard, admin] = cmd.commands;
  assert.equal(rank.data.toJSON().default_member_permissions, undefined);
  assert.equal(leaderboard.data.toJSON().default_member_permissions, undefined);
  assert.equal(admin.data.toJSON().default_member_permissions, String(PermissionsBitField.Flags.ManageGuild));
});

test('/levels set moves a member to the start of a level and is logged', async () => {
  const admin = cmd.commands[2];
  let reply;
  await admin.execute({
    guildId: 'g',
    user: { toString: () => '<@admin>' },
    guild: { members: { fetch: async () => null } },
    options: {
      getSubcommand: () => 'set',
      getUser: () => ({ id: 'u', bot: false, toString: () => '<@u>' }),
      getInteger: () => 7,
    },
    reply: async (p) => {
      reply = p;
    },
  });
  assert.equal(levels.stats('g', 'u').level, 7);
  assert.equal(levels.stats('g', 'u').into, 0);
  assert.match(reply.embeds[0].toJSON().description, /level 7/);
  assert.match(logged[0], /set <@u>'s level to 7/);
});
