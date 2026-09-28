#!/usr/bin/env bash
# =====================================================================================
#  Server bot installer. One command on a fresh Ubuntu/Debian VPS:
#      bash install.sh
#  It asks for what it needs, installs Docker, sets everything up and starts the bot.
#  Safe to run again later: it keeps your settings and updates the code.
# =====================================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/root/server-bot}"
PLUGIN_VERSION="1.18.2"
PLUGIN_SHA256="dd4b3bce50dbc7582c80776bad47bad87bef1dc683c69d66ab4a084aa3006238"
PLUGIN_URL="https://github.com/lavalink-devs/youtube-source/releases/download/${PLUGIN_VERSION}/youtube-plugin-${PLUGIN_VERSION}.jar"
# Prebuilt boxes (container images). The bot's is built by this repo's GitHub Actions and the release
# script fills in its exact version below; yt-cipher's is the author's own official image. If either can't be
# downloaded, the installer builds it here instead (slower, needs more RAM).
BOT_IMAGE="@@BOT_IMAGE@@"
CIPHER_IMAGE="ghcr.io/kikkia/yt-cipher@sha256:4c5ec381ff57336cfc24822d2b526a5ad7cd0171f61065a1bbc87bb736842449"
CIPHER_REPO="https://github.com/kikkia/yt-cipher.git"
CIPHER_COMMIT="1e1fd8e2f34ca90cf23545be72e46307bd3d3d2a"   # tested version of yt-cipher (pinned)
DENO_IMAGE="denoland/deno:2.9.7"                           # yt-cipher's build image, pinned instead of :latest
# ---------- output helpers ----------
B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
step() { echo; echo "${B}${C}==> $*${N}"; }
ok()   { echo "  ${G}✔${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
die()  { echo; echo "  ${R}✘ $*${N}"; echo; exit 1; }
ask()  { local p="$1" d="${2:-}" v; if [ -n "$d" ]; then read -r -p "  $p [$d]: " v </dev/tty; echo "${v:-$d}"; else read -r -p "  $p: " v </dev/tty; echo "$v"; fi; }
ask_secret() { local v; read -r -s -p "  $1: " v </dev/tty; echo >&2; echo "$v"; }
yesno() { local a; read -r -p "  $1 [${2:-y}/$( [ "${2:-y}" = y ] && echo n || echo y )]: " a </dev/tty; a="${a:-${2:-y}}"; [[ "$a" =~ ^[Yy] ]]; }
pause() { read -r -p "  Press Enter to continue..." _ </dev/tty; }
is_id() { [[ "$1" =~ ^[0-9]{17,20}$ ]]; }
# curl that retries on network hiccups / 429 / 5xx instead of failing or hanging
CURL=(curl --retry 3 --retry-delay 3 --retry-connrefused --connect-timeout 15)
envget() { [ -f "$INSTALL_DIR/.env" ] && grep -E "^$1=" "$INSTALL_DIR/.env" | tail -1 | cut -d= -f2- || true; }

[ "$(id -u)" -eq 0 ] || die "Run this as root (log in as root, or use: sudo bash install.sh)"
command -v apt-get >/dev/null || die "This installer supports Ubuntu/Debian (apt) only."

# ---------- 0. check this VPS can run it, before changing anything ----------
echo
echo "${B}${C}==> Checking this VPS${N}"
# shellcheck disable=SC1091
. /etc/os-release
OS_ID="${ID:-}"; OS_CODENAME="${VERSION_CODENAME:-}"
[ "$OS_ID" = ubuntu ] && OS_CODENAME="${UBUNTU_CODENAME:-$OS_CODENAME}"
case "$OS_ID" in
  ubuntu|debian) echo "  ${G}✔${N} ${PRETTY_NAME}" ;;
  *) if [[ " ${ID_LIKE:-} " == *" ubuntu "* ]]; then OS_ID=ubuntu; OS_CODENAME="${UBUNTU_CODENAME:-$OS_CODENAME}"
     elif [[ " ${ID_LIKE:-} " == *" debian "* ]]; then OS_ID=debian
     else die "Unsupported OS: ${PRETTY_NAME:-unknown}. Use Ubuntu or Debian."; fi
     echo "  ${Y}!${N} ${PRETTY_NAME} isn't Ubuntu/Debian itself; treating it as ${OS_ID}." ;;
