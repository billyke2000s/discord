# Bot audit and music changes

Reviewed repository baseline: `ed211b1a15c2e580392598a65644f7b51e5bd550`.
Static review covered every source module, Docker/Compose, installer, release workflow,
dependency lockfile and patched YouTube client. Tests use mocked audio and Discord;
they are not a measurement of live audio quality.

The owner reports a RackNerd VPS with 3 cores, 4 GB RAM and 6 TB traffic.
I cannot verify its live utilisation, installation version, Docker settings, or logs.
I cannot verify the cause of the reported cutouts.

## Confirmed findings and changes

| Area | Evidence in baseline | Change / assessment |
|---|---|---|
| Music transitions | `GuildQueue.next()` shared `current` across awaits; end/stuck could invoke it concurrently | One transition promise, stale encoded-track event checks, cancellation after destroy |
| Playback failure | A rejected `playTrack` was caught without advancing or resetting current | Try the next entry after a rejected start |
| Spotify gaps | YouTube matching started only when each track became current; album fallback can add another request | Match at most two upcoming entries, sequentially, reusing in-flight work. No eager 200-song search storm |
| YouTube import | `/play` awaited the entire `/loadtracks` playlist response before creating/starting a player | Resolve one video first, then fetch the authoritative playlist after playback starts. Serialized guild requests keep later additions behind the import |
| Late background work | Async matching/panel requests could finish after stop | Discard cancelled resolutions/imports and late panels |
| Buffering / CPU | Native buffer 400 ms; decoded-frame buffer 5000 ms; Opus quality 10 | Native buffer 1500 ms, frame buffer unchanged, encoder quality 5. Configurable via Lavalink environment variables |
| Lockdown | `verify:start` checked lockdown but `verify:modal` did not | Submission rechecks verification and lockdown before consuming a challenge/granting a role |
| Repository hygiene | Ignore patterns had literal leading spaces, so ordinary `.env`, dependencies and generated outputs were not ignored | Corrected ignore patterns and excluded updater state |
| Privileged commands | Most relied on slash command defaults; no central runtime permission check | Recheck required member permissions at dispatch. Owners/admins with Discord Administrator still pass |
| Diagnostics | Frame loss divided by one player's minute; high loss attributed categorically to busy VPS | Scale by reported playing players and remove the unsupported root-cause assertion |
| Deployment | Releases/installer existed, but no opt-in scheduled deploy with health rollback | Host systemd timer, digest manifest, backup, readiness gate, rollback, failed-image quarantine, interrupted-update recovery |

## Buffer tradeoffs

