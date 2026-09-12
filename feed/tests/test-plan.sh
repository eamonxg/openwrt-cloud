#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkrepo() { git init -q -b main "$1"; git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init; }
mkrepo "$tmp/alpha"; mkrepo "$tmp/beta"; mkrepo "$tmp/luci"
git -C "$tmp/luci" switch -q -c dash; git -C "$tmp/luci" -c user.email=t@t -c user.name=t commit -q --allow-empty -m d
a=$(git -C "$tmp/alpha" rev-parse main); b=$(git -C "$tmp/beta" rev-parse main); d=$(git -C "$tmp/luci" rev-parse dash)
cat > "$tmp/packages.json" <<EOS
{"feed":"eamonxg","sdk":{"apk":"25.12.5","opkg":"24.10.4"},"arches":null,
 "packages":[
  {"pkg":"alpha","repo":"file://$tmp/alpha","langs":["zh-cn"]},
  {"pkg":"beta","repo":"file://$tmp/beta"},
  {"pkg":"hello-arch","repo":"file://$tmp/beta","arch":"any"},
  {"pkg":"luci-mod-dashboard","repo":"file://$tmp/luci","ref":"dash","feed":"luci"}]}
EOS
cat > "$tmp/live.json" <<EOS
{"sdk":{"apk":"25.12.5","opkg":"24.10.3"},
 "channels":{"snapshots":{"apk":[{"pkg":"alpha","ref":"$a"},{"pkg":"beta","ref":"old"}],"opkg":[{"pkg":"alpha","ref":"$a"}]}},
 "arches":{"aarch64_cortex-a53":{"apk":[{"pkg":"hello-arch","ref":"$b"}],"opkg":[]}}}
EOS
export PLAN_ARCHES="x86_64 aarch64_cortex-a53"
p=$(scripts/plan.sh "$tmp/packages.json" "$tmp/live.json")

[ "$(jq -r '.packages[]|select(.pkg=="alpha")|.ref' <<<"$p")" = "$a" ] || { echo "alpha ref"; exit 1; }
[ "$(jq -r '.packages[]|select(.pkg=="luci-mod-dashboard")|.ref' <<<"$p")" = "$d" ] || { echo "branch ref"; exit 1; }
[ "$(jq -r '.packages[]|select(.pkg=="luci-mod-dashboard")|.kind' <<<"$p")" = feed ] || { echo "feed kind"; exit 1; }
[ "$(jq -r '.packages[]|select(.pkg=="alpha")|.changed.apk' <<<"$p")" = false ] || { echo "alpha apk unchanged"; exit 1; }
[ "$(jq -r '.packages[]|select(.pkg=="alpha")|.changed.opkg' <<<"$p")" = true ]  || { echo "sdk bump must invalidate opkg"; exit 1; }
[ "$(jq -r '.packages[]|select(.pkg=="beta")|.changed.apk' <<<"$p")" = true ]   || { echo "beta changed"; exit 1; }
[ "$(jq -c '.arches' <<<"$p")" = '["aarch64_cortex-a53","x86_64"]' ] || { echo "arches: $(jq -c .arches <<<"$p")"; exit 1; }

apkn=$(jq -c '.cells[]|select(.id=="apk-noarch")' <<<"$p")
[ "$(jq -r '.dir' <<<"$apkn")" = "snapshots/apk" ] || { echo "noarch dir"; exit 1; }
[ "$(jq -r '.arch' <<<"$apkn")" = x86_64 ] || { echo "noarch builds on x86_64"; exit 1; }
[ "$(jq -c '[.build[].pkg]' <<<"$apkn")" = '["beta","luci-mod-dashboard"]' ] || { echo "noarch build: $(jq -c '[.build[].pkg]' <<<"$apkn")"; exit 1; }
[ "$(jq -c '.reuse' <<<"$apkn")" = '["alpha"]' ] || { echo "noarch reuse"; exit 1; }
[ "$(jq -r '.build[0]|has("changed")' <<<"$apkn")" = false ] || { echo "build entries must be plain specs"; exit 1; }
[ "$(jq -r '.build[0]|has("kind") or has("url")' <<<"$apkn")" = false ] || { echo "build entries must be raw action specs"; exit 1; }
[ "$(jq -r '.build[]|select(.pkg=="luci-mod-dashboard")|.repo' <<<"$apkn")" = "file://$tmp/luci" ] || { echo "repo must be the resolved url"; exit 1; }
[ "$(jq -r '.build[]|select(.pkg=="luci-mod-dashboard")|.feed' <<<"$apkn")" = luci ] || { echo "feed kept"; exit 1; }
[ "$(jq -r '.build[]|select(.pkg=="luci-mod-dashboard")|.ref' <<<"$apkn")" = "$d" ] || { echo "spec ref"; exit 1; }

apka=$(jq -c '.cells[]|select(.id=="apk-aarch64_cortex-a53")' <<<"$p")
[ "$(jq -r '.dir' <<<"$apka")" = "snapshots/apk/aarch64_cortex-a53" ] || { echo "arch dir"; exit 1; }
[ "$(jq -c '[.build[].pkg]' <<<"$apka")" = '[]' ] || { echo "hello-arch unchanged on a53"; exit 1; }
[ "$(jq -c '.reuse' <<<"$apka")" = '["hello-arch"]' ] || { echo "a53 reuse"; exit 1; }
apkx=$(jq -c '.cells[]|select(.id=="apk-x86_64")' <<<"$p")
[ "$(jq -c '[.build[].pkg]' <<<"$apkx")" = '["hello-arch"]' ] || { echo "hello-arch must build on x86_64"; exit 1; }
[ "$(jq -r '.any_changed' <<<"$p")" = true ] || { echo "any_changed"; exit 1; }
[ "$(jq -r '[.cells[]|.id]|length' <<<"$p")" = 6 ] || { echo "6 cells"; exit 1; }

p2=$(scripts/plan.sh "$tmp/packages.json")
[ "$(jq -r '.packages[]|select(.pkg=="alpha")|.changed.apk' <<<"$p2")" = true ] || { echo "no live manifest → all changed"; exit 1; }

cat > "$tmp/bad.json" <<EOS
{"feed":"eamonxg","sdk":{"apk":"25.12.5"},"arches":["x86_64"],
 "packages":[{"pkg":"a","repo":"file://$tmp/alpha","arch":["mips_24kc"]}]}
EOS
if scripts/plan.sh "$tmp/bad.json" >/dev/null 2>&1; then echo "arch outside arches must fail"; exit 1; fi
