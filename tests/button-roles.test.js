const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField } = require('discord.js');
require.cache[require.resolve('../src/lib/db')] = {
  exports: {
    getSettings: () => ({
      verify: { memberRole: 'member' },
      tickets: { staffRole: 'staff' },
      ownerRole: 'owner-display',
      birthdayRole: 'birthday',
    }),
  },
};
const { blockedReason } = require('../src/commands/roles');

const role = (id) => ({ id, managed: false, guild: { id: 'g' }, permissions: new PermissionsBitField(0n) });

test('the Owner display role and the Birthday role can never be self-assigned', () => {
  assert.match(blockedReason(role('owner-display')), /Owner/);
  assert.match(blockedReason(role('birthday')), /Birthday/);
  assert.match(blockedReason(role('member')), /Member/);
  assert.match(blockedReason(role('staff')), /Staff/);
  assert.equal(blockedReason(role('gamer')), null, 'ordinary roles are still allowed');
});
