// Spotify links without any Spotify account, token or browser.
// Spotify's public embed page (the player websites put on their pages) already lists the songs,
// so the bot reads title + artist from it and plays each song from YouTube when its turn comes.
// Uses spotify-url-info (MIT), which knows how to read that page.
const spotifyInfo = require('spotify-url-info');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const info = spotifyInfo((url, opts) => fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts?.headers || {}) }, signal: AbortSignal.timeout(15_000) }));

const SPOTIFY_RE = /^https?:\/\/(open\.spotify\.com|spotify\.link|play\.spotify\.com)\//i;
const isSpotifyUrl = (q) => SPOTIFY_RE.test(q.trim());

// spotify.link/xxxx short links redirect to open.spotify.com: follow them first.
async function expand(url) {
  if (!/spotify\.link\//i.test(url)) return url;
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
  return res.url;
}

// Returns { name, tracks: [{ title, artist, length, uri }] }. Throws a friendly error if the page can't be read.
async function load(url) {
  let data;
  try {
    const full = (await expand(url.trim())).replace(/\/intl-[a-z-]+\//i, '/'); // /intl-de/ etc.
    const m = /open\.spotify\.com\/(track|album|playlist)\/([A-Za-z0-9]+)/i.exec(full);
    if (!m) throw new Error('not a Spotify song, album or playlist link');
    // The embed page: https://open.spotify.com/embed/<type>/<id>
    const res = await fetch(`https://open.spotify.com/embed/${m[1].toLowerCase()}/${m[2]}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Spotify answered ${res.status}`);
    try {
      data = spotifyInfo.parseData(await res.text());
    } catch {
      data = await info.getData(full); // the library's own way, in case the page moved
    }
  } catch (e) {
    const err = new Error('Couldn’t read that Spotify link. It may be private, or Spotify changed their page.');
    err.cause = e;
    throw err;
  }
  const list = data.trackList?.length ? data.trackList : [data];
  const tracks = list
    .filter((t) => t && (t.title || t.name) && t.uri && !String(t.uri).includes(':episode:'))
    .map((t) => ({
      title: t.title || t.name,
      artist: t.subtitle || (t.artists || []).map((a) => a.name).join(', '),
      length: t.duration || 0,
      uri: t.uri,
    }));
  if (!tracks.length) throw new Error('That Spotify link has no playable songs.');
  return { name: data.name || data.title || 'Spotify', type: data.type, tracks };
}

// Album name of one song, from the song's public Spotify page. Its preview text reads
// "Artist · Album · Song · Year". Only used when the YouTube search wasn't sure. null if unavailable.
async function albumOf(trackUrl) {
  try {
    const res = await fetch(trackUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    return parseAlbum(await res.text());
  } catch { return null; }
}
function parseAlbum(html) {
  const m = /<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i.exec(html)
         || /<meta[^>]+content="([^"]*)"[^>]+property="og:description"/i.exec(html);
  if (!m) return null;
  const text = m[1].replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const parts = text.split(' · ');
  return parts.length >= 4 && /^song$/i.test(parts[parts.length - 2]) ? parts.slice(1, -2).join(' · ') || null : null;
}

// "spotify:track:abc" -> "https://open.spotify.com/track/abc"
const openUrl = (uri) => {
  const m = /^spotify:(track|album|playlist):([A-Za-z0-9]+)/.exec(uri || '');
  return m ? `https://open.spotify.com/${m[1]}/${m[2]}` : null;
};

module.exports = { isSpotifyUrl, load, openUrl, albumOf, parseAlbum };
