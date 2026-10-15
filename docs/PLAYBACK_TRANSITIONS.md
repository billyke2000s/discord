# Advancing after a song ends or is skipped

The old event guard required the end event's encoded track string to exactly equal
the initially queued encoding. A regression test reproduces a stuck first song when
the same source identifier arrives with a different serialization. Whether this
was the cause on the user's VPS has not been verified from live events.

Each play request now attaches a fresh `serverBotPlaybackId` in Lavalink track
userData. Start/end/stuck/exception events use this playback instance identifier,
so delayed events for a preceding play of the same song do not skip its replacement.
For sources omitting userData, the compatibility fallback compares stable source
identifier/source name before encoded data. Events without identity cannot provide
the same stale-event protection as a returned playback identifier.

The play request explicitly resets position to zero, clears any endTime and unpauses.
A successful skip stop request schedules advancement even if its websocket event is
missing/delayed. The same queue transition guard coalesces a stop event already in
flight. Exceptions also advance instead of merely posting a 'Moving on' message.
An unsuccessful stop request does not schedule an advance.

Coverage includes natural end with changed serialization, stop without an event,
exception followed by loadFailed, stale events for identical consecutive songs,
events arriving before REST completes, and the real Shoukaku Player dispatcher with
an in-memory REST stub: song one finishes, song two starts, skip starts song three.
The persistent music-health log includes `queue-advance` and the queued count,
without song titles, source URLs or playback identifiers. This is not a live audible
test and does not establish that every source/network failure is resolved.

Lavalink's supported track userData and player reset fields are documented in its
[REST API](https://lavalink.dev/api/rest); track lifecycle payloads are in the
[websocket API](https://lavalink.dev/api/websocket).

