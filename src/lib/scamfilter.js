// Scam / hacked-account filter.
//  1. Known scam domains from two public lists (refreshed every 6 hours, cached to disk).
//     On BOTH lists: delete + timeout. On only ONE list: delete + log, but no timeout, so one list
//     getting something wrong can't get innocent people punished.
//  2. Non-staff message with @everyone/@here AND a link: classic hacked-account spam.
//  3. Same message posted in N different channels within 30 seconds: hacked-account spam.
// Action: delete the message (and the same message in other channels), timeout, DM, log.
const fs = require('node:fs');
const path = require('node:path');
const { PermissionFlagsBits: P } = require('discord.js');
const { getSettings } = require('./db');
const { embed, log, truncate, isBotAdmin } = require('./util');

const SOURCES = [
  { url: 'https://raw.githubusercontent.com/nikolaischunk/discord-phishing-links/main/domain-list.json', parse: (t) => JSON.parse(t).domains },
  { url: 'https://raw.githubusercontent.com/Discord-AntiScam/scam-links/main/list.txt', parse: (t) => t.split(/\r?\n/) },
];
// Never flag these even if a list gets them wrong.
const SAFE = new Set([
  'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'youtube.com', 'youtu.be', 'twitch.tv', 'github.com',
  'google.com', 'steamcommunity.com', 'steampowered.com', 'store.steampowered.com', 'twitter.com', 'x.com', 'reddit.com',
  'tenor.com', 'giphy.com', 'imgur.com', 'spotify.com', 'ea.com', 'nintendo.com', 'medal.tv', 'instagram.com', 'tiktok.com',
  'youtube-nocookie.com', 'googleusercontent.com', 'gstatic.com', 'microsoft.com', 'xbox.com', 'playstation.com', 'epicgames.com',
  'apple.com', 'amazon.com', 'amazon.co.uk', 'wikipedia.org', 'facebook.com', 'whatsapp.com', 'roblox.com', 'riotgames.com',
  'twitch.com', 'cloudflare.com', 'paypal.com', 'ebay.com', 'ebay.co.uk', 'bsky.app', 'soundcloud.com', 'tracker.gg',
]);
const REFRESH_MS = 6 * 3600 * 1000;
const cacheFile = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'scam-domains.txt');

let domains = new Map(); // domain -> how many of the lists have it (1 or 2)
let lastLoaded = 0;

const clean = (d) => String(d).trim().toLowerCase().replace(/^\*\./, '');
const valid = (x) => x && !x.startsWith('#') && x.includes('.') && !SAFE.has(x);

// lists: one array of domains per source. Also accepts the cache format "domain<TAB>count".
function setDomains(...lists) {
  const m = new Map();
  for (const list of lists) {
    for (const x of new Set(list.map(clean))) if (valid(x)) m.set(x, (m.get(x) || 0) + 1);
  }
  domains = m;
}
function loadCache(text) {
  const m = new Map();
  for (const line of text.split('\n')) {
    const [d, n] = line.split('\t');
    const x = clean(d);
    if (valid(x)) m.set(x, Math.min(2, Number(n) || 1));
  }
  domains = m;
}

const lastGood = []; // per source: last list that looked sane
async function refresh() {
  let ok = 0;
  for (const [i, src] of SOURCES.entries()) {
    try {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = src.parse(await res.text());
      if (!Array.isArray(list)) throw new Error('unexpected format');
      // A list that suddenly shrinks to a fraction of its size is probably broken upstream: keep the old one.
      if (lastGood[i] && list.length < lastGood[i].length * 0.3) throw new Error(`list shrank from ${lastGood[i].length} to ${list.length}, ignoring this update`);
      lastGood[i] = list;
      ok++;
    } catch (e) {
      console.warn(`[scamfilter] couldn't use ${src.url}: ${e.message}`);
    }
  }
  if (lastGood.some(Boolean)) {
    setDomains(...lastGood.filter(Boolean));
    lastLoaded = Date.now();
    try { fs.writeFileSync(cacheFile, [...domains].map(([d, n]) => `${d}\t${n}`).join('\n')); } catch {}
    console.log(`[scamfilter] ${domains.size} scam domains (${[...domains.values()].filter((n) => n >= 2).length} on both lists) from ${ok}/${SOURCES.length} lists`);
  } else if (!domains.size) {
    // offline: fall back to last saved copy
    try {
      loadCache(fs.readFileSync(cacheFile, 'utf8'));
      console.log(`[scamfilter] using cached list (${domains.size} domains)`);
    } catch {
      console.warn('[scamfilter] no list available yet; mass-ping and cross-channel checks still work');
    }
  }
}

function start() {
  refresh();
  setInterval(refresh, REFRESH_MS).unref();
}

