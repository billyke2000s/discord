const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, SPOTIFY_PUBLIC_LIMIT } = require('../src/lib/spotify');

const page = (type, count) => {
  const trackList = Array.from({ length: count }, (_, i) => ({
    title: `Song ${i}`,
    subtitle: 'Artist',
    duration: 1000,
    uri: `spotify:track:t${i}`,
  }));
  const entity = { name: 'Big list', type, uri: `spotify:${type}:abc`, trackList };
  return (
    '<html><body><script id="__NEXT_DATA__">' +
    JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } }) +
    '</script></body></html>'
  );
};
const fetcher = (html) => async () => ({ ok: true, text: async () => html });

test('a Spotify playlist that fills the public 100-song page is flagged as cut short', async () => {
  assert.equal(SPOTIFY_PUBLIC_LIMIT, 100);
  const full = await load('https://open.spotify.com/playlist/abc', fetcher(page('playlist', 100)));
  assert.equal(full.tracks.length, 100);
  assert.equal(full.limited, true);
  const small = await load('https://open.spotify.com/playlist/abc', fetcher(page('playlist', 42)));
  assert.equal(small.limited, false);
  const album = await load('https://open.spotify.com/album/abc', fetcher(page('album', 100)));
  assert.equal(album.limited, true);
});
