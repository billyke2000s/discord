// Database backups into ./backups on the VPS (bind-mounted to /app/backups).
//   daily:      once a day, the last 7 are kept
//   weekly:     every Sunday, the last 4 are kept
//   pre-update: made by install.sh before updating, the last 5 are kept
// Run by hand:  docker compose exec bot node src/lib/backup.js [tag]
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db');

const DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
const KEEP = { daily: 7, weekly: 4, 'pre-update': 5, manual: 5 };
const NAME_RE = /^bot-(\d{4}-\d{2}-\d{2})-(\d{4})-([a-z-]+)\.sqlite$/;

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return { day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}${p(d.getMinutes())}` };
};

function list(tag) {
  let files = [];
  try { files = fs.readdirSync(DIR); } catch { return []; }
  return files.map((f) => ({ f, m: NAME_RE.exec(f) })).filter((x) => x.m && (!tag || x.m[3] === tag))
    .map((x) => ({ file: x.f, day: x.m[1], tag: x.m[3] })).sort((a, b) => a.file.localeCompare(b.file));
}

function prune(tag) {
  const keep = KEEP[tag] ?? 5;
  const all = list(tag);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    try { fs.unlinkSync(path.join(DIR, old.file)); } catch {}
  }
}

// Safe while the bot is running (SQLite's online backup).
async function run(tag = 'manual') {
  fs.mkdirSync(DIR, { recursive: true });
  const { day, time } = stamp();
  const file = path.join(DIR, `bot-${day}-${time}-${tag}.sqlite`);
  await db.backup(file);
  try { fs.chmodSync(file, 0o600); } catch {}
  prune(tag);
  return file;
}

async function daily() {
  const today = stamp().day;
  try {
    if (!list('daily').some((b) => b.day === today)) console.log(`[backup] daily: ${await run('daily')}`);
    if (new Date().getDay() === 0 && !list('weekly').some((b) => b.day === today)) console.log(`[backup] weekly: ${await run('weekly')}`);
  } catch (e) {
    console.error(`[backup] FAILED: ${e.message} (check the backups folder is writable)`);
  }
}

function start() {
  daily();
  setInterval(daily, 60 * 60 * 1000).unref(); // checks hourly, backs up once per day
}

function latest() {
  const all = list();
  return all.length ? all.sort((a, b) => a.day.localeCompare(b.day))[all.length - 1] : null;
}

module.exports = { run, start, list, latest, DIR };

// CLI: node src/lib/backup.js pre-update
if (require.main === module) {
  const tag = (process.argv[2] || 'manual').replace(/[^a-z-]/g, '') || 'manual';
  run(tag).then((f) => { console.log(`Backup saved: ${f}`); process.exit(0); })
    .catch((e) => { console.error(`Backup failed: ${e.message}`); process.exit(1); });
}
