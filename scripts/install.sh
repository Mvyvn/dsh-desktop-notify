#!/usr/bin/env bash
# dsh-desktop-notify installer — macOS / Linux
# Copies the plugin into the dsh web profile, registers it as a bundle
# (idempotent), then tells you to fully restart dsh web.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
TARGET="$PROFILE_DIR/node_modules/dsh-desktop-notify"
PROFILE_PKG="$PROFILE_DIR/package.json"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "[dsh-desktop-notify] web profile not found at $PROFILE_DIR" >&2
  echo "Start 'dsh web' once so the profile is generated, then re-run this script." >&2
  exit 1
fi

mkdir -p "$TARGET"
cp -R "$REPO_ROOT/lib"              "$TARGET/"
cp -R "$REPO_ROOT/assets"           "$TARGET/"
cp    "$REPO_ROOT/cordis.patch.yml" "$TARGET/"
cp    "$REPO_ROOT/package.json"     "$TARGET/"
mkdir -p "$TARGET/scripts"
cp    "$REPO_ROOT/scripts/register-aumid.py" "$TARGET/scripts/" 2>/dev/null || true
echo "[dsh-desktop-notify] plugin files installed to $TARGET"

if [ ! -f "$PROFILE_PKG" ]; then
  echo "[dsh-desktop-notify] profile package.json missing at $PROFILE_PKG — add 'dsh-desktop-notify' to dsh.profile.bundles manually" >&2
else
  node -e "
    const fs = require('fs');
    const path = process.argv[1];
    const p = JSON.parse(fs.readFileSync(path, 'utf8'));
    let changed = false;
    if (!p.dependencies) p.dependencies = {};
    if (!p.dependencies['dsh-desktop-notify']) { p.dependencies['dsh-desktop-notify'] = '1.0.0'; changed = true; }
    if (!Array.isArray(p.dsh.profile.bundles)) p.dsh.profile.bundles = [];
    if (!p.dsh.profile.bundles.includes('dsh-desktop-notify')) { p.dsh.profile.bundles.push('dsh-desktop-notify'); changed = true; }
    if (changed) fs.writeFileSync(path, JSON.stringify(p, null, 2) + '\n');
    process.exit(changed ? 0 : 1);
  " "$PROFILE_PKG" && echo "[dsh-desktop-notify] updated $PROFILE_PKG" || echo "[dsh-desktop-notify] already registered in profile package.json (no change)"
fi

echo ""
echo "[dsh-desktop-notify] done. Now FULLY restart 'dsh web' (stop the process, then start it again) - a page refresh is not enough."
