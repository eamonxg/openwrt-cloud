#!/usr/bin/env bash
set -euo pipefail
fmt=$1 sdk=$2
if [ -n "${PLAN_ARCHES:-}" ]; then printf '%s\n' $PLAN_ARCHES; exit 0; fi
case "$sdk" in main|snapshot|snapshots) base=https://downloads.openwrt.org/snapshots ;; *) base=https://downloads.openwrt.org/releases/$sdk ;; esac
curl -fsS "$base/packages/" | grep -oE 'href="[a-z0-9_-]+/"' | sed 's/href="//;s/\/"//' | sort -u
