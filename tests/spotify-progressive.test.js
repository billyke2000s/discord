const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadForPlayback, firstTrack } = require('../src/lib/spotify');
const { withoutBootstrap, firstVideo } = require('../src/lib/playlist');
const song = { title: 'First {song}', subtitle: 'Artist', duration: 180000, uri: 'spotify:track:first' };
test('Spotify starts from an early entry without reading hundreds of remaining entries', async () => {
  let reads = 0,
    cancelled = false,
    requests = 0;
  const entries = [
    song,
    ...Array.from({ length: 500 }, (_, i) => ({ ...song, title: `Song ${i}`, uri: `spotify:track:t${i}` })),
  ];
  const entity = { name: 'Large playlist', type: 'playlist', uri: 'spotify:playlist:abc', trackList: entries };
  const prefix =
    '<html><body><script id="__NEXT_DATA__">{"props":{"pageProps":{"state":{"data":{"entity":{"trackList":[' +
    JSON.stringify(song) +
    ',';
  const full =
    '<html><body><script id="__NEXT_DATA__">' +
    JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } }) +
    '</script></body></html>';
  const result = await loadForPlayback('https://open.spotify.com/playlist/abc', async () => {
    requests++;
    if (requests > 1) return { ok: true, text: async () => full };
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            reads++;
            if (reads > 1) throw Error('Must not wait for the rest');
            return { done: false, value: new TextEncoder().encode(prefix) };
          },
          cancel: async () => {
            cancelled = true;
          },
        }),
      },
    };
  });
  assert.equal(reads, 1);
  assert.equal(cancelled, true);
  assert.equal(requests, 1);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].uri, song.uri);
  const remaining = await result.remaining();
  assert.equal(requests, 2);
  assert.equal(remaining.tracks.length, 501);
});
test('early parsers handle reordered fields, escaped strings and incomplete objects', () => {
  const prefix = '<script id="__NEXT_DATA__">{"trackList":[';
  assert.equal(firstTrack(prefix + JSON.stringify(song)).title, song.title);
  assert.equal(firstTrack(prefix + '{"title":"unfinished'), null);
  assert.equal(firstTrack('"trackList":[' + JSON.stringify(song)), null);
  assert.equal(
    firstVideo('{"playlistVideoRenderer":{"title":{"text":"a } quote \\""},"videoId":"abcdefghijk"}}'),
    'abcdefghijk',
  );
  const t = (uri) => ({ info: { uri } });
  assert.deepEqual(withoutBootstrap([t('a'), t('b'), t('c')], t('b')), [t('c')]);
});
