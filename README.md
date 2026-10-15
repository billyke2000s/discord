# Server Bot

An all-in-one Discord bot for a server that you host yourself. It covers music (YouTube and Spotify), join-to-create voice channels, captcha verification, moderation, a scam-link filter, tickets, logs and a one-time server builder.

Runs on your VPS in three Docker containers: the bot, Lavalink (music), and the YouTube cipher helper. The supplied Compose configuration does not publish their ports to the internet.

Start with **2 GB RAM and 1–2 CPU cores**; **4 GB RAM and 2+ cores** gives more room. Actual capacity depends on playback and other VPS workloads.

**Already installed?** Go to [Update the bot](#update-the-bot). Installing a release and enabling automatic updates are **two separate steps**. The installer does not ask about automatic updates.

---

## Contents

1. [Features](#features)
2. [What you need](#what-you-need)
3. [Install](#install)
4. [First time in Discord](#first-time-in-discord)
5. [Server layout](#server-layout)
6. [Commands](#commands)
7. [Music](#music)
8. [Verification, moderation and protection](#verification-moderation-and-protection)
9. [Who can reset the server](#who-can-reset-the-server)
10. [Birthdays](#birthdays)
11. [Update the bot](#update-the-bot)
12. [Diagnostics](#diagnostics)
13. [Backups](#backups)
14. [Troubleshooting](#troubleshooting)
15. [Limits and known weak spots](#limits-and-known-weak-spots)
16. [Files](#files)
17. [Credits](#credits)

Quick links: [Manual update](#manual-update-or-configuration-changes) · [Enable automatic updates](#enable-automatic-updates-once) · [Update now](#check-and-update-now) · [Birthdays](#birthdays) · [Diagnostics](#diagnostics)

---

## Features

| | |
|---|---|
| 🎵 **Music** | Song names, YouTube links/playlists and Spotify links/playlists/albums. A self-updating panel with pause, vote skip, vote stop, shuffle, queue and volume. |
| 🔊 **Join-to-create voice** | Join the lobby and you get your own voice channel, which you control with `/vc`. It's deleted when it empties. |
| ✅ **Captcha verification** | New people must read an image code before they see the server. Anyone who doesn't verify in 15 minutes is kicked. |
| 🛡️ **Moderation** | warn, timeout, kick, ban, purge, slowmode and more, all logged. `/lockdown` for raids. |
| 🚫 **Scam filter** | Deletes known Discord and Steam scam links and catches hacked-account spam. |
| 🎫 **Tickets** | A private channel with staff at the click of a button. |
| 🏷️ **Button roles** | Members pick their own roles. |
| 📋 **Logs** | Joins, leaves, deleted and edited messages, and every mod action. |
| 👋 **Welcome, suggestions, self-promo** | Welcome message, 👍/👎 plus a discussion thread on suggestions, and a 7-day wait before self-promo. |
| 🏗️ **Server builder** | `/setup rebuild` builds the whole server layout in one go. It works once, then locks. |
| 🎂 **Birthdays** | Private birthday set/show commands, a friendly announcement including age, and a 👑 Birthday role for 24 hours. |
| 🩺 **Diagnostics** | Grouped checks, resource readings, playback observations and a small speed test. Missing measurements are identified. |
| 🔄 **Optional automatic updates** | Daily checks for published bot releases, music-session deferral, backups and health-based image rollback. Requires explicit setup below. |
| 💾 **Backups** | Scheduled database backups and update snapshots; see the coverage and restore instructions below. |

---

## What you need

- A VPS running **Ubuntu or Debian**, with root access, and 15 GB+ of disk space. See [How much server you need](#how-much-server-you-need).
- A way to upload a file (for example WinSCP) and a terminal (for example PuTTY).
- A **Discord account** and a server you own.
- Optional, for YouTube: a **throwaway Google account**. ⚠️ Expect this account to get banned by Google or YouTube at some point, maybe years later. **Never use your main Google account.**

---

## How much server you need

| Server | Installer mode / planning guidance |
|---|---|
| **1 GB RAM, 1 core** | Lean mode + swap; limited headroom, check actual memory use |
| **2 GB RAM, 1–2 cores** | Lean mode; starting recommendation |
| **4 GB RAM, 2+ cores** | Standard mode; more headroom |

The installer checks how much RAM the server has and picks the mode itself: **3 GB or less = lean mode** (smaller music server, smaller caches, and swap on servers under 2 GB), more = standard mode. It checks again on every run, so upgrading your VPS switches modes by itself. To force a mode: `LEAN=yes bash install.sh` or `LEAN=no bash install.sh`. Every feature, Spotify included, works in both modes.

Use `/diagnostics` to check the actual resources visible to the bot. Its short samples can miss intermittent CPU/network problems; it cannot measure what listeners hear.

---

## Install

Use the installer attached to a **published release**. Downloading repository files alone does not update a running container. The following terminal instructions assume root access and the standard `/root/server-bot` installation directory.

1. Download **`install.sh`** from this repo's **Releases** (right-hand side of the repo page → latest release).
2. Upload it to `/root` on the VPS (for example with WinSCP) and run:

```bash
cd /root && bash install.sh
```

The installer:

1. **Checks the VPS** (OS, CPU, RAM, disk) before changing anything.
2. **Tells you what to do in Discord:** make an application at <https://discord.com/developers/applications>, copy the bot token, turn on **Server Members Intent** and **Message Content Intent**, and turn on Developer Mode in Discord.
3. **Asks for:**
   - the bot token, which it checks with Discord
   - your server ID; if the bot isn't in the server yet, it prints the invite link and waits
   - the owner's user ID (prefilled from Discord and checked against the actual server owner)
   - your admin user ID(s)
   - whether to set up YouTube. If yes, it shows a code to enter at google.com/device with the throwaway account.

   It picks lean or standard mode by itself from the server's RAM.
4. **Installs Docker** from Docker's official repository and **downloads the ready-made bot** (built by this repo's GitHub Actions, pinned to an exact version) plus the other parts (checksums verified, versions pinned). If a ready-made part can't be downloaded, it builds that part on the VPS instead. That's slower but still works.
5. **Waits** until the bot is online and music is connected, then tells you what to do next.

**Automatic updates are still off after installation.** To enable them, follow [Enable automatic updates once](#enable-automatic-updates-once). For later manual updates, use the fresh-download instructions below; an old `/root/install.sh` contains an old release.

---

## Publishing (for whoever owns this repo)

Every push to `main` makes GitHub Actions (`.github/workflows/release.yml`):

1. run the regression tests, then build the bot's image for normal (amd64) and ARM (arm64) servers and publish it to this repo's **Packages** (`ghcr.io/<owner>/<repo>`)
2. build `install.sh` pinned to that exact image (`scripts/build-installer.sh`)
3. publish a new **Release** with `install.sh` and the digest-pinned `update.json` manifest attached

An open PR or an edit on a feature branch is not a release. Wait for **Build and release** to finish successfully. VPS automatic updates follow published releases, not every repository edit.

One-time setup after the first successful run: go to your profile → **Packages** → this package → **Package settings** → **Change visibility** → **Public**. VPSes download the image without logging in, so it has to be public. (If the workflow can't create the release, set **Settings → Actions → General → Workflow permissions** to *Read and write*.)

To build an installer by hand without GitHub: `bash scripts/build-installer.sh`. That installer builds the bot on the VPS.

Repo-only files (not copied to the VPS): `installer/install-head.sh` (the installer itself), `scripts/build-installer.sh` (packs the repo into `install.sh`), `.github/workflows/release.yml` (the automatic build).

---

## First time in Discord

1. **Server Settings → Roles:** drag the bot's role to the **top**.
2. Run **`/setup rebuild`**. It shows everything it will delete and create, backs up every channel and DMs you the backup, asks you to type the server name to confirm, then builds the layout below, including roles, permissions and every feature.
   *Already have the layout from an older version? Run `/setup restyle` instead. It only renames channels, and every message is kept.*
3. Write your rules in 📜・rules.
4. Run **`/diagnostics`**. Read failures, warnings and unavailable readings first; optional features being off is not necessarily a fault.
5. If wanted, enable automatic updates on the VPS using the separate instructions below. Do not run `/setup rebuild` to update the bot.

---

## Server layout

```
📌 INFO      📜・rules  📢・announcements  ✅・verify  🤝・partnerships  🎫・support
💬 CHAT      💬・general  👋・introductions  💭・off-topic  🚿・shower-thoughts  😂・memes
             🎬・clips-and-media  🖥️・setups  🗳️・politics  💡・suggestions  📣・self-promo
             🎁・giveaways  🎂・birthdays
🎮 VOICE     🎮・lfg  🤖・bot-commands  🔊・General  ➕・Join to Create  🎵・Music
             🔴・Live Streaming  💤・AFK (idle 15 min, can't talk)
🎫 TICKETS   staff only (ticket channels appear here)
🔒 STAFF     🛡️・staff-chat  📋・mod-logs

Roles        Admin · Staff · Member
```

- People who haven't verified only see ✅・verify.
- Members see everything except the Tickets and Staff categories.
- Everyone gets **Member** during the rebuild, so existing members don't have to verify.

---

## Commands

`/help` in Discord only shows the commands the person asking can use.

### Everyone
| Command | What it does |
|---|---|
| `/play <song or link>` | Play or queue a song name, YouTube link or Spotify link |
| `/skip` · `/stop` | Vote to skip the song or stop the music |
| `/pause` · `/resume` · `/queue` | |
| `/nowplaying` | Bring the music panel back to the bottom |
| `/birthday set month:September day:15 year:1966` | Save your own birthday; private reply |
| `/birthday show` | Show only your saved birthday; private reply |
| `/vc lock` · `unlock` · `limit` · `rename` · `kick` · `transfer` | Control your own join-to-create channel |
| `/help` | What you can use |

### Staff
`/warn` · `/warnings` · `/delwarn` · `/timeout` · `/untimeout` · `/kick` · `/ban` · `/unban` · `/purge` · `/slowmode`. Staff can also skip or stop music without a vote.

### Admins
| Command | What it does |
|---|---|
| `/diagnostics` or `/diagnosis` | Grouped health checks, resource samples, playback warnings and a small internet speed test; once every minute |
| `/setup show` | Current settings |
| `/setup logs · welcome · verify · verify-off · verify-existing · joinvoice · joinvoice-off · tickets · scamfilter` | Set features up one at a time |
| `/buttonroles` | Post self-assign role buttons |
| `/lockdown on · off · status` | Kick anyone new who joins, during a raid |

### Owner and bot admins only
| Command | What it does |
|---|---|
| `/setup restyle` | Add the `emoji・name` style to channel names (renames only) |
| `/setup rebuild` | ⚠️ **Wipes and rebuilds the server.** Locked after its first use. |

---

## Music

### Large playlists and the queue

- **Playback capacity: 2,000 songs per music session**, including the current song. Imports share that capacity; excess entries are reported as omitted.
- **Visible preview: up to 99 upcoming songs**, ten per `/queue page:<number>`. The footer shows the real queued count. Songs beyond the preview remain queued and play normally.
- **First song before the full import:** supported public Spotify and YouTube playlist formats expose one starting song, which plays while the remaining list loads in the background. A watch link with a playlist starts from its selected video. If early discovery cannot read the source format, the compatibility fallback waits for the full source response.
- **Lazy matching:** storing a title in the queue does not mean searching for its audio immediately. Spotify songs are matched to playable YouTube audio as needed, with only two upcoming matches prepared ahead. A 2,000-song queue does not trigger 2,000 playback searches at once. This two-song look-ahead does not limit what the queue can display.
- Source metadata and queue capacity are different: if a provider returns only part of a playlist, the bot cannot infer the missing entries. Raising capacity does not establish source completeness.

The released Lavalink configuration allows twenty YouTube playlist metadata pages. Apply music-server configuration changes through the **manual installer**, because automatic updates replace only the bot image. See [playlist behaviour and limitations](docs/PLAYLIST_STARTUP.md) and [the audit](docs/AUDIT.md).

### Playing and controlling music

- `/play` takes a **song name**, a **YouTube** link or playlist, or a **Spotify** link, playlist or album.
- Each song posts a **panel** in the voice channel's own chat, with a progress bar that updates itself:

| Button | Who can use it |
|---|---|
| ⏸️ Pause / ▶️ Resume · 🔀 Shuffle · 🔉🔊 Volume · 📜 Queue | Anyone in that voice channel |
| ⏭️ Vote skip · ⏹️ Vote stop | Needs **more than half** of the people in the channel. Staff can skip or stop instantly. |

- You must be in the voice channel to control the music. One bot plays in one voice channel at a time.
- The bot leaves after 2 minutes with nothing playing or nobody listening.

**Spotify links:** the bot reads public Spotify embed metadata and finds audio on YouTube Music/YouTube; it does not stream audio from Spotify. No Spotify account is configured. Private/inaccessible lists and changes to public embed formats can stop imports. Public embeds can expose fewer tracks than the original list; there is no promise that every Spotify playlist is imported completely. Matching uses title, artist and duration but can still choose the wrong recording.

**How YouTube works:** the bot uses the throwaway Google account's login, a patched YouTube client and a self-hosted helper (`yt-cipher`) that unlocks the streams.

## Birthdays

In Discord, use:

```text
/birthday set month:September day:15 year:1966
/birthday show
```

- Month accepts `September`, `Sep`, `Sept`, `9` or `09`, ignoring case. Other English month names and three-letter abbreviations also work.
- Day accepts `15` or `15th` (and correct ordinals such as `1st`, `2nd`, `3rd`). Enter a four-digit birth year, 1900 or later. Impossible dates, non-leap February 29 dates and future birth dates are rejected without replacing the saved record.
- **Set and show reply privately** and only access the caller's record. There is no `/birthday remove` command.
- The date and birth year are saved in the database. On the birthday, the public birthday-channel announcement includes the age reached that day, for example: **“Happy birthday, @David! You’re 60 today! Wishing you a wonderful day and a brilliant year ahead.”** Only the birthday member is mentioned.
- The bot creates a zero-permission **👑 Birthday** display role and assigns it for 24 hours. It needs **Manage Roles** and a bot role above the birthday role.
- Birthdays use **UTC**, checked on startup and every minute. February 29 birthdays run on February 29 only. An entirely missed offline birthday is not announced afterwards.
- Role expiry is saved across restarts. If the bot is offline at expiry, it removes the role after restarting; failed removals are retried. Changing the date does not enable repeated announcements in the same year.
- Existing saved dates are preserved. If an old record lacks a year, use `/birthday set` once to add it; the bot omits age until it is supplied.

The bot uses the configured birthday channel or a unique existing `🎂・birthdays` channel. A rebuild saves its new channel ID. See [birthday details](docs/BIRTHDAYS.md) for delivery/restart limitations.

---

## Verification, moderation and protection

- **Captcha:** a 5-character image code, 3 tries per image, 5 minutes per image. There's no text anywhere for a bot to copy.
- **New accounts** (under 3 days old) are flagged in 📋・mod-logs.
- **Scam filter:**
  - A link on **both** scam lists is deleted and the sender gets a 24h timeout, plus a DM saying their account is probably hacked.
  - A link on only **one** list is deleted, but nobody is punished, in case that list is wrong.
  - Big sites (YouTube, Google, Discord, Steam, Twitch, Spotify and so on) can **never** be flagged.
  - It also catches hacked-account spam: `@everyone` or `@here` with a link, or the same message in 3+ channels within 30 seconds.
  - If a site is flagged by mistake, use `/setup scamfilter allow:<domain>`.
- **Button roles** refuse the Member, Staff and any mod or admin role. The bot re-checks on every click.
- **`/lockdown`** stays on through restarts and updates until you turn it off, or until its timer ends.
- **Self-promo:** posts from people who joined less than 7 days ago are removed, and they get a DM saying when they can post.

---

## Who can reset the server

The installer asks for the owner's ID and defaults the bot-admin prompt to that same
ID on a new installation. The bot automatically creates/reuses an **Owner** display
role and assigns it to the actual server owner at startup and after a rebuild.
There is no role command. It adds no permissions and does not transfer ownership;
extra bot admins do not receive it. Older installations without `OWNER_ID` use
Discord's actual owner ID. A configured mismatch is reported instead of assigning
the label to a different account. The bot needs Manage Roles and sufficient role
hierarchy to create/assign the label; move it in Roles to choose its display position.

- **Only the server owner and the IDs in `BOT_ADMIN_IDS`** can run `/setup rebuild` or `/setup restyle`. Having Discord's Administrator permission isn't enough.
- Members and Staff can't see `/setup` at all.
- After it has been used once, `/setup rebuild` is **locked and removed from the command list**. The lock is saved twice, in the database and as a file in `locks/`, so wiping one copy doesn't unlock it.
- The **only** way to unlock it is on the VPS:

```bash
cd /root/server-bot
nano .env               # set ALLOW_REBUILD=yes
docker compose up -d
```

Set it back to `no` afterwards.

---

## Update the bot

### Manual update or configuration changes

Stop music first. In PuTTY/your SSH terminal, download the **latest published installer**, then run it:

```bash
cd /root &&
curl -fL https://github.com/billyke2000s/discord/releases/latest/download/install.sh -o install.sh &&
bash install.sh
```

Choose **Yes** when asked **“Keep your current settings and just update?”** The installer attempts a pre-update backup, keeps saved settings and rebuild locks, installs the release files/configuration, and restarts the containers. Review any backup/startup warnings. No `/setup rebuild` is needed. Music and pending captcha challenges are not preserved through the restart.

Use this route for first installation of the updater, Lavalink/YouTube configuration changes, or an installation built from a local/tag-only image. Re-running an old installer installs its old pinned release, so download it again when updating.

### Enable automatic updates once

**The installer does not prompt for this and does not enable it automatically.** After installing a recent release into `/root/server-bot`, run this separate block as root:

```bash
cd /root/server-bot &&
printf '%s\n' '{"enabled": true}' > auto-update.json &&
chmod 600 auto-update.json &&
cp deployment/server-bot-update.service deployment/server-bot-update.timer /etc/systemd/system/ &&
systemctl daemon-reload &&
systemctl enable --now server-bot-update.timer &&
systemctl list-timers server-bot-update.timer --no-pager
```

A row with a **NEXT** date confirms a scheduled check. It does **not** prove a release has been applied. A blank LAST value before the first run is normal. If you see `(END)` in a terminal viewer, press **Q** to return to the prompt. For a custom installation directory, follow the service-path changes in [the detailed updater guide](docs/AUTO_UPDATES.md) instead of copying these defaults unchanged.

### When automatic updates run

- Checks are scheduled **daily at 04:00 plus up to 30 minutes of random delay, in the VPS’s timezone**. Use `timedatectl` to see that timezone and `systemctl list-timers server-bot-update.timer --no-pager` for the actual next run. If the VPS uses UTC, 04:00–04:30 is 05:00–05:30 UK time during British Summer Time, and 04:00–04:30 in winter.
- It checks the latest **published release manifest** and immutable bot-image digest. It does not follow unmerged PRs or unfinished builds.
- If a **music session** exists, it defers until the next scheduled check. An idle/paused voice session can also block it; use `/stop` to end the session before a manual update check. It does not automatically retry immediately when a song ends.
- A check missed while the VPS was off runs after it returns. Successful updates restart the bot briefly.
- **Only the bot image updates.** The updater does not replace host source files, the updater script/timer, Compose configuration, Lavalink, the YouTube plugin or cipher helper. Run the manual installer for those changes. Host `src/` files may therefore differ from the code inside an automatically updated container.
- Before deployment it checks health/free space, saves settings and an online database backup, then verifies Discord/Lavalink readiness. Startup/health failure triggers an image rollback and records the failed digest. This does not test audible playback or restore database writes; a request arriving during the idle-check race can still be interrupted.

### Check and update now

After enabling updates, stop music with `/stop`, then run:

```bash
systemctl start server-bot-update.service
journalctl -u server-bot-update.service -n 40 --no-pager
```

The first command waits for that check to finish. Read the logs afterwards:

| Log message | Meaning / next step |
|---|---|
| `Deployed and healthy` | The new bot passed startup/readiness checks. Run `/diagnostics` and try the changed feature. |
| `Already on this release` | The running bot image matches the latest release. |
| `Music session active; deferring` | End the music session with `/stop`, then run the service again. |
| `Automatic updates disabled` | Check that `/root/server-bot/auto-update.json` contains `{"enabled": true}`. |
| Current image must be pinned / current bot not healthy | Run the latest manual installer, or investigate the bot logs before retrying. |
| A previously failed image / pending recovery error | Read [recovery instructions](docs/AUTO_UPDATES.md#inspect-disable-recover); do not delete recovery files blindly. |
| `Unit ... not found` / deployment files missing | Install a recent release and complete the one-time enable step. |

For a preview that changes nothing: `cd /root/server-bot && python3 deployment/update.py`.

### Check status or turn automatic updates off

```bash
systemctl is-enabled server-bot-update.timer
systemctl list-timers server-bot-update.timer --no-pager
journalctl -u server-bot-update.service -n 40 --no-pager
```

To stop future scheduled runs and disable applying updates:

```bash
systemctl disable --now server-bot-update.timer
printf '%s\n' '{"enabled": false}' > /root/server-bot/auto-update.json
```

Disabling the timer does not cancel an update that is already running. More details: [automatic updates, backups and recovery](docs/AUTO_UPDATES.md).

## Diagnostics

Use **`/diagnostics`** or **`/diagnosis`** in Discord. Both are admin-only, produce the same private report, and share **one check at a time with a one-minute cooldown**. The report groups server resources, internet, music/voice, permissions, features and storage, with problems and next steps first. A text attachment retains the complete detail.

- CPU busy/disk wait/hypervisor wait, available RAM/swap, bot process/container readings, music heap and disk space are labelled separately. Unavailable values are not passes. The bot cannot read every other container's resource limit.
- Each accepted check includes a bounded HTTPS test: three response-time samples, a 2 MiB download and a 256 KiB generated-data upload. The total deadline is 12 seconds. Results are **sampled Mbps**, not full connection capacity or Discord packet loss.
- Music checks use position progress, update age and available voice/frame readings. They cannot prove that listeners hear smooth audio. If audio cuts out, save the report **during the problem**, before restarting; a later healthy sample can miss it.
- ✅ means that specific check passed; ⚠️ needs review; ❌ failed; ❔ could not be measured; ➖ is off/informational. A disabled optional feature is not necessarily broken.

See [the diagnostic guide](docs/DIAGNOSTICS.md) and [audit findings and remaining limitations](docs/AUDIT.md).

### Everyday VPS commands

```bash
cd /root/server-bot
docker compose ps                             # check all three containers
docker compose logs -f bot                     # watch the bot (Ctrl+C to stop watching)
docker compose logs --tail 80 lavalink         # music log
docker compose restart                         # restart everything
```

- **VPS reboots:** everything starts again by itself, and music reconnects automatically. Anything that was playing stops, so people just `/play` again.
- **Connection/deployment settings and secrets** live in `/root/server-bot/.env`. After editing it by hand, run `docker compose up -d`. Per-server feature settings and birthdays are stored separately in the persistent database.
- **Logs** rotate with the configured Docker limits. Backups and other files still consume disk space; monitor free space.

---

## Backups

- **Scheduled database backups:** saved to `/root/server-bot/backups/`, with the last 7 daily and 4 weekly copies retained. They include stored birthdays, warnings and settings. They are not copies of every Discord channel/message or VPS file.
- **Manual installer:** attempts a database/settings/lock snapshot in `backups/pre-update-<date>/`; the last 5 directories are kept. Read any backup warning before relying on the snapshot. Raw pre-update database copies may include a matching WAL file and need to be restored together.
- **Automatic updater:** makes an online SQLite backup plus a private settings/Compose/lock snapshot before deployment. The last five pre-update online database backups are retained; settings snapshot directories remain until you remove them. Monitor disk use and keep a protected off-VPS copy.
- If the database is ever damaged, the bot **refuses to start** and says so, instead of running on broken data.
- ⚠️ Backups contain your tokens. Never share the `backups` folder.

**Restoring a scheduled/online `.sqlite` backup:** replace `FILE.sqlite` below with the actual backup filename. These commands overwrite the active database. They are not a procedure for restoring a raw installer snapshot with a separate WAL file.

```bash
cd /root/server-bot
docker compose stop bot
docker compose cp backups/FILE.sqlite bot:/app/data/bot.sqlite     # use your file name
docker compose run --rm --no-deps --user root bot sh -c 'rm -f /app/data/bot.sqlite-wal /app/data/bot.sqlite-shm; chown node:node /app/data/bot.sqlite'
docker compose up -d bot
```

---

## Troubleshooting

1. Run **`/diagnostics`** in Discord. Follow the next steps for failures, warnings and unavailable measurements. A clean sample does not rule out an intermittent problem.
2. On the VPS, run `cd /root/server-bot && docker compose ps` and check all 3 say **Up**.
3. Check the log for whatever's broken:

| Problem | Look at |
|---|---|
| Music won't play / "No results found" | `docker compose logs --tail 80 lavalink` |
| Spotify links fail | `/diagnostics` shows whether Spotify's page can be read; `docker compose logs --tail 80 bot` |
| Bot offline or commands missing | `docker compose logs --tail 80 bot`, then press Ctrl+R in Discord |
| `/birthday` still says “no birth year stored” or rejects month names | The running bot/registered commands are old. Update, check bot startup/command-sync logs, then refresh Discord. |
| Birthday role not assigned/removed | Check bot Manage Roles permission, role hierarchy and `[birthday]` errors in the bot log. |
| Updates not happening | Read the timer and service logs in [Check and update now](#check-and-update-now). Enabling a timer alone does not prove an update succeeded. |
| Queue preview stops at 99 | Read the footer's actual queued count. The preview stops at 99; queued songs beyond it still play. Partial source metadata is a separate issue. |

4. Preserve relevant logs before restarting. If you need a reinstall/configuration refresh, download the latest installer using [Manual update](#manual-update-or-configuration-changes). Do not use `/setup rebuild` as a repair/update command.

**YouTube account banned?** Make a new throwaway Google account, delete the value after `YOUTUBE_REFRESH_TOKEN=` in `.env`, and run `bash /root/install.sh`. It shows a new login code.

---

## Limits and known weak spots

- **YouTube and Spotify use unofficial routes.** Streaming YouTube through a bot is against YouTube's terms, which is why a throwaway account is used. Either service can change things and break playback until the tools are updated.
- One bot = music in one voice channel at a time. That's a Discord rule.
- `/vc rename`: Discord allows 2 renames per channel every 10 minutes.
- `/purge` can't delete messages older than 14 days. That's a Discord rule.
- The scam lists are maintained by volunteers, so brand-new scam sites may not be on them yet.
- Someone halfway through the captcha during a restart just clicks **New image**.

---

## Files

```
/root/server-bot/
├─ .env                     your settings and tokens (private, never share)
├─ docker-compose.yml       the 3 containers: bot, lavalink, yt-cipher
├─ src/                     the bot's code
├─ deployment/              updater script and systemd service/timer templates
├─ auto-update.json         automatic-update opt-in (created when enabled)
├─ lavalink/application.yml music server config (secrets come from .env)
├─ lavalink/plugins/        YouTube plugin (downloaded and checked by install.sh)
├─ yt-cipher/               YouTube helper (pinned version)
├─ tools/                   our change to the YouTube client
├─ backups/                 automatic backups (private)
└─ locks/                   the server-rebuild lock (don't delete)
```

---

## Credits

Built on [discord.js](https://discord.js.org), [Lavalink](https://github.com/lavalink-devs/Lavalink), [Shoukaku](https://github.com/shipgirlproject/Shoukaku), [youtube-source](https://github.com/lavalink-devs/youtube-source) (MIT, see `tools/README.md`), [spotify-url-info](https://github.com/microlinkhq/spotify-url-info) (MIT) and [yt-cipher](https://github.com/kikkia/yt-cipher). Scam lists: [nikolaischunk/discord-phishing-links](https://github.com/nikolaischunk/discord-phishing-links) and [Discord-AntiScam/scam-links](https://github.com/Discord-AntiScam/scam-links).

