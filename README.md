# Server Bot

An all-in-one Discord bot for a gaming server that you host yourself on a VPS. It covers music (YouTube and Spotify), join-to-create voice channels, captcha verification, moderation, a scam-link filter, tickets, logs and a one-time server builder.

Everything runs on your own VPS in Docker (3 small containers). No ports are opened to the internet.

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
10. [Looking after it](#looking-after-it)
11. [Backups](#backups)
12. [Troubleshooting](#troubleshooting)
13. [Limits and known weak spots](#limits-and-known-weak-spots)
14. [Files](#files)
15. [Credits](#credits)

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
| 🩺 **Diagnostics** | `/diagnostics` checks every part of the bot and says exactly what's wrong. |
| 💾 **Backups** | Daily database backups, plus a full backup before every update. |

---

## What you need

- A VPS running **Ubuntu or Debian**, with root access, and 15 GB+ of disk space. See [How much server you need](#how-much-server-you-need).
- A way to upload a file (for example WinSCP) and a terminal (for example PuTTY).
- A **Discord account** and a server you own.
- Optional, for YouTube: a **throwaway Google account**. ⚠️ Expect this account to get banned by Google or YouTube at some point, maybe years later. **Never use your main Google account.**

---

## How much server you need

| Server | Works? |
|---|---|
| **1 GB RAM, 1 core** | ✅ with lean mode + swap (added automatically) |
| **2 GB RAM, 1–2 cores** | ✅ lean mode, everything on |
| **4 GB RAM, 2+ cores** | ✅ comfortable |

The installer asks **"Does this server have 3 GB of RAM or less?"**. Answer yes and it uses the leanest settings: smaller music server, smaller caches, and swap on servers under 2 GB. Every feature, Spotify included, works in both modes.

Measured memory use (on a test machine, before any audio plays):

| Part | Uses |
|---|---|
| Lavalink (music server) | ~217 MB lean / ~230 MB standard, idle; more while playing |
| Bot | ~95 MB at start, ~145 MB once the first captcha has been drawn (measured without a Discord connection) |
| Spotify links | nothing extra: the bot reads Spotify's public embed page itself |
| YouTube cipher helper | not measured yet (1 worker, small cache) |

More cores mostly make installs/updates faster and keep music smooth when other things run at the same time. `/diagnostics` shows the music server's CPU use and how smooth the audio was over the last minute.

---

## Install

It's one command, and it asks you for everything as it goes.

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
   - your admin user ID(s)
   - whether to set up YouTube. If yes, it shows a code to enter at google.com/device with the throwaway account.
   - whether the server has 3 GB of RAM or less (lean mode).
4. **Installs Docker** from Docker's official repository and **downloads the ready-made bot** (built by this repo's GitHub Actions, pinned to an exact version) plus the other parts (checksums verified, versions pinned). If a ready-made part can't be downloaded, it builds that part on the VPS instead. That's slower but still works.
5. **Waits** until the bot is online and music is connected, then tells you what to do next.

**Updating later:** download the newest `install.sh` from Releases and run it again. It backs everything up first, keeps all your settings, and you just press Enter at each question.

---

## Publishing and that 

Every push to `main` makes GitHub Actions (`.github/workflows/release.yml`):

1. build the bot's image for normal (amd64) and ARM (arm64) servers and publish it to this repo's **Packages** (`ghcr.io/<owner>/<repo>`)
2. build `install.sh` pinned to that exact image (`scripts/build-installer.sh`)
3. publish a new **Release** with `install.sh` attached

One-time setup after the first successful run: go to your profile → **Packages** → this package → **Package settings** → **Change visibility** → **Public**. VPSes download the image without logging in, so it has to be public. (If the workflow can't create the release, set **Settings → Actions → General → Workflow permissions** to *Read and write*.)

To build an installer by hand without GitHub: `bash scripts/build-installer.sh`. That installer builds the bot on the VPS.

Repo-only files (not copied to the VPS): `installer/install-head.sh` (the installer itself), `scripts/build-installer.sh` (packs the repo into `install.sh`), `.github/workflows/release.yml` (the automatic build).

---

## First time in Discord

1. **Server Settings → Roles:** drag the bot's role to the **top**.
2. Run **`/setup rebuild`**. It shows everything it will delete and create, backs up every channel and DMs you the backup, asks you to type the server name to confirm, then builds the layout below, including roles, permissions and every feature.
   *Already have the layout from an older version? Run `/setup restyle` instead. It only renames channels, and every message is kept.*
3. Write your rules in 📜・rules.
4. Run **`/diagnostics`** and check everything is ✅.

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
| `/vc lock` · `unlock` · `limit` · `rename` · `kick` · `transfer` | Control your own join-to-create channel |
| `/help` | What you can use |

### Staff
`/warn` · `/warnings` · `/delwarn` · `/timeout` · `/untimeout` · `/kick` · `/ban` · `/unban` · `/purge` · `/slowmode`. Staff can also skip or stop music without a vote.

### Admins
| Command | What it does |
|---|---|
| `/diagnostics` | Checks everything is working |
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

- `/play` takes a **song name**, a **YouTube** link or playlist, or a **Spotify** link, playlist or album.
- Each song posts a **panel** in the voice channel's own chat, with a progress bar that updates itself:

| Button | Who can use it |
|---|---|
| ⏸️ Pause / ▶️ Resume · 🔀 Shuffle · 🔉🔊 Volume · 📜 Queue | Anyone in that voice channel |
| ⏭️ Vote skip · ⏹️ Vote stop | Needs **more than half** of the people in the channel. Staff can skip or stop instantly. |

- You must be in the voice channel to control the music. One bot plays in one voice channel at a time.
- The bot leaves after 2 minutes with nothing playing or nobody listening.

**How Spotify works:** Spotify never plays any audio itself, and no Spotify account is needed. The bot reads the song list from Spotify's public embed page (the player websites show), then when each song's turn comes it searches YouTube Music (then YouTube) for "title artist", preferring a result whose length matches the Spotify song, so live versions and covers lose. Private playlists won't load, and [Unverified] very long playlists may only give their first 100 songs.

**How YouTube works:** the bot uses the throwaway Google account's login, a patched YouTube client and a self-hosted helper (`yt-cipher`) that unlocks the streams.

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

## Looking after it

```bash
cd /root/server-bot
docker compose ps                              # all 3 should say "Up"
docker compose logs -f bot                     # watch the bot (Ctrl+C to stop watching)
docker compose logs --tail 80 lavalink         # music log
docker compose restart                         # restart everything
bash /root/install.sh                          # update / repair / change settings
```

- **VPS reboots:** everything starts again by itself, and music reconnects automatically. Anything that was playing stops, so people just `/play` again.
- **Settings** live in `/root/server-bot/.env`. After editing it by hand, run `docker compose up -d`.
- **Logs** are capped at 30 MB per container, so they can't fill the disk.

---

## Backups

- **Daily:** the database (warnings, settings, tickets, lockdown, locks) is saved to `/root/server-bot/backups/`. The last 7 daily and 4 weekly copies are kept.
- **Before every update:** `install.sh` saves the database, `.env` and the lock files into `backups/pre-update-<date>/`. The last 5 are kept.
- If the database is ever damaged, the bot **refuses to start** and says so, instead of running on broken data.
- ⚠️ Backups contain your tokens. Never share the `backups` folder.

**Restoring a backup:**

```bash
cd /root/server-bot
docker compose stop bot
docker compose cp backups/FILE.sqlite bot:/app/data/bot.sqlite     # use your file name
docker compose run --rm --no-deps --user root bot sh -c 'rm -f /app/data/bot.sqlite-wal /app/data/bot.sqlite-shm; chown node:node /app/data/bot.sqlite'
docker compose up -d bot
```

---

## Troubleshooting

1. Run **`/diagnostics`** in Discord. Anything marked ❌ is the problem.
2. On the VPS, run `cd /root/server-bot && docker compose ps` and check all 3 say **Up**.
3. Check the log for whatever's broken:

| Problem | Look at |
|---|---|
| Music won't play / "No results found" | `docker compose logs --tail 80 lavalink` |
| Spotify links fail | `/diagnostics` shows whether Spotify's page can be read; `docker compose logs --tail 80 bot` |
| Bot offline or commands missing | `docker compose logs --tail 80 bot`, then press Ctrl+R in Discord |

4. Most problems are fixed by `docker compose restart` or by running `bash /root/install.sh` again. Re-running the installer is always safe.

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