[Lavalink's configuration](https://lavalink.dev/configuration/config/file) distinguishes
the native sending buffer (helps tolerate JVM pauses) from the decoded audio frame
buffer (five seconds here). The 1.5-second setting is supported buffering, not a
forced sleep before sending the first track. It does not promise that every track
has 1.5 seconds of source audio downloaded before its first frame.

[Inference] More native buffering may tolerate longer pauses at the cost of latency;
lower encoder complexity may reduce CPU work at a quality cost. These are tuning
choices, not verified remediation of the owner's cutouts. Pausing cannot be used
as an assumed prebuffer mechanism: the REST API has no buffer-fill readiness event.
Measure before/after rather than assuming success.

## Playlist limits

[Lavalink REST](https://lavalink.dev/api/rest) returns a complete track list; it does
not stream playlist entries to Shoukaku. The fast path therefore uses a separate
single-video request. For watch links, that is the selected video; later entries
start after that video's first occurrence. For playlist-only links, a bounded public
YouTube page request discovers the first playlist video. It accepts exact YouTube
hosts, does not follow redirects, times out after four seconds, reads at most 2 MB,
and falls back to normal Lavalink loading if discovery/resolution fails. The page
format is unofficial and can change. Extra requests are the cost of faster startup.

The rest loads in the background while the first track plays. One import per guild
is processed at a time; another `/play` waits behind it. Queue capacity is 2,000 (including the current song)
waiting entries. Stop/disconnect discards imports. An empty queue waits for an import,
but leaving an empty voice channel still ends the session. Failed imports keep the
first track and report an error. Playlist order and intentional repeats remain;
only the bootstrap occurrence and preceding entries on selected-video links are removed.

Spotify already reads playlist metadata in one request and resolves each audio match
lazily. This change overlaps the next two audio matches with playback. It cannot
play before Spotify returns metadata, nor recover entries Spotify's public embed
does not return. A reported 200-song playlist needs a live entry-count comparison;
no Spotify account/API integration has been added.

## Strengths confirmed in code

- Locked dependencies and container/version pinning; installer verifies plugin checksum.
- Bot runs as an unprivileged container user; music/helper ports are not published.
- SQLite WAL, prepared statements, startup integrity check, online daily/weekly backups.
- Rebuild checks owner/bot admin, requires server name confirmation and a backup;
  database and filesystem rebuild locks persist across bot restarts.
- Moderation role hierarchy checks, button role checks at creation and click time,
  channel-local music controls and majority votes.
- Fetch timeouts for Spotify/scam lists, bounded music queue and rotated Docker logs.
- Separation between commands, music manager, persistent storage and gateway events
  is usable for this small self-hosted bot. The audio service is a separate process.

## Remaining issues / follow-up priorities

These are code findings, not proof they caused music cutouts.

1. **High: unrestricted outbound URL loading.** `MusicManager.resolve` accepts arbitrary
   HTTP(S) URLs and Lavalink's HTTP source is enabled. Untrusted members can direct
   server-side requests. No egress filter is configured in this repository.
   [Unverified] Exploitability of private-network targets depends on source-manager
   checks, DNS/redirect handling and host networking. Consider disabling the HTTP
   source if direct audio-file URLs are not needed; otherwise enforce an outbound
   proxy/firewall policy. It remains enabled to preserve current source support.
2. **Medium: resource creation races.** Ticket opening and join-to-create look up an
   existing row before awaiting channel creation, without a per-user creation lock.
   Concurrent requests can create multiple channels. Add deduplication and recovery
   separately; these paths were reviewed but not rewritten in a music/deploy PR.
3. **Medium: rebuild backup completeness and CPU.** Message-fetch failures become
   `null` and stop copying that channel; filenames derive from sanitised names, so
   different names can collide. `zipSync(level:9)` blocks the bot event loop and holds
   all transcripts in memory. Rebuild excludes thread transcripts. These limits need
   explicit backup completeness reporting before relying on an export for recovery.
4. **Medium: manual installer backup failure.** The old path stops the bot and merely
   warns when database copying fails; it can proceed without a database backup.
   The new automatic updater instead aborts when the online backup command fails.
5. **Medium: broad setup power.** `/setup verify` can select a normal but privileged
   role; runtime ManageGuild is required, but a more granular trust model would also
   check actor hierarchy and dangerous role bits. `GUILD_ID` limits command sync,
   not every gateway handler. Do not treat it as a guild access boundary.
6. **Medium: no durable music queue.** Queues/votes are memory-only; reconnect and
   updates drop playback. The new updater normally defers while any music session
   exists. A request racing the final idle check may still be interrupted.
7. **Low/operational: external format and supply-chain dependence.** Spotify scraping,
   patched YouTube OAuth clients and cipher helper can change independently. Release
   actions use major-version action tags; further hardening could pin action commits
   and verify published provenance. New updater trusts this repository's release
   manifest and digest; this is integrity pinning, not independent publisher attestation.
8. **Low: expensive diagnostics/sweeps.** `/diagnostics` runs an SQLite check and live
   remote searches. Captcha drawing/SQLite operations are synchronous. Several async
   intervals have no overlap guard. [Inference] They may add bot event-loop delay on
   a busy server, but Lavalink sends audio separately, so this alone does not establish
   a source of mid-song audio loss.

The dependency install audit reported zero known vulnerabilities for the locked tree
at review time. That is not a proof that the bot or dependencies are vulnerability-free.

## Validation and rollout

### Playback evidence added after the live report

The owner supplied a report that said music was playing while the audio check said
"nothing playing". That branch actually means frame statistics were unavailable.
It now warns rather than passing. A playback monitor records actual player updates
(not the panel's extrapolated clock), voice connection/ping, node CPU and frame counters
when supplied. It checks every five seconds during started, unpaused playback: no
updates for 20 seconds, or unchanged position with fresh updates for 15 seconds,
become separate warnings. Voice disconnect and ping at or above 1000 ms are recorded.
Track changes/pause reset the stall window. Warnings are logged once per episode,
with recovery events; source exceptions, stuck tracks, failed starts and voice closes
are also recorded without raw exception messages, tokens, track URLs or titles.

`/diagnostics` shows active observations and the most recent issue retained in memory.
Samples are recorded every 30 seconds while playing. Persistent evidence is saved in
the SQLite data volume as `/app/data/music-health.jsonl`, with two rotated files
(`.1`, `.2`), each rotated at approximately 2 MB. Disk writes are asynchronous and
serialized, with at most 100 pending writes; overload drops observations rather than
growing memory without a bound. A write failure logs an error code. Evidence survives
a normal container restart; an observation not yet written when the process stops
can be lost. Per-guild memory retains only the last 20 events.

Read recent evidence after installing the PR's image:

```bash
docker compose exec -T bot tail -n 80 /app/data/music-health.jsonl
```

These observations cannot detect every audible interruption. Player position can
advance while audio packets fail downstream. No microphone recording, automated
restart, or root-cause claim is added. Six deterministic monitor tests cover stalled
position, missing updates, pause/reset, recovery, voice signals, stopped playback,
and unavailable frame statistics; the JavaScript suite now contains 25 tests.

Run `npm test`, `python3 -m unittest discover -s tests -p 'test_*.py'`, and the installer
packaging/syntax checks. PR CI exercises these on Linux with Node 22; release CI runs
the tests before building images. Node tests mock SQLite and avoid bot login; updater
tests mock Docker calls and check successful deployment, rollback and crash recovery.

No VPS access, bot token or live Discord voice session was supplied. Docker image
build, systemd execution, actual source playback and live playlist timings require
Linux CI / staging / the owner's host. No live deployment was performed.

After manual review/merge and installation, test a short YouTube link, watch+playlist,
playlist-only link and Spotify playlist. Check count/order, vote skip/stop, pause,
disconnect and concurrent `/play`. Capture first-audio time and gaps for the same
playlist before/after. During cutouts capture `/diagnostics`, `docker stats --no-stream`,
`docker compose logs --since 10m bot lavalink yt-cipher`, and host CPU/memory/IO data.
Redact tokens (especially YouTube login messages) before sharing logs.

[Hypothesis] Missing frames plus CPU/GC spikes would support investigating compute
pressure; upstream exceptions or HTTP failures would support investigating source
loading; low CPU with audible loss needs network/voice-path investigation. Neither
a 4 GB allocation nor a large traffic allowance verifies real-time network stability.

