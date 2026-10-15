const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { db, getSettings, updateSettings } = require('../lib/db');
db.exec(
  `CREATE TABLE IF NOT EXISTS birthdays (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, month INTEGER NOT NULL CHECK(month BETWEEN 1 AND 12), day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 31), last_sent_year INTEGER, PRIMARY KEY(guild_id,user_id))`,
);
// Additive migration keeps historical day/month records; never invent a missing year.
if (
  !db
    .prepare('PRAGMA table_info(birthdays)')
    .all()
    .some((c) => c.name === 'birth_year')
)
  db.exec('ALTER TABLE birthdays ADD COLUMN birth_year INTEGER');
db.exec(`CREATE TABLE IF NOT EXISTS birthday_grants (
 guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL,
 expires_at INTEGER NOT NULL, PRIMARY KEY(guild_id,user_id)
);
CREATE TABLE IF NOT EXISTS birthday_announcements (
 guild_id TEXT NOT NULL, user_id TEXT NOT NULL, year INTEGER NOT NULL,
 PRIMARY KEY(guild_id,user_id,year)
)`);
const valid = (m, d) =>
  Number.isInteger(m) &&
  Number.isInteger(d) &&
  m >= 1 &&
  m <= 12 &&
  d >= 1 &&
  d <= new Date(Date.UTC(2024, m, 0)).getUTCDate();
