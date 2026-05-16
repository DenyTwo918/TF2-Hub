#!/usr/bin/with-contenv bashio
set -uo pipefail

echo "[tf2-hub] v1.8.1 starting"
echo "[tf2-hub] node: $(node --version 2>&1)"

BASE="https://raw.githubusercontent.com/DenyTwo918/TF2-Hub/main"

# Auto-update every file from GitHub on each start.
# /app is writable in the container's layer — changes survive restarts.
# This means you NEVER need to click Update in HA again; just restart.
update_file() {
  local src="$1" dst="$2"
  if wget -q -O "${dst}.new" "${BASE}/${src}" 2>/dev/null && [ -s "${dst}.new" ]; then
    mv "${dst}.new" "$dst"
    echo "[tf2-hub] updated ${src}"
  else
    rm -f "${dst}.new"
    echo "[tf2-hub] fetch failed for ${src} — using bundled"
  fi
}

update_file "server.js"         "/app/server.js"
update_file "public/index.html" "/app/public/index.html"
update_file "public/app.js"     "/app/public/app.js"
update_file "public/app.css"    "/app/public/app.css"
update_file "public/styles.css" "/app/public/styles.css"

exec node /app/server.js 2>&1
