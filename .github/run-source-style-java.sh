#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2026 WasalX
set -euo pipefail

url=$1
digest=$2
shift 2
cache=${PRE_COMMIT_HOME:-${XDG_CACHE_HOME:-"$HOME/.cache"}/pre-commit}/java
jar="$cache/$digest/${url##*/}"
mkdir -p "$cache/$digest"
if [[ ! -f "$jar" ]] || ! printf '%s  %s\n' "$digest" "$jar" | shasum -a 256 --check --status; then
  bash scripts/release/fetch-verified-asset.sh "$url" "$jar" "$digest"
fi

java_home=${JAVA_HOME_21_X64:-${JAVA_HOME:-}}
exec "${java_home:+$java_home/bin/}java" -jar "$jar" "$@"
