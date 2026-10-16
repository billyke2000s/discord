// Song lyrics from LRCLIB (https://lrclib.net), a free community lyrics database. No account or key.
// Synced lyrics come as LRC text ("[01:23.45] a line"), so the bot can show the line being sung.
// Lyrics are copyrighted by their owners: the bot shows one line on the panel and the rest only in
// private (ephemeral) replies to whoever asks. A failed lookup never affects playback.
const API = 'https://lrclib.net/api';
// LRCLIB asks apps to identify themselves.
const CLIENT = 'server-bot (https://github.com/billyke2000s/discord)';
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 8_000;
const CACHE_SIZE = 300;
const MISS_TTL_MS = 10 * 60_000; // retry songs with no lyrics after 10 minutes
const DURATION_SLACK_S = 10; // a match must be within 10 s of the song's length

// ---------- requests (fixed host, size and time limits) ----------
async function getJson(path, params, fetcher = fetch) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const res = await fetcher(url.toString(), {
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': CLIENT, 'Lrclib-Client': CLIENT, Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB answered ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('LRCLIB answer too large');
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(text);
}

// ---------- LRC parsing ----------
// "[01:23.45] text" (several time tags per line allowed) -> [{ t: ms, text }], sorted by time.
function parseLrc(lrc) {
  const lines = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue; // metadata such as [ar:Artist]
    const text = raw.slice(tags.at(-1).index + tags.at(-1)[0].length).trim();
    for (const m of tags) {
      const frac = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) : 0;
      lines.push({ t: Number(m[1]) * 60_000 + Number(m[2]) * 1000 + frac, text });
    }
  }
  return lines.sort((a, b) => a.t - b.t);
}

// Index of the line being sung at `ms` (the last one that has started), or -1 before the first.
function indexAt(lines, ms) {
  let lo = 0,
    hi = lines.length - 1,
    found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

// ---------- what to search for ----------
// Upload junk in titles: "(Official Video)", "[4K]", "| Lyrics", "ft. Someone"...
const JUNK =
  /\s*[([{【][^)\]}】]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|mv|m\/v|remaster(ed)?|explicit|clean|color coded|prod\.?|feat\.?|ft\.?|with lyrics|music video|full song|topic)\b[^)\]}】]*[)\]}】]/gi;
function cleanTitle(title) {
  return String(title || '')
    .replace(JUNK, '')
    .replace(/\s*[|｜].*$/, '') // "Song | Artist | Label"
    .replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, '')
    .replace(/["“”]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function cleanArtist(author) {
  return String(author || '')
    .replace(/\s*-\s*topic$/i, '')
    .replace(/vevo$/i, '')
    .replace(/\s*(official|music)$/i, '')
    .split(/,|\s&\s|\s(?:feat\.?|ft\.?|x)\s/i)[0]
    .trim();
}

// Spotify entries have a clean title and artist; YouTube titles are often "Artist - Song (Official Video)".
function guess(track) {
  const info = track?.info || {};
  const seconds = info.length > 0 && !info.isStream ? Math.round(info.length / 1000) : undefined;
  if (/open\.spotify\.com/.test(info.uri || ''))
    return { title: cleanTitle(info.title), artist: cleanArtist(info.author), seconds };
  const raw = String(info.title || '');
  const dash = /\s[-–—]\s/.exec(raw);
  if (dash)
    return {
      title: cleanTitle(raw.slice(dash.index + dash[0].length)),
      artist: cleanArtist(raw.slice(0, dash.index)),
      seconds,
    };
  return { title: cleanTitle(raw), artist: cleanArtist(info.author), seconds };
}

// Best of several LRCLIB results: right length, then synced over plain.
function pick(results, seconds) {
  const usable = (results || []).filter(
    (r) =>
      r &&
      (r.instrumental || r.syncedLyrics || r.plainLyrics) &&
      (!seconds || !r.duration || Math.abs(r.duration - seconds) <= DURATION_SLACK_S),
  );
  usable.sort(
    (a, b) =>
      !!b.syncedLyrics - !!a.syncedLyrics ||
      Math.abs((a.duration || 0) - (seconds || 0)) - Math.abs((b.duration || 0) - (seconds || 0)),
  );
  return usable[0] || null;
}

function shape(r) {
  if (!r) return null;
  const synced = r.syncedLyrics ? parseLrc(r.syncedLyrics) : [];
  return {
    title: r.trackName,
    artist: r.artistName,
    instrumental: !!r.instrumental,
    synced: synced.length ? synced : null,
    plain: r.plainLyrics || (synced.length ? synced.map((l) => l.text).join('\n') : null),
  };
}

// ---------- lookup with a small cache ----------
const cache = new Map(); // key -> { value, at }
function cacheKey(track) {
  const i = track?.info || {};
  return `${i.sourceName || ''}:${i.identifier || i.uri || i.title}`;
}

// The lyrics for a queue entry, or null when none are found.
async function lookup(track, fetcher = fetch) {
  const key = cacheKey(track);
  const hit = cache.get(key);
  if (hit && (hit.value || Date.now() - hit.at < MISS_TTL_MS)) return hit.value;
  const { title, artist, seconds } = guess(track);
  let found = null;
  if (title) {
    if (artist) {
      const exact = await getJson('get', { track_name: title, artist_name: artist, duration: seconds }, fetcher);
      found = pick(exact ? [exact] : [], seconds);
      if (!found) found = pick(await getJson('search', { track_name: title, artist_name: artist }, fetcher), seconds);
    }
    if (!found) found = pick(await getJson('search', { q: `${artist || ''} ${title}`.trim() }, fetcher), seconds);
  }
  const value = shape(found);
  cache.set(key, { value, at: Date.now() });
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return value;
}

// A web search for when LRCLIB has nothing.
function searchUrl(track) {
  const { title, artist } = guess(track);
  return `https://www.google.com/search?q=${encodeURIComponent(`${artist || ''} ${title || track?.info?.title || ''} lyrics`.trim())}`;
}

module.exports = { lookup, parseLrc, indexAt, guess, cleanTitle, pick, searchUrl, _cache: cache };
