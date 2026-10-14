const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { hasCommandPermission } = require('../src/lib/permissions');
test('runtime command permissions reject a user even if Discord exposes the command', () => {
  const command = { data: new SlashCommandBuilder().setName('ban').setDescription('ban').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers) };
  assert.equal(hasCommandPermission(command, new PermissionsBitField()), false);
  assert.equal(hasCommandPermission(command, new PermissionsBitField(PermissionFlagsBits.BanMembers)), true);
  assert.equal(hasCommandPermission(command, new PermissionsBitField(PermissionFlagsBits.Administrator)), true);
  assert.equal(hasCommandPermission(command, null), false);
  assert.equal(hasCommandPermission({ data: new SlashCommandBuilder().setName('play').setDescription('play') }, null), true);
});
test('captcha submitted after lockdown starts cannot grant a role', async () => {
  let granted = false;
  require.cache[require.resolve('../src/lib/db')] = { exports: { db: {}, getSettings: () => ({ verify: { enabled: true, memberRole: 'member' } }) } };
  require.cache[require.resolve('../src/lib/util')] = { exports: { embed: () => {}, log: () => {} } };
  require.cache[require.resolve('../src/lib/antiraid')] = { exports: { isLocked: () => true } };
  const verify = require('../src/commands/verify');
  let reply;
  await verify.components['verify:modal']({ guildId: 'guild', member: { roles: { add: () => { granted = true; } } },
    reply: async (r) => { reply = r; } });
  assert.equal(granted, false); assert.match(reply.content, /lockdown/);
});
