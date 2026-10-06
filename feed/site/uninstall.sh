#!/bin/sh
# eamonxg OpenWrt feed uninstaller — https://__FEED_HOST__
# Usage: wget -qO- https://__FEED_HOST__/uninstall.sh | sh
#        wget -qO- https://__FEED_HOST__/uninstall.sh | YES=1 sh
set -e
HOST="__FEED_HOST__"
FPR="__USIGN_FPR__"
PACKAGES="__UNINSTALL_PACKAGES__"
ROOT="${ROOT:-}"
TTY_DEV="${TTY_DEV-/dev/tty}"

[ "$(id -u)" = 0 ] || { echo "This uninstaller must be run as root." >&2; exit 1; }

if [ -f "$ROOT/lib/apk/db/installed" ]; then
  PM=apk
elif [ -f "$ROOT/usr/lib/opkg/status" ]; then
  PM=opkg
else
  echo "Cannot detect apk or opkg from the on-disk package database." >&2
  exit 1
fi
command -v "$PM" >/dev/null 2>&1 || { echo "$PM database found but $PM binary is missing" >&2; exit 1; }

is_installed() {
  if [ "$PM" = apk ]; then
    [ -n "$(apk info -e "$1" 2>/dev/null)" ]
  else
    opkg list-installed "$1" 2>/dev/null | awk -v p="$1" '$1 == p { found=1 } END { exit !found }'
  fi
}

installed=""
for pkg in $PACKAGES; do
  is_installed "$pkg" && installed="$installed $pkg"
done

echo "Package manager: $PM"
if [ -n "$installed" ]; then
  echo "Installed feed package names to remove:"
  for pkg in $installed; do echo "  $pkg"; done
  echo "Check shared names such as luci-mod-dashboard if installed from another feed."
else
  echo "No feed package names are installed."
fi
echo "The eamonxg feed entry and signing key will also be removed."

if [ -z "${YES:-}" ]; then
  if [ -z "$TTY_DEV" ] || ! (exec 3<"$TTY_DEV") 2>/dev/null; then
    echo "A terminal is required to confirm. For unattended use, pipe to YES=1 sh." >&2
    exit 1
  fi
  printf 'Continue? [y/N] '
  read -r answer <"$TTY_DEV" || answer=""
  case "$answer" in y|Y|yes|YES) ;; *) echo "Nothing done."; exit 0 ;; esac
fi

# Do not leave LuCI pointing at a theme that is about to be removed.
current_theme=$(uci -q get luci.main.mediaurlbase 2>/dev/null || true)
case "$current_theme" in
  /luci-static/aurora|/luci-static/shadcn)
    uci set luci.main.mediaurlbase=/luci-static/bootstrap
    uci commit luci
    echo "Active LuCI theme reset to bootstrap."
    ;;
esac

for pkg in $installed; do
  # apk may remove another selected package as a dependent of the first.
  is_installed "$pkg" || continue
  echo "==> $PM remove $pkg"
  if [ "$PM" = apk ]; then apk del "$pkg"; else opkg remove "$pkg"; fi
done

if [ "$PM" = apk ]; then
  feed_file="$ROOT/etc/apk/repositories.d/customfeeds.list"
  if [ -f "$feed_file" ]; then
    grep -vF "https://$HOST/" "$feed_file" > "$feed_file.tmp" || true
    mv "$feed_file.tmp" "$feed_file"
  fi
  rm -f "$ROOT/etc/apk/keys/eamonxg.pem"
else
  feed_file="$ROOT/etc/opkg/customfeeds.conf"
  if [ -f "$feed_file" ]; then
    grep -vF 'src/gz eamonxg ' "$feed_file" > "$feed_file.tmp" || true
    mv "$feed_file.tmp" "$feed_file"
  fi
  rm -f "$ROOT/etc/opkg/keys/$FPR" "$ROOT/var/opkg-lists/eamonxg"
fi
"$PM" update
echo "eamonxg packages, feed entry and signing key removed."
