// Registers the slash commands per server. Once a server has been rebuilt, /setup rebuild is left out of
// that server's command list entirely, so nobody can even see it. It only comes back if ALLOW_REBUILD=yes
// is set in .env on the VPS and the bot is restarted.
//
// The lock is stored twice: in the database AND as a file in ./locks on the VPS (outside Docker's data
// volume). Either one is enough to keep it locked, so wiping the database alone doesn't unlock it.
const fs = require('fs');
const path = require('path');
const { getSettings, updateSettings } = require('./db');

const LOCK_DIR = process.env.LOCK_DIR || path.join(__dirname, '..', '..', 'locks');
const lockFile = (guildId) => path.join(LOCK_DIR, `rebuild-done-${guildId}`);

function hasLockFile(guildId) {
  try { return fs.existsSync(lockFile(guildId)); } catch { return false; }
}

function rebuildLocked(guildId) {
  if (process.env.ALLOW_REBUILD === 'yes') return false;
  return !!getSettings(guildId).rebuildDone || hasLockFile(guildId);
}

// Record that this server has been built. Writes both copies; a failed file write is logged, not fatal.
function markRebuildDone(guildId) {
  updateSettings(guildId, { rebuildDone: true });
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(lockFile(guildId), `Server ${guildId} was built on ${new Date().toISOString()}.\nTo allow /setup rebuild again, set ALLOW_REBUILD=yes in .env and restart the bot.\n`);
  } catch (e) {
    console.error(`[lock] couldn't write ${lockFile(guildId)}: ${e.message}`);
  }
}

// On start: if only one copy exists (e.g. the database was wiped), restore the other.
function repairLock(guildId) {
  const db = !!getSettings(guildId).rebuildDone, file = hasLockFile(guildId);
  if (db !== file && (db || file)) markRebuildDone(guildId);
}

function commandBody(guildId) {
  const { commands } = require('../commands'); // lazy: commands/ requires this file indirectly
  return [...commands.values()].map((c) => {
    const json = c.data.toJSON();
    if (json.name === 'setup' && rebuildLocked(guildId)) {
      json.options = json.options.filter((o) => o.name !== 'rebuild');
    }
    return json;
  });
}

async function syncGuild(guild) {
  repairLock(guild.id);
  const body = commandBody(guild.id);
  await guild.commands.set(body);
  console.log(`[commands] ${body.length} commands registered in ${guild.name}${rebuildLocked(guild.id) ? ' (/setup rebuild hidden: locked)' : ''}`);
}

module.exports = { rebuildLocked, markRebuildDone, repairLock, commandBody, syncGuild, LOCK_DIR };
