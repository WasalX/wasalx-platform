#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

failure() {
  printf 'command=%s exit=%s reason=%s\n' "$2" "$1" "$3" >&2
}

# BASH_COMMAND is the checked-in shell expression, with no expanded arguments.
trap 'failure "$?" "$BASH_COMMAND" "rehearsal command failed at line $LINENO"' ERR

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  failure 1 'bash scripts/release/installer-nightly.sh' 'requires a GitHub-hosted Actions runner'
  exit 1
fi
work="$RUNNER_TEMP/wasalx-nightly"
project=wasalx-nightly
full_env="$work/full.env"
diagnostics="$work/diagnostics"
candidate_compose=(docker compose --env-file "$full_env" -f compose.yaml -f compose.full.yaml
  --profile full --profile runtime-workers --project-name "$project")
compose=("${candidate_compose[@]}" -f scripts/release/installer-nightly.compose.yaml)
mkdir -p "$diagnostics"

inventory() {
  docker ps --all --no-trunc --filter "label=com.docker.compose.project=$project" \
    --format '{{.Label "com.docker.compose.service"}} {{.ID}}' | LC_ALL=C sort
}

if [[ "${1:-}" == cleanup ]]; then
  [[ -f "$full_env" ]] || exit 0
  status=0
  docker ps --all --filter "label=com.docker.compose.project=$project" \
    --format '{{.Label "com.docker.compose.service"}} {{.Status}}' > "$diagnostics/containers.log" || {
    status=$?
    failure "$status" 'docker ps' 'cannot record rehearsal containers before teardown'
  }
  timeout 3m "${compose[@]}" down --volumes --remove-orphans > "$work/teardown.raw" 2>&1 || {
    status=$?
    failure "$status" 'docker compose down --volumes --remove-orphans' 'disposable stack teardown failed'
  }
  commit=$(git rev-parse HEAD)
  verifier="$project-migration-input-${commit:0:12}"
  if docker container inspect "$verifier" >/dev/null 2>&1; then
    docker rm --force "$verifier" >/dev/null || {
      status=$?
      failure "$status" 'docker rm --force' 'migration verifier teardown failed'
    }
  fi
  if remaining=$(inventory); then
    if [[ -n "$remaining" ]]; then
      status=1
      failure "$status" 'docker ps' 'rehearsal containers remain after teardown'
    fi
  else
    status=$?
    failure "$status" 'docker ps' 'cannot verify the rehearsal containers were removed'
  fi
  printf 'teardown exit=%s\n' "$status" | tee -a "$diagnostics/phases.log"
  exit "$status"
fi

