# Server Bot

An all-in-one Discord bot that you host yourself: music (YouTube and Spotify), join-to-create voice channels, captcha verification, moderation, a scam-link filter, tickets, logs, birthdays and a one-time server builder.

It runs on your VPS in three Docker containers: the bot, Lavalink (music) and a YouTube helper. None of them is reachable from the internet.

**Already installed?** Go to [Update the bot](#update-the-bot).

## Contents

[Features](#features) · [What you need](#what-you-need) · [Install](#install) · [First time in Discord](#first-time-in-discord) · [Commands](#commands) · [Music](#music) · [Protection](#verification-moderation-and-protection) · [Server reset](#who-can-reset-the-server) · [Birthdays](#birthdays) · [Update the bot](#update-the-bot) · [Diagnostics](#diagnostics) · [Backups](#backups) · [Troubleshooting](#troubleshooting) · [Limits](#limits) · [Files](#files)

---

## Features

| | |
|---|---|
| 🎵 **Music** | Song names, YouTube links/playlists and Spotify links/playlists/albums. A live panel with vote back, skip, stop and shuffle, and a paged queue. |
| 🔊 **Join-to-create voice** | Join the lobby to get your own voice channel, controlled with `/vc`. It's deleted when it empties. |
| ✅ **Captcha verification** | New people type a code from an image before they see the server. Anyone who doesn't verify in 15 minutes is kicked. |
| 🛡️ **Moderation** | warn, timeout, kick, ban, purge, slowmode and more, all logged. `/lockdown` for raids. |
| 🚫 **Scam filter** | Deletes known Discord and Steam scam links and catches hacked-account spam. |
| 🎫 **Tickets** | A private channel with staff at the click of a button. A transcript goes to the log when it closes. |
| 🏷️ **Button roles** | Members pick their own roles. |
| 📋 **Logs** | Joins, leaves, deleted and edited messages, and every mod action. |
| 👋 **Welcome, suggestions, self-promo** | Welcome message, 👍/👎 plus a discussion thread on suggestions, and a 7-day wait before self-promo. |
| 🏗️ **Server builder** | `/setup rebuild` builds the whole server layout in one go. It works once, then locks. |
| 🎂 **Birthdays** | Private set/show commands, an announcement with age, and a 👑 Birthday role for 24 hours. |
| 🩺 **Status checks** | `/status` lets anyone see if music is down or it's just them. `/diagnostics` gives admins the full picture and what to fix. |
| 🔄 **Updates** | Optional daily automatic updates with backups and automatic rollback, or `/update` from Discord. |
| 💾 **Backups** | Daily and weekly database backups. |

---

## What you need

- A VPS running **Ubuntu or Debian** with root access and 15 GB+ of free disk.
- A way to upload a file (for example WinSCP) and a terminal (for example PuTTY).
- A **Discord account** and a server you own.
- Optional, for YouTube: a **throwaway Google account**. ⚠️ Expect Google to ban it eventually. **Never use your main account.**

| VPS | What to expect |
|---|---|
| 1 GB RAM, 1 core | Works, with swap. Fine for one server's music |
| 2 GB RAM, 1–2 cores | Comfortable, room for other things on the VPS |
| 4 GB RAM, 2+ cores | Plenty; more than the bot needs |

Measured on a 3-core, 4 GB VPS while playing music (standard mode): the three containers used about **370 MB** together (bot 60 MB, music server 224 MB, YouTube helper 82 MB) and under 5% CPU. Their memory limits add up to about 1.5 GB in standard mode and 1.3 GB in lean mode, so they have room to grow during busy moments such as loading a big playlist.

The installer picks lean mode (3 GB RAM or less) or standard mode by itself, and checks again on every run. To force it: `LEAN=yes bash install.sh` or `LEAN=no bash install.sh`.

---

## Install

1. Download **`install.sh`** from this repo's **Releases** (right-hand side of the repo page → latest release).
2. Upload it to `/root` on the VPS and run:

```bash
cd /root && bash install.sh
```

The installer checks the VPS, tells you how to create the bot in the [Discord developer portal](https://discord.com/developers/applications) (turn on **Server Members Intent** and **Message Content Intent**), then asks for:

- the bot token (it checks it with Discord)
- your server ID (it prints an invite link if the bot isn't in the server yet)
- the owner's user ID and any extra admin user IDs
- whether to set up YouTube (you enter a code at google.com/device with the throwaway account)

It installs Docker, downloads the pinned bot and music server, and waits until everything is online. Automatic updates stay **off** until you [turn them on](#automatic-updates).

---

## First time in Discord

1. **Server Settings → Roles:** drag the bot's role to the **top**.
2. Run **`/setup rebuild`**. It lists everything it will delete and create, backs up every channel and DMs you the backup, and asks you to type the server name. Then it builds the layout below with roles, permissions and every feature set up.
   *Already have the layout from an older version? Run `/setup restyle` instead. It only renames channels.*
3. Write your rules in 📜・rules.
4. Run **`/diagnostics`** and fix anything it flags.
5. Once setup is done, replace the bot's Administrator permission with the specific list `/diagnostics` gives you.

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

People who haven't verified only see ✅・verify. Members see everything except Tickets and Staff. Everyone already in the server gets **Member** during the rebuild, so they don't have to verify.

---

## Commands

`/help` in Discord shows only the commands the person asking can use.

### Everyone
| Command | What it does |
|---|---|
| `/play <song or link>` | Play or queue a song name, or a YouTube, Spotify, SoundCloud, Twitch, Vimeo or Bandcamp link |
| `/skip` · `/stop` | Vote to skip the song or stop the music |
| `/queue` | View the queue, ten songs per page |
| `/nowplaying` | Bring the music panel back to the bottom |
| `/status` | Is the music working, or is it just me? A quick private check |
| `/birthday set` · `/birthday show` | Save or see your own birthday (private reply) |
| `/vc lock` · `unlock` · `limit` · `rename` · `kick` · `transfer` | Control your own join-to-create channel |
| `/help` | What you can use |

### Staff
`/warn` · `/warnings` · `/delwarn` · `/timeout` · `/untimeout` · `/kick` · `/ban` · `/unban` · `/purge` · `/slowmode`. Staff can also skip, stop, go back or shuffle music without a vote.

### Admins (Manage Server)
| Command | What it does |
|---|---|
| `/diagnostics` | Full check of the bot and VPS: a plain summary plus a detailed file |
| `/setup show` | Current settings |
| `/setup logs · welcome · verify · verify-off · verify-existing · joinvoice · joinvoice-off · tickets · scamfilter` | Set features up one at a time |
| `/buttonroles` | Post self-assign role buttons |
| `/lockdown on · off · status` | Kick anyone new who joins, during a raid |

### Owner only
| Command | Who |
|---|---|
| `/setup restyle` | Server owner and `BOT_ADMIN_IDS`. Renames channels to the `emoji・name` style |
| `/setup rebuild` | Server owner and `BOT_ADMIN_IDS`. ⚠️ **Wipes and rebuilds the server.** Locked after its first use |
| `/update` | The actual server owner only. Checks for and installs a new bot release ([details](#update-from-discord)) |

---

## Music

- `/play` takes a **song name** or a **YouTube**, **Spotify**, SoundCloud, Twitch, Vimeo or Bandcamp link. Other links are refused, so nobody can make your VPS fetch arbitrary web addresses.
- Each song posts a **panel** in the voice channel's own chat with a live progress bar.
- **⏮️ Back, ⏭️ Skip, ⏹️ Stop and 🔀 Shuffle** need votes from **more than half** of the people in the channel. Staff act instantly. 📜 Queue opens a private queue view.
- You must be in the bot's voice channel to control it. One bot plays in one channel at a time.
- The bot leaves after 2 minutes with nothing playing or nobody listening.
- **Big playlists:** up to 2,000 songs per session. The first song starts while the rest load. The queue view shows the next 99; the rest still play.
- **Spotify:** the bot reads the public Spotify page and plays each song from YouTube. Private playlists don't work, very long public playlists may be cut short by Spotify, and now and then a different recording is picked. The panel shows which YouTube video is playing so you can spot it.
- **YouTube:** uses the throwaway account's login, a patched YouTube client and the `yt-cipher` helper.
- Volume is set by `DEFAULT_VOLUME` in `.env`.

More detail: [playlist behaviour](docs/PLAYLIST_STARTUP.md).

---

## Verification, moderation and protection

- **Captcha:** a 5-character image code, 3 tries per image, 5 minutes per image.
- **New accounts** (under 3 days old) are flagged in 📋・mod-logs.
- **Scam filter:**
  - A link on **both** scam lists is deleted, the sender gets a 24 h timeout and a DM saying their account is probably hacked.
  - A link on only **one** list is deleted, but nobody is punished.
  - Big sites (YouTube, Google, Discord, Steam, Twitch, Spotify and so on) are never flagged.
  - It also catches `@everyone`/`@here` with a link, and the same message in 3+ channels within 30 seconds.
  - Wrongly flagged site? `/setup scamfilter allow:<domain>`.
- **Button roles** refuse the Member, Staff and any role with mod or admin powers, checked again on every click.
- **`/lockdown`** stays on through restarts until you turn it off or its timer ends.
- **Self-promo:** posts from people who joined less than 7 days ago are removed and they're told when they can post.
- **Tickets:** closing a ticket posts a text transcript (up to the last 1,000 messages) to 📋・mod-logs before the channel is deleted.

---

## Who can reset the server

- **Only the server owner and the IDs in `BOT_ADMIN_IDS`** can run `/setup rebuild` or `/setup restyle`. Discord's Administrator permission isn't enough.
- After one use, `/setup rebuild` is **locked and hidden**. The lock is saved in the database and as a file in `locks/`, so wiping one doesn't unlock it.
- The bot gives the real server owner an **Owner** display role. It adds no permissions.
- The only way to unlock a rebuild is on the VPS:

```bash
cd /root/server-bot
nano .env               # set ALLOW_REBUILD=yes
docker compose up -d
```

Set it back to `no` afterwards.

---

## Birthdays

```text
/birthday set month:September day:15 year:1966
/birthday show
```

Replies are private. On the day, the bot posts in 🎂・birthdays with the member's new age and gives them a 👑 Birthday role for 24 hours. Dates use UTC. The bot needs Manage Roles and its role above the birthday role. Details: [docs/BIRTHDAYS.md](docs/BIRTHDAYS.md).

---

## Update the bot

### Update from Discord

The **actual server owner** can run `/update` (or `/update check-only:true` to only check). Stop music with `/stop` first. The VPS backs up, installs the new bot, checks it's healthy and rolls back if not. The result arrives by DM.

This needs the host update bridge, which the manual installer sets up and [automatic updates](#automatic-updates) switch on.

### Manual update

Stop music first, then on the VPS:

```bash
cd /root &&
curl -fL https://github.com/billyke2000s/discord/releases/latest/download/install.sh -o install.sh &&
bash install.sh
```

Choose **Yes** for **"Keep your current settings and just update?"** It backs up, keeps your settings and locks, and restarts the containers. Use this route for music server or YouTube changes too: automatic updates only replace the bot itself. An old `install.sh` installs its old version, so always download it fresh.

### Automatic updates

Off until you run this once on the VPS:

```bash
cd /root/server-bot &&
printf '%s\n' '{"enabled": true}' > auto-update.json &&
chmod 600 auto-update.json &&
cp deployment/server-bot-update.service deployment/server-bot-update.timer /etc/systemd/system/ &&
cp deployment/server-bot-discord-update.service deployment/server-bot-discord-update.timer /etc/systemd/system/ &&
systemctl daemon-reload &&
systemctl enable --now server-bot-update.timer server-bot-discord-update.timer &&
systemctl list-timers server-bot-update.timer --no-pager
```

It checks daily at 04:00–04:30 in the VPS's timezone, skips the day if music is playing, backs up first and rolls back if the new bot isn't healthy. Check now or read the result:

```bash
systemctl start server-bot-update.service
journalctl -u server-bot-update.service -n 40 --no-pager
```

| Log says | Meaning |
|---|---|
| `Deployed and healthy` | Updated. Run `/diagnostics`. |
| `Already on this release` | Nothing to do. |
| `Music session active; deferring` | `/stop` the music and run it again. |
| `Automatic updates disabled` | `auto-update.json` doesn't say `{"enabled": true}`. |
| Anything about a failed image or recovery | Read [recovery](docs/AUTO_UPDATES.md#inspect-disable-recover) before deleting anything. |

Turn it off:

```bash
systemctl disable --now server-bot-update.timer server-bot-discord-update.timer
printf '%s\n' '{"enabled": false}' > /root/server-bot/auto-update.json
```

Custom install folder, trust model and recovery: [docs/AUTO_UPDATES.md](docs/AUTO_UPDATES.md).

---

## Diagnostics

There are two checks:

- **`/status`** is for everyone. It answers "is the music down, or is it just me?": bot online, music server, finding songs, Spotify links, and what's playing here. It shows nothing about the VPS or other members, tells the person what to try, and posts a note in 📋・mod-logs (at most every 10 minutes) when music is down or stuck. YouTube and Spotify results are shared for 2 minutes, so lots of people checking at once doesn't hit those services.
- **`/diagnostics`** is for admins (Manage Server). It checks everything, including the VPS, once a minute.

The rest of this section is about `/diagnostics`. The reply is private.

You get a short summary: a verdict, one line each for Bot, Music, Internet, Server, Data and Setup, and what to do about anything that needs attention. The attached `bot-diagnostics.txt` has every number for whoever is debugging.

It can't hear the audio. **If music cuts out, run it while it's happening**, before restarting anything, and save the music log:

```bash
docker compose exec -T bot tail -n 80 /app/data/music-health.jsonl
```

How each check works: [docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md).

---

## Backups

- **Daily and weekly** database backups go to `/root/server-bot/backups/` (last 7 daily and 4 weekly kept). They hold settings, warnings and birthdays, not Discord messages.
- **Installer and automatic updates** also make a backup before changing anything.
- If the database is ever damaged, the bot **refuses to start** instead of running on broken data.
- ⚠️ Backups contain your tokens. Never share the `backups` folder. Keep a copy somewhere off the VPS.

**Restore a backup** (replace `FILE.sqlite` with the real name; this overwrites the current database):

```bash
cd /root/server-bot
docker compose stop bot
docker compose cp backups/FILE.sqlite bot:/app/data/bot.sqlite
docker compose run --rm --no-deps --user root bot sh -c 'rm -f /app/data/bot.sqlite-wal /app/data/bot.sqlite-shm; chown node:node /app/data/bot.sqlite'
docker compose up -d bot
```

---

## Troubleshooting

1. Run **`/diagnostics`** and follow what it says.
2. On the VPS: `cd /root/server-bot && docker compose ps`. All three should say **Up**.
3. Check the log for whatever's broken (save it before restarting):

| Problem | Look at |
|---|---|
| Music won't play / "No results found" | `docker compose logs --tail 80 lavalink` |
| Spotify links fail | `docker compose logs --tail 80 bot` |
| Bot offline or commands missing | `docker compose logs --tail 80 bot`, then press Ctrl+R in Discord |
| Birthday role not given or removed | The bot's Manage Roles permission and role order |
| Updates not happening | [Automatic updates](#automatic-updates) |

Restart everything with `docker compose restart`. After editing `.env`, run `docker compose up -d`. Don't use `/setup rebuild` to fix or update anything.

**YouTube account banned?** Make a new throwaway Google account, delete the value after `YOUTUBE_REFRESH_TOKEN=` in `.env`, and run `bash /root/install.sh`. It shows a new login code.

---

## Limits

- **YouTube and Spotify use unofficial routes.** Streaming YouTube through a bot is against YouTube's terms, which is why a throwaway account is used. Either service can change and break playback until the tools are updated.
- Music, votes and pending captchas are kept in memory, so a restart or update ends them.
- One bot plays music in one voice channel at a time (a Discord rule).
- `/vc rename` works twice per channel every 10 minutes, and `/purge` can't delete messages older than 14 days (both Discord rules).
- The scam lists are run by volunteers, so brand-new scam sites may be missing.

---

## Files

```
/root/server-bot/
├─ .env                     your settings and tokens (private, never share)
├─ docker-compose.yml       the 3 containers: bot, lavalink, yt-cipher
├─ src/                     the bot's code
├─ deployment/              updater script and systemd timers
├─ auto-update.json         automatic-update switch (created when you enable it)
├─ updates/                 /update requests and results
├─ lavalink/application.yml music server settings (secrets come from .env)
├─ lavalink/plugins/        YouTube plugin (downloaded and checked by install.sh)
├─ yt-cipher/               YouTube helper (pinned version)
├─ tools/                   our change to the YouTube client
├─ backups/                 automatic backups (private)
└─ locks/                   the server-rebuild lock (don't delete)
```

---

## Credits

Built on [discord.js](https://discord.js.org), [Lavalink](https://github.com/lavalink-devs/Lavalink), [Shoukaku](https://github.com/shipgirlproject/Shoukaku), [youtube-source](https://github.com/lavalink-devs/youtube-source) (MIT, see `tools/README.md`), [spotify-url-info](https://github.com/microlinkhq/spotify-url-info) (MIT) and [yt-cipher](https://github.com/kikkia/yt-cipher). Scam lists: [nikolaischunk/discord-phishing-links](https://github.com/nikolaischunk/discord-phishing-links) and [Discord-AntiScam/scam-links](https://github.com/Discord-AntiScam/scam-links).
