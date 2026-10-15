const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
delete process.env.TWITCH_CLIENT_ID;
const { db } = require('../src/lib/db');
const live = require('../src/lib/live');
const command = require('../src/commands/live').commands[0];

const realFetch = global.fetch;
let pages = {};
beforeEach(() => {
  db.exec('DELETE FROM live_accounts');
  pages = {};
  global.fetch = async (url) => {
    const body = pages[url];
    if (body === undefined) return new Response('nope', { status: 404 });
    return new Response(body, { status: 200 });
  };
});
test.after(() => {
  global.fetch = realFetch;
});

const feed = (...ids) =>
  `<feed>${ids.map((id) => `<entry><yt:videoId>${id}</yt:videoId><title>Video ${id} &amp; more</title></entry>`).join('')}</feed>`;
const row = () => db.prepare('SELECT * FROM live_accounts').get();

function fakeChannel() {
  const sent = [],
    edited = [];
  return {
    sent,
    edited,
    send: async (p) => {
      sent.push(p);
      return { id: `m${sent.length}` };
    },
    messages: {
      fetch: async (id) => ({
        content: '',
        embeds: [{ toJSON: () => ({ title: 'x' }) }],
        edit: async (p) => edited.push({ id, p }),
      }),
    },
  };
}

test('account names: usernames, links and handles are accepted; anything else is refused', () => {
  assert.equal(live.parseAccount('twitch', 'https://www.twitch.tv/Some_Streamer/').account, 'some_streamer');
  assert.equal(live.parseAccount('kick', 'kick.com/my-name').account, 'my-name');
  assert.equal(live.parseAccount('youtube', 'https://youtube.com/@Cool.Channel').account, '@cool.channel');
  assert.equal(live.parseAccount('youtube', 'MyHandle').account, '@myhandle');
  assert.equal(
    live.parseAccount('youtube', 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv').channelId,
    'UCabcdefghijklmnopqrstuv',
  );
  assert.throws(() => live.parseAccount('twitch', 'bad name/../x'), /Twitch username/);
  assert.throws(() => live.parseAccount('kick', 'a'), /Kick username/);
});

test('adding a YouTube channel finds its ID and does not post its old videos', async () => {
  pages['https://www.youtube.com/@creator'] =
    '<meta property="og:title" content="Creator &amp; Co">"externalId":"UCabcdefghijklmnopqrstuv"';
  pages['https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv'] = feed(
    'newestVideo',
    'olderVideo1',
  );
  const added = await live.add('g', 'youtube', '@creator');
  assert.equal(added.label, 'Creator & Co');
  assert.equal(row().ext_id, 'UCabcdefghijklmnopqrstuv');
  assert.equal(row().last_video, 'newestVideo');
});

test('going live posts once with the ping; staying live does not repost; ending updates the post', async () => {
  db.prepare(
    "INSERT INTO live_accounts (guild_id, platform, account, label) VALUES ('g', 'twitch', 'streamer', 'streamer')",
  ).run();
  const channel = fakeChannel();
  const settings = { pingRole: 'fans' };
  const status = (s) => async () => s;

  await live.checkAccount(
    row(),
    channel,
    settings,
    status({ live: true, title: 'Ranked grind', url: 'https://www.twitch.tv/streamer' }),
  );
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, '<@&fans>');
  assert.deepEqual(channel.sent[0].allowedMentions, { roles: ['fans'], parse: [] });
  assert.match(channel.sent[0].embeds[0].author.name, /streamer is live on Twitch/);
  assert.equal(row().is_live, 1);

  await live.checkAccount(row(), channel, settings, status({ live: true }));
  assert.equal(channel.sent.length, 1, 'no repeat while still live');

  await live.checkAccount(row(), channel, settings, async () => {
    throw new Error('page changed');
  });
  assert.equal(row().is_live, 1, 'a failed check changes nothing');

  await live.checkAccount(row(), channel, settings, status({ live: false }));
  assert.equal(row().is_live, 0);
  assert.match(channel.edited[0].p.embeds[0].author.name, /was live/);
});

