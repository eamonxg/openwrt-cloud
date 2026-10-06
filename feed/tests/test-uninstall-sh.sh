#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$PWD
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

sed -e 's/__FEED_HOST__/feed.example.test/g' \
    -e 's/__USIGN_FPR__/0b26f36ae0f4106d/g' \
    -e 's/__UNINSTALL_PACKAGES__/luci-app-aurora-config luci-i18n-aurora-config-de luci-mod-dashboard luci-theme-aurora/g' \
    site/uninstall.sh > "$tmp/uninstall.sh"
sh -n "$tmp/uninstall.sh"

setup() {
  rm -rf "$tmp/root"
  mkdir -p "$tmp/root/etc/opkg/keys" "$tmp/root/etc/apk/keys" "$tmp/root/etc/apk/repositories.d" "$tmp/root/lib/apk/db" "$tmp/root/usr/lib/opkg" "$tmp/root/var/opkg-lists"
  if [ "$1" = apk ]; then touch "$tmp/root/lib/apk/db/installed"
  else touch "$tmp/root/usr/lib/opkg/status"; fi
  printf '%s\n' 'src/gz other https://other.example/packages' 'src/gz eamonxg https://feed.example.test/snapshots/opkg' > "$tmp/root/etc/opkg/customfeeds.conf"
  printf '%s\n' 'https://other.example/packages.adb' 'https://feed.example.test/snapshots/apk/packages.adb' > "$tmp/root/etc/apk/repositories.d/customfeeds.list"
  touch "$tmp/root/etc/opkg/keys/0b26f36ae0f4106d" "$tmp/root/etc/apk/keys/eamonxg.pem" "$tmp/root/var/opkg-lists/eamonxg"
  : > "$tmp/log"
}

run_uninstall() {
  set +e
  out=$(env PATH="$REPO/tests/fixtures/fake-bin:$PATH" ROOT="$tmp/root" TTY_DEV= FAKE_LOG="$tmp/log" \
    FAKE_INSTALLED='luci-theme-aurora luci-i18n-aurora-config-de' "$@" sh "$tmp/uninstall.sh" 2>&1)
  rc=$?
  set -e
}

setup opkg
run_uninstall
[ "$rc" != 0 ] && ! grep -q 'opkg remove' "$tmp/log" || { echo "unconfirmed uninstall changed packages"; exit 1; }
grep -q 'src/gz eamonxg ' "$tmp/root/etc/opkg/customfeeds.conf"

run_uninstall YES=1 FAKE_THEME=/luci-static/aurora
[ "$rc" = 0 ] || { echo "$out"; exit 1; }
grep -qx 'opkg remove luci-theme-aurora' "$tmp/log"
grep -qx 'opkg remove luci-i18n-aurora-config-de' "$tmp/log"
! grep -q 'opkg remove luci-mod-dashboard' "$tmp/log"
grep -qx 'uci set luci.main.mediaurlbase=/luci-static/bootstrap' "$tmp/log"
grep -qx 'src/gz other https://other.example/packages' "$tmp/root/etc/opkg/customfeeds.conf"
[ ! -e "$tmp/root/etc/opkg/keys/0b26f36ae0f4106d" ]
[ ! -e "$tmp/root/var/opkg-lists/eamonxg" ]

setup apk
run_uninstall YES=1
[ "$rc" = 0 ] || { echo "$out"; exit 1; }
grep -qx 'apk del luci-theme-aurora' "$tmp/log"
grep -qx 'apk del luci-i18n-aurora-config-de' "$tmp/log"
grep -qx 'https://other.example/packages.adb' "$tmp/root/etc/apk/repositories.d/customfeeds.list"
[ ! -e "$tmp/root/etc/apk/keys/eamonxg.pem" ]

setup opkg
run_uninstall YES=1 FAKE_FAIL=luci-theme-aurora
[ "$rc" != 0 ] || { echo "failed package removal should stop"; exit 1; }
grep -q 'src/gz eamonxg ' "$tmp/root/etc/opkg/customfeeds.conf"
[ -e "$tmp/root/etc/opkg/keys/0b26f36ae0f4106d" ]
