# Reading the bot check

`/diagnostics` is the full admin check. Members have `/status` instead, which only says whether music is working (see the README). `/diagnostics` needs Manage Server, the reply is private, and only one check runs at a time, once a minute for the whole bot. A refused request does no checking at all. The cooldown resets when the bot restarts.

## What you get

**The summary (in Discord)**

1. A verdict: ✅ Everything looks fine, ⚠️ N things to review, or ❌ N problems found.
2. One line each for **Bot, Music, Internet, Server, Data & protection and Setup**. A healthy area shows a short plain summary (for example "CPU 4% · 3.1 GB memory free · 32.0 GB disk free"). An area with a problem names the checks that need attention.
3. **What to do:** each failure or warning with one next step, worst first (up to five; the rest are in the file).
4. Anything that couldn't be measured.

**The file (`bot-diagnostics.txt`)**

Every check with its number, grouped by area, worst first. Channel and role mentions are written as names with IDs, times are UTC, and each line starts with a word you can search for:

| Word | Meaning |
|---|---|
| `OK` | The check passed |
| `WARN` | Needs a look |
| `FAIL` | Broken |
| `UNMEASURED` | Couldn't be checked. Not a pass |
| `INFO` | Off, not set up, or just for information |

Next steps appear only on `WARN`, `FAIL` and `UNMEASURED` lines. An optional feature that's off is `INFO`, not a fault.

## What each area checks

**Bot:** Discord response time, the bot's permissions, whether its role is high enough, and uptime. Administrator is a warning once `/setup rebuild` is locked, because the bot no longer needs it; the file lists the permissions to give instead.

**Music:** whether the music server (Lavalink) is connected, its CPU, its memory against the Java maximum (`-Xmx`), the share of audio frames that were missing or late in the last minute, whether the YouTube plugin is loaded, a YouTube search, the YouTube helper, reading a public Spotify song, and stall/voice warnings for the current song. Missing or late audio: under 1% is fine, 1–5% is a warning, over 5% is a failure.

**Internet:** a small HTTPS test against Cloudflare's speed-test endpoints: 5 response-time requests (the median is shown, with the range), a 2 MiB download and a 256 KiB upload of zero bytes, all within 12 seconds. Nothing from the bot is uploaded. The results are rough: the transfers are kept small so they don't disturb music, so a fast VPS may look slower than it is. It doesn't measure packet loss or the route to Discord's voice servers. Below 2 Mbps or over 500 ms is a warning.

**Server:** free disk space, CPU busy, time spent waiting for the disk or the host (hypervisor), load against the number of cores, free memory (Linux `MemAvailable`, which counts reusable cache as free), swap, the bot's own CPU, and two memory figures for the bot:

- **Bot memory** is the process's resident memory, which includes shared program files.
- **Bot container memory** is what the container is charged for, which is what its limit applies to.

They're counted differently, so the process figure can be the higher one. CPU and memory warn at 85% and fail at 95%; waiting warns at 10%; a slowest reaction over 200 ms warns. The CPU sample lasts one second, so it can miss a short spike.

**Data & protection:** a database integrity and write test, the age of the last **daily or weekly** backup (installer and update snapshots don't count, so a broken daily backup can't hide behind them; older than 26 hours fails), the scam list, lockdown (on is a warning) and whether `/setup rebuild` has been used.

**Setup:** that the configured log, welcome, verification, ticket, join-to-create, self-promo and suggestion channels and roles still exist and that the bot can post where it needs to.

## Limits

The check is a snapshot. It can't hear the audio, and a healthy result taken after a cutout doesn't explain the cutout. When music cuts out, run it while it's happening and save the music log before restarting:

```bash
docker compose exec -T bot tail -n 80 /app/data/music-health.jsonl
```

The bot can't see inside the other containers, so the YouTube helper's CPU and memory and the music container's total memory aren't shown.
