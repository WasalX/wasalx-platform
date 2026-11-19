#!/usr/bin/env bash
set -euo pipefail

test "$GITHUB_REPOSITORY" = WasalX/wasalx-platform
test "$GITHUB_EVENT_NAME" = push
test "$GITHUB_REF" = "refs/tags/$GITHUB_REF_NAME"
[[ "$GITHUB_REF_NAME" =~ ^v[A-Za-z0-9_.-]{0,127}$ ]]

commit=$(git rev-parse HEAD)
refs=$(git ls-remote --exit-code origin "$GITHUB_REF" "${GITHUB_REF}^{}")
grep -q "^$commit[[:space:]]" <<< "$refs"
status=$(gh api "repos/$GITHUB_REPOSITORY/compare/$commit...main" --jq .status)
[[ "$status" == ahead || "$status" == identical ]] || { echo '::error::Tagged commit is outside main'; exit 1; }

run=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml --branch main \
  --event push --commit "$commit" --status success --limit 1 \
  --json databaseId --jq '.[0].databaseId // empty')
[[ "$run" =~ ^[0-9]+$ ]] || { echo '::error::No green main publication for the tagged commit'; exit 1; }
directory=$(mktemp -d "$RUNNER_TEMP/wasalx-release.XXXXXX")
gh run download "$run" --repo "$GITHUB_REPOSITORY" --name images-manifest --dir "$directory"
manifest="$directory/images-manifest.json"

echo 'c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74  '"$(command -v cosign)" | sha256sum --check --strict
python3 scripts/release/images-by-digest.py verify-publication --manifest "$manifest"

jq -er '.images[].pullReference' "$manifest" | while IFS= read -r ref; do
  alias="${ref%@*}:$GITHUB_REF_NAME"
  # Wrapping a single manifest in an index changes the digest.
  docker buildx imagetools create --prefer-index=false --tag "$alias" "$ref"
  actual=$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$alias")
  [[ "$actual" == "${ref#*@}" ]] || { echo "::error::Digest mismatch for $alias"; exit 1; }
done

flags=()
if [[ "$GITHUB_REF_NAME" == v*-rc.* ]]; then flags+=(--prerelease); fi
gh release create --repo "$GITHUB_REPOSITORY" --verify-tag --generate-notes "${flags[@]}" "$GITHUB_REF_NAME" "$manifest"
