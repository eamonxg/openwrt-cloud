#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tools=${FEED_TOOLS:-}
[ -n "$tools" ] && [ -x "$tools/apk" ] && [ -x "$tools/usign" ] || { echo "   skip: FEED_TOOLS not set"; exit 0; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/c"; printf 'Package: luci-theme-a\nVersion: 1.2.3-r4\nArchitecture: all\nDescription: x\n' > "$tmp/c/control"
tar -C "$tmp/c" -czf "$tmp/control.tar.gz" ./control
echo 2.0 > "$tmp/debian-binary"; mkdir -p "$tmp/d"; tar -C "$tmp/d" -czf "$tmp/data.tar.gz" .
mkdir -p "$tmp/opkg"; tar -C "$tmp" -czf "$tmp/opkg/luci-theme-a_1.2.3-r4_all.ipk" ./debian-binary ./control.tar.gz ./data.tar.gz
"$tools/usign" -G -s "$tmp/u.sec" -p "$tmp/u.pub" -c t >/dev/null 2>&1
USIGN_KEY="$(cat "$tmp/u.sec")" scripts/index-dir.sh "$tmp/opkg" opkg noarch "$tools"
grep -q '^Package: luci-theme-a$' "$tmp/opkg/Packages" || { echo "Packages"; exit 1; }
grep -q '^SHA256sum: ' "$tmp/opkg/Packages" || { echo "sha in Packages"; exit 1; }
! grep -q '^Maintainer' "$tmp/opkg/Packages" || { echo "filtered fields"; exit 1; }
gunzip -t "$tmp/opkg/Packages.gz" || { echo "gz"; exit 1; }
"$tools/usign" -V -m "$tmp/opkg/Packages" -p "$tmp/u.pub" -x "$tmp/opkg/Packages.sig" || { echo "sig"; exit 1; }
jq -e '.packages["luci-theme-a"]' "$tmp/opkg/index.json" >/dev/null || { echo "index.json"; exit 1; }

[ -n "${FEED_TEST_APK:-}" ] && [ -f "$FEED_TEST_APK" ] || { echo "   partial: no FEED_TEST_APK, apk half skipped"; exit 0; }
mkdir -p "$tmp/apk"; cp "$FEED_TEST_APK" "$tmp/apk/"
openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/k.pem"
APK_KEY="$(cat "$tmp/k.pem")" scripts/index-dir.sh "$tmp/apk" apk noarch "$tools"
"$tools/apk" adbdump "$tmp/apk/packages.adb" | grep -q 'name: luci-theme-aurora' || { echo "adb"; exit 1; }
jq -e '.packages|length>=1' "$tmp/apk/index.json" >/dev/null || { echo "apk index.json"; exit 1; }
