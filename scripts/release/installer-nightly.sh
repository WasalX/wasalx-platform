#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "$GITHUB_ACTIONS" == true && "$RUNNER_ENVIRONMENT" == github-hosted ]]
work="$RUNNER_TEMP/wasalx-nightly"
project=wasalx-nightly
full_env="$work/full.env"
diagnostics="$work/diagnostics"
compose=(docker compose --env-file "$full_env" -f compose.yaml -f compose.full.yaml
  -f scripts/release/installer-nightly.compose.yaml --profile full --profile runtime-workers --project-name "$project")
mkdir -p "$diagnostics"

inventory() {
  docker ps --all --no-trunc --filter "label=com.docker.compose.project=$project" \
    --format '{{.Label "com.docker.compose.service"}} {{.ID}}' | LC_ALL=C sort
}

if [[ "${1:-}" == cleanup ]]; then
  [[ -f "$full_env" ]] || exit 0
  docker ps --all --filter "label=com.docker.compose.project=$project" \
    --format '{{.Label "com.docker.compose.service"}} {{.Status}}' > "$diagnostics/containers.log" || true
  status=0
  timeout 3m "${compose[@]}" down --volumes --remove-orphans > "$work/teardown.raw" 2>&1 || status=$?
  commit=$(git rev-parse HEAD)
  verifier="$project-migration-input-${commit:0:12}"
  if docker container inspect "$verifier" >/dev/null 2>&1; then
    docker rm --force "$verifier" >/dev/null || status=$?
  fi
  if ! remaining=$(inventory) || [[ -n "$remaining" ]]; then
    status=1
  fi
  printf 'teardown exit=%s\n' "$status" | tee -a "$diagnostics/phases.log"
  exit "$status"
fi

phase() {
  local name=$1 limit=$2 started=$SECONDS status=0
  shift 2
  timeout "$limit" "$@" > "$work/$name.raw" 2>&1 || status=$?
  printf '%s exit=%s elapsed=%ss\n' "$name" "$status" "$((SECONDS - started))" | tee -a "$diagnostics/phases.log"
  # Copy only installer control messages, never an env file, Compose logs or inspect payloads.
  grep -E '^remote full stage [a-z-]+ (passed \(operator authentication/live acceptance separate\)|failed; inspect before retry)$|^remote full stage [a-z-]+ reason: assertion failed at [a-z-]+\.mjs:[0-9]+$|^unrecreatable fields: \[("[a-zA-Z0-9_.-]+"(,|\]))+$' \
    "$work/$name.raw" >> "$diagnostics/installer.log" || true
  return "$status"
}

resources() {
  local name=$1
  {
    echo "$name"
    df -Pm "$PWD" "$(docker info --format '{{.DockerRootDir}}')"
    free -m
    docker system df
  } | tee -a "$diagnostics/resources.log"
}

export WASALX_INSTALL_EXPECTED_HOSTNAME
WASALX_INSTALL_EXPECTED_HOSTNAME=$(hostname)
export DOCKER_CONFIG="$work/docker"
mkdir -p "$DOCKER_CONFIG"
commit=$(git rev-parse HEAD)
tree=$(git rev-parse 'HEAD^{tree}')
test -z "$(inventory)"
test -z "$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project")"
test -z "$(docker network ls --quiet --filter "label=com.docker.compose.project=$project")"
printf 'installer=%s tree=%s images=%s\n' "$commit" "$tree" "$MAIN_SHA" | tee -a "$diagnostics/phases.log"
resources baseline
if (( $(sysctl -n vm.max_map_count) < 1048576 )); then
  sudo sysctl -w vm.max_map_count=1048576
fi

phase fixture 30s python3 scripts/release/generate-simulation-env.py "$PWD" "$full_env" \
  scripts/contracts/waha-simulation-server.mjs --installer-rehearsal
phase bundles 5m python3 -B scripts/release/images-by-digest.py stage-hosted-bundles --manifest "$work/images-manifest.json"
stage=(--env-file "$full_env" --project-name "$project" --rehearsal-main "$MAIN_SHA")
manifest_hash=$(sha256sum "$work/images-manifest.json" | cut -d ' ' -f 1)
hosted=(--hosted-images "$work/images-manifest.json" --hosted-images-sha256 "$manifest_hash"
  --hosted-trusted-root "$TRUSTED_ROOT")
installer=(node scripts/release/installer-stages.mjs)
phase fresh-preflight 2m "${installer[@]}" preflight "${stage[@]}" --capture-preimage
phase preload 10m "${installer[@]}" preload-hosted "${stage[@]}" "${hosted[@]}"
resources preloaded
phase admission 5m "${installer[@]}" admit-hosted "${stage[@]}" "${hosted[@]}"

smoke() {
  phase "$1" 3m "${installer[@]}" smoke "${stage[@]}" "${hosted[@]}"
  mv "output/release-evidence/$commit/nightly-stack.json" "$work/$1.json"
}

phase fresh-install 10m "${installer[@]}" replace "${stage[@]}" "${hosted[@]}" --drained
smoke fresh-smoke
inventory > "$work/fresh.ids"
test -s "$work/fresh.ids"
resources installed

# The first install passed smoke and has no incoming traffic or provider sessions.
phase reinstall 8m "${installer[@]}" replace "${stage[@]}" "${hosted[@]}" --drained --retry-reviewed
smoke reinstall-smoke
inventory > "$work/reinstalled.ids"
diff -u "$work/fresh.ids" "$work/reinstalled.ids" > "$diagnostics/reinstall.diff"

# Capture from a clean candidate separate from the running Compose input tree.
preflight="$work/preflight"
git worktree add --detach "$preflight" "$commit"
(
  cd "$preflight"
  phase native-preflight 5m sudo env "PATH=$PATH" GITHUB_ACTIONS=true \
    "WASALX_INSTALL_EXPECTED_HOSTNAME=$WASALX_INSTALL_EXPECTED_HOSTNAME" \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory "GIT_CONFIG_VALUE_0=$preflight" \
    "${installer[@]}" preflight "${stage[@]}" --capture-preimage
)

printf '\nWASALX_FULL_GRAFANA_ADMIN_USER=nightly-recreated\n' >> "$full_env"
phase configured-reinstall 8m "${installer[@]}" replace "${stage[@]}" "${hosted[@]}" --drained --retry-reviewed
smoke configured-smoke
inventory > "$work/configured.ids"
diff -u <(cut -d ' ' -f 1 "$work/reinstalled.ids") <(cut -d ' ' -f 1 "$work/configured.ids")
LC_ALL=C join "$work/reinstalled.ids" "$work/configured.ids" | awk '$2 != $3 { print $1 }' | tee "$diagnostics/recreated.log"
diff -u <(printf '%s\n' grafana) "$diagnostics/recreated.log"
resources recreated
{
  echo '### Installer rehearsal'
  echo '```text'
  cat "$diagnostics/phases.log" "$diagnostics/resources.log"
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
