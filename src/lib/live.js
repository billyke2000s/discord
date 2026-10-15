// Live and upload alerts for Twitch, YouTube and Kick, posted in the server's live channel.
//   Twitch live    official API when TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are set, else the public page
//   YouTube live   the channel's public /live page
//   YouTube videos YouTube's official public feed (RSS), no key needed
//   Kick live      Kick's public channel endpoint (may be blocked by Kick's bot protection)
// A failed check never changes anything; only a clear "live" or "offline" does.
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS live_accounts (
  guild_id   TEXT NOT NULL,
  platform   TEXT NOT NULL,
  account    TEXT NOT NULL,
  label      TEXT NOT NULL,
  ext_id     TEXT,
  is_live    INTEGER NOT NULL DEFAULT 0,
  message_id TEXT,
  last_video TEXT,
  PRIMARY KEY (guild_id, platform, account)
)`);

const PLATFORMS = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };
const COLORS = { twitch: 0x9146ff, youtube: 0xff0000, kick: 0x53fc18 };
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const MAX_BYTES = 3_000_000;
const MAX_ACCOUNTS = 15;

// ---------- fetching (fixed hosts only; account names are validated before use) ----------
async function fetchText(url, { headers = {}, timeout = 10_000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9', Cookie: 'CONSENT=YES+1', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const host = new URL(res.url || url).hostname;
  if (!/(^|\.)(twitch\.tv|youtube\.com|kick\.com)$/.test(host)) throw new Error('redirected off-site');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}
const unescape = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
const meta = (html, prop) =>
  unescape(
    (new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, 'i').exec(html) ||
      new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop}"`, 'i').exec(html) ||
      [])[1],
  ) || null;

// ---------- account names ----------
// Returns { account, label } or throws a friendly error. YouTube also needs resolve() for its channel ID.
function parseAccount(platform, input) {
  const raw = String(input || '')
    .trim()
    .replace(/\/+$/, '');
  const fromUrl = (re) => (re.exec(raw) || [])[1];
  if (platform === 'twitch') {
    const name = (fromUrl(/twitch\.tv\/([A-Za-z0-9_]+)/i) || raw).toLowerCase();
    if (!/^[a-z0-9_]{3,25}$/.test(name)) throw new Error('That isn’t a Twitch username (letters, numbers and _ only).');
    return { account: name, label: name };
  }
  if (platform === 'kick') {
    const name = (fromUrl(/kick\.com\/([A-Za-z0-9_-]+)/i) || raw).toLowerCase();
    if (!/^[a-z0-9_-]{3,30}$/.test(name)) throw new Error('That isn’t a Kick username.');
    return { account: name, label: name };
  }
  if (platform === 'youtube') {
    const id =
      fromUrl(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/i) || (/^UC[A-Za-z0-9_-]{22}$/.test(raw) ? raw : null);
    if (id) return { account: id, label: id, channelId: id };
    const handle = (
      fromUrl(/youtube\.com\/(@[A-Za-z0-9._-]+)/i) || (raw.startsWith('@') ? raw : `@${raw}`)
    ).toLowerCase();
    if (!/^@[a-z0-9._-]{3,30}$/.test(handle)) throw new Error('Give a YouTube handle like @name, or a channel link.');
    return { account: handle, label: handle };
  }
  throw new Error('Unknown platform.');
}

// YouTube handle -> channel ID and display name.
async function resolveYouTube(account) {
  const url = account.startsWith('@')
    ? `https://www.youtube.com/${account}`
    : `https://www.youtube.com/channel/${account}`;
  const html = await fetchText(url);
  const id = (/"externalId":"(UC[A-Za-z0-9_-]{22})"/.exec(html) ||
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/.exec(html) ||
    [])[1];
  if (!id) throw new Error('Couldn’t find that YouTube channel.');
  return { channelId: id, label: meta(html, 'og:title') || account };
}

