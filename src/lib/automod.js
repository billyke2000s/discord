// Automod: rules admins switch on with /automod. Every rule is off until turned on.
//   words     blocked words or phrases (whole words; `*` at the end matches the rest of a word)
//   invites   invite links to other Discord servers
//   links     links to sites that aren't on the allowed list
//   caps      messages that are mostly capital letters
//   mentions  too many people or roles mentioned in one message
//   spam      too many messages in a few seconds
// Each rule has an action: delete, warn (delete + a warning in /warnings) or timeout (delete + timeout).
// Staff (Manage Messages), bot admins, exempt roles and exempt channels are never checked.
const { PermissionFlagsBits: P } = require('discord.js');
const { db } = require('./db');
const { embed, log, truncate, isBotAdmin } = require('./util');

const RULES = ['words', 'invites', 'links', 'caps', 'mentions', 'spam'];
const RULE_NAMES = {
  words: 'Blocked words',
  invites: 'Invite links',
  links: 'Links',
  caps: 'Too many capitals',
  mentions: 'Too many mentions',
  spam: 'Sending too fast',
};
const ACTIONS = ['delete', 'warn', 'timeout'];

// ---------- text helpers ----------
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
// Lowercase, strip accents and common number/symbol swaps, so "B4D w0rd" still matches "bad word".
const normalize = (text) =>
  String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => LEET[c]);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function wordPattern(entry) {
  const word = normalize(entry).trim();
  if (!word) return null;
  const wildcard = word.endsWith('*');
  const body = escape(wildcard ? word.slice(0, -1) : word).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${wildcard ? '[\\p{L}\\p{N}]*' : '(?![\\p{L}\\p{N}])'}`, 'u');
}
const patternCache = new Map(); // word list (joined) -> compiled patterns
function blockedWord(content, words) {
  if (!words?.length) return null;
  const key = words.join('\n');
  if (!patternCache.has(key)) {
    if (patternCache.size > 50) patternCache.clear();
    patternCache.set(
      key,
      words.map((w) => [w, wordPattern(w)]).filter(([, p]) => p),
    );
  }
  const text = normalize(content);
  return patternCache.get(key).find(([, p]) => p.test(text))?.[0] || null;
}

const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg)\/([a-z0-9-]{2,32})/gi;
const inviteCodes = (content) => [...String(content || '').matchAll(INVITE_RE)].map((m) => m[1]);

const URL_RE = /https?:\/\/([^\s/<>"'?#]+)/gi;
function linkHosts(content) {
  return [...String(content || '').matchAll(URL_RE)].map((m) =>
    m[1]
      .toLowerCase()
      .replace(/:\d+$/, '')
      .replace(/^www\./, ''),
  );
}
const hostAllowed = (host, allowed) => allowed.some((d) => host === d || host.endsWith(`.${d}`));

function capsShare(content, minLetters) {
  // Ignore mentions, custom emoji, links and code, which aren't shouting.
  const text = String(content || '').replace(/<[^>]+>|https?:\/\/\S+|`[^`]*`/gi, '');
  const letters = [...text].filter((c) => c.toLowerCase() !== c.toUpperCase());
  if (letters.length < minLetters) return 0;
  return Math.round((100 * letters.filter((c) => c === c.toUpperCase()).length) / letters.length);
}

// ---------- spam tracking ----------
const recent = new Map(); // guildId:userId -> [{ at, id, channelId }]
function trackSpam(msg, cfg, now) {
  const key = `${msg.guildId}:${msg.authorId}`;
  const windowMs = cfg.spamSeconds * 1000;
  const list = (recent.get(key) || []).filter((x) => now - x.at < windowMs);
  list.push({ at: now, id: msg.id, channelId: msg.channelId });
  recent.set(key, list);
  if (list.length < cfg.spamMessages) return null;
  recent.delete(key); // one action per burst
  return list;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of recent) if (!v.some((x) => now - x.at < 60_000)) recent.delete(k);
}, 60_000).unref();

// ---------- checking ----------
// msg: { id, guildId, authorId, channelId, content, mentionCount, edited }. Returns { rule, detail, extra } or null.
// isOwnInvite(code) -> Promise<boolean> lets invites to this server through.
async function evaluate(msg, cfg, { now = Date.now(), isOwnInvite = async () => false } = {}) {
  const on = (rule) => cfg.rules?.[rule]?.enabled;
  if (on('words')) {
    const word = blockedWord(msg.content, cfg.words);
    if (word) return { rule: 'words', detail: 'a blocked word' };
  }
  if (on('invites')) {
    for (const code of inviteCodes(msg.content)) {
      if (!(await isOwnInvite(code).catch(() => false)))
        return { rule: 'invites', detail: 'an invite to another server' };
    }
  }
  if (on('links')) {
    // Invite links are the invites rule's job when it's on (it lets this server's own invites through).
    const inviteHost = (h) => on('invites') && /^(discord\.gg|dsc\.gg|discord(app)?\.com)$/.test(h);
    const bad = linkHosts(msg.content).find((h) => !inviteHost(h) && !hostAllowed(h, cfg.allowedLinks || []));
    if (bad) return { rule: 'links', detail: `a link to ${bad}` };
  }
  if (on('caps')) {
    const share = capsShare(msg.content, cfg.capsMinLetters);
    if (share >= cfg.capsPercent) return { rule: 'caps', detail: `${share}% capital letters` };
  }
  if (on('mentions') && msg.mentionCount > cfg.maxMentions) {
    return { rule: 'mentions', detail: `${msg.mentionCount} mentions (limit ${cfg.maxMentions})` };
  }
  if (on('spam') && !msg.edited) {
    const burst = trackSpam(msg, cfg, now);
    if (burst) return { rule: 'spam', detail: `${burst.length} messages in ${cfg.spamSeconds} seconds`, extra: burst };
  }
  return null;
}

