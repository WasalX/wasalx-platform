#!/usr/bin/env bash
set -euo pipefail

if [[ "${RUNNER_OS}/${RUNNER_ARCH}" != Linux/X64 ]]; then exit 0; fi
[[ "$NODE_VERSION" == 22.23.4 ]]
transform='flags=rh;s,^[^/]*/*$,.,;s,^[^/]*/,,'
checksum=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406
source "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/release/fetch-verified-asset.sh"
verified_asset_mirror >/dev/null || {
  printf 'invalid BIN_MIRROR_BASE: expected an HTTP(S) DNS/IPv4 origin\n' >&2
  exit 2
}
# RUNNER_TEMP is job-owned; repeated action calls in one job are sequential.
[[ -d "$RUNNER_TEMP" && ! -L "$RUNNER_TEMP" && -O "$RUNNER_TEMP" ]]
job_root="$(cd "$RUNNER_TEMP" && pwd -P)"
parent="$job_root/wasalx-node-$NODE_VERSION"
[[ ! -L "$parent" && ( ! -e "$parent" || -O "$parent" ) ]]
mkdir -p "$parent"
cache="$parent/x64"
retained="${cache}.tar.gz"
archive=""
stage=""
trap 'if [[ -n "$archive" ]]; then rm -f "$archive"; fi; if [[ -n "$stage" ]]; then rm -rf "$stage"; fi' EXIT

verified_tree() {
  local tree="$1" tarball="$2" comparison status=0 nonownership expected actual
  [[ -d "$tree" && ! -L "$tree" && -f "$tree/bin/node" && ! -L "$tree/bin/node" && -f "$tarball" && ! -L "$tarball" ]] || return 1
  printf '%s  %s\n' "$checksum" "$tarball" | sha256sum --check --status || return 1
  comparison="$(LC_ALL=C tar --compare --gzip --file "$tarball" --transform "$transform" --directory "$tree" 2>&1)" || status=$?
  if (( status != 0 )); then
    [[ "$status" == 1 && -n "$comparison" ]] || return 1
    # Only archive UID/GID may differ; bytes, links, modes and timestamps must match.
    nonownership="$(printf '%s\n' "$comparison" | sed -E '/: (Uid|Gid) differs$/d')" || return 1
    [[ -z "$nonownership" ]] || return 1
  fi
  expected="$(tar --list --gzip --file "$tarball" --strip-components=1 --show-transformed-names | sed -E 's:/$::; /^$/d' | LC_ALL=C sort)" || return 1
  actual="$(find "$tree" -mindepth 1 -printf '%P\n' | LC_ALL=C sort)" || return 1
  [[ "$expected" == "$actual" ]]
}

# Repair only the exact owned job entry; never remove a redirected/foreign path.
for entry in "$cache" "${cache}.complete" "$retained"; do
  [[ ! -L "$entry" && ( ! -e "$entry" || -O "$entry" ) ]]
done
if [[ -d "$cache" ]]; then
  ownership="$(find "$cache" ! -uid "$(id -u)" -print -quit)"
  [[ -z "$ownership" ]]
fi
publish_marker=false
if [[ -f "${cache}.complete" ]] && verified_tree "$cache" "$retained"; then
  printf '::notice::Verified warm job Node cache: %s\n' "$cache"
else
  [[ "$cache" == "$job_root/wasalx-node-$NODE_VERSION/x64" ]]
  rm -rf -- "$cache" "${cache}.complete" "$retained"
  archive="$(mktemp "$parent/.wasalx-node.XXXXXX.tar.gz")"
  prewarmed=false
  # Canonical caches are read-only inputs; even an exact hit is extracted locally.
  if [[ -n "${RUNNER_TOOL_CACHE:-}" && -d "$RUNNER_TOOL_CACHE" && ! -L "$RUNNER_TOOL_CACHE" ]] &&
    global_root="$(cd "$RUNNER_TOOL_CACHE" && pwd -P)"; then
    global_cache="$global_root/node/$NODE_VERSION/x64"
    if [[ ! -L "$global_root/node" && ! -L "$global_root/node/$NODE_VERSION" && -f "${global_cache}.complete" && ! -L "${global_cache}.complete" ]] &&
      verified_tree "$global_cache" "${global_cache}.tar.gz" && cp "${global_cache}.tar.gz" "$archive"; then
      prewarmed=true
      printf '::notice::Verified read-only prewarmed Node input: %s\n' "$global_cache"
    fi
  fi
  if [[ "$prewarmed" != true ]]; then
    fetch_verified_asset "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" "$archive" "$checksum"
  fi
  printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status
  stage="$(mktemp -d "$parent/.wasalx-node.XXXXXX")"
  tar --extract --gzip --file "$archive" --transform "$transform" --directory "$stage" --no-same-owner --same-permissions
  mv -T "$stage" "$cache"
  stage=""
  mv -T "$archive" "$retained"
  archive=""
  publish_marker=true
fi
node_bin="$(realpath "$cache/bin/node")"
[[ "$node_bin" == "$cache/bin/node" && -x "$node_bin" ]]
node_version="$("$node_bin" --version)"
[[ "$node_version" == "v$NODE_VERSION" ]]
if [[ "$publish_marker" == true ]]; then touch "${cache}.complete"; fi
printf '%s/bin\n' "$cache" >> "$GITHUB_PATH"
printf 'WASALX_NODE_BIN=%s\n' "$node_bin" >> "$GITHUB_ENV"
printf 'Node command: %s\nNode realpath: %s\n' "$node_bin" "$(realpath "$node_bin")"