// Pull hostnames out of a message: full URLs and bare domains like "free-nitro.gift/abc".
const HOST_RE = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;
function hosts(text) {
  const out = new Set();
  for (const m of String(text).matchAll(HOST_RE)) {
    out.add(m[0].replace(/^https?:\/\//i, '').toLowerCase());
  }
  return [...out];
}
const hasLink = (text) => /https?:\/\/\S+/i.test(text);

// Is this host (or any parent domain of it) on the list? e.g. "gift.free-nitro.xyz" matches "free-nitro.xyz"
// Returns { domain, lists } or false.
function isScamHost(host, allow) {
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join('.');
    if (SAFE.has(d) || allow.includes(d)) return false;
    if (domains.has(d)) return { domain: d, lists: domains.get(d) };
  }
  return false;
}

// Recent messages per user, for cross-channel spam detection and cleanup.
const recent = new Map(); // guildId:userId -> [{ channelId, id, content, ts }]
const WINDOW = 30_000;

function remember(msg) {
  const key = `${msg.guildId}:${msg.author.id}`;
  const now = Date.now();
  const list = (recent.get(key) || []).filter((x) => now - x.ts < WINDOW);
  list.push({ channelId: msg.channelId, id: msg.id, content: msg.content, ts: now });
  recent.set(key, list);
  return list;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of recent) if (!v.some((x) => now - x.ts < WINDOW)) recent.delete(k);
}, 60_000).unref();

// Returns true if the message was handled (deleted).
async function check(msg) {
  const cfg = getSettings(msg.guild.id).scamFilter;
  if (!cfg.enabled || !msg.member) return false;
  const text = [msg.content, ...msg.embeds.map((e) => `${e.url || ''} ${e.description || ''}`)].join(' ');
  const staff = isBotAdmin(msg.author.id) || msg.member.permissions.has(P.ManageMessages);
  const history = remember(msg);

  let reason = null, detail = '', punish = true;
  let weak = null;
  for (const h of hosts(text)) {
    const hit = isScamHost(h, cfg.allow);
    if (hit && hit.lists >= 2) { reason = 'Known scam link'; detail = hit.domain; weak = null; break; }
    if (hit && !weak) weak = hit;
  }
  if (!reason && weak) {
    // Only one list has it: remove the message but don't punish, in case that list is wrong.
    reason = 'Possible scam link (on one scam list)'; detail = weak.domain; punish = false;
  }
  if ((!reason || !punish) && !staff && cfg.blockMassPingLinks && hasLink(msg.content) && /@(everyone|here)/.test(msg.content)) {
    reason = '@everyone/@here with a link (hacked-account pattern)'; punish = true;
  }
  if ((!reason || !punish) && !staff && cfg.crossChannelSpam && msg.content.length >= 10) {
    const same = history.filter((x) => x.content === msg.content);
    if (new Set(same.map((x) => x.channelId)).size >= cfg.crossChannelSpam) {
      reason = `Same message in ${cfg.crossChannelSpam}+ channels within 30s (hacked-account pattern)`; punish = true;
    }
  }
  if (!reason) return false;

  // Delete this message and copies of it in other channels
  await msg.delete().catch(() => {});
  let removed = 1;
  for (const x of history) {
    if (x.id === msg.id || x.content !== msg.content) continue;
    const ch = msg.guild.channels.cache.get(x.channelId);
    await ch?.messages.delete(x.id).then(() => removed++).catch(() => {});
  }

  let action = punish ? 'Deleted' : 'Deleted (not punished: only one list has this domain)';
  if (punish && cfg.timeoutHours && msg.member.moderatable) {
    await msg.member.timeout(cfg.timeoutHours * 3600_000, `Scam filter: ${reason}`)
      .then(() => { action = `Deleted + timed out ${cfg.timeoutHours}h`; }).catch(() => {});
  }
  await msg.author.send(punish
    ? `Your message in **${msg.guild.name}** was removed by the scam filter (${reason}).\n` +
      'If you didn’t send it, **your account is probably hacked**: change your password, turn on 2FA, and in Discord Settings → Devices log out all other devices. ' +
      'Then ask a moderator to remove your timeout.'
    : `Your message in **${msg.guild.name}** was removed because it contained a link on a scam list (\`${detail}\`). If it's a real site, ask a moderator.`,
  ).catch(() => {});

  // Defang the link so nobody clicks it from the log
  const safeText = truncate(msg.content, 900).replace(/https?:\/\//gi, 'hxxp://').replace(/\./g, '[.]');
  await log(msg.guild, embed('bad').setTitle('🚫 Scam filter')
    .setDescription(`**User:** ${msg.author} (${msg.author.tag})\n**Channel:** ${msg.channel}\n**Why:** ${reason}${detail ? ` (\`${detail}\`)` : ''}\n**Action:** ${action}, ${removed} message(s) removed\n\n**Message (links disabled):**\n${safeText || '*(embed only)*'}`)
    .setFooter({ text: `User ID ${msg.author.id} · if this is wrong: /setup scamfilter allow:<domain>` }));
  return true;
}

module.exports = { start, check, stats: () => ({ size: domains.size, lastLoaded }), _setDomains: setDomains /* used by tests */, _loadCache: loadCache };