function exempt(member, channel, cfg) {
  if (!member) return true;
  if (isBotAdmin(member.id) || member.id === member.guild.ownerId) return true;
  if (member.permissions?.has(P.ManageMessages)) return true;
  if (cfg.exemptRoles?.some((id) => member.roles.cache.has(id))) return true;
  const ids = [channel?.id, channel?.parentId].filter(Boolean);
  return ids.some((id) => cfg.exemptChannels?.includes(id));
}

// Invite codes for this server, cached for an hour so automod doesn't call Discord for every invite posted.
const inviteCache = new Map(); // code -> { guildId, at }
async function ownInvite(client, code, guildId) {
  const hit = inviteCache.get(code);
  if (hit && Date.now() - hit.at < 3600e3) return hit.guildId === guildId;
  const invite = await client.fetchInvite(code).catch(() => null);
  inviteCache.set(code, { guildId: invite?.guild?.id || null, at: Date.now() });
  if (inviteCache.size > 1000) inviteCache.delete(inviteCache.keys().next().value);
  return invite?.guild?.id === guildId;
}

// ---------- acting ----------
const addWarning = db.prepare(
  'INSERT INTO warnings (guild_id, user_id, mod_id, reason, created_at) VALUES (?, ?, ?, ?, ?)',
);
const countWarnings = db.prepare('SELECT COUNT(*) c FROM warnings WHERE guild_id = ? AND user_id = ?');

async function act(message, hit, cfg) {
  const rule = cfg.rules[hit.rule];
  const name = RULE_NAMES[hit.rule];
  await message.delete().catch(() => {});
  let removed = 1;
  for (const x of hit.extra || []) {
    if (x.id === message.id) continue;
    await message.guild.channels.cache
      .get(x.channelId)
      ?.messages.delete(x.id)
      .then(() => removed++)
      .catch(() => {});
  }
  let action = 'Deleted';
  let dm = `Your message in **${message.guild.name}** was removed by automod: ${name.toLowerCase()} (${hit.detail}).`;
  if (rule.action === 'warn') {
    addWarning.run(
      message.guild.id,
      message.author.id,
      message.client.user.id,
      `Automod: ${name} (${hit.detail})`,
      Date.now(),
    );
    const count = countWarnings.get(message.guild.id, message.author.id).c;
    action = `Deleted + warning #${count}`;
    dm += ` This counts as a warning (you have ${count}). Use \`/mywarnings\` in the server to see them.`;
  } else if (rule.action === 'timeout' && message.member?.moderatable) {
    await message.member
      .timeout(cfg.timeoutMinutes * 60_000, `Automod: ${name}`)
      .then(() => {
        action = `Deleted + ${cfg.timeoutMinutes} min timeout`;
        dm += ` You're timed out for ${cfg.timeoutMinutes} minutes.`;
      })
      .catch(() => {});
  }
  await message.author.send(dm).catch(() => {});
  const shown = truncate(message.content || '*(no text)*', 900).replace(/https?:\/\//gi, 'hxxp://');
  await log(
    message.guild,
    embed('warn')
      .setTitle('🤖 Automod')
      .setDescription(
        `**User:** ${message.author} (${message.author.tag})\n**Channel:** ${message.channel}\n**Rule:** ${name} (${hit.detail})\n` +
          `**Action:** ${action}${removed > 1 ? `, ${removed} messages removed` : ''}\n\n**Message:**\n${shown}`,
      )
      .setFooter({ text: `User ID ${message.author.id} · change rules with /automod` }),
  );
  return action;
}

// Check a real Discord message. Returns true when automod removed it.
async function check(message, cfg, { edited = false } = {}) {
  if (!cfg || !RULES.some((r) => cfg.rules?.[r]?.enabled)) return false;
  if (!message.guild || message.author?.bot || exempt(message.member, message.channel, cfg)) return false;
  const hit = await evaluate(
    {
      id: message.id,
      guildId: message.guild.id,
      authorId: message.author.id,
      channelId: message.channelId,
      content: message.content,
      mentionCount: (message.mentions?.users?.size || 0) + (message.mentions?.roles?.size || 0),
      edited,
    },
    cfg,
    { isOwnInvite: (code) => ownInvite(message.client, code, message.guild.id) },
  );
  if (!hit) return false;
  await act(message, hit, cfg);
  return true;
}

module.exports = {
  RULES,
  RULE_NAMES,
  ACTIONS,
  check,
  evaluate,
  exempt,
  normalize,
  blockedWord,
  inviteCodes,
  linkHosts,
  capsShare,
  _resetSpam: () => recent.clear(),
};