// ---------- status checks: { live, title, url } or throws ----------
let twitchToken = null; // { token, expires }
async function twitchApiToken() {
  if (twitchToken && Date.now() < twitchToken.expires) return twitchToken.token;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Twitch login HTTP ${res.status}`);
  const data = await res.json();
  twitchToken = { token: data.access_token, expires: Date.now() + (data.expires_in - 300) * 1000 };
  return twitchToken.token;
}
async function twitchStatus(login) {
  const url = `https://www.twitch.tv/${login}`;
  if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) {
    const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${login}`, {
      headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${await twitchApiToken()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) twitchToken = null;
    if (!res.ok) throw new Error(`Twitch API HTTP ${res.status}`);
    const stream = (await res.json()).data?.[0];
    return {
      live: !!stream,
      title: stream?.title || null,
      game: stream?.game_name || null,
      url,
      key: stream?.id || null,
    };
  }
  const html = await fetchText(url);
  const live = /"isLiveBroadcast":true/.test(html);
  return { live, title: live ? meta(html, 'og:description') : null, url, key: null };
}
async function youtubeLive(channelId) {
  const html = await fetchText(`https://www.youtube.com/channel/${channelId}/live`);
  const video = (/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/.exec(html) ||
    [])[1];
  const live = !!video && /"isLiveNow":true/.test(html);
  return {
    live,
    title: live ? meta(html, 'og:title') : null,
    url: live ? `https://www.youtube.com/watch?v=${video}` : null,
    key: live ? video : null,
  };
}
async function youtubeVideos(channelId) {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, e]) => ({
      id: (/<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/.exec(e) || [])[1],
      title: unescape((/<title>([\s\S]*?)<\/title>/.exec(e) || [])[1]),
    }))
    .filter((v) => v.id)
    .map((v) => ({ ...v, url: `https://www.youtube.com/watch?v=${v.id}` })); // newest first
}
async function kickStatus(slug) {
  const data = JSON.parse(
    await fetchText(`https://kick.com/api/v2/channels/${slug}`, { headers: { Accept: 'application/json' } }),
  );
  const stream = data?.livestream;
  return {
    live: !!stream,
    title: stream?.session_title || null,
    url: `https://kick.com/${slug}`,
    key: stream?.id ? String(stream.id) : null,
  };
}
function liveStatus(row) {
  if (row.platform === 'twitch') return twitchStatus(row.account);
  if (row.platform === 'kick') return kickStatus(row.account);
  return youtubeLive(row.ext_id);
}

// ---------- storage ----------
const listStmt = db.prepare('SELECT * FROM live_accounts WHERE guild_id = ? ORDER BY platform, account');
const allStmt = db.prepare('SELECT * FROM live_accounts ORDER BY guild_id');
const countStmt = db.prepare('SELECT COUNT(*) c FROM live_accounts WHERE guild_id = ?');
const addStmt = db.prepare(
  'INSERT OR REPLACE INTO live_accounts (guild_id, platform, account, label, ext_id, is_live, message_id, last_video) VALUES (?, ?, ?, ?, ?, 0, NULL, ?)',
);
const removeStmt = db.prepare('DELETE FROM live_accounts WHERE guild_id = ? AND platform = ? AND account = ?');
const liveStmt = db.prepare(
  'UPDATE live_accounts SET is_live = ?, message_id = ? WHERE guild_id = ? AND platform = ? AND account = ?',
);
const videoStmt = db.prepare(
  'UPDATE live_accounts SET last_video = ? WHERE guild_id = ? AND platform = ? AND account = ?',
);

const list = (guildId) => listStmt.all(guildId);
const count = (guildId) => countStmt.get(guildId).c;
const remove = (guildId, platform, account) => removeStmt.run(guildId, platform, account).changes;

// Add an account. YouTube is resolved to its channel ID, and its existing videos are marked as seen
// so adding a channel doesn't post its whole back catalogue.
async function add(guildId, platform, input) {
  const parsed = parseAccount(platform, input);
  let { account, label } = parsed;
  let extId = null,
    lastVideo = null;
  if (platform === 'youtube') {
    const yt = await resolveYouTube(account);
    extId = yt.channelId;
    label = yt.label;
    lastVideo = (await youtubeVideos(extId).catch(() => []))[0]?.id || null;
  }
  addStmt.run(guildId, platform, account, label, extId, lastVideo);
  return { platform, account, label, ext_id: extId };
}

