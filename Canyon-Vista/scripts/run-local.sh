#!/bin/zsh

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export SERVER_HOST="${SERVER_HOST:-127.0.0.1}"
export SERVER_PORT="${SERVER_PORT:-4173}"

if command -v node >/dev/null 2>&1; then
  exec node scripts/dev-server.mjs
fi

if command -v python3 >/dev/null 2>&1; then
  echo "Node not found on PATH, falling back to python3 -m http.server"
  exec python3 -m http.server "$SERVER_PORT" --bind "$SERVER_HOST"
fi

echo "Unable to start local server: neither node nor python3 is available on PATH." >&2
exit 1
