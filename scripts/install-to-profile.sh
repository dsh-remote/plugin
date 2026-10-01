#!/bin/sh
# Build the plugin and (re)install it into a DSH profile.
#
#   ./scripts/install-to-profile.sh                       # ~/.dsh/profiles/desktop
#   DSH_PROFILE=~/.dsh/profiles/tui ./scripts/install-to-profile.sh
#
# Why this script exists: pnpm installs a `file:` dependency as a COPY, not a
# symlink. So `pnpm -r build` alone does NOT update the plugin the Harness
# actually loads — you must reinstall. This does both, in order.
#
# A backup of the profile's package.json is written next to it before editing.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
PLUGIN="$ROOT/packages/plugin"
PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/desktop}"

if [ ! -d "$PROFILE" ]; then
  echo "install-to-profile: profile not found: $PROFILE" >&2
  exit 1
fi

echo "→ building…"
(cd "$ROOT" && pnpm -r build)

TARGET="$PROFILE/node_modules/dsh-remote-control"

# Judge by the DECLARATION, not by the directory: a previously failed install
# can leave the tree missing while package.json still lists the dependency,
# and re-running `pnpm add` then re-resolves every GitHub tarball in the
# profile (which is exactly what breaks when the network is flaky).
if grep -q '"dsh-remote-control"' "$PROFILE/package.json"; then
  # Already installed. `pnpm add` would re-resolve EVERY dependency of the
  # profile — including the GitHub tarballs — so a network hiccup there would
  # block updating a purely local plugin. And pnpm hard-links `file:` deps, so
  # a rebuild leaves the old inode in place. Just replace the tree.
  echo "→ refreshing $TARGET (copy, no network) …"
  rm -rf "$TARGET"
  mkdir -p "$TARGET"
  cp -R "$PLUGIN/dist" "$TARGET/dist"
  cp "$PLUGIN/package.json" "$TARGET/package.json"
  [ -f "$PLUGIN/cordis.patch.yml" ] && cp "$PLUGIN/cordis.patch.yml" "$TARGET/cordis.patch.yml"
  [ -f "$PLUGIN/README.md" ] && cp "$PLUGIN/README.md" "$TARGET/README.md"
else
  echo "→ first install into $PROFILE …"
  cp "$PROFILE/package.json" "$PROFILE/package.json.bak-drc-$(date +%s)"
  (cd "$PROFILE" && pnpm add -w --prefer-offline "file:$PLUGIN")
fi

echo "→ registering the bundle …"
(cd "$PROFILE" && node -e '
const fs = require("fs")
const p = JSON.parse(fs.readFileSync("package.json", "utf8"))
const list = (((p.dsh || {}).profile || {}).bundles) || []
if (!list.includes("dsh-remote-control")) list.push("dsh-remote-control")
p.dsh = p.dsh || {}
p.dsh.profile = p.dsh.profile || {}
p.dsh.profile.bundles = list
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n")
console.log("   bundles:", list.join(", "))
')

echo
echo "✅ installed. Now RESTART the DSH Harness (new packages are not hot-reloaded),"
echo "   then check the log for:"
echo "     [dsh-remote-control] host runtime started → … (carrier=dsh)"
echo "   If it says carrier=mock, the real kernel bridge did not attach."
