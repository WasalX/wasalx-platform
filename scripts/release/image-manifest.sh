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
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || return 1
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
  local base=$1 directory=$2 candidates commit run jobs artifacts tree complete
  local manifest="$directory/images-manifest.json"
  require_main_ancestor "$base" >&2 || return
  candidates=$(git rev-list --first-parent --max-count=5 "$base") || return

  for commit in $candidates; do
    run=$(green_main_run "$commit") || return
    if [[ -z "$run" ]]; then
      echo "Nightly publication skipped $commit: no green main CI push run" >&2
      continue
    fi
    [[ "$run" =~ ^[0-9]+$ ]] || return 1
    jobs=$(successful_manifest_jobs "$run") || return
    if [[ "$jobs" == 0 ]]; then
      echo "Nightly publication skipped $commit: no successful Image digest manifest job" >&2
      continue
    fi
    [[ "$jobs" == 1 ]] || return 1
    artifacts=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run/artifacts?name=images-manifest" \
      --jq '[.artifacts[] | select(.expired == false)] | length') || return
    if [[ "$artifacts" == 0 ]]; then
      echo "Nightly publication skipped $commit: no available images-manifest artifact" >&2
      continue
    fi
    [[ "$artifacts" == 1 ]] || return 1

    gh run download "$run" --repo "$GITHUB_REPOSITORY" --name images-manifest --dir "$directory" >&2 || return
    tree=$(git rev-parse "$commit^{tree}") || return
    complete=$(jq -ers --arg commit "$commit" --arg tree "$tree" --arg repo "$GITHUB_REPOSITORY" \
      --slurpfile catalog scripts/release/product-images.json '
      if length == 1 and (.[0] | .schemaVersion == 1 and .repository == $repo and .platform == "linux/amd64"
          and .commit == $commit and .tree == $tree and (.images | type) == "object"
          and (((.images | keys) + (.pending | keys)) | sort) == ($catalog[0] | map(.image) | sort)
          and (.pending | type) == "object" and .publicationComplete == ((.pending | length) == 0))
      then .[0].publicationComplete | tostring
      else error("Invalid nightly publication manifest identity or completeness") end
    ' "$manifest") || return
    if [[ "$complete" == false ]]; then
      echo "Nightly publication skipped $commit: images-manifest is incomplete" >&2
      rm -- "$manifest" || return
      rm -f -- "$directory/images-manifest-attempt.json" || return
      continue
    fi

    if [[ "$commit" == "$base" ]]; then
      echo "Nightly uses $commit: requested base has a complete publication (run $run)" >&2
    else
      local warning="Nightly images come from $commit (run $run) because requested base $base has no complete green publication."
      printf '::warning::%s\n' "$warning" >&2
      if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
        printf '%s\n' "$warning" >> "$GITHUB_STEP_SUMMARY" || return
      fi
    fi
    printf '%s\n' "$commit"
    return
  done

  echo "::error::No complete green main publication for $base in up to five first-parent commits" >&2
  return 1
}
