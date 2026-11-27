#!/usr/bin/env bash
set -euo pipefail

test "$GITHUB_REPOSITORY" = WasalX/wasalx-platform
test "$GITHUB_EVENT_NAME" = push
test "$GITHUB_REF" = "refs/tags/$GITHUB_REF_NAME"
[[ "$GITHUB_REF_NAME" =~ ^v[A-Za-z0-9_.-]{0,127}$ ]]

source scripts/release/image-manifest.sh
commit=$(git rev-parse HEAD)
require_tag_commit "$GITHUB_REF" "$commit"
directory=$(mktemp -d "$RUNNER_TEMP/wasalx-release.XXXXXX")
download_main_image_manifest "$commit" "$directory"
manifest="$directory/images-manifest.json"

sha=$(jq -er '.linuxAmd64Sha256' scripts/release/cosign-pin.json)
binary=$(command -v cosign)
printf '%s  %s\n' "$sha" "$binary" | sha256sum --check --strict
python3 scripts/release/images-by-digest.py verify-publication --manifest "$manifest"

jq -er '.images[].pullReference' "$manifest" | while IFS= read -r ref; do
  alias="${ref%@*}:$GITHUB_REF_NAME"
  # Wrapping a single manifest in an index changes the digest.
  docker buildx imagetools create --prefer-index=false --tag "$alias" "$ref"
  # Buildx can print a summary for .Manifest templates. Hash the original bytes.
  actual=$(docker buildx imagetools inspect --raw "$alias" | sha256sum)
  actual="sha256:${actual%% *}"
  [[ "$actual" == "${ref#*@}" ]] || {
    printf '::error::Digest mismatch for %s (expected %s, got %s)\n' "$alias" "${ref#*@}" "$actual"
    exit 1
  }
done

if release=$(gh release view "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" --json tagName 2>&1); then
  gh release upload "$GITHUB_REF_NAME" "$manifest" --repo "$GITHUB_REPOSITORY" --clobber
elif [[ "$release" == 'release not found' ]]; then
  flags=()
  if [[ "$GITHUB_REF_NAME" == v*-rc.* ]]; then flags+=(--prerelease); fi
  gh release create --repo "$GITHUB_REPOSITORY" --verify-tag --generate-notes "${flags[@]}" "$GITHUB_REF_NAME" "$manifest"
else
  printf '%s\n' "$release" >&2
  exit 1
fi
