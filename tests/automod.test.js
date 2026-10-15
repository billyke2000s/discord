const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EmbedBuilder, Collection, PermissionsBitField, PermissionFlagsBits } = require('discord.js');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'automod-'));
const logged = [];
const realUtil = require('../src/lib/util');
require.cache[require.resolve('../src/lib/util')] = {
  exports: { ...realUtil, embed: () => new EmbedBuilder(), log: async (_g, e) => logged.push(e.toJSON().description) },
};
const { db, getSettings, updateSettings } = require('../src/lib/db');
const automod = require('../src/lib/automod');
const command = require('../src/commands/automod').commands[0];

const base = () => getSettings('g').automod;
const withRules = (rules, extra = {}) => {
  const cfg = base();
  for (const [r, action] of Object.entries(rules)) cfg.rules[r] = { enabled: true, action };
  return { ...cfg, ...extra };
};
const msgData = (content, extra = {}) => ({
  id: String(Math.random()),
  guildId: 'g',
  authorId: 'u',
  channelId: 'c',
  content,
  mentionCount: 0,
  ...extra,
});

beforeEach(() => {
  db.exec('DELETE FROM guild_settings; DELETE FROM warnings;');
  logged.length = 0;
  automod._resetSpam();
});

test('every rule is off by default and nothing is checked', async () => {
  const cfg = base();
  assert.ok(automod.RULES.every((r) => cfg.rules[r].enabled === false));
  assert.equal(await automod.check({ guild: {}, author: {} }, cfg), false);
});

test('blocked words match whole words, ignore case, accents and number swaps, and support *', () => {
  const words = ['badword', 'bad phrase', 'slur*'];
  assert.equal(automod.blockedWord('this is a BADWORD!', words), 'badword');
  assert.equal(automod.blockedWord('b4dw0rd', words), 'badword');
  assert.equal(automod.blockedWord('bádwórd', words), 'badword');
  assert.equal(automod.blockedWord('a  bad   phrase here', words), 'bad phrase');
  assert.equal(automod.blockedWord('slurring', words), 'slur*');
  assert.equal(automod.blockedWord('notbadwordy', words), null, 'not inside other words');
  assert.equal(automod.blockedWord('a bad day', words), null);
});

test('invites to other servers are caught; this server’s own invites are allowed', async () => {
  const cfg = withRules({ invites: 'delete' });
  const own = async (code) => code === 'ours';
  assert.equal((await automod.evaluate(msgData('join discord.gg/theirs'), cfg, { isOwnInvite: own })).rule, 'invites');
  assert.equal(await automod.evaluate(msgData('join https://discord.gg/ours'), cfg, { isOwnInvite: own }), null);
  assert.equal((await automod.evaluate(msgData('discord.com/invite/abc'), cfg)).rule, 'invites');
});

test('links rule allows listed sites and subdomains only', async () => {
  const cfg = withRules({ links: 'delete' });
  assert.equal(
    await automod.evaluate(msgData('look https://www.youtube.com/watch?v=x and https://media.tenor.com/a.gif'), cfg),
    null,
  );
  const hit = await automod.evaluate(msgData('free stuff https://sketchy.example/x'), cfg);
  assert.equal(hit.rule, 'links');
  assert.match(hit.detail, /sketchy\.example/);
  assert.equal((await automod.evaluate(msgData('https://youtube.com.evil.example/'), cfg)).rule, 'links');
});

test('caps ignore short messages, mentions and links', async () => {
  const cfg = withRules({ caps: 'delete' });
  assert.equal((await automod.evaluate(msgData('WHY IS EVERYONE SO LOUD TODAY'), cfg)).rule, 'caps');
  assert.equal(await automod.evaluate(msgData('OK LOL'), cfg), null);
  assert.equal(await automod.evaluate(msgData('<@123> HTTPS://EXAMPLE.COM/ABCDEFGHIJ thanks'), cfg), null);
  assert.equal(await automod.evaluate(msgData('This Is A Normal Sentence With Capitals'), cfg), null);
});

test('mentions over the limit are caught', async () => {
  const cfg = withRules({ mentions: 'timeout' });
  assert.equal(await automod.evaluate(msgData('hi', { mentionCount: 5 }), cfg), null);
  assert.equal((await automod.evaluate(msgData('hi', { mentionCount: 6 }), cfg)).rule, 'mentions');
});

test('spam: the 5th message within 5 seconds triggers once per burst; edits don’t count', async () => {
  const cfg = withRules({ spam: 'timeout' });
  let t = 1_000_000;
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await automod.evaluate(msgData(`m${i}`), cfg, { now: (t += 500) }));
  assert.deepEqual(
    results.map((r) => r?.rule || null),
    [null, null, null, null, 'spam', null],
  );
  assert.equal(results[4].extra.length, 5);
  automod._resetSpam();
  for (let i = 0; i < 6; i++)
    assert.equal(await automod.evaluate(msgData('e', { edited: true }), cfg, { now: (t += 100) }), null);
  assert.equal(await automod.evaluate(msgData('slow'), cfg, { now: t + 10_000 }), null);
});

