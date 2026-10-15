// A cosmetic label for the actual guild owner. No Administrator permission is added.
const creating = new Map();
async function ensureOwnerRole(guild, actorId, settings, save) {
  if (actorId !== guild.ownerId) throw new Error('Only the actual server owner can create this display role.');
  if (creating.has(guild.id)) return creating.get(guild.id);
  const task = (async () => {
    await guild.roles.fetch();
    const owner = await guild.fetchOwner();
    let role = settings.ownerRole ? guild.roles.cache.get(settings.ownerRole) : null;
    if (role && (role.managed || role.id === guild.id || role.permissions.bitfield !== 0n))
      throw new Error(
        'The saved Owner role is no longer a plain display role. Review it in Server Settings → Roles first.',
      );
    if (!role) {
      role = await guild.roles.create({
        name: 'Owner',
        colors: { primaryColor: 0xf1c40f },
        hoist: true,
        mentionable: false,
        permissions: [],
        reason: 'Automatic Owner display role from server setup',
      });
      // Save before assigning: a retry after an assignment error reuses this role.
      save({ ownerRole: role.id });
    }
    await owner.roles.add(role, 'Display role for the actual server owner');
    return role;
  })();
  creating.set(guild.id, task);
  try {
    return await task;
  } finally {
    creating.delete(guild.id);
  }
}
async function ensureConfiguredOwnerRole(guild, settings, save, configuredId = process.env.OWNER_ID) {
  // Older installations have no OWNER_ID. Discord's ownerId is authoritative;
  // never guess ownership from a list of bot administrators.
  if (configuredId && configuredId !== guild.ownerId)
    throw new Error('OWNER_ID does not match the actual Discord server owner. Rerun the installer to update it.');
  return ensureOwnerRole(guild, guild.ownerId, settings, save);
}
module.exports = { ensureOwnerRole, ensureConfiguredOwnerRole };
