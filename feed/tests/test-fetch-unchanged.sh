#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
mkdir -p "$tmp/live/snapshots/apk"; printf 'AAA' > "$tmp/live/snapshots/apk/alpha-1.0.apk"; printf 'BBB' > "$tmp/live/snapshots/apk/luci-i18n-alpha-de-1.0.apk"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
cat > "$tmp/live.json" <<EOS
{"channels":{"snapshots":{"apk":[
  {"pkg":"alpha","source":"alpha","file":"alpha-1.0.apk","sha256":"$(sha "$tmp/live/snapshots/apk/alpha-1.0.apk")"},
  {"pkg":"luci-i18n-alpha-de","source":"alpha","file":"luci-i18n-alpha-de-1.0.apk","sha256":"$(sha "$tmp/live/snapshots/apk/luci-i18n-alpha-de-1.0.apk")"}],"opkg":[]}},"arches":{}}
EOS
cat > "$tmp/plan.json" <<'EOS'
{"cells":[{"id":"apk-noarch","fmt":"apk","dir":"snapshots/apk","build":[],"reuse":["alpha"]}]}
EOS
python3 -m http.server -d "$tmp/live" 18081 >/dev/null 2>&1 & srv=$!; trap 'kill $srv 2>/dev/null; wait $srv 2>/dev/null || true; rm -rf "$tmp"' EXIT; sleep 1
scripts/fetch-unchanged.sh "$tmp/plan.json" "$tmp/live.json" http://127.0.0.1:18081 "$tmp/cache"
[ "$(cat "$tmp/cache/snapshots/apk/alpha-1.0.apk")" = AAA ] || { echo "file"; exit 1; }
[ "$(cat "$tmp/cache/snapshots/apk/luci-i18n-alpha-de-1.0.apk")" = BBB ] || { echo "i18n sibling"; exit 1; }
printf 'BAD' > "$tmp/live/snapshots/apk/alpha-1.0.apk"; rm -f "$tmp/cache/snapshots/apk/alpha-1.0.apk"
if scripts/fetch-unchanged.sh "$tmp/plan.json" "$tmp/live.json" http://127.0.0.1:18081 "$tmp/cache" 2>/dev/null; then echo "sha mismatch must fail"; exit 1; fi
