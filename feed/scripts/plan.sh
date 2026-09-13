#!/usr/bin/env bash
set -euo pipefail
cfg=$1 live=${2:-}
here=$(cd "$(dirname "$0")" && pwd)
die() { echo "plan: $*" >&2; exit 1; }

jq -e 'type=="object" and (.feed|type)=="string" and (.sdk|type)=="object" and (.packages|type)=="array"' "$cfg" >/dev/null || die "bad config shape"
jq -e '(keys - ["feed","sdk","arches","packages"]) == []' "$cfg" >/dev/null || die "unknown top-level key"
jq -e '.packages | all(.[]; (keys - ["pkg","repo","ref","feed","arch","langs","formats"]) == [] and has("pkg") and has("repo"))' "$cfg" >/dev/null || die "bad package entry"
jq -e --argjson F "$(jq -c '.sdk|keys' "$cfg")" '.packages | all(.[]; (has("formats")|not) or ((.formats|type)=="array" and (.formats - $F) == []))' "$cfg" >/dev/null || die "formats must be a subset of the sdk keys"
jq -e --argjson F "$(jq -c '.sdk|keys' "$cfg")" '[.packages[] | .pkg as $p | (.formats // $F)[] | "\(.)|\($p)"] | length == (unique|length)' "$cfg" >/dev/null || die "a package is listed twice for one format"

feed=$(jq -r .feed "$cfg")
fmts=$(jq -r '.sdk|keys[]' "$cfg")

