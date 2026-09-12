#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/dist" "$tmp/site/assets"; echo a > "$tmp/site/assets/a.css"
cat > "$tmp/dist/manifest.json" <<'EOS'
{"generated":"t","feed":"eamonxg","sdk":{"apk":"25.12.5","opkg":"24.10.4"},"built":{"snapshots":{"apk":"t","opkg":"t"}},
 "channels":{"snapshots":{"apk":[{"pkg":"luci-theme-aurora"},{"pkg":"luci-i18n-aurora-config-de"},{"pkg":"luci-app-aurora-config"}],"opkg":[{"pkg":"luci-theme-aurora"}]}},
 "arches":{"aarch64_cortex-a53":{"apk":[{"pkg":"luci-theme-aurora"},{"pkg":"hello-arch"}],"opkg":[]},"x86_64":{"apk":[{"pkg":"luci-theme-aurora"}],"opkg":[]}}}
EOS
printf '<p>__FEED_HOST__ __PACKAGES__ __ARCHES__</p>\n' > "$tmp/site/index.html"
printf 'HOST="__FEED_HOST__"\nFPR="__USIGN_FPR__"\nALL="__PACKAGES__"\nARCHES="__ARCHES__"\n__ARCH_PACKAGES__\n' > "$tmp/site/install.sh"
printf '/x\n  A: b\n' > "$tmp/site/_headers"
scripts/render-site.sh "$tmp/site" "$tmp/dist" feed.example fpr123 SHA256:apk
grep -q 'ALL="luci-app-aurora-config luci-theme-aurora"' "$tmp/dist/install.sh" || { echo "packages: $(grep ALL= "$tmp/dist/install.sh")"; exit 1; }
grep -q 'ARCHES="aarch64_cortex-a53 x86_64"' "$tmp/dist/install.sh" || { echo "arches"; exit 1; }
grep -q '^arch_extra() {' "$tmp/dist/install.sh" || { echo "arch_extra fn"; exit 1; }
sed -n '/^arch_extra() {/,/^}/p' "$tmp/dist/install.sh" > "$tmp/fn.sh"
( . "$tmp/fn.sh"; [ "$(arch_extra aarch64_cortex-a53)" = "hello-arch" ] && [ -z "$(arch_extra x86_64)" ] && [ -z "$(arch_extra mips_24kc)" ] ) || { echo "arch_extra values"; exit 1; }
grep -q 'feed.example' "$tmp/dist/index.html" && ! grep -q '__' "$tmp/dist/index.html" && ! grep -q '__' "$tmp/dist/install.sh" || { echo "residue"; exit 1; }
