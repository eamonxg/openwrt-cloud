#!/usr/bin/env bash
set -euo pipefail
plan=$1 art=$2 cache=$3 live=$4 dist=$5

entries_from_live() {
  local dir=$1 fmt=$2 src=$3 q
  case "$dir" in snapshots/*/*) q=".arches[\"${dir##*/}\"][\"$fmt\"]" ;; *) q=".channels.snapshots[\"$fmt\"]" ;; esac
  jq -c --arg s "$src" "[ $q[]? | select(.source==\$s) ]
    | {pkg:\$s, kind:\"reused\", ref:(.[0].ref // \"\"), declared_arch:(.[0].arch // \"noarch\"),
       files: map({file, name:.pkg, version, arch, size, sha256})}" "$live"
}

cell_packages() {
  local cell=$1 dst=$2 id dir fmt
  id=$(jq -r .id <<<"$cell"); dir=$(jq -r .dir <<<"$cell"); fmt=$(jq -r .fmt <<<"$cell")
  if jq -e '.build|length>0' <<<"$cell" >/dev/null; then
    [ -f "$art/$id/build-info.json" ] || { echo "assemble: missing artifact for $id" >&2; exit 1; }
    jq -c '.packages[]' "$art/$id/build-info.json" | while read -r p; do
      jq -r '.files[].file' <<<"$p" | while read -r f; do cp -f "$art/$id/$f" "$dst/"; done
      printf '%s\n' "$p"
    done
  fi
  jq -r '.reuse[]' <<<"$cell" | while read -r src; do
    p=$(entries_from_live "$dir" "$fmt" "$src")
    jq -r '.files[].file' <<<"$p" | while read -r f; do cp -f "$cache/$dir/$f" "$dst/"; done
    printf '%s\n' "$p"
  done
}

jq -c '.cells[]' "$plan" | while read -r cell; do
  dir=$(jq -r .dir <<<"$cell"); fmt=$(jq -r .fmt <<<"$cell"); target=$(jq -r .target <<<"$cell"); sdk=$(jq -r .sdk <<<"$cell")
  dst="$dist/$dir"; rm -rf "$dst"; mkdir -p "$dst"
  pk=$(cell_packages "$cell" "$dst")
  if [ "$target" != noarch ]; then
    noarch=$(jq -c --arg f "$fmt" '.cells[] | select(.fmt==$f and .target=="noarch")' "$plan")
    pk="$pk"$'\n'"$(cell_packages "$noarch" "$dst")"
  fi
  printf '%s\n' "$pk" | grep -v '^$' | jq -sc --arg sdk "$sdk" --arg a "$target" --arg t "$fmt" \
    '{sdk:$sdk, arch:$a, pkg_type:(if $t=="opkg" then "ipk" else "apk" end), packages:.}' > "$dst/build-info.json"
done
