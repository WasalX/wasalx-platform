#!/usr/bin/env bash

require_tag_commit() {
  local tag_ref=$1 commit=$2 refs
  refs=$(git ls-remote --exit-code origin "$tag_ref" "${tag_ref}^{}") || return
  grep -Fxq -e "$commit"$'\t'"$tag_ref" -e "$commit"$'\t'"${tag_ref}^{}" <<< "$refs" || {
    echo '::error::Tag does not resolve to the workflow commit'
    return 1
  }
}

download_main_image_manifest() {
  local commit=$1 directory=$2 status run manifest_jobs
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || return 1
  status=$(gh api "repos/$GITHUB_REPOSITORY/compare/$commit...main" --jq .status) || return
  [[ "$status" == ahead || "$status" == identical ]] || { echo '::error::Commit is outside main'; return 1; }

  run=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml --branch main \
    --event push --commit "$commit" --status success --limit 1 \
    --json databaseId --jq '.[0].databaseId // empty') || return
  [[ "$run" =~ ^[0-9]+$ ]] || { echo '::error::No green main CI push run for the commit'; return 1; }

  manifest_jobs=$(gh run view "$run" --repo "$GITHUB_REPOSITORY" --json jobs \
    --jq '[.jobs[] | select(.name == "publish / Image digest manifest" and .conclusion == "success")] | length') || return
  [[ "$manifest_jobs" == 1 ]] || { echo '::error::No successful Image digest manifest job'; return 1; }
  gh run download "$run" --repo "$GITHUB_REPOSITORY" --name images-manifest --dir "$directory"
}
