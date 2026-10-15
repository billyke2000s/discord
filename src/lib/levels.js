// Levelling: members earn XP for chatting, level up, and can get roles at set levels.
// XP: 15–25 per message, at most once a minute per member, so spamming doesn't help.
// The curve matches what most Discord levelling bots use: level n → n+1 needs 5n² + 50n + 100 XP.
const crypto = require('node:crypto');
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS levels (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  xp         INTEGER NOT NULL DEFAULT 0,
  messages   INTEGER NOT NULL DEFAULT 0,
  last_xp_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
)`);
db.exec('CREATE INDEX IF NOT EXISTS levels_rank ON levels (guild_id, xp DESC)');

const XP_MIN = 15;
const XP_MAX = 25;
const COOLDOWN_MS = 60_000;
const MAX_LEVEL = 500;

const getStmt = db.prepare('SELECT xp, messages, last_xp_at FROM levels WHERE guild_id = ? AND user_id = ?');
const upsertStmt = db.prepare(
  'INSERT INTO levels (guild_id, user_id, xp, messages, last_xp_at) VALUES (?, ?, ?, 1, ?) ' +
    'ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = xp + excluded.xp, messages = messages + 1, last_xp_at = excluded.last_xp_at',
);
const countStmt = db.prepare('UPDATE levels SET messages = messages + 1 WHERE guild_id = ? AND user_id = ?');
const setStmt = db.prepare(
  'INSERT INTO levels (guild_id, user_id, xp) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = excluded.xp',
);
const resetStmt = db.prepare('DELETE FROM levels WHERE guild_id = ? AND user_id = ?');
const resetAllStmt = db.prepare('DELETE FROM levels WHERE guild_id = ?');
const rankStmt = db.prepare('SELECT COUNT(*) + 1 AS rank FROM levels WHERE guild_id = ? AND xp > ?');
const totalStmt = db.prepare('SELECT COUNT(*) AS n FROM levels WHERE guild_id = ? AND xp > 0');
const topStmt = db.prepare(
  'SELECT user_id, xp, messages FROM levels WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC, user_id LIMIT ? OFFSET ?',
);

// XP needed to go from level n to n+1.
const xpToNext = (level) => 5 * level * level + 50 * level + 100;

// Total XP → { level, into (XP into this level), needed (XP this level takes) }.
function levelFromXp(total) {
  let level = 0;
  let rest = Math.max(0, Math.floor(total));
  while (level < MAX_LEVEL && rest >= xpToNext(level)) {
    rest -= xpToNext(level);
    level++;
  }
  return { level, into: rest, needed: xpToNext(level) };
}

// Total XP at the start of a level (for /levels set-level).
function xpForLevel(level) {
  let total = 0;
  for (let n = 0; n < Math.min(level, MAX_LEVEL); n++) total += xpToNext(n);
  return total;
}

// Award XP for one message. Returns { gained, before, after } or null if on cooldown.
function award(guildId, userId, now = Date.now(), random = () => crypto.randomInt(XP_MIN, XP_MAX + 1)) {
  const row = getStmt.get(guildId, userId);
  if (row && now - row.last_xp_at < COOLDOWN_MS) {
    countStmt.run(guildId, userId);
    return null;
  }
  const gained = random();
  const beforeXp = row?.xp || 0;
  upsertStmt.run(guildId, userId, gained, now);
  return {
    gained,
    before: levelFromXp(beforeXp).level,
    after: levelFromXp(beforeXp + gained).level,
    xp: beforeXp + gained,
  };
}

function stats(guildId, userId) {
  const row = getStmt.get(guildId, userId);
  const xp = row?.xp || 0;
  return {
    xp,
    messages: row?.messages || 0,
    ...levelFromXp(xp),
    rank: xp > 0 ? rankStmt.get(guildId, xp).rank : null,
    ranked: totalStmt.get(guildId).n,
  };
}

const top = (guildId, limit = 10, offset = 0) => topStmt.all(guildId, limit, offset);
const ranked = (guildId) => totalStmt.get(guildId).n;
const setXp = (guildId, userId, xp) => setStmt.run(guildId, userId, Math.max(0, Math.floor(xp)));
const reset = (guildId, userId) => resetStmt.run(guildId, userId).changes;
const resetAll = (guildId) => resetAllStmt.run(guildId).changes;

// Reward roles a member should have at `level`: every reward at or below it, or only the highest when not stacking.
function rewardsFor(rewards, level, stack = true) {
  const earned = (rewards || []).filter((r) => r.level <= level).sort((a, b) => a.level - b.level);
  if (stack) return earned;
  return earned.length ? [earned[earned.length - 1]] : [];
}

module.exports = {
  award,
  stats,
  top,
  ranked,
  setXp,
  reset,
  resetAll,
  rewardsFor,
  levelFromXp,
  xpForLevel,
  xpToNext,
  COOLDOWN_MS,
  XP_MIN,
  XP_MAX,
  MAX_LEVEL,
};
