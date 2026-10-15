function hasCommandPermission(command, permissions) {
  const required = command?.data.toJSON().default_member_permissions;
  return !required || !!permissions?.has(BigInt(required));
}
module.exports = { hasCommandPermission };
