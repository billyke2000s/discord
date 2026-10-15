const { test } = require('node:test');
const assert = require('node:assert/strict');
const { youtubePlaylist, firstVideo, bootstrapVideo, withoutBootstrap } = require('../src/lib/playlist');
test('accept only exact YouTube hosts and valid IDs', () => {
  assert.equal(youtubePlaylist('https://youtube.com.evil.test/playlist?list=PL123'), null);
  assert.equal(youtubePlaylist('http://127.0.0.1/?list=PL123'), null);
  assert.equal(youtubePlaylist('https://youtube.com:8443/?list=PL123'), null);
  assert.deepEqual(youtubePlaylist('https://youtu.be/abcdefghijk?list=PL123'), { list: 'PL123', video: 'abcdefghijk' });
});
test('page bootstrap excludes unrelated video IDs and handles split chunks', async () => {
  const html = '{"videoId":"wrongwrong1"} {"playlistVideoRenderer":{"videoId":"abcdefghijk"}}';
  assert.equal(firstVideo(html), 'abcdefghijk');
  const bytes = new TextEncoder().encode(html);
  const result = await bootstrapVideo({ list: 'PL123' }, async () => ({ ok: true, body: new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 75)); c.enqueue(bytes.slice(75)); c.close(); } }) }));
  assert.equal(result, 'abcdefghijk');
});
test('watch link does not fetch HTML and selected track is removed only once', async () => {
  assert.equal(await bootstrapVideo({ video: 'abcdefghijk' }, () => { throw new Error('unexpected fetch'); }), 'abcdefghijk');
  const t = (id) => ({ info: { identifier: id } });
  assert.deepEqual(withoutBootstrap([t('a'), t('b'), t('b'), t('c')], t('b')), [t('b'), t('c')]);
});
test('health requires fresh Discord and music readiness', () => {
  const { healthy } = require('../src/lib/health');
  assert.equal(healthy({ ready: true, music: true, at: 1000 }, 2000), true);
  assert.equal(healthy({ ready: true, music: false, at: 1000 }, 2000), false);
  assert.equal(healthy({ ready: true, music: true, at: 1000 }, 40000), false);
});
