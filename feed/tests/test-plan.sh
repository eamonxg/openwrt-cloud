#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkrepo() { git init -q -b main "$1"; git -C "$1" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init; }
mkrepo "$tmp/alpha"; mkrepo "$tmp/beta"; mkrepo "$tmp/luci"
git -C "$tmp/luci" switch -q -c dash; git -C "$tmp/luci" -c user.email=t@t -c user.name=t commit -q --allow-empty -m d
git -C "$tmp/luci" switch -q -c dash24 main; git -C "$tmp/luci" -c user.email=t@t -c user.name=t commit -q --allow-empty -m d24
a=$(git -C "$tmp/alpha" rev-parse main); b=$(git -C "$tmp/beta" rev-parse main); d=$(git -C "$tmp/luci" rev-parse dash); d24=$(git -C "$tmp/luci" rev-parse dash24)
cat > "$tmp/packages.json" <<EOS
{"feed":"eamonxg","sdk":{"apk":"25.12.5","opkg":"24.10.4"},"arches":null,
 "packages":[
  {"pkg":"alpha","repo":"file://$tmp/alpha","langs":["zh-cn"]},
  {"pkg":"beta","repo":"file://$tmp/beta"},
  {"pkg":"hello-arch","repo":"file://$tmp/beta","arch":"any"},
  {"pkg":"luci-mod-dashboard","repo":"file://$tmp/luci","ref":"dash","feed":"luci","formats":["apk"]},
  {"pkg":"luci-mod-dashboard","repo":"file://$tmp/luci","ref":"dash24","feed":"luci","formats":["opkg"]}]}
EOS
cat > "$tmp/live.json" <<EOS
{"sdk":{"apk":"25.12.5","opkg":"24.10.3"},
 "channels":{"snapshots":{"apk":[{"pkg":"alpha","ref":"$a"},{"pkg":"beta","ref":"old"}],"opkg":[{"pkg":"alpha","ref":"$a"}]}},
 "arches":{"aarch64_cortex-a53":{"apk":[{"pkg":"hello-arch","ref":"$b"}],"opkg":[]}}}
EOS
export PLAN_ARCHES="x86_64 aarch64_cortex-a53"
p=$(scripts/plan.sh "$tmp/packages.json" "$tmp/live.json")

[ "$(jq -r '.packages[]|select(.pkg=="alpha")|.ref' <<<"$p")" = "$a" ] || { echo "alpha ref"; exit 1; }
[ "$(jq -r '.packages[]|select(.pkg=="luci-mod-dashboard" and .formats==["apk"])|.ref' <<<"$p")" = "$d" ] || { echo "branch ref"; exit 1; }
[ "$(jq -r '.packages[]|select(.pkg=="luci-mod-dashboard" and .formats==["apk"])|.kind' <<<"$p")" = feed ] || { echo "feed kind"; exit 1; }
[ "$(jq -r '.packages[]|select(.pkg=="alpha")|.changed.apk' <<<"$p")" = false ] || { echo "alpha apk unchanged"; exit 1; }
[ "$(jq -r '.packages[]|select(.pkg=="alpha")|.changed.opkg' <<<"$p")" = true ]  || { echo "sdk bump must invalidate opkg"; exit 1; }
[ "$(jq -r '.packages[]|select(.pkg=="beta")|.changed.apk' <<<"$p")" = true ]   || { echo "beta changed"; exit 1; }
[ "$(jq -c '.arches' <<<"$p")" = '["aarch64_cortex-a53","x86_64"]' ] || { echo "arches: $(jq -c .arches <<<"$p")"; exit 1; }

