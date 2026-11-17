#!/usr/bin/env bash
set -euo pipefail

[[ "${RUNNER_OS:-}" == Linux && "${RUNNER_ARCH:-}" == X64 ]] || {
  printf 'Skipping Buildx cache preparation; retain the pinned action on this platform\n' >&2
  exit 0
}
version="${BUILDX_VERSION#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$BUILDX_LINUX_AMD64_SHA256" =~ ^[0-9a-f]{64}$ && "$RUNNER_TOOL_CACHE" == /* ]] || exit 2
[[ "$RUNNER_TEMP" == /* && -d "$RUNNER_TEMP" && ! -L "$RUNNER_TEMP" && -O "$RUNNER_TEMP" && -n "$GITHUB_OUTPUT" ]] || exit 2
job_temp=$(cd "$RUNNER_TEMP" && pwd -P)
[[ "$job_temp" != *$'\n'* && "$job_temp" != *$'\r'* && "$job_temp" != *'"'* && "$job_temp" != *'\'* ]] || exit 2

# The shared cache is read-only input, never the action's execution handoff.
tool_root=$(realpath -m "$RUNNER_TOOL_CACHE")
shared="$tool_root/buildx-dl-bin/$version/linux-x64"
[[ "$(realpath -m "$shared")" == "$shared" ]] || exit 2
[[ ! -L "$shared" && ! -L "$shared/docker-buildx" && ! -L "$shared.complete" ]] || exit 2
if [[ -e "$shared" || -e "$shared.complete" ]]; then
  [[ -d "$shared" && -f "$shared/docker-buildx" && -f "$shared.complete" ]] || exit 2
  printf '%s  %s\n' "$BUILDX_LINUX_AMD64_SHA256" "$shared/docker-buildx" | sha256sum --check --status || exit 2
fi

umask 077
job_cache=$(mktemp -d "$job_temp/wasalx-buildx-cache.XXXXXX")
[[ "$job_cache" == "$job_temp"/wasalx-buildx-cache.* && "$(realpath -e "$job_cache")" == "$job_cache" ]] || exit 2
published=false
trap 'if [[ "$published" != true ]]; then rm -rf -- "$job_cache"; fi' EXIT
if [[ -f "$shared.complete" ]]; then
  cp -- "$shared/docker-buildx" "$job_cache/docker-buildx"
else
  bash "$(dirname "${BASH_SOURCE[0]}")/fetch-verified-asset.sh" \
    "https://github.com/docker/buildx/releases/download/v$version/buildx-v$version.linux-amd64" \
    "$job_cache/docker-buildx" "$BUILDX_LINUX_AMD64_SHA256"
fi

# Matches the pinned action's toolkit 0.63.0 protocol in an exclusive job cache.
cache="$job_cache/buildx-dl-bin/$version/linux-x64"
binary="$cache/docker-buildx"
mkdir -p "$(dirname "$cache")"
mkdir "$cache" # A lost claim fails; never adopt another writer's bytes.
mv -- "$job_cache/docker-buildx" "$binary"
chmod 0755 "$binary"
(set -o noclobber; : > "$cache.complete")
[[ "$(realpath -e "$cache")" == "$cache" && ! -L "$binary" && -f "$binary" && ! -L "$cache.complete" && -f "$cache.complete" ]] || exit 2
printf '%s  %s\n' "$BUILDX_LINUX_AMD64_SHA256" "$binary" | sha256sum --check --status || exit 2
# The runner overwrites reserved RUNNER_* step env before starting JS actions.
# A job-owned preload selects this cache before the pinned action's first import.
printf '%s\n' 'process.env.RUNNER_TOOL_CACHE = __dirname;' > "$job_cache/tool-cache.cjs"
printf 'tool-cache=%s\n' "$job_cache" >> "$GITHUB_OUTPUT"
printf 'node-options=--require="%s/tool-cache.cjs"\n' "$job_cache" >> "$GITHUB_OUTPUT"
published=true # RUNNER_TEMP cleanup owns this entry after the action finishes.