phase() {
  local name=$1 limit=$2 started=$SECONDS status=0 command reason arg
  shift 2
  command=$1
  case "$1" in
    node) command="$1 $2" ;;
    python3)
      for arg in "${@:2}"; do
        if [[ "$arg" == scripts/*.py ]]; then
          command="$1 $arg"
          break
        fi
      done
      ;;
    docker) command='docker compose' ;;
  esac
  timeout "$limit" "$@" > "$work/$name.raw" 2>&1 || status=$?
  printf '%s exit=%s elapsed=%ss\n' "$name" "$status" "$((SECONDS - started))" | tee -a "$diagnostics/phases.log"
  # Copy only installer control messages, never an env file, Compose logs or inspect payloads.
  sed -nE '/^remote full stage [a-z-]+ (passed \(operator authentication\/live acceptance separate\)|failed; inspect before retry|reason: [[:print:]]+)$/p;
    /^remote full qualification reason: [[:print:]]+$/p;
    /^flock: cannot open lock file \/tmp\/wasalx-compose-stage\.lock: [[:print:]]+$/p;
    /^unrecreatable fields: \[("[a-zA-Z0-9_.-]+"(,|\]))+$/p;
    /^hosted bundle staging reason: [[:print:]]+$/p' "$work/$name.raw" >> "$diagnostics/installer.log"
  if [[ "$name" == native-preflight ]]; then
    sed -nE '/^native docker diff service=[a-z0-9][a-z0-9_-]{0,62} elapsed=[0-9]+ms$/p' \
      "$work/$name.raw" | tee -a "$diagnostics/installer.log"
    if (( status != 0 )); then
      sed -nE '/^native docker diff service=[a-z0-9][a-z0-9_-]{0,62} (started|elapsed=[0-9]+ms)$/p' \
        "$work/$name.raw" | tail -n 1 | sed -n '/ started$/p' | tee -a "$diagnostics/installer.log"
    fi
  fi
  if (( status != 0 )); then
    reason=$(sed -nE '/^probe-scan error=(Error|AssertionError|SyntaxError|TypeError|RangeError) message=[[:print:]]{1,480}$/p;
      /^remote full (stage [a-z-]+|qualification) reason: [[:print:]]+$/p;
      /^flock: cannot open lock file \/tmp\/wasalx-compose-stage\.lock: [[:print:]]+$/p;
      /^hosted bundle staging reason: [[:print:]]+$/p' "$work/$name.raw" | tail -n 1)
    if (( status == 124 )); then
      reason="stage exceeded its $limit deadline${reason:+ ($reason)}"
    fi
    failure "$status" "$command ($name)" "${reason:-stage failed without a redacted child diagnostic}"
    exit "$status"
  fi
}

if [[ "${1:-}" == stage-bundles ]]; then
  phase bundles 5m python3 -I -B scripts/release/installer-hosted-bundles.py "$work/images-manifest.json"
  exit 0
fi

resources() {
  local name=$1
  {
    echo "$name"
    local docker_root
    docker_root=$(docker info --format '{{.DockerRootDir}}')
    df -Pm "$PWD" "$docker_root"
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
containers=$(inventory)
volumes=$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project")
networks=$(docker network ls --quiet --filter "label=com.docker.compose.project=$project")
if [[ -n "$containers$volumes$networks" ]]; then
  failure 1 'docker ps / docker volume ls / docker network ls' 'rehearsal project already has resources'
  exit 1
fi
printf 'installer=%s tree=%s images=%s\n' "$commit" "$tree" "$MAIN_SHA" | tee -a "$diagnostics/phases.log"
resources baseline
map_count=$(sysctl -n vm.max_map_count)
if (( map_count < 1048576 )); then
  sudo sysctl -w vm.max_map_count=1048576
fi

# Sticky /tmp rejects flock's O_CREAT when neither the caller nor /tmp owns the file.
lock_path=$(jq -er '.lockPath' scripts/release/compose-stage-config.json)
phase initialize-lock 30s sudo sh -c 'umask 022; set -C; : > "$1"' sh "$lock_path"
phase runner-lock 30s flock --nonblock "$lock_path" true
phase root-lock 30s sudo flock --nonblock "$lock_path" true

phase fixture 30s python3 scripts/release/generate-simulation-env.py "$PWD" "$full_env" \
  scripts/contracts/waha-simulation-server.mjs --installer-rehearsal
if ! git diff --quiet "$MAIN_SHA" "$commit" -- Dockerfile.foundation-keycloak compose.full.yaml \
    scripts/release/patch-keycloak-jackson.py infra/docker/full/keycloak/; then
  # The signed main image set stays intact. Bootstrap the PR-built image with the ordinary Compose command.
  phase candidate-keycloak-build 8m "${candidate_compose[@]}" build keycloak
  phase candidate-keycloak-bootstrap 5m "${candidate_compose[@]}" up --no-build \
    --abort-on-container-exit --exit-code-from keycloak-bootstrap keycloak-bootstrap
  phase candidate-keycloak-teardown 3m "${candidate_compose[@]}" down --volumes
  containers=$(inventory)
  test -z "$containers"
fi
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
node scripts/release/installer-nightly-grafana.mjs "${compose[@]:1}"
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
(
  umask 022
  git worktree add --detach "$preflight" "$commit"
)
(
  cd "$preflight"
  phase native-preflight 5m sudo -H env "PATH=$PATH" GITHUB_ACTIONS=true \
    "WASALX_INSTALL_EXPECTED_HOSTNAME=$WASALX_INSTALL_EXPECTED_HOSTNAME" \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory "GIT_CONFIG_VALUE_0=$preflight" \
    "${installer[@]}" preflight "${stage[@]}" --capture-preimage

  # Nightly uses the ordinary replace path, whose actual held set is empty.
  phase probe-scan 5m sudo -H env "PATH=$PATH" node scripts/dev-install/probe.mjs \
    --env-file "$full_env" --project-name "$project" --compose-file scripts/release/installer-nightly.compose.yaml --held-services ''
  jq -e '.census == "PASS" and .services == 37 and .rerendered_hashes == .services
    and (.compose_hashes | length) == .services and (.fields | length) == 0' "$work/probe-scan.raw" > /dev/null
  printf 'probe-scan services=37 rerendered_hashes=37 census=PASS\n' | tee -a "$diagnostics/phases.log"
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
