#!/usr/bin/env bash
# Builds the one-file installer: installer/install-head.sh + this whole repo packed inside it.
#   scripts/build-installer.sh [bot-image-reference] [output-file]
# GitHub Actions runs this with the exact image it just built (ghcr.io/<owner>/<repo>@sha256:...).
# Run without an image and the installer builds the bot on the VPS instead.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${1:-@@BOT_IMAGE@@}"
OUT="${2:-$ROOT/dist/install.sh}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/server-bot" "$(dirname "$OUT")"
tar -C "$ROOT" \
  --exclude=./.git --exclude=./.github --exclude=./dist --exclude=./installer --exclude=./scripts \
  --exclude=./node_modules --exclude=./data --exclude=./.env --exclude=./yt-cipher --exclude=./spotify-tokener \
  --exclude=./lavalink/plugins --exclude=./locks --exclude=./backups --exclude='*.bak' \
  -cf - . | tar -xf - -C "$TMP/server-bot"
tar -C "$TMP" -czf "$TMP/payload.tgz" server-bot

sed "s#@@BOT_IMAGE@@#${IMAGE}#" "$ROOT/installer/install-head.sh" > "$OUT"
base64 -w 76 "$TMP/payload.tgz" >> "$OUT"
chmod +x "$OUT"
echo "Built $OUT ($(du -h "$OUT" | cut -f1)), bot image: ${IMAGE}"
