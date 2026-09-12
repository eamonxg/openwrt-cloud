#!/usr/bin/env bash
set -euo pipefail
plan=$1 live=$2 base=$3 cache=$4
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
jq -c '.cells[]' "$plan" | while read -r cell; do
  dir=$(jq -r .dir <<<"$cell"); fmt=$(jq -r .fmt <<<"$cell")
  mkdir -p "$cache/$dir"
  case "$dir" in
    snapshots/*/*) arch=${dir##*/}; q=".arches[\"$arch\"][\"$fmt\"]" ;;
    *) q=".channels.snapshots[\"$fmt\"]" ;;
  esac
  jq -r '.reuse[]' <<<"$cell" | while read -r src; do
    jq -c "$q[]? | select(.source==\"$src\")" "$live" | while read -r ent; do
      f=$(jq -r .file <<<"$ent"); want=$(jq -r .sha256 <<<"$ent"); dst="$cache/$dir/$f"
      if [ -f "$dst" ] && [ "$(sha "$dst")" = "$want" ]; then continue; fi
      curl -fsS --retry 3 "$base/$dir/$f" -o "$dst"
      [ "$(sha "$dst")" = "$want" ] || { echo "fetch-unchanged: sha256 mismatch for $dir/$f" >&2; rm -f "$dst"; exit 1; }
    done
  done
done