function member({ perms = 0n, roles = [], id = 'u' } = {}) {
  const guild = { ownerId: 'owner' };
  return {
    id,
    guild,
    permissions: new PermissionsBitField(perms),
    roles: { cache: new Collection(roles.map((r) => [r, {}])) },
    moderatable: true,
  };
}

test('staff, owner, exempt roles and exempt channels (or their category) skip automod', () => {
  const cfg = { ...base(), exemptRoles: ['trusted'], exemptChannels: ['memes', 'cat'] };
  const chan = { id: 'general', parentId: 'other' };
  assert.equal(automod.exempt(member(), chan, cfg), false);
  assert.equal(automod.exempt(member({ perms: PermissionFlagsBits.ManageMessages }), chan, cfg), true);
  assert.equal(automod.exempt(member({ id: 'owner' }), chan, cfg), true);
  assert.equal(automod.exempt(member({ roles: ['trusted'] }), chan, cfg), true);
  assert.equal(automod.exempt(member(), { id: 'memes' }, cfg), true);
  assert.equal(automod.exempt(member(), { id: 'x', parentId: 'cat' }, cfg), true);
});

function discordMessage(content, m = member()) {
  const out = { deleted: false, dms: [], timedOut: null };
  m.timeout = async (ms) => {
    out.timedOut = ms;
  };
  return {
    out,
    msg: {
      id: '1',
      content,
      channelId: 'c',
      member: m,
      guild: { id: 'g', name: 'Test', channels: { cache: new Map() } },
      channel: { id: 'c', toString: () => '<#c>' },
      author: { id: 'u', bot: false, tag: 'user', toString: () => '<@u>', send: async (t) => out.dms.push(t) },
      client: { user: { id: 'bot' }, fetchInvite: async () => null },
      mentions: { users: new Collection(), roles: new Collection() },
      delete: async () => {
        out.deleted = true;
      },
    },
  };
}

test('actions: delete, warn (adds to /warnings) and timeout; every action is logged', async () => {
  updateSettings('g', { automod: { words: ['badword'], rules: { words: { enabled: true, action: 'warn' } } } });
  const a = discordMessage('you badword');
  assert.equal(await automod.check(a.msg, getSettings('g').automod), true);
  assert.equal(a.out.deleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM warnings').get().c, 1);
  assert.match(a.out.dms[0], /counts as a warning/);
  assert.match(logged[0], /Blocked words[\s\S]*warning #1/);

  updateSettings('g', { automod: { rules: { words: { enabled: true, action: 'timeout' } }, timeoutMinutes: 3 } });
  const b = discordMessage('badword again');
  await automod.check(b.msg, getSettings('g').automod);
  assert.equal(b.out.timedOut, 180_000);
  assert.match(logged[1], /3 min timeout/);

  const staff = discordMessage('badword', member({ perms: PermissionFlagsBits.ManageMessages }));
  assert.equal(await automod.check(staff.msg, getSettings('g').automod), false);
  assert.equal(staff.out.deleted, false);
});

async function run(sub, opts = {}) {
  let reply;
  await command.execute({
    guildId: 'g',
    guild: {},
    user: { toString: () => '<@admin>' },
    options: {
      getSubcommand: () => sub,
      getString: (n) => opts[n] ?? null,
      getBoolean: (n) => opts[n] ?? null,
      getInteger: (n) => opts[n] ?? null,
      getRole: (n) => opts[n] ?? null,
      getChannel: (n) => opts[n] ?? null,
    },
    reply: async (p) => {
      reply = p;
    },
  });
  return reply.content || reply.embeds?.[0]?.toJSON().description;
}

test('/automod sets rules, words, links and limits, and logs changes', async () => {
  assert.equal(command.data.toJSON().default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.match(await run('rule', { rule: 'words', enabled: true }), /list is empty/);
  await run('words-add', { words: 'one, two , one, ' });
  assert.deepEqual(getSettings('g').automod.words, ['one', 'two']);
  await run('words-remove', { word: 'ONE' });
  assert.deepEqual(getSettings('g').automod.words, ['two']);
  assert.match(await run('rule', { rule: 'caps', enabled: true, action: 'warn' }), /add a warning/);
  assert.equal(getSettings('g').automod.rules.caps.action, 'warn');
  await run('links-allow', { domain: 'https://www.Example.com/path' });
  assert.ok(getSettings('g').automod.allowedLinks.includes('example.com'));
  assert.match(await run('links-allow', { domain: 'not a domain' }), /doesn’t look like a domain/);
  await run('limits', { max_mentions: 3, timeout_minutes: 60 });
  assert.equal(getSettings('g').automod.maxMentions, 3);
  assert.equal(getSettings('g').automod.timeoutMinutes, 60);
  assert.ok(logged.length >= 5);
});

test('/automod test tries every rule, even ones that are off', async () => {
  assert.match(await run('test', { text: 'hello there' }), /Nothing would catch/);
  assert.match(await run('test', { text: 'GO TO https://sketchy.example NOW PLEASE' }), /Links[\s\S]*off right now/);
});
