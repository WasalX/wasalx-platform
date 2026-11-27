#!/usr/bin/env bash

require_tag_commit() {
  local tag_ref=$1 commit=$2 refs
  refs=$(git ls-remote --exit-code origin "$tag_ref" "${tag_ref}^{}") || return
  grep -Fxq -e "$commit"$'\t'"$tag_ref" -e "$commit"$'\t'"${tag_ref}^{}" <<< "$refs" || {
    echo '::error::Tag does not resolve to the workflow commit'
    return 1
  }
}

require_main_ancestor() {
  local commit=$1 status
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo '::error::Expected a full main commit SHA'; return 1; }
  status=$(gh api "repos/$GITHUB_REPOSITORY/compare/$commit...main" --jq .status) || return
  [[ "$status" == ahead || "$status" == identical ]] || { echo '::error::Commit is outside main'; return 1; }
}

green_main_run() {
  local commit=$1
  gh run list --repo "$GITHUB_REPOSITORY" --workflow ci.yml --branch main \
    --event push --commit "$commit" --status success --limit 1 \
    --json databaseId --jq '.[0].databaseId // empty'
}

successful_manifest_jobs() {
  gh run view "$1" --repo "$GITHUB_REPOSITORY" --json jobs \
    --jq '[.jobs[] | select(.name == "publish / Image digest manifest" and .conclusion == "success")] | length'
}

download_main_image_manifest() {
  local commit=$1 directory=$2 run manifest_jobs
  require_main_ancestor "$commit" || return
  run=$(green_main_run "$commit") || return
  [[ "$run" =~ ^[0-9]+$ ]] || { echo '::error::No green main CI push run for the commit'; return 1; }
  manifest_jobs=$(successful_manifest_jobs "$run") || return
  [[ "$manifest_jobs" == 1 ]] || { echo '::error::No successful Image digest manifest job'; return 1; }
  gh run download "$run" --repo "$GITHUB_REPOSITORY" --name images-manifest --dir "$directory"
}

download_nightly_image_manifest() {
  local base=$1 directory=$2 mode=${3:-exact} candidates commit committed_at run jobs artifacts tree catalog complete reason summary
  local now cutoff examined=0
  local -r max_age_hours=24 max_commits=50
  local manifest="$directory/images-manifest.json"
  if [[ "$mode" == latest ]]; then
    now=$(date -u +%s) || return
    cutoff=$((now - max_age_hours * 60 * 60))
    # Take one shallow snapshot of main and bound the first-parent walk independently.
    git fetch --no-tags --depth="$max_commits" origin refs/heads/main >&2 || return
    candidates=$(git log --first-parent --max-count="$max_commits" --format='%H %ct' FETCH_HEAD) || return
  else
    require_main_ancestor "$base" >&2 || return
    candidates=$base
    if ! git cat-file -e "$base^{commit}"; then
      git fetch --no-tags --depth=1 origin "$base" >&2 || return
    fi
  fi

  while read -r commit committed_at; do
    examined=$((examined + 1))
    if [[ "$mode" == latest ]] && (( committed_at < cutoff || committed_at > now )); then
      continue
    fi
    run=$(green_main_run "$commit") || return
    if [[ -z "$run" ]]; then
      reason='no green main CI push run'
      echo "Nightly publication unavailable for $commit ($reason)" >&2
      continue
    fi
    [[ "$run" =~ ^[0-9]+$ ]] || return 1
    jobs=$(successful_manifest_jobs "$run") || return
    if [[ "$jobs" == 0 ]]; then
      reason='no successful Image digest manifest job'
      echo "Nightly publication unavailable for $commit ($reason)" >&2
      continue
    fi
    [[ "$jobs" == 1 ]] || return 1
    artifacts=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run/artifacts?name=images-manifest" \
      --jq '[.artifacts[] | select(.expired == false)] | length') || return
    if [[ "$artifacts" == 0 ]]; then
      reason='no available images-manifest artifact'
      echo "Nightly publication unavailable for $commit ($reason)" >&2
      continue
    fi
    [[ "$artifacts" == 1 ]] || return 1

    gh run download "$run" --repo "$GITHUB_REPOSITORY" --name images-manifest --dir "$directory" >&2 || return
    tree=$(git rev-parse "$commit^{tree}") || return
    catalog=$(git show "$commit:scripts/release/product-images.json") || return
    complete=$(jq -ers --arg commit "$commit" --arg tree "$tree" --arg repo "$GITHUB_REPOSITORY" \
      --argjson catalog "$catalog" '
      if length == 1 and (.[0] | .schemaVersion == 1 and .repository == $repo and .platform == "linux/amd64"
          and .commit == $commit and .tree == $tree and (.images | type) == "object"
          and (((.images | keys) + (.pending | keys)) | sort) == ($catalog | map(.image) | sort)
          and (.pending | type) == "object" and .publicationComplete == ((.pending | length) == 0))
      then .[0].publicationComplete | tostring
      else error("Invalid nightly publication manifest identity or completeness") end
    ' "$manifest") || return
    if [[ "$complete" == false ]]; then
      reason='images-manifest is incomplete'
      echo "Nightly publication unavailable for $commit ($reason)" >&2
      rm -- "$manifest" || return
      rm -f -- "$directory/images-manifest-attempt.json" || return
      continue
    fi

    if [[ "$mode" == latest ]]; then
      summary="Selected main publication $commit (run $run), skipped $((examined - 1)) newer commits."
    else
      summary="Exact main publication $commit is complete (run $run)."
    fi
    printf '%s\n' "$summary" >&2
    if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
      printf '%s\n' "$summary" >> "$GITHUB_STEP_SUMMARY" || return
    fi
    printf '%s\n' "$commit"
    return
  done <<< "$candidates"

  if [[ "$mode" == latest ]]; then
    summary="BLOCKED: No complete green main publication from the last $max_age_hours hours (searched up to $max_commits first-parent main commits)."
  else
    summary="BLOCKED: Exact main publication for $base is unavailable ($reason)."
  fi
  printf '::error::%s\n' "$summary" >&2
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$summary" >> "$GITHUB_STEP_SUMMARY" || return
  fi
  return 1
}
