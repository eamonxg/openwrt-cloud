#!/usr/bin/env bash
set -euo pipefail
base=$1 fmt=$2 dir=$3 tools=$4 pub=$5; shift 5
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
tools=$(cd "$tools" && pwd)
headers_ok() {
  [ -z "${VERIFY_SKIP_HEADERS:-}" ] || return 0
  curl -fsSI "$base/$dir/$1" -o "$tmp/h"
  grep -qi '^content-type: application/octet-stream' "$tmp/h" || { echo "verify-feed: $dir/$1 content-type wrong" >&2; exit 1; }
  ! grep -qi '^content-encoding:' "$tmp/h" || { echo "verify-feed: $dir/$1 has content-encoding" >&2; exit 1; }
}
case "$fmt" in
  apk)
    command -v wget >/dev/null || { echo "verify-feed: apk fetches through wget, which is missing" >&2; exit 1; }
    root="$tmp/root"; mkdir -p "$root/etc/apk/keys" "$root/lib/apk/db"
    cp "$pub" "$root/etc/apk/keys/$(basename "$pub")"
    echo "$base/$dir/packages.adb" > "$root/etc/apk/repositories"
    a=("$tools/apk" --root "$root" --arch x86_64 --keys-dir "$root/etc/apk/keys" --no-cache)
    "${a[@]}" add --initdb --usermode >/dev/null
    "${a[@]}" update >/dev/null
    for p in "$@"; do
      "${a[@]}" list "$p" | grep -q "^$p-" || { echo "verify-feed: $p not in $dir index" >&2; exit 1; }
    done
    headers_ok packages.adb ;;
  opkg)
    curl -fsS "$base/$dir/Packages" -o "$tmp/Packages"
    curl -fsS "$base/$dir/Packages.gz" -o "$tmp/Packages.gz"; gunzip -t "$tmp/Packages.gz"
    curl -fsS "$base/$dir/Packages.sig" -o "$tmp/Packages.sig"
    "$tools/usign" -V -m "$tmp/Packages" -p "$pub" -x "$tmp/Packages.sig" >/dev/null || { echo "verify-feed: signature check failed for $dir" >&2; exit 1; }
    for p in "$@"; do grep -q "^Package: $p\$" "$tmp/Packages" || { echo "verify-feed: $p not in $dir index" >&2; exit 1; }; done
    headers_ok Packages.gz ;;
  *) echo "verify-feed: unknown format $fmt" >&2; exit 1 ;;
esac
echo "verify-feed: $dir ok ($*)"
