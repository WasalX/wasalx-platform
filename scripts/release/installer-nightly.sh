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
registry=127.0.0.1:5007
registry_container="$project-registry"
registry_image=docker.io/library/registry@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e
registry_overlay="$full_env.$project.registry.compose.json"
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
  if docker container inspect "$registry_container" >/dev/null 2>&1; then
    docker rm --force "$registry_container" >/dev/null || {
      status=$?
      failure "$status" 'docker rm --force' 'guest registry teardown failed'
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
  if [[ "$name" == bundles ]]; then
    sed -nE '/^hosted bundle staging timing: route=(token|manifests|referrers|blobs) requests=[0-9]+ total_ms=[0-9]+ p95_ms=[0-9]+ max_ms=[0-9]+ http_404=[0-9]+ http_429=[0-9]+ transport_errors=[0-9]+$/p' \
      "$work/$name.raw" | tee -a "$diagnostics/installer.log"
  elif [[ "$name" == registry-stage ]]; then
    sed -nE '/^registry-stage source=[a-zA-Z0-9._:\/-]+@sha256:[0-9a-f]{64}$/p' "$work/$name.raw" >> "$diagnostics/installer.log"
  elif [[ "$name" == native-preflight ]]; then
    sed -nE '/^native docker diff service=[a-z0-9][a-z0-9_-]{0,62} elapsed=[0-9]+ms$/p' \
      "$work/$name.raw" | tee -a "$diagnostics/installer.log"
    if (( status != 0 )); then
      sed -nE '/^native docker diff service=[a-z0-9][a-z0-9_-]{0,62} (started|elapsed=[0-9]+ms)$/p' \
        "$work/$name.raw" | tail -n 1 | sed -n '/ started$/p' | tee -a "$diagnostics/installer.log"
    fi
  fi
  if (( status != 0 )); then
    reason=$(sed -nE '/^probe-scan error=(Error|AssertionError|SyntaxError|TypeError|RangeError) message=[[:print:]]{1,480}$/p;
      /^registry-egress reason: [[:print:]]+$/p;
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

start_registry() {
  local read_only=$1 mount="type=bind,src=$work/registry,dst=/var/lib/registry"
  if [[ "$read_only" == true ]]; then mount+=,readonly; fi
  cat > "$work/registry-config.json" <<EOF
{
  "version": "0.1",
  "storage": {
    "filesystem": {"rootdirectory": "/var/lib/registry"},
    "maintenance": {"readonly": {"enabled": $read_only}, "uploadpurging": {"enabled": false}}
  },
  "validation": {"manifests": {"indexes": {"platforms": "list", "platformlist": [{"os": "linux", "architecture": "amd64"}]}}},
  "http": {"addr": "$registry"}
}
EOF
  docker run --detach --rm --pull never --name "$registry_container" --network host \
    --env OTEL_TRACES_EXPORTER=none --mount "$mount" \
    --mount "type=bind,src=$work/registry-config.json,dst=/etc/distribution/config.yml,readonly" "$registry_image"
  curl --fail --silent --show-error --retry 5 --retry-connrefused --max-time 3 "http://$registry/v2/"
}

stage_registry() {
  local source destination expected manifest platform
  local copy=(skopeo copy --preserve-digests --dest-tls-verify=false)
  mkdir -p "$work/registry"
  # Establish that the exact public probe reference is reachable before the block.
  docker pull "$registry_image"
  start_registry false
  {
    jq -er '.images[] | .pullReference' "$work/images-manifest.json"
    "${compose[@]}" config --images
  } | LC_ALL=C sort -u | node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { localRegistryReference } from "./scripts/release/installer-hosted-images.mjs";
    const seen = new Set();
    for (const source of readFileSync(0, "utf8").split(/\s+/u).filter(value => value.includes("@"))) {
      const destination = localRegistryReference(process.argv[1], source);
      if (!seen.has(destination)) console.log(source.replace(/:[^/:]+(?=@)/u, ""), destination);
      seen.add(destination);
    }
  ' "$registry" > "$work/registry-images"
  test -s "$work/registry-images"
  while read -r source destination; do
    expected=${destination##*@}
    printf 'registry-stage source=%s\n' "$source"
    manifest=$(skopeo inspect --raw "docker://$source")
    if jq -e 'has("manifests")' <<< "$manifest" > /dev/null; then
      # Copy the guest platform and retain the upstream index bytes.
      platform=$(jq -er '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64") | .digest]
        | select(length == 1) | .[0] | select(test("^sha256:[0-9a-f]{64}$"))' <<< "$manifest")
      "${copy[@]}" "docker://${source%@*}@$platform" "docker://${destination%@*}:amd64"
    fi
    "${copy[@]}" --multi-arch=index-only --digestfile "$work/copied.digest" \
      "docker://$source" "docker://${destination%@*}:staged"
    [[ "$(cat "$work/copied.digest")" == "$expected" ]]
  done < "$work/registry-images"
  docker stop "$registry_container"
  start_registry true
  # An upload to the read-only registry must be refused.
  test "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --request POST "http://$registry/v2/staged/readonly-check/blobs/uploads/" --max-time 3)" = 405
}

block_registry_egress() {
  local unit group tool family route iface
  [[ -n "$(ip -o -4 route show default)" ]]
  for unit in docker.service containerd.service; do
    group=$(systemctl show "$unit" --property=ControlGroup --value)
    [[ -n "$group" && -d "/sys/fs/cgroup$group" ]]
    for tool in iptables ip6tables; do
      sudo "$tool" -I OUTPUT 1 ! -o lo -m cgroup --path "${group#/}" -j REJECT
      sudo "$tool" -C OUTPUT ! -o lo -m cgroup --path "${group#/}" -j REJECT
    done
  done
  for family in 4 6; do
    tool=iptables
    if [[ "$family" == 6 ]]; then tool=ip6tables; fi
    route=$(ip -o "-$family" route show default)
    while read -r iface; do
      [[ -n "$iface" ]] || continue
      sudo "$tool" -I FORWARD 1 -o "$iface" -j REJECT
      sudo "$tool" -C FORWARD -o "$iface" -j REJECT
    done < <(awk '{ for (i=1; i<NF; i++) if ($i=="dev") print $(i+1) }' <<< "$route" | sort -u)
  done
}

verify_registry_egress() {
  local output status=0
  output=$(timeout 15s docker pull "$registry_image" 2>&1) || status=$?
  if (( status == 0 )); then
    echo 'registry-egress reason: public pull succeeded after the block' >&2
    return 1
  fi
  if (( status != 1 )) || ! grep -Eq 'dial tcp .*: connect: (connection refused|network is unreachable|no route to host)' <<< "$output"; then
    echo "registry-egress reason: public pull failed without a TCP rejection (exit=$status)" >&2
    return 1
  fi
  echo 'public-registry-egress=blocked'
}

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
stage=(--env-file "$full_env" --project-name "$project" --rehearsal-main "$MAIN_SHA" --local-registry "$registry")
manifest_hash=$(sha256sum "$work/images-manifest.json" | cut -d ' ' -f 1)
hosted=(--hosted-images "$work/images-manifest.json" --hosted-images-sha256 "$manifest_hash"
  --hosted-trusted-root "$TRUSTED_ROOT")
installer=(node scripts/release/installer-stages.mjs)
phase fresh-preflight 2m "${installer[@]}" preflight "${stage[@]}" --capture-preimage
# Only the loopback registry serves the installer after staging.
export -f start_registry stage_registry block_registry_egress verify_registry_egress
export registry registry_container registry_image work
# A subprocess cannot inherit Bash arrays, so pass the original Compose inputs explicitly.
phase registry-stage 12m bash -euo pipefail -c 'compose=("$@"); stage_registry' bash "${compose[@]}"
phase registry-egress 30s bash -euo pipefail -c 'block_registry_egress; verify_registry_egress'
grep -Fx 'public-registry-egress=blocked' "$work/registry-egress.raw" | tee -a "$diagnostics/phases.log"
phase preload 10m "${installer[@]}" preload-hosted "${stage[@]}" "${hosted[@]}"
resources preloaded
phase admission 5m "${installer[@]}" admit-hosted "${stage[@]}" "${hosted[@]}"

smoke() {
  phase "$1" 3m "${installer[@]}" smoke "${stage[@]}" "${hosted[@]}"
  mv "output/release-evidence/$commit/nightly-stack.json" "$work/$1.json"
}

phase fresh-install 10m "${installer[@]}" replace "${stage[@]}" "${hosted[@]}" --drained
smoke fresh-smoke
printf 'local-registry product=%s services=%s digests=PASS\n' \
  "$(jq -er '.images | length' "$work/images-manifest.json")" "$(jq -er '.services | length' "$work/fresh-smoke.json")" \
  | tee -a "$diagnostics/phases.log"
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
    --env-file "$full_env" --project-name "$project" --compose-file scripts/release/installer-nightly.compose.yaml \
    --compose-file "$registry_overlay" --held-services ''
  jq -er 'select(.census == "PASS" and .expected_services > 0 and .services == .expected_services
    and .rerendered_hashes == .expected_services and (.compose_hashes | length) == .expected_services
    and (.fields | length) == 0)
    | "probe-scan services=\(.services) rerendered_hashes=\(.rerendered_hashes) census=PASS"' "$work/probe-scan.raw" \
    | tee -a "$diagnostics/phases.log"
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