// ---------- posting ----------
function announcement(row, status, settings) {
  const content = settings.pingRole ? `<@&${settings.pingRole}>` : undefined;
  return {
    content,
    allowedMentions: { roles: settings.pingRole ? [settings.pingRole] : [], parse: [] },
    embeds: [
      {
        color: COLORS[row.platform],
        author: { name: `🔴 ${row.label} is live on ${PLATFORMS[row.platform]}!` },
        title: (status.title || `Watch on ${PLATFORMS[row.platform]}`).slice(0, 250),
        url: status.url,
        description: status.game ? `Playing **${status.game.slice(0, 100)}**` : undefined,
        footer: { text: PLATFORMS[row.platform] },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}
function videoPost(row, video, settings) {
  return {
    content: settings.pingRole ? `<@&${settings.pingRole}>` : undefined,
    allowedMentions: { roles: settings.pingRole ? [settings.pingRole] : [], parse: [] },
    embeds: [
      {
        color: COLORS.youtube,
        author: { name: `📹 New video from ${row.label}` },
        title: (video.title || 'New video').slice(0, 250),
        url: video.url,
        image: { url: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg` },
        footer: { text: 'YouTube' },
      },
    ],
  };
}

// One pass over one account: announce going live, mark the end, post new YouTube videos.
async function checkAccount(row, channel, settings, statusFn = liveStatus, videosFn = youtubeVideos) {
  const events = [];
  let status = null;
  try {
    status = await statusFn(row);
  } catch (err) {
    events.push({ type: 'error', message: err.message });
  }
  if (status?.live && !row.is_live) {
    const msg = await channel.send(announcement(row, status, settings)).catch((e) => {
      events.push({ type: 'error', message: `couldn't post: ${e.message}` });
      return null;
    });
    // Only remember "live" once the post went out, so a failed post is tried again next time.
    if (msg) {
      liveStmt.run(1, msg.id, row.guild_id, row.platform, row.account);
      events.push({ type: 'live' });
    }
  } else if (status && !status.live && row.is_live) {
    liveStmt.run(0, null, row.guild_id, row.platform, row.account);
    if (row.message_id) {
      const msg = await channel.messages.fetch(row.message_id).catch(() => null);
      const old = msg?.embeds?.[0]?.toJSON?.();
      if (old) {
        await msg
          .edit({
            content: msg.content || undefined,
            embeds: [
              { ...old, author: { name: `${row.label} was live on ${PLATFORMS[row.platform]}` }, color: 0x99aab5 },
            ],
          })
          .catch(() => {});
      }
    }
    events.push({ type: 'ended' });
  }
  if (row.platform === 'youtube' && row.ext_id) {
    try {
      const videos = await videosFn(row.ext_id);
      if (videos.length) {
        const seen = videos.findIndex((v) => v.id === row.last_video);
        // Unknown last video (first run or the feed moved on): don't flood, just remember the newest.
        const fresh = seen === -1 ? [] : videos.slice(0, seen).reverse().slice(-3);
        for (const v of fresh) {
          if (status?.key && v.id === status.key) continue; // the stream itself, already announced
          await channel.send(videoPost(row, v, settings)).catch(() => {});
          events.push({ type: 'video', id: v.id });
        }
        if (videos[0].id !== row.last_video) videoStmt.run(videos[0].id, row.guild_id, row.platform, row.account);
      }
    } catch (err) {
      events.push({ type: 'error', message: err.message });
    }
  }
  return { status, events };
}

// ---------- polling ----------
const POLL_MS = 2 * 60_000;
let running = false;
async function pollAll(client, getSettings) {
  if (running) return;
  running = true;
  try {
    for (const row of allStmt.all()) {
      const guild = client.guilds.cache.get(row.guild_id);
      const settings = guild && getSettings(guild.id).live;
      const channel = settings?.channel && guild.channels.cache.get(settings.channel);
      if (!channel?.isTextBased?.()) continue;
      await checkAccount(row, channel, settings).catch((e) => console.error('[live]', e.message));
    }
  } finally {
    running = false;
  }
}
function start(client, getSettings) {
  const tick = () => pollAll(client, getSettings).catch((e) => console.error('[live]', e.message));
  setTimeout(tick, 15_000).unref?.();
  setInterval(tick, POLL_MS).unref?.();
}

module.exports = {
  PLATFORMS,
  MAX_ACCOUNTS,
  parseAccount,
  add,
  remove,
  list,
  count,
  liveStatus,
  youtubeVideos,
  checkAccount,
  start,
  announcement,
  _parse: { meta },
};
