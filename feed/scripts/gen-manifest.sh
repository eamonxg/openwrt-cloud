#!/usr/bin/env bash
set -euo pipefail
dist=$1 feed=$2 sdk_json=$3
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
entries() {
  [ -f "$1" ] || { printf '[]'; return; }
  jq -c '[.packages[] as $p | $p.files[] | {pkg:.name, version, file, size, sha256, arch, source:$p.pkg, ref:$p.ref}]' "$1"
}
fmts=$(jq -r 'keys[]' <<<"$sdk_json")
channels='{}'; built='{}'
for f in $fmts; do
  channels=$(jq -c --arg f "$f" --argjson e "$(entries "$dist/snapshots/$f/build-info.json")" '. + {($f):$e}' <<<"$channels")
  built=$(jq -c --arg f "$f" --arg t "$now" '. + {($f):$t}' <<<"$built")
done
arches='{}'
for d in "$dist"/snapshots/*/*/; do
  [ -d "$d" ] || continue
  a=$(basename "$d"); f=$(basename "$(dirname "$d")")
  arches=$(jq -c --arg a "$a" --arg f "$f" --argjson e "$(entries "$d/build-info.json")" '.[$a] = ((.[$a] // {}) + {($f):$e})' <<<"$arches")
done
jq -n --arg gen "$now" --arg feed "$feed" --argjson sdk "$sdk_json" --argjson built "$built" \
  --argjson ch "$channels" --argjson ar "$arches" \
  '{generated:$gen, feed:$feed, sdk:$sdk, built:{snapshots:$built}, channels:{snapshots:$ch}, arches:$ar}' \
  > "$dist/manifest.json"
