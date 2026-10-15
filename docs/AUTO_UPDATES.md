# Opt-in automatic bot updates on the Docker VPS

This is designed for the repository's Ubuntu/Debian Docker Compose installation.
It updates **only the bot image**, to the immutable digest in a tested release's
`update.json`. Lavalink, the patched plugin, cipher helper, Compose config, secrets,
locks and database schemas stay under manual installer control. A full installer
run is required once to obtain these new files/configuration and a health-aware image.

Automatic updates are disabled until you install/enable the timer and explicitly set
`enabled` to true. No remote installer code is downloaded/executed by the updater,
and the bot gets no Docker socket. Host root/systemd owns deployment.

## Enable after reviewing and installing this release

For the standard `/root/server-bot` directory:

```bash
cd /root/server-bot
apt-get install -y python3
cp deployment/auto-update.example.json auto-update.json
chmod 600 auto-update.json
# Preview the available digest without changing the running bot:
python3 deployment/update.py
# Explicitly opt in:
printf '%s\n' '{"enabled": true}' > auto-update.json
cp deployment/server-bot-update.service deployment/server-bot-update.timer /etc/systemd/system/
cp deployment/server-bot-discord-update.service deployment/server-bot-discord-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now server-bot-update.timer
systemctl enable --now server-bot-discord-update.timer
systemctl list-timers server-bot-update.timer
```

For a custom directory, change **both** paths in the service and add
`--directory /your/path` to ExecStart. Use a root-owned installation directory/config.
The timer checks daily at 04:00 in the **VPS's timezone**, plus up to 30 minutes of
jitter. Missed checks run after reboot. It does not follow the user's desktop timezone.

## Deployment behaviour

The updater locks against another updater/manual installer, validates the repository,
release tag, commit and image digest, and requires a currently healthy digest-pinned
bot. Local/tag-only images are refused. It defers while a music queue exists, pulls
before changing `.env`, checks idle again, requires 2 GiB free disk, saves settings,
Compose and lock files, and makes an online SQLite backup. Backup failure aborts.
Only the `BOT_IMAGE=` line changes. Duplicate/missing lines or disagreement between
the running image and `.env` abort rather than guessing.

The bot health check requires a fresh heartbeat with Discord and Lavalink ready.
If the new bot fails health/start checks, deployment restores the previous `.env` and
recreates the old image. A failed digest is quarantined in `.failed-update`; the next
timer does not repeatedly deploy it. An interrupted deployment leaves a private journal;
the next enabled updater run restores the saved settings/image before checking releases.
If recovery itself fails, the journal remains and manual intervention is required.

This causes a short bot restart. An incoming request racing the idle check may still
be interrupted. Existing tickets, moderation, verification settings and rebuild locks
are persisted, but pending captcha challenges and music state are memory-only.
Readiness checks do not test audible playback or every moderation feature.

Image rollback does **not** roll back database writes. Release maintainers must keep
`deployment: 1` only for bot releases compatible with this deployment and the prior
database schema. Increment it for destructive schema/deployment changes, making old
updaters refuse those releases and require the manual installer. Future configuration
changes also require a manual installer even when a bot-only release is compatible.

## Inspect, disable, recover

```bash
journalctl -u server-bot-update.service --since yesterday
systemctl start server-bot-update.service  # one opted-in check now
systemctl disable --now server-bot-update.timer
systemctl disable --now server-bot-discord-update.timer
printf '%s\n' '{"enabled": false}' > /root/server-bot/auto-update.json
```

Failed updates exit nonzero and appear in systemd logs; no external notification
service is configured. Diagnose the failed image before removing `.failed-update`.
If an interrupted-update journal exists, temporarily enable the local opt-in and run
`python3 deployment/update.py --apply` to recover; the manual installer refuses to
overwrite a pending recovery. Do not run the installer/update tools concurrently.

Settings snapshots live in `backups/auto-update-<UTC timestamp>/`; online database
snapshots are `backups/bot-<date>-<time>-pre-update.sqlite` (last five retained).
Settings snapshots are retained until you remove them; monitor disk use. Backups
contain secrets, must remain private, and should also be copied to protected off-host
storage. The updater neither deletes volumes nor restores a database automatically.

## Trust boundary

The manifest comes from `billyke2000s/discord` via GitHub HTTPS and selects only that
repository's GHCR image by digest. Someone controlling its release publishing can
publish code the updater installs. Enable this only if you trust that publishing path.
The repository's existing `main` release policy remains: pushes publish releases,
with regression tests now required by the release job before building/publishing.

## Owner Discord command

`/update` checks the running image's build version/commit against the latest stable
release manifest and queues an update when different. `/update check-only:true`
does not deploy. Only the actual Discord guild owner can use either command;
Administrator and BOT_ADMIN_IDS are insufficient. Both replies are private.

Install the current release **with the manual installer once** for the host worker,
Compose mounts and build metadata. The installer enables the bridge timer if the
existing local auto-update config explicitly opts in. New installations need the
separate enable step above. For custom paths, edit both services' WorkingDirectory
and ExecStart; timer files have no installation paths.

The bot can write `updates/requests/`, but `updates/status/` is read-only in its
container. A root systemd oneshot checks every 15 seconds and accepts only request
ID, guild ID, owner ID and timestamp. No command, image, URL or path is accepted.
The host verifies ownership using Discord's API with the existing bot token, then
fetches/validates the release independently and calls the same deployment code.
It uses a separate worker lock plus the shared deployment lock; invalid/expired
requests and already processed IDs are ignored. It never follows request symlinks.

Version metadata is embedded at image build time. Updates still affect only the
bot image; the command cannot update the host worker, timer, Compose or Lavalink.
The command is not a bypass for disabled opt-in, active music, unhealthy current
state, failed-image quarantine, incompatible manifests or unavailable disk space.

Results persist through bot restarts. Owner DMs are best effort and attempted once;
the command can display the persisted result if DMs fail. Request/result records
contain Discord IDs and versions, not interaction tokens or the bot token. The bot
process cannot author a host result through the read-only mount. The host worker
reconciles a previously updating result on its next run, including calling the
existing updater recovery path. Failures require inspection of:

```bash
journalctl -u server-bot-discord-update.service -n 50 --no-pager
systemctl list-timers server-bot-discord-update.timer --no-pager
```

Disabling `auto-update.json` blocks both daily and Discord-triggered deployments.
Disabling just the daily timer leaves an enabled Discord bridge available.