test('a live post that fails to send is tried again next time', async () => {
  db.prepare("INSERT INTO live_accounts (guild_id, platform, account, label) VALUES ('g', 'kick', 'k', 'k')").run();
  const broken = {
    send: async () => {
      throw new Error('Missing Permissions');
    },
  };
  const { events } = await live.checkAccount(row(), broken, {}, async () => ({
    live: true,
    url: 'https://kick.com/k',
  }));
  assert.match(events[0].message, /couldn't post/);
  assert.equal(row().is_live, 0);
  const channel = fakeChannel();
  await live.checkAccount(row(), channel, {}, async () => ({ live: true, url: 'https://kick.com/k' }));
  assert.equal(channel.sent.length, 1);
});

test('new YouTube videos are posted oldest first, at most 3, skipping the live stream itself', async () => {
  db.prepare(
    "INSERT INTO live_accounts (guild_id, platform, account, label, ext_id, last_video) VALUES ('g', 'youtube', '@c', 'C', 'UCx', 'v1')",
  ).run();
  const channel = fakeChannel();
  const videos = async () =>
    ['v6', 'v5', 'v4', 'v3', 'v2', 'v1'].map((id) => ({ id, title: id, url: `https://www.youtube.com/watch?v=${id}` }));
  await live.checkAccount(
    row(),
    channel,
    {},
    async () => ({ live: true, key: 'v6', url: 'https://www.youtube.com/watch?v=v6' }),
    videos,
  );
  const posted = channel.sent.map((p) => p.embeds[0].title);
  assert.equal(channel.sent[0].embeds[0].author.name.startsWith('🔴'), true, 'live post first');
  assert.deepEqual(posted.slice(1), ['v4', 'v5'], 'v3 dropped (cap of 3 newest), v6 is the stream');
  assert.equal(row().last_video, 'v6');

  const again = fakeChannel();
  await live.checkAccount(row(), again, {}, async () => ({ live: false }), videos);
  assert.equal(again.sent.length, 0, 'nothing new');
});

test('YouTube feed and page parsing', async () => {
  pages['https://www.youtube.com/feeds/videos.xml?channel_id=UCx'] = feed('aaaaaaaaaaa', 'bbbbbbbbbbb');
  const videos = await live.youtubeVideos('UCx');
  assert.deepEqual(
    videos.map((v) => v.id),
    ['aaaaaaaaaaa', 'bbbbbbbbbbb'],
  );
  assert.equal(videos[0].title, 'Video aaaaaaaaaaa & more');
  pages['https://www.youtube.com/channel/UCx/live'] =
    '<link rel="canonical" href="https://www.youtube.com/watch?v=ccccccccccc"><meta property="og:title" content="Stream!">"isLiveNow":true';
  const s = await live.liveStatus({ platform: 'youtube', ext_id: 'UCx' });
  assert.deepEqual([s.live, s.title, s.key], [true, 'Stream!', 'ccccccccccc']);
  pages['https://www.youtube.com/channel/UCx/live'] =
    '<link rel="canonical" href="https://www.youtube.com/channel/UCx">';
  assert.equal((await live.liveStatus({ platform: 'youtube', ext_id: 'UCx' })).live, false);
  pages['https://www.twitch.tv/someone'] =
    '<script>{"isLiveBroadcast":true}</script><meta property="og:description" content="Playing games">';
  assert.equal((await live.liveStatus({ platform: 'twitch', account: 'someone' })).live, true);
  pages['https://kick.com/api/v2/channels/k'] = JSON.stringify({ livestream: { id: 5, session_title: 'Hi' } });
  assert.deepEqual(await live.liveStatus({ platform: 'kick', account: 'k' }), {
    live: true,
    title: 'Hi',
    url: 'https://kick.com/k',
    key: '5',
  });
});

test('/live is for Manage Server only', () => {
  assert.equal(command.data.toJSON().default_member_permissions, String(PermissionFlagsBits.ManageGuild));
});
