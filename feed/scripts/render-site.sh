#!/usr/bin/env bash
set -euo pipefail
site=$1 dist=$2 host=$3 fpr=$4 apk_fpr=$5
m="$dist/manifest.json"
[ -f "$m" ] || { echo "ERROR: $m missing — run gen-manifest.sh before render-site.sh" >&2; exit 1; }
pkgs=$(jq -r '[.channels.snapshots[][]] | map(.pkg) | unique | map(select(startswith("luci-i18n-")|not)) | join(" ")' "$m")
[ -n "$pkgs" ] || { echo "ERROR: no packages found in manifest.json" >&2; exit 1; }
arches=$(jq -r '.arches | keys | join(" ")' "$m")
fn="arch_extra() {
  case \"\$1\" in"
for a in $arches; do
  extra=$(jq -r --arg a "$a" '([.arches[$a][][]?.pkg] | unique | map(select(startswith("luci-i18n-")|not))) - ([.channels.snapshots[][].pkg] | unique) | join(" ")' "$m")
  fn="$fn
    $a) echo \"$extra\" ;;"
done
fn="$fn
    *) echo \"\" ;;
  esac
}"
cp "$site"/index.html "$site"/install.sh "$site"/_headers "$dist/"
mkdir -p "$dist/assets"; cp "$site"/assets/* "$dist/assets/"
for f in "$dist/index.html" "$dist/install.sh"; do
  sed -i.bak -e "s/__FEED_HOST__/$host/g" -e "s/__USIGN_FPR__/$fpr/g" -e "s|__APK_FPR__|$apk_fpr|g" \
    -e "s/__PACKAGES__/$pkgs/g" -e "s/__ARCHES__/$arches/g" "$f" && rm -f "$f.bak"
done
fnfile=$(mktemp); printf '%s\n' "$fn" > "$fnfile"
awk -v f="$fnfile" '$0=="__ARCH_PACKAGES__" { while ((getline line < f) > 0) print line; close(f); next } { print }' "$dist/install.sh" > "$dist/install.sh.new"
mv "$dist/install.sh.new" "$dist/install.sh"; rm -f "$fnfile"
if grep -l '__FEED_HOST__\|__USIGN_FPR__\|__APK_FPR__\|__PACKAGES__\|__ARCHES__\|__ARCH_PACKAGES__' "$dist/index.html" "$dist/install.sh"; then
  echo "ERROR: unsubstituted placeholders remain in dist" >&2; exit 1
fi
