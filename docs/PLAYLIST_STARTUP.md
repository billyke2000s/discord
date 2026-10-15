# First song while the playlist loads

Spotify album/playlist embed responses are read incrementally. When the first
complete song appears in the supported public JSON format, the reader is cancelled
and that song is returned immediately. The queue starts it before requesting the
authoritative remaining list. Songs are matched to YouTube as needed, with two
upcoming songs prefetched. The initial lookup no longer waits for the full page.

YouTube watch links with a playlist use their selected video directly. Playlist-only
links read the first playlist entry incrementally; JSON field order does not matter.
After playback starts, Lavalink loads the remaining list in the background.

Both early lookups are bounded to four seconds and 2 MB. If a service changes its
public format or does not expose a first playable entry, the existing full-loader
fallback remains. This can still delay startup; it is a compatibility limitation,
not a guarantee of instant playback for every URL. Public Spotify embeds can expose
fewer songs than the original playlist. Remaining imports obey the 500-track queue
limit. Playback remains running if the background list fails to load.

Regression coverage holds the remaining 200-entry Spotify import unresolved while
asserting the first song has already played, and uses a 501-entry streamed embed
fixture to verify the initial response stops after the first entry. Real audible
playback and the user's particular link have not been verified.

