#!/usr/bin/env bash
set -euo pipefail

verified_asset_mirror() {
  local mirror="${BIN_MIRROR_BASE:-}" host port part
  [[ -n "$mirror" ]] || return 0
  [[ "$mirror" =~ ^https?://([A-Za-z0-9.-]+)(:([0-9]{1,5}))?/?$ ]] || return 1
  host="${BASH_REMATCH[1]}"; port="${BASH_REMATCH[3]}"
  [[ -z "$port" ]] || ((10#$port >= 1 && 10#$port <= 65535)) || return 1
  [[ ${#host} -le 253 ]] || return 1
  if [[ "$host" =~ ^[0-9.]+$ ]]; then
    [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    for part in ${host//./ }; do
      [[ "$part" =~ ^(0|[1-9][0-9]{0,2})$ ]] && ((10#$part <= 255)) || return 1
    done
  else
    [[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$ ]] || return 1
    for part in ${host//./ }; do
      [[ ${#part} -le 63 ]] || return 1
    done
  fi
  printf '%s\n' "${mirror%/}"
}
fetch_verified_asset() (
[[ $# == 3 && "$1" == https://* && -n "$2" && "$3" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'usage: fetch-verified-asset.sh <https-url> <output> <sha256>\n' >&2
  exit 2
}
url="$1"
output="$2"
expected="$3"
mirror="$(verified_asset_mirror)" || {
  printf 'invalid BIN_MIRROR_BASE: expected an HTTP(S) DNS/IPv4 origin\n' >&2
  exit 2
}
pending=$(mktemp "${output}.pending.XXXXXX")
trap 'rm -f "$pending"' EXIT

# A mirror miss is cheap; checksum failure is a trust failure, never a retry.
if [[ -z "$mirror" ]] || ! mirror_status=$(curl --proto '=http,https' --max-redirs 0 --fail --silent --show-error --retry 0 \
  --connect-timeout 3 --max-time 8 --write-out '%{http_code}' --output "$pending" "$mirror/${url#https://}") ||
  [[ ! "$mirror_status" =~ ^2[0-9]{2}$ ]]; then
  rm -f "$pending"
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --http1.1 \
    --fail --location --silent --show-error --retry 3 \
    --retry-delay 2 --retry-max-time 120 --connect-timeout 20 --max-time 120 \
    --output "$pending" "$url" || exit 1
fi
actual=$(if command -v sha256sum >/dev/null; then sha256sum "$pending"; else shasum -a 256 "$pending"; fi | awk '{print $1}')
[[ "$actual" == "$expected" ]] || {
  printf 'release asset failed pinned checksum verification: %s\n' "${url##*/}" >&2
  exit 2
}
mv -f "$pending" "$output"
)

# Node also sources the validator and fetcher; isolate the download's EXIT trap.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then fetch_verified_asset "$@"; fi
