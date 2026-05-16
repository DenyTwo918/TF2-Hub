#!/bin/bash
# TF2 Trading Hub — patch all app files without an HA add-on update.
# Run from HA Terminal add-on:
#   curl -fsSL https://raw.githubusercontent.com/DenyTwo918/TF2-HA-Hub/main/update.sh | bash

set -e

BASE="https://raw.githubusercontent.com/DenyTwo918/TF2-HA-Hub/main"

# Find the running container (slug can be prefixed with repo hash)
CONTAINER=$(docker ps --format '{{.Names}}' | grep -m1 'tf2_trading_hub' || true)
if [ -z "$CONTAINER" ]; then
  echo "ERROR: tf2_trading_hub container not found. Is the add-on running?"
  exit 1
fi
echo "Found container: $CONTAINER"

# Download files to host /tmp, verify they look like JS/HTML (not an error page),
# then copy them into the container with docker cp.
fetch() {
  local src="$1" dst="$2" tmp="/tmp/tf2hub_$(basename $src)"
  wget -qO "$tmp" "${BASE}/${src}"
  local size=$(wc -c < "$tmp")
  if [ "$size" -lt 200 ]; then
    echo "  WARN: $src download looks empty/failed (${size} bytes) — skipping"
    return
  fi
  docker cp "$tmp" "${CONTAINER}:${dst}"
  rm -f "$tmp"
  echo "  updated $dst (${size} bytes)"
}

fetch "server.js"         "/app/server.js"
fetch "public/index.html" "/app/public/index.html"
fetch "public/app.js"     "/app/public/app.js"
fetch "public/app.css"    "/app/public/app.css"
fetch "public/styles.css" "/app/public/styles.css"

# Restart the container so the new code takes effect
docker restart "$CONTAINER"
echo "Done — bot restarting with latest code"
