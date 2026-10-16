const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MessageFlags } = require('discord.js');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mywarnings-'));
const { db } = require('../src/lib/db');
const { commands } = require('../src/commands');
const { hasCommandPermission } = require('../src/lib/permissions');

const mywarnings = commands.get('mywarnings');
const add = (user, mod, reason, at) =>
  db
    .prepare('INSERT INTO warnings (guild_id, user_id, mod_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('g', user, mod, reason, at);

async function run(userId) {
  let reply;
  await mywarnings.execute({
    guildId: 'g',
    user: { id: userId },
    client: { user: { id: 'bot' } },
    reply: async (p) => {
      reply = p;
    },
  });
  return reply;
}

test('/mywarnings is open to everyone', () => {
  assert.ok(mywarnings, 'command is registered');
  assert.equal(hasCommandPermission(mywarnings, null), true);
});

test('/mywarnings shows only your own warnings with reasons, privately, without naming the moderator', async () => {
  add('me', 'mod123', 'Spamming in general', 1_700_000_000_000);
  add('me', 'bot', 'Automod: Blocked words (a blocked word)', 1_700_100_000_000);
  add('someone-else', 'mod123', 'Not yours', 1_700_200_000_000);

  const reply = await run('me');
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  const e = reply.embeds[0].toJSON();
  assert.match(e.title, /\(2\)/);
  assert.match(e.description, /staff: Spamming in general/);
  assert.match(e.description, /automod: Automod: Blocked words/);
  assert.doesNotMatch(e.description, /Not yours/);
  assert.doesNotMatch(e.description, /mod123/);
  // Newest first
  assert.ok(e.description.indexOf('automod') < e.description.indexOf('Spamming'));
});

test('/mywarnings with no warnings says so', async () => {
  const reply = await run('clean');
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.match(reply.content, /no warnings/);
});