resolve() {
  local url=$1 ref=$2 out
  if [ -z "$ref" ]; then out=$(git ls-remote "$url" HEAD | awk '{print $1}')
  elif [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then out=$ref
  else out=$(git ls-remote "$url" "refs/heads/$ref" "refs/tags/$ref" | awk '{print $1}' | head -n1); fi
  [ -n "$out" ] || die "cannot resolve $ref in $url"
  printf '%s' "$out"
}
url_of() { case "$1" in *://*|*@*:*) printf '%s' "$1" ;; *) printf 'https://github.com/%s.git' "$1" ;; esac; }

LIVE_SDK_JSON=$( { [ -n "$live" ] && [ -f "$live" ] && jq -c '.sdk // {}' "$live"; } || echo '{}')
present=$(jq -c --argjson sdk "$(jq -c .sdk "$cfg")" --argjson lsdk "$LIVE_SDK_JSON" '
  [ (.channels.snapshots // {} | to_entries[] | .key as $f | .value[]? | {f:$f, t:"noarch", e:.}),
    (.arches // {} | to_entries[] | .key as $a | .value | to_entries[] | .key as $f | .value[]? | {f:$f, t:$a, e:.}) ]
  | map(select(($sdk[.f] // "x") == ($lsdk[.f] // "y")))
  | map("\(.f)|\(.t)|\(.e.source // .e.pkg)|\(.e.ref // "")") | unique' \
  "$( [ -n "$live" ] && [ -f "$live" ] && echo "$live" || echo /dev/null )" 2>/dev/null || echo '[]')
[ -n "$present" ] || present='[]'

pkgs='[]'
while read -r e; do
  url=$(url_of "$(jq -r .repo <<<"$e")"); sha=$(resolve "$url" "$(jq -r '.ref // ""' <<<"$e")")
  pkgs=$(jq -c --arg u "$url" --arg s "$sha" --argjson e "$e" '
    . + [ ($e | (if has("feed") then "feed" else "repo" end) as $kind
          | {pkg, kind:$kind, url:$u, ref:$s} + (if $kind=="feed" then {feed} else {} end)
          + {arch:(.arch // "all"), langs:(.langs // []), formats:(.formats // null)}) ]' <<<"$pkgs")
done < <(jq -c '.packages[]' "$cfg")

arches=$(jq -r '.arches // empty | .[]' "$cfg" | sort -u)
if [ -z "$arches" ] && jq -e '.packages|any(.[]; (.arch // "all") != "all")' "$cfg" >/dev/null; then
  first=$(printf '%s\n' $fmts | head -n1)
  arches=$("$here/upstream-arches.sh" "$first" "$(jq -r --arg f "$first" '.sdk[$f]' "$cfg")" | sort -u)
fi
arches_json=$(printf '%s\n' $arches | jq -R . | jq -sc 'map(select(length>0))')
jq -e --argjson A "$arches_json" '.packages | all(.[]; ((.arch // "all")|type)!="array" or (.arch - $A) == [])' "$cfg" >/dev/null \
  || die "a package lists an arch outside the arches set"

cells='[]'
for f in $fmts; do
  sdk=$(jq -r --arg f "$f" '.sdk[$f]' "$cfg")
  cells=$(jq -c --arg f "$f" --arg sdk "$sdk" --argjson P "$pkgs" --argjson H "$present" '
    def infmt: select(.formats == null or (.formats|index($f)) != null);
    def fresh: ("\($f)|noarch|\(.pkg)|\(.ref)") as $k | ($H | index($k)) != null;
    def spec: {pkg, repo:.url, ref} + (if .kind=="feed" then {feed} else {} end) + {arch, langs};
    def ovkey: if .kind=="feed" then "\(.feed)@\(.ref)" else "" end;
    ([$P[] | infmt | select(.arch=="all")]) as $A
    | . + [{id:"\($f)-noarch", fmt:$f, sdk:$sdk, target:"noarch", arch:"x86_64", dir:"snapshots/\($f)", override:"",
            build:[$A[] | select(.kind!="feed" and (fresh|not)) | spec],
            reuse:[$A[] | select(fresh) | .pkg]}]
      + ([ $A[] | select(.kind=="feed" and (fresh|not)) | ovkey ] | unique
         | map(. as $k | {id:"\($f)-noarch-\($k|split("@")[0])", fmt:$f, sdk:$sdk, target:"noarch", arch:"x86_64", dir:"snapshots/\($f)", override:$k,
                          build:[$A[] | select(.kind=="feed" and ovkey==$k and (fresh|not)) | spec], reuse:[]}))' <<<"$cells")
  for a in $arches; do
    cells=$(jq -c --arg f "$f" --arg sdk "$sdk" --arg a "$a" --argjson P "$pkgs" --argjson H "$present" '
      def infmt: select(.formats == null or (.formats|index($f)) != null);
      def forarch: select(.arch=="any" or ((.arch|type)=="array" and (.arch|index($a))!=null));
      def fresh: ("\($f)|\($a)|\(.pkg)|\(.ref)") as $k | ($H | index($k)) != null;
      def spec: {pkg, repo:.url, ref} + (if .kind=="feed" then {feed} else {} end) + {arch, langs};
      def ovkey: if .kind=="feed" then "\(.feed)@\(.ref)" else "" end;
      ([$P[] | infmt | forarch]) as $A
      | . + [{id:"\($f)-\($a)", fmt:$f, sdk:$sdk, target:$a, arch:$a, dir:"snapshots/\($f)/\($a)", override:"",
              build:[$A[] | select(.kind!="feed" and (fresh|not)) | spec],
              reuse:[$A[] | select(fresh) | .pkg]}]
      + ([ $A[] | select(.kind=="feed" and (fresh|not)) | ovkey ] | unique
         | map(. as $k | {id:"\($f)-\($a)-\($k|split("@")[0])", fmt:$f, sdk:$sdk, target:$a, arch:$a, dir:"snapshots/\($f)/\($a)", override:$k,
                          build:[$A[] | select(.kind=="feed" and ovkey==$k and (fresh|not)) | spec], reuse:[]}))' <<<"$cells")
  done
done

pkgs=$(jq -c --argjson C "$cells" --argjson F "$(printf '%s\n' $fmts | jq -R . | jq -sc .)" '
  map(. as $p | . + {changed: ([$F[] as $f | {key:$f, value: ([$C[] | select(.fmt==$f) | .build[] | .pkg] | index($p.pkg) != null)}] | from_entries)})' <<<"$pkgs")

jq -n --arg feed "$feed" --argjson sdk "$(jq -c .sdk "$cfg")" --argjson A "$arches_json" \
  --argjson P "$pkgs" --argjson C "$cells" \
  '{feed:$feed, sdk:$sdk, arches:$A, packages:$P, cells:$C,
    any_changed:([$C[] | (.build|length>0)] | any)}'
