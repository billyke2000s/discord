// Saved music sessions, so the queue and current song survive bot restarts, updates and music-server reconnects.
// One row per server. Removed when music is stopped on purpose (vote/staff stop, everyone left, idle).
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS music_sessions (
  guild_id   TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)`);

const saveStmt = db.prepare(
  'INSERT INTO music_sessions (guild_id, data, position, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data, position = excluded.position, updated_at = excluded.updated_at',
);
// The song position changes all the time; updating it alone avoids rewriting a 2,000-song queue every 30 s.
const positionStmt = db.prepare('UPDATE music_sessions SET position = ?, updated_at = ? WHERE guild_id = ?');
const removeStmt = db.prepare('DELETE FROM music_sessions WHERE guild_id = ?');
const allStmt = db.prepare('SELECT guild_id, data, position, updated_at FROM music_sessions');

function save(guildId, data, position = 0) {
  saveStmt.run(guildId, JSON.stringify(data), Math.max(0, Math.round(position)), Date.now());
}
function savePosition(guildId, position) {
  positionStmt.run(Math.max(0, Math.round(position)), Date.now(), guildId);
}
function remove(guildId) {
  removeStmt.run(guildId);
}
// Rows that can't be read are dropped instead of stopping every other server's music from resuming.
function all() {
  const out = [];
  for (const row of allStmt.all()) {
    try {
      out.push({
        guildId: row.guild_id,
        updatedAt: row.updated_at,
        position: row.position,
        data: JSON.parse(row.data),
      });
    } catch {
      remove(row.guild_id);
    }
  }
  return out;
}

module.exports = { save, savePosition, remove, all };