apkn=$(jq -c '.cells[]|select(.id=="apk-noarch")' <<<"$p")
[ "$(jq -r '.dir' <<<"$apkn")" = "snapshots/apk" ] || { echo "noarch dir"; exit 1; }
[ "$(jq -r '.arch' <<<"$apkn")" = x86_64 ] || { echo "noarch builds on x86_64"; exit 1; }
[ "$(jq -c '[.build[].pkg]' <<<"$apkn")" = '["beta"]' ] || { echo "noarch build: $(jq -c '[.build[].pkg]' <<<"$apkn")"; exit 1; }
ov=$(jq -c '.cells[]|select(.id=="apk-noarch-luci")' <<<"$p")
[ -n "$ov" ] || { echo "override cell missing"; exit 1; }
[ "$(jq -r '.dir' <<<"$ov")" = "snapshots/apk" ] && [ "$(jq -r '.override' <<<"$ov")" = "luci@$d" ] || { echo "override cell shape"; exit 1; }
[ "$(jq -c '[.build[].pkg]' <<<"$ov")" = '["luci-mod-dashboard"]' ] || { echo "override build"; exit 1; }
ov24=$(jq -c '.cells[]|select(.id=="opkg-noarch-luci")' <<<"$p")
[ "$(jq -r '.override' <<<"$ov24")" = "luci@$d24" ] || { echo "opkg override must use its own entry: $ov24"; exit 1; }
[ "$(jq -c '[.build[]|{pkg,ref}]' <<<"$ov24")" = "[{\"pkg\":\"luci-mod-dashboard\",\"ref\":\"$d24\"}]" ] || { echo "opkg override build: $ov24"; exit 1; }
[ "$(jq -c '.reuse' <<<"$apkn")" = '["alpha"]' ] || { echo "noarch reuse"; exit 1; }
[ "$(jq -r '.build[0]|has("changed")' <<<"$apkn")" = false ] || { echo "build entries must be plain specs"; exit 1; }
[ "$(jq -r '.build[0]|has("kind") or has("url")' <<<"$apkn")" = false ] || { echo "build entries must be raw action specs"; exit 1; }
[ "$(jq -r '.build[]|select(.pkg=="luci-mod-dashboard")|.repo' <<<"$ov")" = "file://$tmp/luci" ] || { echo "repo must be the resolved url"; exit 1; }
[ "$(jq -r '.build[]|select(.pkg=="luci-mod-dashboard")|.feed' <<<"$ov")" = luci ] || { echo "feed kept"; exit 1; }
[ "$(jq -r '.build[]|select(.pkg=="luci-mod-dashboard")|.ref' <<<"$ov")" = "$d" ] || { echo "spec ref"; exit 1; }

apka=$(jq -c '.cells[]|select(.id=="apk-aarch64_cortex-a53")' <<<"$p")
[ "$(jq -r '.dir' <<<"$apka")" = "snapshots/apk/aarch64_cortex-a53" ] || { echo "arch dir"; exit 1; }
[ "$(jq -c '[.build[].pkg]' <<<"$apka")" = '[]' ] || { echo "hello-arch unchanged on a53"; exit 1; }
[ "$(jq -c '.reuse' <<<"$apka")" = '["hello-arch"]' ] || { echo "a53 reuse"; exit 1; }
apkx=$(jq -c '.cells[]|select(.id=="apk-x86_64")' <<<"$p")
[ "$(jq -c '[.build[].pkg]' <<<"$apkx")" = '["hello-arch"]' ] || { echo "hello-arch must build on x86_64"; exit 1; }
[ "$(jq -r '.any_changed' <<<"$p")" = true ] || { echo "any_changed"; exit 1; }
[ "$(jq -r '[.cells[]|.id]|length' <<<"$p")" = 8 ] || { echo "8 cells: $(jq -c '[.cells[].id]' <<<"$p")"; exit 1; }
cat > "$tmp/badfmt.json" <<EOS
{"feed":"eamonxg","sdk":{"apk":"25.12.5"},"packages":[{"pkg":"a","repo":"file://$tmp/alpha","formats":["opkg"]}]}
EOS
if scripts/plan.sh "$tmp/badfmt.json" >/dev/null 2>&1; then echo "formats outside sdk keys must fail"; exit 1; fi
cat > "$tmp/dupfmt.json" <<EOS
{"feed":"eamonxg","sdk":{"apk":"25.12.5","opkg":"24.10.4"},"packages":[
  {"pkg":"a","repo":"file://$tmp/alpha"},{"pkg":"a","repo":"file://$tmp/beta","formats":["opkg"]}]}
EOS
if scripts/plan.sh "$tmp/dupfmt.json" >/dev/null 2>&1; then echo "a package twice in one format must fail"; exit 1; fi

p2=$(scripts/plan.sh "$tmp/packages.json")
[ "$(jq -r '.packages[]|select(.pkg=="alpha")|.changed.apk' <<<"$p2")" = true ] || { echo "no live manifest → all changed"; exit 1; }

cat > "$tmp/bad.json" <<EOS
{"feed":"eamonxg","sdk":{"apk":"25.12.5"},"arches":["x86_64"],
 "packages":[{"pkg":"a","repo":"file://$tmp/alpha","arch":["mips_24kc"]}]}
EOS
if scripts/plan.sh "$tmp/bad.json" >/dev/null 2>&1; then echo "arch outside arches must fail"; exit 1; fi
