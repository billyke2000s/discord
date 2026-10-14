const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ensureOwnerRole } = require('../src/lib/owner-role');
function fixture() {
  const saved = {}; const assigned = []; let creates = 0;
  const role = { id: 'role', permissions: { bitfield: 0n }, managed: false };
  const guild = { id: 'guild', ownerId: 'owner', roles: { cache: new Map(), fetch: async () => {}, create: async data => {
    creates++; assert.deepEqual(data.permissions, []); assert.equal(data.hoist, true); assert.equal(data.mentionable, false);
    guild.roles.cache.set(role.id, role); return role;
  } }, fetchOwner: async () => ({ roles: { add: async r => assigned.push(r.id) } }) };
  return { guild, role, saved, assigned, count: () => creates, save: patch => Object.assign(saved, patch) };
}
test('only actual ownership authorizes the display role, not an admin-like actor ID', async () => {
  const f = fixture(); await assert.rejects(ensureOwnerRole(f.guild, 'admin', {}, f.save), /actual server owner/);
  assert.equal(f.count(), 0); assert.deepEqual(f.assigned, []);
});
test('create a powerless display role and reuse it on later calls', async () => {
  const f = fixture(); await ensureOwnerRole(f.guild, 'owner', f.saved, f.save);
  await ensureOwnerRole(f.guild, 'owner', f.saved, f.save);
  assert.equal(f.count(), 1); assert.equal(f.saved.ownerRole, 'role'); assert.deepEqual(f.assigned, ['role', 'role']);
});
test('concurrent calls create only one role', async () => {
  const f = fixture(); await Promise.all([ensureOwnerRole(f.guild, 'owner', {}, f.save), ensureOwnerRole(f.guild, 'owner', {}, f.save)]);
  assert.equal(f.count(), 1); assert.equal(f.assigned.length, 1);
});
test('a saved role that gained permissions is refused without changing it', async () => {
  const f = fixture(); f.role.permissions.bitfield = 8n; f.guild.roles.cache.set('role', f.role);
  await assert.rejects(ensureOwnerRole(f.guild, 'owner', { ownerRole: 'role' }, f.save), /plain display role/);
  assert.equal(f.count(), 0); assert.deepEqual(f.assigned, []);
});
test('an assignment failure keeps the saved role for a retry', async () => {
  const f = fixture(); f.guild.fetchOwner = async () => ({ roles: { add: async () => { throw new Error('hierarchy'); } } });
  await assert.rejects(ensureOwnerRole(f.guild, 'owner', f.saved, f.save), /hierarchy/);
  assert.equal(f.saved.ownerRole, 'role'); assert.equal(f.count(), 1);
});

