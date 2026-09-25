#!/usr/bin/env bash
# dsh-desktop-notify installer — Linux（macOS 暂不支持）
# Copies the plugin into the dsh web profile, registers it as a bundle
# (idempotent), then tells you to fully restart dsh web.
#
# 不需要 Python、不需要 pip：
#   Linux  → lib/toast-linux.js 直连 D-Bus（org.freedesktop.Notifications，无子进程）
#   Windows→ lib/winrt.js 用 koffi 直调 WinRT（见 scripts/install.ps1）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
TARGET="$PROFILE_DIR/node_modules/dsh-desktop-notify"
PROFILE_PKG="$PROFILE_DIR/package.json"

case "$(uname -s)" in
  Linux) ;;
  Darwin)
    echo "[dsh-desktop-notify] 警告：macOS 通知后端尚未实现，插件会加载但不会弹通知。" >&2
    echo "                   欢迎提交 PR（osascript / UNUserNotificationCenter 路径）。" >&2
    ;;
  *)
    echo "[dsh-desktop-notify] 警告：未识别的平台 $(uname -s)，插件会加载但不会弹通知。" >&2
    ;;
esac

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
# GPL 要求把许可证文本随作品一起交给接收者，所以安装副本里也要有一份
cp    "$REPO_ROOT/LICENSE"          "$TARGET/"
echo "[dsh-desktop-notify] plugin files installed to $TARGET"

if [ "$(uname -s)" = "Linux" ]; then
  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ ! -S "/run/user/$(id -u)/bus" ]; then
    echo "[dsh-desktop-notify] 提示：未检测到会话 D-Bus（/run/user/$(id -u)/bus），" >&2
    echo "                   通知需要桌面会话的 D-Bus；纯 SSH/无桌面环境不会弹通知。" >&2
  fi
fi

if [ ! -f "$PROFILE_PKG" ]; then
  echo "[dsh-desktop-notify] profile package.json missing at $PROFILE_PKG — add 'dsh-desktop-notify' to dsh.profile.bundles manually" >&2
else
  # 登记真实版本号（原先硬编码 1.0.0，与包版本漂移）
  REPO_VERSION="$(node -e "process.stdout.write(require('$REPO_ROOT/package.json').version)")"
  node -e "
    const fs = require('fs');
    const [path, name, version] = process.argv.slice(1);
    const p = JSON.parse(fs.readFileSync(path, 'utf8'));
    let changed = false;
    if (!p.dependencies) { p.dependencies = {}; changed = true; }
    if (!p.dependencies[name]) { p.dependencies[name] = version; changed = true; }
    if (!p.dsh) { p.dsh = {}; changed = true; }
    if (!p.dsh.profile) { p.dsh.profile = {}; changed = true; }
    if (!Array.isArray(p.dsh.profile.bundles)) { p.dsh.profile.bundles = []; changed = true; }
    if (!p.dsh.profile.bundles.includes(name)) { p.dsh.profile.bundles.push(name); changed = true; }
    if (changed) fs.writeFileSync(path, JSON.stringify(p, null, 2) + '\n');
    process.exit(changed ? 0 : 1);
  " "$PROFILE_PKG" 'dsh-desktop-notify' "$REPO_VERSION" \
    && echo "[dsh-desktop-notify] registered in profile package.json as $REPO_VERSION" \
    || echo "[dsh-desktop-notify] already registered in profile package.json (no change)"
fi

echo ""
echo "[dsh-desktop-notify] done. Now FULLY restart 'dsh web' (stop the process, then start it again) - a page refresh is not enough."