const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
function parseMonth(input) {
  const s = String(input).trim().toLowerCase().replace(/\.$/, '');
  if (/^\d{1,2}$/.test(s)) {
    const n = Number(s);
    return n >= 1 && n <= 12 ? n : null;
  }
  if (s === 'sept') return 9;
  const index = months.findIndex((m) => s === m.toLowerCase() || s === m.slice(0, 3).toLowerCase());
  return index < 0 ? null : index + 1;
}
function parseDay(input) {
  const match = /^(\d{1,2})(st|nd|rd|th)?$/i.exec(String(input).trim());
  if (!match) return null;
  const day = Number(match[1]);
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th';
  return day >= 1 && day <= 31 && (!match[2] || match[2].toLowerCase() === suffix) ? day : null;
}
function validBirthDate(m, d, y, now = new Date()) {
  if (!valid(m, d) || !Number.isInteger(y) || y < 1900 || y > now.getUTCFullYear()) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d && date.getTime() <= now.getTime();
}
function birthdayMessage(row, year) {
  const age = row.birth_year == null ? '' : ` You’re ${year - row.birth_year} today!`;
  return `🎂 Happy birthday, <@${row.user_id}>!${age} 🎉 Wishing you a wonderful day and a brilliant year ahead. Enjoy your 👑 Birthday role for 24 hours!`;
}
function savedBirthday(row, now = new Date()) {
  const date = `${row.day} ${months[row.month - 1]}${row.birth_year == null ? '' : ` ${row.birth_year}`}`;
  const today = row.month === now.getUTCMonth() + 1 && row.day === now.getUTCDate();
  const greeting =
    today && row.birth_year != null ? ` Happy birthday! You’re ${now.getUTCFullYear() - row.birth_year} today! 🎉` : '';
  return `Your birthday: ${date}.${greeting}${row.birth_year == null ? ' Use /birthday set to add your birth year so the announcement can include your age.' : ''}`;
}
const command = {
  data: new SlashCommandBuilder()
    .setName('birthday')
    .setDescription('Opt in to birthday announcements')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set your birthday and birth year')
        .addStringOption((o) =>
          o
            .setName('month')
            .setDescription('Month name, abbreviation or number: September, Sep, Sept, 9 or 09')
            .setRequired(true),
        )
        .addStringOption((o) => o.setName('day').setDescription('Day: 1-31, for example 15 or 15th').setRequired(true))
        .addIntegerOption((o) =>
          o
            .setName('year')
            .setDescription('Your four-digit birth year, for the age in your birthday announcement')
            .setRequired(true)
            .setMinValue(1900)
            .setMaxValue(9999),
        ),
    )
    .addSubcommand((s) => s.setName('show').setDescription('Show your saved birthday')),
  async execute(i) {
    const sub = i.options.getSubcommand(),
      g = i.guildId,
      u = i.user.id;
    if (sub === 'set') {
      const m = parseMonth(i.options.getString('month', true)),
        d = parseDay(i.options.getString('day', true)),
        y = i.options.getInteger('year', true);
      if (!validBirthDate(m, d, y))
        return i.reply({
          content:
            'Please enter a real birth date that is not in the future. Example: month:September day:15 year:1966. February 29 needs a leap birth year.',
          flags: MessageFlags.Ephemeral,
        });
      db.prepare(
        'INSERT INTO birthdays (guild_id,user_id,month,day,birth_year,last_sent_year) VALUES (?,?,?,?,?,NULL) ON CONFLICT(guild_id,user_id) DO UPDATE SET month=excluded.month,day=excluded.day,birth_year=excluded.birth_year',
      ).run(g, u, m, d, y);
      return i.reply({
        content: `Birthday saved! ${savedBirthday({ month: m, day: d, birth_year: y })} On the day, the birthday channel announces your age and you get the 👑 Birthday role for 24 hours. Dates use UTC.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    const row = db.prepare('SELECT month,day,birth_year FROM birthdays WHERE guild_id=? AND user_id=?').get(g, u);
    return i.reply({
      content: row ? savedBirthday(row) : 'No birthday saved. Use /birthday set to add yours.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
let sweeping = false;
async function sweep(client, now = new Date()) {
  if (sweeping) return;
  sweeping = true;
  try {
    await runSweep(client, now);
  } finally {
    sweeping = false;
  }
}
async function runSweep(client, now) {
  const month = now.getUTCMonth() + 1,
    day = now.getUTCDate(),
    year = now.getUTCFullYear();
  // Expiry is independent of the birthday record: editing/removing a date cannot strand a role.
  for (const grant of db.prepare('SELECT * FROM birthday_grants WHERE expires_at<=?').all(now.getTime())) {
    const guild = client.guilds.cache.get(grant.guild_id);
    if (!guild) continue;
    try {
      const member = await guild.members.fetch(grant.user_id).catch((e) => {
        if (e.code === 10007) return null;
        throw e;
      });
      const role = await guild.roles.fetch(grant.role_id);
      if (member && role) await member.roles.remove(role, 'Birthday role expired after 24 hours');
      db.prepare('DELETE FROM birthday_grants WHERE guild_id=? AND user_id=?').run(grant.guild_id, grant.user_id);
    } catch (e) {
      console.error('[birthday] Role expiry failed:', e.message);
    }
  }
  for (const row of db
    .prepare('SELECT * FROM birthdays WHERE month=? AND day=? AND (last_sent_year IS NULL OR last_sent_year != ?)')
    .all(month, day, year)) {
    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) continue;
    if (process.env.GUILD_ID && guild.id !== process.env.GUILD_ID) continue;
    const settings = getSettings(guild.id);
    // Older rebuilds created this channel without saving its ID. Only accept an exact, unique match.
    let id = settings.birthdayChannel;
    if (!id) {
      const matches = [...guild.channels.cache.values()].filter((c) => c.name === '🎂・birthdays' && c.isTextBased());
      if (matches.length === 1) {
        id = matches[0].id;
        updateSettings(guild.id, { birthdayChannel: id });
      }
    }
    if (!id) continue;
    const channel = guild.channels.cache.get(id);
    if (!channel?.isTextBased()) continue;
    try {
      const member = await guild.members.fetch(row.user_id).catch((e) => {
        if (e.code === 10007) return null;
        throw e;
      });
      if (!member) continue;
      let role = settings.birthdayRole ? await guild.roles.fetch(settings.birthdayRole) : null;
      if (role && (role.managed || role.permissions.bitfield !== 0n))
        throw Error('Birthday role must have no permissions and must not be managed.');
      if (!role) {
        role = await guild.roles.create({
          name: '👑 Birthday',
          permissions: [],
          hoist: true,
          mentionable: false,
          reason: 'Birthday celebration',
        });
        updateSettings(guild.id, { birthdayRole: role.id });
      }
      let grant = db.prepare('SELECT * FROM birthday_grants WHERE guild_id=? AND user_id=?').get(guild.id, row.user_id);
      if (!grant) {
        db.prepare('INSERT INTO birthday_grants VALUES (?,?,?,?)').run(
          guild.id,
          row.user_id,
          role.id,
          now.getTime() + 86400000,
        );
      }
      await member.roles.add(role, 'Birthday celebration for 24 hours');
      // Persist the attempt first: a crash after sending cannot repeatedly ping members.
      const claimed = db
        .prepare('INSERT OR IGNORE INTO birthday_announcements VALUES (?,?,?)')
        .run(guild.id, row.user_id, year).changes;
      if (claimed)
        await channel.send({ content: birthdayMessage(row, year), allowedMentions: { users: [row.user_id] } });
      db.prepare('UPDATE birthdays SET last_sent_year=? WHERE guild_id=? AND user_id=?').run(
        year,
        row.guild_id,
        row.user_id,
      );
    } catch (e) {
      console.error('[birthday] Celebration failed:', e.message);
    }
  }
}
module.exports = {
  commands: [command],
  sweep,
  valid,
  parseMonth,
  parseDay,
  validBirthDate,
  birthdayMessage,
  savedBirthday,
};
