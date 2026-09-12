#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/dist/snapshots/apk" "$tmp/dist/snapshots/opkg" "$tmp/dist/snapshots/apk/x86_64"
cat > "$tmp/dist/snapshots/apk/build-info.json" <<'EOS'
{"sdk":"25.12.5","arch":"noarch","pkg_type":"apk","packages":[
 {"pkg":"luci-app-x","kind":"repo","ref":"r1","declared_arch":"all","files":[
   {"file":"luci-app-x-1.0.apk","name":"luci-app-x","version":"1.0","arch":"noarch","size":3,"sha256":"s1"},
   {"file":"luci-i18n-x-de-1.0.apk","name":"luci-i18n-x-de","version":"1.0","arch":"noarch","size":2,"sha256":"s2"}]}]}
EOS
cat > "$tmp/dist/snapshots/opkg/build-info.json" <<'EOS'
{"sdk":"24.10.4","arch":"noarch","pkg_type":"ipk","packages":[]}
EOS
cat > "$tmp/dist/snapshots/apk/x86_64/build-info.json" <<'EOS'
{"sdk":"25.12.5","arch":"x86_64","pkg_type":"apk","packages":[
 {"pkg":"hello-arch","kind":"repo","ref":"r2","declared_arch":"any","files":[{"file":"hello-arch-1.0.apk","name":"hello-arch","version":"1.0","arch":"x86_64","size":9,"sha256":"s3"}]},
 {"pkg":"luci-app-x","kind":"reused","ref":"r1","declared_arch":"all","files":[
   {"file":"luci-app-x-1.0.apk","name":"luci-app-x","version":"1.0","arch":"noarch","size":3,"sha256":"s1"}]}]}
EOS
scripts/gen-manifest.sh "$tmp/dist" eamonxg '{"apk":"25.12.5","opkg":"24.10.4"}'
m="$tmp/dist/manifest.json"
[ "$(jq -r '.channels.snapshots.apk|length' "$m")" = 2 ] || { echo "apk entries"; exit 1; }
e=$(jq -c '.channels.snapshots.apk[]|select(.pkg=="luci-app-x")' "$m")
[ "$(jq -r .file <<<"$e")" = luci-app-x-1.0.apk ] && [ "$(jq -r .sha256 <<<"$e")" = s1 ] && [ "$(jq -r .size <<<"$e")" = 3 ] || { echo "entry fields"; exit 1; }
[ "$(jq -r .source <<<"$e")" = luci-app-x ] && [ "$(jq -r .ref <<<"$e")" = r1 ] || { echo "source/ref"; exit 1; }
[ "$(jq -r '.channels.snapshots.apk[]|select(.pkg=="luci-i18n-x-de")|.source' "$m")" = luci-app-x ] || { echo "i18n source"; exit 1; }
[ "$(jq -r '.channels.snapshots.opkg|type' "$m")" = array ] && [ "$(jq -r '.channels.snapshots.opkg|length' "$m")" = 0 ] || { echo "opkg must be an empty array"; exit 1; }
[ "$(jq -r '.channels.snapshots|keys|join(",")' "$m")" = "apk,opkg" ] || { echo "channel keys must be apk,opkg"; exit 1; }
[ "$(jq -r '.arches["x86_64"].apk|length' "$m")" = 2 ] || { echo "arch entries"; exit 1; }
[ "$(jq -r '.sdk.apk' "$m")" = 25.12.5 ] && [ "$(jq -r '.sdk.opkg' "$m")" = 24.10.4 ] && [ "$(jq -r .feed "$m")" = eamonxg ] || { echo "sdk/feed"; exit 1; }
[ "$(jq -r '.built.snapshots.apk' "$m")" = "$(jq -r .generated "$m")" ] || { echo "built"; exit 1; }
[ "$(jq -r 'has("releases")' "$m")" = false ] && [ "$(jq -r '.channels|has("releases")' "$m")" = false ] || { echo "no releases"; exit 1; }
