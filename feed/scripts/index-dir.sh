#!/usr/bin/env bash
set -euo pipefail
dir=$1 fmt=$2 arch=$3 tools=$4
dir=$(cd "$dir" && pwd); tools=$(cd "$tools" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cd "$dir"
case "$fmt" in
  apk)
    ls ./*.apk >/dev/null 2>&1 || { echo "index-dir: no .apk in $dir" >&2; exit 1; }
    sign=()
    if [ -n "${APK_KEY:-}" ]; then printf '%s\n' "$APK_KEY" > "$tmp/private-key.pem"; sign=(--sign "$tmp/private-key.pem"); fi
    rm -f packages.adb
    "$tools/apk" mkndx --root "$tmp" --keys-dir "$tmp" --allow-untrusted "${sign[@]}" --output packages.adb ./*.apk
    "$tools/apk" adbdump --format json packages.adb | python3 "$tools/make-index-json.py" -f apk -a "$arch" - > index.json ;;
  opkg)
    ls ./*.ipk >/dev/null 2>&1 || { echo "index-dir: no .ipk in $dir" >&2; exit 1; }
    cat > "$tmp/mkhash" <<'EOS'
#!/usr/bin/env bash
if command -v sha256sum >/dev/null; then sha256sum "$2"; else shasum -a 256 "$2"; fi | cut -d' ' -f1
EOS
    chmod +x "$tmp/mkhash"
    MKHASH="$tmp/mkhash" bash "$tools/ipkg-make-index.sh" . 2>/dev/null > Packages.manifest
    grep -vE '^(Maintainer|LicenseFiles|Source|SourceName|Require|SourceDateEpoch)' Packages.manifest > Packages
    size=$(if stat -c %s Packages >/dev/null 2>&1; then stat -c %s Packages; else stat -f %z Packages; fi)
    case "$(((64 + size) % 128))" in 110|111) { echo ""; echo ""; } >> Packages ;; esac
    python3 "$tools/make-index-json.py" -f opkg -a "$arch" Packages > index.json
    gzip -9nc Packages > Packages.gz
    if [ -n "${USIGN_KEY:-}" ]; then
      printf '%s\n' "$USIGN_KEY" > "$tmp/key-build"
      "$tools/usign" -S -m Packages -s "$tmp/key-build" -x Packages.sig
    fi ;;
  *) echo "index-dir: unknown format $fmt" >&2; exit 1 ;;
esac
