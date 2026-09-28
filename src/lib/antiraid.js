// Manual lockdown (/lockdown on|off). While locked, new joiners are kicked with a DM explaining,
// and the verify button stops working. Saved in SQLite, so a restart or update doesn't end it.
const { db } = require('./db');

db.exec('CREATE TABLE IF NOT EXISTS lockdowns (guild_id TEXT PRIMARY KEY, until INTEGER NOT NULL)'); // until 0 = no end time

const timers = new Map(); // guildId -> timeout handle
const rowStmt = db.prepare('SELECT until FROM lockdowns WHERE guild_id = ?');

function schedule(guildId, until, onExpire) {
  clearTimeout(timers.get(guildId));
  timers.delete(guildId);
  if (!until) return;
  // setTimeout can't wait longer than ~24.8 days in one go: re-check in steps.
  const wait = Math.min(Math.max(0, until - Date.now()), 2 ** 31 - 1);
  const t = setTimeout(() => {
    if (Date.now() < until) return schedule(guildId, until, onExpire);
    unlock(guildId);
    onExpire?.();
  }, wait);
  t.unref?.();
  timers.set(guildId, t);
}

function lock(guildId, minutes, onExpire) {
  const until = minutes ? Date.now() + minutes * 60_000 : 0;
  db.prepare('INSERT INTO lockdowns (guild_id, until) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET until = excluded.until').run(guildId, until);
  schedule(guildId, until, onExpire);
}

function unlock(guildId) {
  clearTimeout(timers.get(guildId));
  timers.delete(guildId);
  db.prepare('DELETE FROM lockdowns WHERE guild_id = ?').run(guildId);
}

function isLocked(guildId) {
  const row = rowStmt.get(guildId);
  return !!row && (row.until === 0 || row.until > Date.now());
}

function lockInfo(guildId) {
  const row = rowStmt.get(guildId);
  return row ? { until: row.until || Infinity } : null;
}

// On start: bring back timers for lockdowns that were running before the restart.
// onExpire(guildId) is called when a timed one ends.
function restore(onExpire) {
  for (const row of db.prepare('SELECT * FROM lockdowns').all()) {
    if (row.until && row.until <= Date.now()) { unlock(row.guild_id); onExpire?.(row.guild_id); continue; }
    schedule(row.guild_id, row.until, () => onExpire?.(row.guild_id));
  }
  return db.prepare('SELECT COUNT(*) c FROM lockdowns').get().c;
}

module.exports = { lock, unlock, isLocked, lockInfo, restore };