esac
[ -n "$OS_CODENAME" ] || die "Couldn't tell which ${OS_ID} version this is (no codename in /etc/os-release)."
case "$(uname -m)" in
  x86_64|aarch64) echo "  ${G}✔${N} CPU: $(uname -m)" ;;
  *) die "CPU type $(uname -m) isn't supported (needs x86_64 or arm64)." ;;
esac
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if (( MEM_MB >= 1800 )); then echo "  ${G}✔${N} RAM: ${MEM_MB} MB"
elif (( MEM_MB >= 900 )); then echo "  ${Y}!${N} RAM: ${MEM_MB} MB. Should work, but 2 GB or more is recommended."
else die "RAM: ${MEM_MB} MB. At least 1 GB is needed (2 GB+ recommended)."; fi
DISK_GB=$(df -Pk / | awk 'NR==2 {print int($4/1048576)}')
(( DISK_GB >= 5 )) || die "Only ${DISK_GB} GB of free disk space. At least 5 GB is needed."
echo "  ${G}✔${N} Free disk: ${DISK_GB} GB"

cat <<'BANNER'

   ╭──────────────────────────────────────────────╮
   │            Discord server bot setup          │
   │  music · voice rooms · verification · mod    │
   ╰──────────────────────────────────────────────╯
BANNER

