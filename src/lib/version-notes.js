// "The bot was updated" notes. The release build bakes the titles of the pull requests merged since the
// previous release into the image (BOT_BUILD_NOTES, a JSON list). On start-up the bot compares its
// version with the one it last ran as; when it changed, the music that carries on says what's new.
const { escapeMarkdown } = require('discord.js');
const { db } = require('./db');

db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const getStmt = db.prepare('SELECT value FROM meta WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

const MAX_NOTES = 8;

function parseNotes(raw) {
  let list;
  try {
    list = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => n.trim().replace(/\s+/g, ' ').slice(0, 150))
    .slice(0, MAX_NOTES);
}

// Call once at start-up. Returns { version, notes, at } if this start follows an update, else null.
function checkUpdated(version = process.env.BOT_BUILD_VERSION, rawNotes = process.env.BOT_BUILD_NOTES) {
  if (!version || version === 'development') return null;
  const previous = getStmt.get('version')?.value;
  if (previous !== version) setStmt.run('version', version);
  if (!previous || previous === version) return null; // first run, or a plain restart
  return { version, notes: parseNotes(rawNotes), at: Date.now() };
}

function updateMessage({ version, notes }) {
  const head = `✨ **The bot was updated** to \`${escapeMarkdown(version)}\`.`;
  if (!notes?.length) return `${head} The music panel shows any new controls from this song on.`;
  return `${head} What's new:\n${notes.map((n) => `• ${escapeMarkdown(n)}`).join('\n')}`;
}

module.exports = { checkUpdated, updateMessage, parseNotes };
