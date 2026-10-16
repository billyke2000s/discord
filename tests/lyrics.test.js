const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { EmbedBuilder, MessageFlags } = require('discord.js');
require.cache[require.resolve('../src/lib/util')] = {
  exports: {
    embed: () => new EmbedBuilder(),
    truncate: (s, n) => {
      s = String(s ?? '');
      return s.length > n ? s.slice(0, n - 1) + '…' : s;
    },
    fmtDuration: () => '0:00',
    isBotAdmin: () => false,
  },
};
const lyrics = require('../src/lib/lyrics');
const { GuildQueue } = require('../src/lib/music');
const music = require('../src/commands/music');

// A fetch stand-in that answers from a list and records what was asked.
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: new URL(url), opts });
    const a = answers.shift() ?? { status: 404 };
    const bytes = new TextEncoder().encode(JSON.stringify(a.json ?? null));
    let done = false;
    return {
      status: a.status,
      ok: a.status >= 200 && a.status < 300,
      body: {
        getReader: () => ({
          read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })),
          cancel: async () => {},
        }),
      },
    };
  };
  fn.calls = calls;
  return fn;
}
const LRC = '[ar:Someone]\n[00:01.00]First line\n[00:05.50][00:20.00]Chorus\n[00:10.25]Second *line*\n[00:15.00]';

test('LRC parsing handles metadata, repeated time tags and blank lines; indexAt finds the sung line', () => {
  const lines = lyrics.parseLrc(LRC);
  assert.deepEqual(
    lines.map((l) => [l.t, l.text]),
    [
      [1000, 'First line'],
      [5500, 'Chorus'],
      [10250, 'Second *line*'],
      [15000, ''],
      [20000, 'Chorus'],
    ],
  );
  assert.equal(lyrics.indexAt(lines, 0), -1);
  assert.equal(lyrics.indexAt(lines, 1000), 0);
  assert.equal(lyrics.indexAt(lines, 9999), 1);
  assert.equal(lyrics.indexAt(lines, 99_000), 4);
});

test('messy YouTube titles and Spotify entries become a clean title and artist', () => {
  assert.deepEqual(
    lyrics.guess({
      info: {
        title: 'Queen – Bohemian Rhapsody (Official Video Remastered)',
        author: 'Queen Official',
        length: 355_000,
      },
    }),
    { title: 'Bohemian Rhapsody', artist: 'Queen', seconds: 355 },
  );
  assert.deepEqual(
    lyrics.guess({ info: { title: 'Midnight City [4K] | Some Label', author: 'M83 - Topic', length: 243_400 } }),
    { title: 'Midnight City', artist: 'M83', seconds: 243 },
  );
  assert.deepEqual(
    lyrics.guess({
      info: {
        title: 'Song ft. Guest',
        author: 'Main Artist, Guest',
        length: 200_000,
        uri: 'https://open.spotify.com/track/abc',
      },
    }),
    { title: 'Song', artist: 'Main Artist', seconds: 200 },
  );
  assert.equal(lyrics.cleanTitle("(Don't Fear) The Reaper"), "(Don't Fear) The Reaper", 'real brackets stay');
  assert.equal(lyrics.guess({ info: { title: 'x', length: 1, isStream: true } }).seconds, undefined);
});

test('lookup: exact match first, then search picks the right-length synced result; results are cached', async () => {
  const track = { info: { identifier: 'vid-1', sourceName: 'youtube', title: 'Artist - Tune', length: 180_000 } };
  const f = fakeFetch([
    { status: 404 },
    {
      status: 200,
      json: [
        { trackName: 'Tune', artistName: 'Artist', duration: 180, plainLyrics: 'plain only' },
        { trackName: 'Tune (Live)', artistName: 'Artist', duration: 260, syncedLyrics: '[00:01.00]wrong length' },
        { trackName: 'Tune', artistName: 'Artist', duration: 182, plainLyrics: 'a', syncedLyrics: LRC },
      ],
    },
  ]);
  const found = await lyrics.lookup(track, f);
  assert.equal(found.synced.length, 5);
  assert.equal(found.title, 'Tune');
  assert.equal(f.calls[0].url.host, 'lrclib.net');
  assert.equal(f.calls[0].url.pathname, '/api/get');
  assert.equal(f.calls[0].url.searchParams.get('track_name'), 'Tune');
  assert.equal(f.calls[0].url.searchParams.get('artist_name'), 'Artist');
  assert.equal(f.calls[0].url.searchParams.get('duration'), '180');
  assert.match(f.calls[0].opts.headers['User-Agent'], /server-bot/);
  assert.equal(f.calls[0].opts.redirect, 'error');
  assert.equal(f.calls[1].url.pathname, '/api/search');
  await lyrics.lookup(track, f);
  assert.equal(f.calls.length, 2, 'second lookup comes from the cache');
});

