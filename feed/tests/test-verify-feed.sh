#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tools=${FEED_TOOLS:-}
[ -n "$tools" ] && [ -x "$tools/usign" ] || { echo "   skip: FEED_TOOLS not set"; exit 0; }
tmp=$(mktemp -d)
mkdir -p "$tmp/www/snapshots/opkg"
printf 'Package: luci-theme-aurora\nVersion: 1.0\n\nPackage: other\nVersion: 2\n' > "$tmp/www/snapshots/opkg/Packages"
gzip -9nc "$tmp/www/snapshots/opkg/Packages" > "$tmp/www/snapshots/opkg/Packages.gz"
"$tools/usign" -G -s "$tmp/u.sec" -p "$tmp/u.pub" -c t >/dev/null 2>&1
"$tools/usign" -S -m "$tmp/www/snapshots/opkg/Packages" -s "$tmp/u.sec" -x "$tmp/www/snapshots/opkg/Packages.sig"
python3 -m http.server -d "$tmp/www" 18082 >/dev/null 2>&1 & srv=$!; trap 'kill $srv 2>/dev/null; wait $srv 2>/dev/null || true; rm -rf "$tmp"' EXIT; sleep 1
VERIFY_SKIP_HEADERS=1 scripts/verify-feed.sh http://127.0.0.1:18082 opkg snapshots/opkg "$tools" "$tmp/u.pub" luci-theme-aurora
if VERIFY_SKIP_HEADERS=1 scripts/verify-feed.sh http://127.0.0.1:18082 opkg snapshots/opkg "$tools" "$tmp/u.pub" luci-theme-aurora missing-pkg 2>/dev/null; then echo "missing pkg must fail"; exit 1; fi
"$tools/usign" -G -s "$tmp/w.sec" -p "$tmp/w.pub" -c w >/dev/null 2>&1
if VERIFY_SKIP_HEADERS=1 scripts/verify-feed.sh http://127.0.0.1:18082 opkg snapshots/opkg "$tools" "$tmp/w.pub" luci-theme-aurora 2>/dev/null; then echo "wrong key must fail"; exit 1; fi
