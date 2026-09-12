#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/art/apk-noarch" "$tmp/art/apk-x86_64" "$tmp/cache/snapshots/apk"
printf 'N' > "$tmp/art/apk-noarch/beta-2.0.apk"
cat > "$tmp/art/apk-noarch/build-info.json" <<'EOS'
{"sdk":"25.12.5","arch":"x86_64","pkg_type":"apk","packages":[{"pkg":"beta","kind":"repo","ref":"b","declared_arch":"all","files":[{"file":"beta-2.0.apk","name":"beta","version":"2.0","arch":"noarch","size":1,"sha256":"x"}]}]}
EOS
mkdir -p "$tmp/art/apk-noarch-luci"; printf 'D' > "$tmp/art/apk-noarch-luci/dash-3.0.apk"
cat > "$tmp/art/apk-noarch-luci/build-info.json" <<'EOS'
{"sdk":"25.12.5","arch":"x86_64","pkg_type":"apk","packages":[{"pkg":"dash","kind":"feed","ref":"d","declared_arch":"all","files":[{"file":"dash-3.0.apk","name":"dash","version":"3.0","arch":"noarch","size":1,"sha256":"z"}]}]}
EOS
printf 'X' > "$tmp/art/apk-x86_64/hello-arch-1.0.apk"
cat > "$tmp/art/apk-x86_64/build-info.json" <<'EOS'
{"sdk":"25.12.5","arch":"x86_64","pkg_type":"apk","packages":[{"pkg":"hello-arch","kind":"repo","ref":"h","declared_arch":"any","files":[{"file":"hello-arch-1.0.apk","name":"hello-arch","version":"1.0","arch":"x86_64","size":1,"sha256":"y"}]}]}
EOS
printf 'A' > "$tmp/cache/snapshots/apk/alpha-1.0.apk"
cat > "$tmp/live.json" <<'EOS'
{"sdk":{"apk":"25.12.5"},"channels":{"snapshots":{"apk":[{"pkg":"alpha","source":"alpha","file":"alpha-1.0.apk","version":"1.0","arch":"noarch","size":1,"sha256":"a","ref":"r"}],"opkg":[]}},"arches":{}}
EOS
cat > "$tmp/plan.json" <<'EOS'
{"sdk":{"apk":"25.12.5"},"cells":[
 {"id":"apk-noarch","fmt":"apk","sdk":"25.12.5","target":"noarch","arch":"x86_64","dir":"snapshots/apk","build":[{"pkg":"beta"}],"reuse":["alpha"]},
 {"id":"apk-noarch-luci","fmt":"apk","sdk":"25.12.5","target":"noarch","arch":"x86_64","dir":"snapshots/apk","override":"luci@d","build":[{"pkg":"dash"}],"reuse":[]},
 {"id":"apk-x86_64","fmt":"apk","sdk":"25.12.5","target":"x86_64","arch":"x86_64","dir":"snapshots/apk/x86_64","build":[{"pkg":"hello-arch"}],"reuse":[]}]}
EOS
scripts/assemble.sh "$tmp/plan.json" "$tmp/art" "$tmp/cache" "$tmp/live.json" "$tmp/dist"
[ -f "$tmp/dist/snapshots/apk/beta-2.0.apk" ] && [ -f "$tmp/dist/snapshots/apk/alpha-1.0.apk" ] && [ -f "$tmp/dist/snapshots/apk/dash-3.0.apk" ] || { echo "noarch dir must merge both cells"; exit 1; }
[ "$(jq -r '.packages|length' "$tmp/dist/snapshots/apk/build-info.json")" = 3 ] || { echo "noarch build-info merged"; exit 1; }
[ ! -e "$tmp/dist/snapshots/apk/hello-arch-1.0.apk" ] || { echo "arch pkg must not be in noarch dir"; exit 1; }
for f in beta-2.0.apk alpha-1.0.apk dash-3.0.apk hello-arch-1.0.apk; do [ -f "$tmp/dist/snapshots/apk/x86_64/$f" ] || { echo "arch dir missing $f"; exit 1; }; done
bi="$tmp/dist/snapshots/apk/x86_64/build-info.json"
[ "$(jq -r '.packages|length' "$bi")" = 4 ] || { echo "merged packages: $(jq -c '[.packages[].pkg]' "$bi")"; exit 1; }
[ "$(jq -r '.packages[]|select(.pkg=="alpha")|.files[0].sha256' "$bi")" = a ] || { echo "reused entry from live manifest"; exit 1; }
[ "$(jq -r '.arch' "$bi")" = x86_64 ] || { echo "arch"; exit 1; }
[ "$(jq -r '.arch' "$tmp/dist/snapshots/apk/build-info.json")" = noarch ] || { echo "noarch label"; exit 1; }