test('lookup returns null when nothing matches, and LRCLIB errors are thrown for the caller to handle', async () => {
  const none = { info: { identifier: 'vid-none', title: 'Nobody - Nothing', length: 100_000 } };
  assert.equal(await lyrics.lookup(none, fakeFetch([])), null);
  const broken = { info: { identifier: 'vid-500', title: 'A - B', length: 100_000 } };
  await assert.rejects(lyrics.lookup(broken, fakeFetch([{ status: 500 }])), /500/);
});

function queueWith(findLyrics) {
  const manager = {
    client: { guilds: { cache: new Map() } },
    queues: new Map(),
    shoukaku: { leaveVoiceChannel: async () => {} },
    recordAudio: () => {},
    findOnYouTube: async () => null,
    findLyrics,
  };
  const player = new EventEmitter();
  player.playTrack = async () => {};
  player.stopTrack = async () => {};
  player.setGlobalVolume = async () => {};
  const q = new GuildQueue(manager, 'g1', player, null, 'vc');
  q.send = () => {};
  q.listeners = () => new Map([['h', {}]]);
  return q;
}
const song = (id) => ({
  encoded: `enc-${id}`,
  requester: 'u',
  info: { identifier: id, title: `Song ${id}`, length: 60_000 },
});

test('the panel shows the line being sung and has a Lyrics button; a failed lookup never breaks it', async () => {
  const q = queueWith(async () => ({ title: 'Song a', synced: lyrics.parseLrc(LRC), plain: 'x' }));
  q.add([song('a')]);
  await q.start();
  await q.loadLyrics(q.current);
  q.clock = { base: 10_500, at: Date.now() };
  const payload = q.panelPayload();
  assert.match(payload.embeds[0].toJSON().description, /🎤 \*Second \\\*line\\\*\*/, 'line shown, markdown escaped');
  const ids = payload.components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
  assert.ok(ids.includes('music:lyrics'));
  await q.destroy();

  const failing = queueWith(async () => {
    throw new Error('LRCLIB down');
  });
  failing.add([song('b')]);
  await failing.start();
  assert.equal(await failing.lyricsFor(failing.current), null);
  await failing.loadLyrics(failing.current);
  assert.doesNotMatch(failing.panelPayload().embeds[0].toJSON().description, /🎤/);
  await failing.destroy();
});

test('the private view highlights the current line among more lines, or offers a web search', () => {
  const q = { sessionId: 's', position: () => 10_500 };
  const track = song('c');
  const found = { title: 'Song c', artist: 'Band', synced: lyrics.parseLrc(LRC), plain: 'x' };
  const view = music.lyricsView(q, track, found);
  const e = view.payload.embeds[0].toJSON();
  assert.equal(e.title, '🎤 Song c — Band');
  assert.match(e.description, /First line\nChorus\n\*\*▶ Second \\\*line\\\*\*\*\n♪\nChorus/);
  assert.match(e.footer.text, /Only you can see this/);

  const none = music.lyricsView(q, track, null);
  const link = none.payload.components[0].toJSON().components[0];
  assert.match(link.url, /^https:\/\/www\.google\.com\/search\?q=.*lyrics$/);
  assert.notEqual(view.key, music.lyricsView({ ...q, position: () => 1_000 }, track, found).key);
});

test('/lyrics replies privately, follows the song, and stops when the music stops', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let pos = 1_000;
    const q = {
      sessionId: 's',
      current: song('d'),
      position: () => pos,
      lyricsFor: async () => ({ title: 'Song d', synced: lyrics.parseLrc(LRC), plain: 'x' }),
    };
    const queues = new Map([['g', q]]);
    const edits = [];
    let deferred;
    const i = {
      guildId: 'g',
      user: { id: 'u' },
      client: { music: { get: (id) => queues.get(id), findLyrics: () => {} } },
      deferReply: async (o) => {
        deferred = o;
      },
      editReply: async (p) => {
        edits.push(p);
      },
      reply: async () => assert.fail('should defer'),
    };
    await music.commands.find((c) => c.data.name === 'lyrics').execute(i);
    assert.equal(deferred.flags, MessageFlags.Ephemeral);
    assert.match(edits[0].embeds[0].toJSON().description, /\*\*▶ First line\*\*/);
    const flush = () => new Promise((r) => setImmediate(r));
    mock.timers.tick(4_000);
    await flush();
    assert.equal(edits.length, 1, 'same line: nothing re-sent');
    pos = 6_000;
    mock.timers.tick(4_000);
    await flush();
    assert.match(edits[1].embeds[0].toJSON().description, /\*\*▶ Chorus\*\*/);
    queues.delete('g');
    mock.timers.tick(4_000);
    await flush();
    assert.match(edits[2].content, /music stopped/);
    assert.equal(music._liveLyrics.size, 0);
  } finally {
    mock.timers.reset();
  }
});
