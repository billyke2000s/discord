const { EmbedBuilder } = require('discord.js');
const { getSettings } = require('./db');

// Bot admins: user IDs from BOT_ADMIN_IDS in .env (comma separated). They get the same power as the
// server owner inside the bot: /setup rebuild, moderating anyone below the bot, controlling any temp VC
// and any music. Discord still decides who can SEE a command, so bot admins also need a role with
// the command's permission (e.g. Administrator) in the server.
const BOT_ADMINS = new Set(String(process.env.BOT_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
function isBotAdmin(userId) {
  return BOT_ADMINS.has(userId);
}
// Owner or bot admin
function isOwner(user, guild) {
  return user.id === guild.ownerId || isBotAdmin(user.id);
}

const COLORS = { info: 0x5865f2, ok: 0x57f287, warn: 0xfee75c, bad: 0xed4245, grey: 0x99aab5 };

function embed(color = 'info') {
  return new EmbedBuilder().setColor(COLORS[color] ?? color);
}

// Send an embed to the guild's configured log channel. Never throws.
async function log(guild, e, extra = {}) {
  try {
    const { logChannel } = getSettings(guild.id);
    if (!logChannel) return;
    const ch = guild.channels.cache.get(logChannel) || (await guild.channels.fetch(logChannel).catch(() => null));
    if (!ch?.isTextBased()) return;
    await ch.send({ embeds: [e.setTimestamp()], ...extra });
  } catch (err) {
    console.error('[log] failed:', err.message);
  }
}

// Can `actor` act on `target`? Checks role hierarchy for both the moderator and the bot.
function canModerate(actor, target) {
  const me = target.guild.members.me;
  if (target.id === target.guild.ownerId) return 'You cannot act on the server owner.';
  if (target.id === actor.id) return 'You cannot do that to yourself.';
  if (target.id === me.id) return 'I am not doing that to myself.';
  if (!isOwner(actor, target.guild) && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0)
    return 'That member has an equal or higher role than you.';
  if (me.roles.highest.comparePositionTo(target.roles.highest) <= 0)
    return 'That member has an equal or higher role than me. Move my role up.';
  return null;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// "10m", "2h", "1d", "30s" -> ms. Returns null if invalid.
function parseDuration(str) {
  const m = /^(\d+)\s*(s|m|h|d|w)$/i.exec(String(str).trim());
  if (!m) return null;
  const mult = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7, w: 6.048e8 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}

function truncate(str, n) {
  str = String(str ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

module.exports = { isBotAdmin, isOwner, embed, log, canModerate, fmtDuration, parseDuration, truncate };
