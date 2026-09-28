// SQLite storage. Every table is keyed by guild_id so the bot can go multi-server later
// without a schema change.
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const dir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new Database(path.join(dir, 'bot.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000'); // wait instead of failing if a backup/other process briefly holds the DB

// Refuse to run on a damaged database instead of making it worse.
const health = db.pragma('quick_check', { simple: true });
if (health !== 'ok') {
  console.error(`[db] The database is damaged (${health}). The bot will not start on it.`);
  console.error('[db] Restore a backup: stop the bot, copy a file from /root/server-bot/backups over the database, start again.');
  console.error('[db] See README -> "Restoring a backup".');
  process.exit(1);
}

db.exec(`
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  data     TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS temp_vcs (
  channel_id TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_verify (
  guild_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS warnings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  mod_id     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  channel_id TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Default settings. Anything unset is null = feature off / not configured.
const DEFAULTS = {
  logChannel: null,
  welcomeChannel: null,
  rebuildDone: false,        // set after a successful /setup rebuild; locks the command
  welcomeMessage: 'Welcome {user} to **{server}**!',
  verify: {
    enabled: false,
    memberRole: null,        // role granted on pass; @everyone should only see the verify channel
    timeoutMinutes: 15,      // kick if not verified within this time (0 = never kick)
    minAccountAgeDays: 3,    // accounts younger than this get flagged in the log channel
  },
  jtc: {
    lobbyChannel: null,      // the "join to create" channel
    categoryId: null,        // where new channels go (defaults to lobby's category)
    defaultLimit: 0,
  },
  tickets: {
    categoryId: null,
    staffRole: null,
  },
  scamFilter: {
    enabled: true,
    timeoutHours: 24,        // timeout for posting a known scam link (0 = just delete)
    blockMassPingLinks: true,// non-staff @everyone/@here + link = hacked account, delete + timeout
    crossChannelSpam: 3,     // same message in this many channels within 30s = hacked account (0 = off)
    allow: [],               // domains never treated as scams (if a list ever gets one wrong)
  },
  selfPromo: {
    channel: null,
    minDays: 7,              // must have been in the server this long to post
  },
  suggestions: {
    channel: null,           // messages get 👍/👎 and a discussion thread
  },
};

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

const getStmt = db.prepare('SELECT data FROM guild_settings WHERE guild_id = ?');
const setStmt = db.prepare(
  'INSERT INTO guild_settings (guild_id, data) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data'
);

function getSettings(guildId) {
  const row = getStmt.get(guildId);
  return deepMerge(DEFAULTS, row ? JSON.parse(row.data) : {});
}

// patch is merged into existing settings, e.g. updateSettings(id, { verify: { enabled: true } })
function updateSettings(guildId, patch) {
  const merged = deepMerge(getSettings(guildId), patch);
  setStmt.run(guildId, JSON.stringify(merged));
  return merged;
}

module.exports = { db, getSettings, updateSettings };