# ---------- 1. what the user must do in Discord first ----------
step "Before we start (Discord side, 2 minutes)"
cat <<'EOF'
  1. Go to https://discord.com/developers/applications and click New Application.
  2. Open the Bot tab:
       - click Reset Token and copy the token (you'll paste it in a moment)
       - turn ON "Server Members Intent" and "Message Content Intent", then Save
  3. In Discord: Settings -> Advanced -> turn on Developer Mode
     (so you can right-click a server or a person and "Copy ID").
EOF
pause

# ---------- 2. existing install? ----------
UPDATING=false
if [ -f "$INSTALL_DIR/.env" ]; then
  step "Existing install found in $INSTALL_DIR"
  if yesno "Keep your current settings and just update?" y; then UPDATING=true; ok "Keeping settings"; fi
fi

# ---------- 3. questions ----------
step "Base packages"
export DEBIAN_FRONTEND=noninteractive
need=(); for c in curl git python3 openssl; do command -v "$c" >/dev/null || need+=("$c"); done
if [ ${#need[@]} -gt 0 ]; then apt-get update -qq && apt-get install -y -qq "${need[@]}" >/dev/null; fi
ok "curl, git, python3, openssl ready"

discord_get() { "${CURL[@]}" -s --max-time 30 -H "Authorization: Bot $TOKEN" -w $'\n%{http_code}' "$DISCORD_API$1"; }
# json KEY  -> prints that top-level field of the JSON on stdin ("" if missing). No eval.
json() {
  python3 -c 'import sys, json
d = json.load(sys.stdin)
v = d.get(sys.argv[1]) if isinstance(d, dict) else None
print("" if v is None else v)' "$1" 2>/dev/null
}

step "Your bot"
TOKEN="$(envget DISCORD_TOKEN)"
while :; do
  [ -n "$TOKEN" ] || TOKEN="$(ask_secret 'Paste the bot token (hidden as you type)')"
  resp="$(discord_get /users/@me)"; code="${resp##*$'\n'}"; body="${resp%$'\n'*}"
  if [ "$code" = 200 ]; then
    BOT_NAME="$(echo "$body" | json username)"; CLIENT_ID="$(echo "$body" | json id)"
    ok "Token works: logged in as ${B}${BOT_NAME}${N} (ID $CLIENT_ID)"; break
  fi
  warn "Discord rejected that token (HTTP $code). Copy it again from the Bot tab (Reset Token)."; TOKEN=""
done

# Intent check: application flags 1<<14/1<<15 = members, 1<<18/1<<19 = message content
flags="$( (discord_get /applications/@me | head -n1 | json flags) || echo 0)"
flags="${flags:-0}"
if (( (flags & (1<<14 | 1<<15)) == 0 || (flags & (1<<18 | 1<<19)) == 0 )); then
  warn "The Server Members and/or Message Content intents look OFF."
  echo "     Bot tab -> Privileged Gateway Intents -> turn both on -> Save."
  pause
else
  ok "Intents are on"
fi

INVITE="https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&integration_type=0&scope=bot+applications.commands"

step "Your server"
GUILD_ID="$(envget GUILD_ID)"
while :; do
  if ! is_id "${GUILD_ID:-}"; then GUILD_ID="$(ask 'Server ID (right-click the server icon -> Copy Server ID)')"; fi
  is_id "$GUILD_ID" || { warn "That doesn't look like an ID (17-20 digits)."; GUILD_ID=""; continue; }
  resp="$(discord_get "/guilds/$GUILD_ID")"; code="${resp##*$'\n'}"; body="${resp%$'\n'*}"
  if [ "$code" = 200 ]; then ok "Bot is in ${B}$(echo "$body" | json name)${N}"; break; fi
  echo
  echo "  The bot isn't in that server yet. Open this link, pick the server, click Authorise:"
  echo "    ${B}${INVITE}${N}"
  pause
done

step "Bot admins"
ADMINS="$(envget BOT_ADMIN_IDS)"
echo "  Bot admins can run /setup rebuild and moderate anyone below the bot."
echo "  Your ID: right-click your own name -> Copy User ID. Several? separate with commas."
while :; do
  ADMINS="$(ask 'Admin user ID(s)' "$ADMINS")"; ADMINS="${ADMINS// /}"
  okids=1; IFS=',' read -ra arr <<<"$ADMINS"; for i in "${arr[@]}"; do is_id "$i" || okids=0; done
  [ "$okids" = 1 ] && [ -n "$ADMINS" ] && { ok "Admins: $ADMINS"; break; }
  warn "Use user IDs (17-20 digits), comma separated."
done

step "Music"
YT_OAUTH="$(envget YOUTUBE_OAUTH)"; YT_TOKEN="$(envget YOUTUBE_REFRESH_TOKEN)"; SEARCH="$(envget SEARCH_PREFIX)"
# migrate a token that older setups kept inside lavalink/application.yml
if [ -z "$YT_TOKEN" ] && [ -f "$INSTALL_DIR/lavalink/application.yml" ]; then
  YT_TOKEN="$(grep -oE 'refreshToken: *"1//[^"]+"' "$INSTALL_DIR/lavalink/application.yml" | sed -E 's/.*"(1\/\/[^"]+)"/\1/' || true)"
  [ -n "$YT_TOKEN" ] && { YT_OAUTH=true; ok "Found your existing YouTube login, keeping it"; }
fi
if [ -z "$YT_OAUTH" ] || ! $UPDATING; then
  cat <<EOF
  YouTube blocks servers unless they're logged in, so this logs in a Google account.

  ${R}${B}  !!  USE A THROWAWAY GOOGLE ACCOUNT ONLY  !!${N}
  ${Y}Expect this account to get banned by Google/YouTube at some point. It could be
  next week or years from now, but plan on it happening.
  NEVER use your main account, or any account with Gmail, photos, files, purchases
  or a YouTube channel you care about: a ban can take the whole account with it.${N}
  Make a fresh Google account just for this bot.
EOF
  if yesno "I'm using a throwaway account. Set up YouTube now?" y; then YT_OAUTH=true; SEARCH=ytsearch
  else YT_OAUTH=false; YT_TOKEN=""; SEARCH=scsearch; warn "Searches will use SoundCloud."; fi
fi
SEARCH="${SEARCH:-ytsearch}"

step "Server size"
LOW_MEM="$(envget LOW_MEMORY)"
if [ -n "$LOW_MEM" ]; then def=$([ "$LOW_MEM" = yes ] && echo y || echo n); else def=$( (( MEM_MB <= 3200 )) && echo y || echo n); fi
echo "  This VPS has ${B}${MEM_MB} MB${N} of RAM."
if yesno "Does this server have 3 GB of RAM or less? (uses the leanest settings)" "$def"; then LOW_MEM=yes; else LOW_MEM=no; fi
if [ "$LOW_MEM" = yes ]; then
  LL_OPTS="-Xmx256m -XX:+UseSerialGC -Xss512k -XX:ReservedCodeCacheSize=48m -XX:MaxMetaspaceSize=128m"
  LL_LIMIT="512m"; CIPHER_CACHE=25
  # Swap = spare memory on disk. Stops a small server crashing when memory runs short (and during builds).
  if (( MEM_MB < 2048 )) && [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
    SW=$( (( MEM_MB < 1500 )) && echo 2048 || echo 1024 )
    echo "  Adding ${SW} MB of swap (spare memory on disk)..."
    if { fallocate -l "${SW}M" /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count="$SW" status=none; } \
       && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
      grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
      sysctl -qw vm.swappiness=10 2>/dev/null; echo 'vm.swappiness=10' > /etc/sysctl.d/99-server-bot-swap.conf
      ok "Swap added (${SW} MB, kept after reboots)"
    else
      rm -f /swapfile; warn "This VPS doesn't allow swap (some cheap container VPSes don't). Carrying on without it."
    fi
  fi
  ok "Lean mode: small Lavalink, small caches"
else
  LL_OPTS="-Xmx384m -XX:+UseSerialGC -Xss512k"; LL_LIMIT="768m"; CIPHER_CACHE=50
  ok "Standard mode"
fi

# ---------- 4. docker ----------
step "Docker"
if ! command -v docker >/dev/null; then
  # Docker's official apt repository (what Docker recommends for servers), signed with Docker's key.
  echo "  Installing Docker from Docker's official repository..."
  APT=(apt-get -o Acquire::Retries=3 -qq)
  "${APT[@]}" update >/dev/null && "${APT[@]}" install -y ca-certificates curl >/dev/null || die "Couldn't install base packages."
  install -m 0755 -d /etc/apt/keyrings
  "${CURL[@]}" -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" -o /etc/apt/keyrings/docker.asc || die "Couldn't download Docker's signing key."
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/${OS_ID}
Suites: ${OS_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  "${APT[@]}" update >/dev/null || die "Couldn't read Docker's repository (is ${OS_ID} ${OS_CODENAME} supported by Docker?)."
  "${APT[@]}" install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null || die "Docker install failed."
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin missing."
systemctl enable --now docker >/dev/null 2>&1 || true
ok "$(docker --version)"

# ---------- 5. backup before updating ----------
mkdir -p "$INSTALL_DIR/backups" && chown 1000:1000 "$INSTALL_DIR/backups" && chmod 700 "$INSTALL_DIR/backups"
if [ -f "$INSTALL_DIR/docker-compose.yml" ] && [ -n "$(cd "$INSTALL_DIR" && docker compose ps -a -q bot 2>/dev/null)" ]; then
  step "Backing up before updating"
  BK="$INSTALL_DIR/backups/pre-update-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BK" && chmod 700 "$BK"
  ( cd "$INSTALL_DIR" && docker compose stop bot >/dev/null 2>&1 || true )   # stopped = the database copy is consistent
  if ( cd "$INSTALL_DIR" && docker compose cp bot:/app/data/bot.sqlite "$BK/bot.sqlite" >/dev/null 2>&1 ); then
    ( cd "$INSTALL_DIR" && docker compose cp bot:/app/data/bot.sqlite-wal "$BK/bot.sqlite-wal" >/dev/null 2>&1 || true )
    ok "Database backed up"
  else
    warn "No database to back up yet"
  fi
  cp -p "$INSTALL_DIR/.env" "$BK/.env" 2>/dev/null && ok ".env backed up"
  [ -d "$INSTALL_DIR/locks" ] && cp -rp "$INSTALL_DIR/locks" "$BK/locks"
  chmod -R go-rwx "$BK"
  # keep the 5 newest pre-update backups
  find "$INSTALL_DIR/backups" -maxdepth 1 -type d -name 'pre-update-*' | sort | head -n -5 | xargs -r rm -rf
  ok "Saved in ${BK}"
fi

# ---------- 6. files ----------
step "Installing files to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
sed -n '/^__PAYLOAD_BELOW__$/,$p' "$0" | tail -n +2 | tr -d '\r' | base64 -d | tar -xz -C "$TMP"
[ -f "$TMP/server-bot/docker-compose.yml" ] || die "Installer payload is damaged. Re-download install.sh."
[ -f "$INSTALL_DIR/lavalink/application.yml" ] && cp "$INSTALL_DIR/lavalink/application.yml" "$INSTALL_DIR/lavalink/application.yml.old"
cp -a "$TMP/server-bot/." "$INSTALL_DIR/"
rm -f "$INSTALL_DIR/tvfix.sh" "$INSTALL_DIR"/*.bak; rm -rf /root/yts-fix
# second copy of the /setup rebuild lock (the bot runs as uid 1000 inside its container)
mkdir -p "$INSTALL_DIR/locks" && chown 1000:1000 "$INSTALL_DIR/locks" && chmod 700 "$INSTALL_DIR/locks"
ok "Code installed"

LL_PASS="$(envget LAVALINK_PASSWORD)"; [ ${#LL_PASS} -ge 20 ] || LL_PASS="$(openssl rand -hex 24)"
CIPHER="$(envget CIPHER_TOKEN)"; [ ${#CIPHER} -ge 20 ] || CIPHER="$(openssl rand -hex 24)"
ALLOW_RB="$(envget ALLOW_REBUILD)"; ALLOW_RB="${ALLOW_RB:-no}"
BOT_IMAGE_USED="server-bot-local:latest"; CIPHER_IMAGE_USED="server-bot-cipher-local:latest"   # decided in step 9
write_env() {
  umask 077
  cat > "$INSTALL_DIR/.env" <<EOF
# Written by install.sh. Keep this file private: it contains your bot token.
DISCORD_TOKEN=$TOKEN
CLIENT_ID=$CLIENT_ID
GUILD_ID=$GUILD_ID
BOT_ADMIN_IDS=$ADMINS
LAVALINK_PASSWORD=$LL_PASS
CIPHER_TOKEN=$CIPHER
YOUTUBE_OAUTH=$YT_OAUTH
YOUTUBE_REFRESH_TOKEN=$YT_TOKEN
SEARCH_PREFIX=$SEARCH
DEFAULT_VOLUME=60
ALLOW_REBUILD=$ALLOW_RB
# Server size (set by install.sh; run it again to change)
LOW_MEMORY=$LOW_MEM
LAVALINK_JAVA_OPTS="$LL_OPTS"
LAVALINK_MEM_LIMIT=$LL_LIMIT
CIPHER_CACHE_SIZE=$CIPHER_CACHE
# Which ready-made boxes to run (set by install.sh)
BOT_IMAGE=$BOT_IMAGE_USED
CIPHER_IMAGE=$CIPHER_IMAGE_USED
EOF
  chmod 600 "$INSTALL_DIR/.env"
}
write_env
ok "Settings saved to .env (private, chmod 600)"

# ---------- 7. patched YouTube plugin ----------
step "YouTube plugin"
mkdir -p "$INSTALL_DIR/lavalink/plugins"
rm -f "$INSTALL_DIR/lavalink/plugins/"*.jar
"${CURL[@]}" -fsSL --max-time 300 -o "$TMP/plugin.jar" "$PLUGIN_URL" || die "Couldn't download the YouTube plugin from GitHub."
echo "$PLUGIN_SHA256  $TMP/plugin.jar" | sha256sum -c --quiet - || die "YouTube plugin download didn't match the expected checksum. Stopping."
python3 - "$TMP/plugin.jar" "$INSTALL_DIR/tools/Tv-1.18.2-patched.class.b64" "$INSTALL_DIR/lavalink/plugins/youtube-plugin-${PLUGIN_VERSION}-tvfix.jar" <<'PY'
import sys, zipfile, base64
src, cls_b64, dst = sys.argv[1:4]
cls = base64.b64decode(open(cls_b64).read())
target = "dev/lavalink/youtube/clients/Tv.class"
with zipfile.ZipFile(src) as zi, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zo:
    names = zi.namelist()
    assert target in names, "Tv.class not found in plugin"
    for it in zi.infolist():
        zo.writestr(it, cls if it.filename == target else zi.read(it.filename))
PY
chmod 755 "$INSTALL_DIR/lavalink/plugins"; chmod 644 "$INSTALL_DIR/lavalink/plugins/"*.jar
ok "Official plugin ${PLUGIN_VERSION} downloaded, checksum OK, TV client patched"

# ---------- 8. helper for building from source (only used if a ready-made box can't be downloaded) ----------
# fetch_pinned <repo> <commit> <dir>: download exactly that commit (3 tries), refuse anything else
fetch_pinned() {
  local repo="$1" commit="$2" dir="$3" got=false attempt
  if [ ! -d "$dir/.git" ]; then rm -rf "$dir"; git init -q "$dir" && git -C "$dir" remote add origin "$repo"; fi
  for attempt in 1 2 3; do
    if git -C "$dir" fetch -q --depth 1 origin "$commit" 2>/dev/null; then got=true; break; fi
    warn "Download of $(basename "$dir") failed (try $attempt/3), retrying..."; sleep 5
  done
  $got || die "Couldn't download $(basename "$dir") from GitHub."
  git -C "$dir" checkout -q -f FETCH_HEAD
  [ "$(git -C "$dir" rev-parse HEAD)" = "$commit" ] || die "$(basename "$dir") isn't the expected version. Stopping."
}

# ---------- 9. get the boxes + start ----------
step "Getting the bot and helpers ready"
cd "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/yt-cipher"   # build folder (only filled if the ready-made box can't be downloaded)
pull() { local i; for i in 1 2 3; do docker pull -q "$1" >/dev/null 2>&1 && return 0; sleep 3; done; return 1; }
BUILD=()
if [[ "$BOT_IMAGE" != @@* ]] && pull "$BOT_IMAGE"; then
  BOT_IMAGE_USED="$BOT_IMAGE"; ok "Downloaded the ready-made bot"
else
  BOT_IMAGE_USED="server-bot-local:latest"; BUILD+=(bot); warn "No ready-made bot available: building it here (slower)"
fi
if pull "$CIPHER_IMAGE"; then
  CIPHER_IMAGE_USED="$CIPHER_IMAGE"; ok "Downloaded the ready-made YouTube cipher helper"
else
  CIPHER_IMAGE_USED="server-bot-cipher-local:latest"; BUILD+=(yt-cipher)
  warn "Couldn't download the YouTube cipher helper: building it here from the pinned source (slower)"
  fetch_pinned "$CIPHER_REPO" "$CIPHER_COMMIT" "$INSTALL_DIR/yt-cipher"
  sed -i "s#^FROM denoland/deno:latest#FROM ${DENO_IMAGE}#" "$INSTALL_DIR/yt-cipher/Dockerfile"
  grep -q "^FROM ${DENO_IMAGE}" "$INSTALL_DIR/yt-cipher/Dockerfile" || die "Couldn't pin yt-cipher's build image."
fi
write_env   # save which boxes are used
if [ ${#BUILD[@]} -gt 0 ]; then
  echo "  Building: ${BUILD[*]} (can take several minutes on small servers)..."
  docker compose build "${BUILD[@]}" >"$TMP/build.log" 2>&1 || { tail -30 "$TMP/build.log"; die "Build failed (output above)."; }
fi
# --force-recreate: every container restarts, so Lavalink re-reads its (possibly updated) config file
if ! docker compose up -d --no-build --remove-orphans --force-recreate >"$TMP/up.log" 2>&1; then
  tail -30 "$TMP/up.log"; die "Start failed (output above)."
fi
# older versions had a Chrome-based Spotify helper: remove it (Spotify links no longer need it)
docker rm -f spotify-tokener >/dev/null 2>&1 || true
docker image rm server-bot-spotify-tokener >/dev/null 2>&1 || true
rm -rf "$INSTALL_DIR/spotify-tokener"
ok "Containers started"

wait_log() { # service, regex, seconds -> prints first matching line
  local end=$((SECONDS + $3)) line
  while (( SECONDS < end )); do
    line="$(docker compose logs --no-color --since 30m "$1" 2>/dev/null | grep -E "$2" | tail -1 || true)"
    [ -n "$line" ] && { echo "$line"; return 0; }
    sleep 3
  done
  return 1
}

# ---------- 10. YouTube login ----------
if [ "$YT_OAUTH" = true ] && [ -z "$YT_TOKEN" ]; then
  step "YouTube login (throwaway Google account)"
  line="$(wait_log lavalink 'google.com/device and enter code' 120)" || die "Lavalink didn't show a login code. Check: docker compose logs lavalink"
  CODE="$(echo "$line" | grep -oE 'enter code [A-Z0-9-]+' | awk '{print $3}')"
  echo
  echo "  ┌──────────────────────────────────────────────────────┐"
  echo "  │  1. On your PC, open an incognito window:            │"
  echo "  │     ${B}https://www.google.com/device${N}                    │"
  echo "  │  2. Sign in with the ${B}THROWAWAY${N} Google account        │"
  echo "  │     (NOT your main account: expect it to get banned) │"
  printf "  │  3. Enter this code:  ${B}%-31s${N}│\n" "$CODE"
  echo "  │  4. Click Allow                                      │"
  echo "  └──────────────────────────────────────────────────────┘"
  echo "  Waiting for you to finish (up to 10 minutes)..."
  line="$(wait_log lavalink 'Token retrieved successfully' 600)" || die "Timed out waiting for the Google login. Run install.sh again to retry."
  YT_TOKEN="$(echo "$line" | grep -oE '1//[A-Za-z0-9_-]+' | tail -1)"
  [ -n "$YT_TOKEN" ] || die "Couldn't read the token from the log."
  write_env
  docker compose up -d lavalink >/dev/null 2>&1   # recreate so it starts with the saved token
  ok "YouTube login saved (in .env)"
fi

# ---------- 11. wait for healthy + commands ----------
step "Checking everything is up"
wait_log lavalink 'ready to accept connections' 180 >/dev/null || die "Lavalink didn't start. Check: docker compose logs lavalink"
ok "Lavalink ready"
docker compose up -d bot >/dev/null 2>&1; docker compose restart bot >/dev/null 2>&1
if out="$(docker compose run --rm -T bot node src/deploy-commands.js 2>&1)"; then ok "$(echo "$out" | tail -1)"
else echo "$out" | tail -15; die "Registering slash commands failed (output above)."; fi
wait_log bot 'Logged in as' 90 >/dev/null || die "Bot didn't log in. Check: docker compose logs bot"
ok "Bot online as ${BOT_NAME}"
if wait_log bot 'node main ready' 60 >/dev/null; then ok "Music connected"; else warn "Music not connected yet (check: docker compose logs bot)"; fi

# ---------- done ----------
cat <<EOF

  ${G}${B}All done.${N}

  In Discord:
    1. Server Settings -> Roles: drag ${B}${BOT_NAME}${N}'s role to the very TOP.
    2. Type ${B}/setup rebuild${N} to build the whole server (channels, roles, permissions).
       It can only be run once: after that it's locked and removed from the command list.
       Already built your server with an older version? Use ${B}/setup restyle${N} instead.
    3. Type ${B}/help${N} to see every command. ${B}/play${N} takes song names, YouTube and Spotify links.
    4. Type ${B}/diagnostics${N} any time to check everything is working.

  Useful commands on this VPS (run inside ${INSTALL_DIR}):
    docker compose logs -f bot        watch the bot
    docker compose restart            restart everything
    bash install.sh                   update / change settings later (backs up first)
    ls backups/                       daily database backups + pre-update backups

EOF
exit 0
__PAYLOAD_BELOW__
