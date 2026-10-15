// Lavalink returns a complete playlist, not a stream of entries. Bootstrap one
// public YouTube video independently, then use Lavalink for the authoritative list.
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const { firstObject } = require('./json-entry');
function youtubePlaylist(query) {
  try {
    const url = new URL(query);
    if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.has(url.hostname) || url.username || url.password || url.port) return null;
    const list = url.searchParams.get('list');
    if (!list || !/^[A-Za-z0-9_-]{2,150}$/.test(list)) return null;
    const video = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v');
    return { list, video: /^[A-Za-z0-9_-]{11}$/.test(video || '') ? video : null };
  } catch { return null; }
}

function firstVideo(html) {
  // Restrict discovery to playlist entries: unrelated recommendations are excluded.
  for(const match of html.matchAll(/"playlistVideoRenderer"\s*:\s*(\{)/g)) {
    const entry=firstObject(html,match.index+match[0].length-1);
    if(/^[A-Za-z0-9_-]{11}$/.test(entry?.videoId||''))return entry.videoId;
  }
  return null;
}

async function bootstrapVideo(playlist, fetcher = fetch) {
  if (playlist.video) return playlist.video;
  const response = await fetcher(`https://www.youtube.com/playlist?list=${playlist.list}`, {
    redirect: 'error', signal: AbortSignal.timeout(4000),
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' },
  });
  if (!response.ok) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return firstVideo(text);
      bytes += value.byteLength;
      if (bytes > 2_000_000) return null;
      text += decoder.decode(value, { stream: true });
      const video = firstVideo(text);
      if (video) return video;
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function withoutBootstrap(tracks, first) {
  const index = tracks.findIndex((t) => first.info.identifier
    ? t.info.identifier === first.info.identifier
    : first.info.uri && t.info.uri === first.info.uri);
  // Start at the selected video on watch?list links; otherwise at first playable.
  return index < 0 ? tracks : tracks.slice(index + 1);
}
module.exports = { youtubePlaylist, firstVideo, bootstrapVideo, withoutBootstrap };

