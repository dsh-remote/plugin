#!/bin/sh
# Start the dsh-remote-control relay with the SAME host token the desktop
# profile's plugin is configured with, so the two agree out of the box.
#
#   ./scripts/relay-start.sh            # ws://127.0.0.1:8787
#   DRC_PORT=9000 ./scripts/relay-start.sh
#   DRC_HOST_TOKEN=xxx ./scripts/relay-start.sh   # override explicitly
#
# The token is read from ~/.dsh/profiles/desktop/cordis.patch.yml (the user
# patch layer, mode 600). If your profile lives elsewhere, set PATCH_FILE.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
SERVER="$HERE/../apps/server/src/main.mjs"
PATCH_FILE="${PATCH_FILE:-$HOME/.dsh/profiles/desktop/cordis.patch.yml}"

if [ -z "$DRC_HOST_TOKEN" ]; then
  if [ ! -f "$PATCH_FILE" ]; then
    echo "relay-start: cannot find $PATCH_FILE — set DRC_HOST_TOKEN manually." >&2
    exit 1
  fi
  DRC_HOST_TOKEN=$(awk '
    /^- id: dsh-remote-control$/ { inblk = 1; next }
    inblk && /^[[:space:]]+- id:/ { inblk = 0 }
    inblk && /^[[:space:]]+hostToken:[[:space:]]+/ {
      sub(/^[[:space:]]+hostToken:[[:space:]]+/, ""); gsub(/["'\'']/, ""); print; exit
    }
  ' "$PATCH_FILE")
fi

if [ -z "$DRC_HOST_TOKEN" ]; then
  echo "relay-start: no hostToken found in $PATCH_FILE — set DRC_HOST_TOKEN." >&2
  exit 1
fi

export DRC_HOST_TOKEN
export DRC_PORT="${DRC_PORT:-8787}"
export DRC_PUBLIC_URL="${DRC_PUBLIC_URL:-ws://127.0.0.1:$DRC_PORT}"

echo "relay-start: port=$DRC_PORT token=${DRC_HOST_TOKEN%"${DRC_HOST_TOKEN#??????}"}… (full token withheld)"
exec node "$SERVER"
