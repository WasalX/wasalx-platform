#!/usr/bin/env bash
set -euo pipefail
case "${WASALX_CI_RUNTIME-native}" in
  native) ;;
  managed) python3 scripts/release/ci-phase-guard.py --payload --docker-phase ;;
  *) printf 'Unknown CI runtime\n' >&2; exit 1 ;;
esac

repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository"
node --test "${WASALX_PRIVATE_INPUT_021:?Set WASALX_PRIVATE_INPUT_021}"
project="wasalx-smoke-$$"
compose=(docker compose --file compose.yaml --file compose.smoke.yaml --project-name "$project")
provisioner_image="wasalx/tenant-provisioner:smoke-${project}"
controller_image="wasalx/tenant-workspace-controller:smoke-${project}"
provider_image="wasalx/workspace-provider:smoke-${project}"
configurator_image="wasalx/workspace-configurator:smoke-${project}"
cleanup() {
  local status=$?
  if (( status != 0 )); then
    printf 'Docker smoke failed (%s); capturing PostgreSQL diagnostics before cleanup\n' "$status" >&2
    timeout 15s "${compose[@]}" ps --all >&2 || true
    timeout 15s "${compose[@]}" logs --no-color --tail 200 postgres >&2 || true
    local postgres_id
    postgres_id="$(timeout 15s "${compose[@]}" ps --all --quiet postgres)" || true
    if [[ -n "$postgres_id" ]]; then
      timeout 15s docker inspect --format '{{json .State}}' "$postgres_id" >&2 || true
    fi
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$provisioner_image" "$controller_image" "$provider_image" "$configurator_image" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

export DOCKER_BUILDKIT=1
export COMPOSE_PROFILES=""
export WASALX_CANDIDATE_SHA="${WASALX_CANDIDATE_SHA:-$(git rev-parse HEAD)}"
export WASALX_CANDIDATE_TREE="${WASALX_CANDIDATE_TREE:-$(git rev-parse 'HEAD^{tree}')}"
skip_build="${WASALX_DOCKER_SMOKE_SKIP_BUILD:-false}"
qualified_provisioner_image="$provisioner_image"
qualified_controller_image="$controller_image"
qualified_provider_image="$provider_image"
qualified_configurator_image="$configurator_image"

if [[ "$skip_build" != "true" ]]; then
  minimum_free_bytes="${WASALX_DOCKER_SMOKE_MIN_FREE_BYTES:-10737418240}"
  if [[ -z "$minimum_free_bytes" || "$minimum_free_bytes" == *[!0-9]* ]]; then
    printf 'WASALX_DOCKER_SMOKE_MIN_FREE_BYTES must be a non-negative integer\n' >&2
    exit 2
  fi
  available_blocks="$(df -Pk "$repository" | awk 'NR == 2 { print $4 }')"
  if [[ -z "$available_blocks" || "$available_blocks" == *[!0-9]* ]]; then
    printf 'Could not determine free disk space for the Docker smoke build\n' >&2
    exit 2
  fi
  available_bytes="$((available_blocks * 1024))"
  if (( available_bytes < minimum_free_bytes )); then
    printf 'Docker smoke build requires at least %s free bytes; only %s are available. Free disk space or explicitly lower WASALX_DOCKER_SMOKE_MIN_FREE_BYTES after reviewing the risk.\n' \
      "$minimum_free_bytes" "$available_bytes" >&2
    exit 2
  fi
  if ! docker buildx version >/dev/null 2>&1; then
    printf 'Docker smoke requires the Buildx plugin; refusing an incompatible legacy build\n' >&2
    exit 2
  fi
fi

if [[ "$skip_build" == "true" ]]; then
  qualified_provisioner_image="wasalx/tenant-provisioner:local"
  qualified_controller_image="wasalx/tenant-workspace-controller:local"
  qualified_provider_image="wasalx/workspace-provider:local"
  qualified_configurator_image="wasalx/workspace-configurator:local"
  for image in \
    wasalx/portal:local \
    wasalx/control-api:local \
    wasalx/connector-worker:local \
    wasalx/dev-secret-sidecar:local \
    wasalx/invitation-mailer:local \
    wasalx/identity-policy-activator:local \
    wasalx/tenant-provisioner:local \
    wasalx/tenant-workspace-controller:local \
    wasalx/workspace-provider:local \
    wasalx/workspace-configurator:local
  do
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      printf 'Required prebuilt image is missing: %s\n' "$image" >&2
      exit 1
    fi
  done
else
  for service in portal control-api connector-worker secret-sidecar invitation-mailer identity-policy-activator; do
    "${compose[@]}" build \
      --build-arg "WASALX_CANDIDATE_SHA=${WASALX_CANDIDATE_SHA}" \
      --build-arg "WASALX_CANDIDATE_TREE=${WASALX_CANDIDATE_TREE}" "$service"
  done
  build_args=(--build-arg "WASALX_CANDIDATE_SHA=${WASALX_CANDIDATE_SHA}" --build-arg "WASALX_CANDIDATE_TREE=${WASALX_CANDIDATE_TREE}")
  docker build "${build_args[@]}" --file Dockerfile.tenant-provisioner --tag "$provisioner_image" .
  docker build "${build_args[@]}" --file Dockerfile.tenant-workspace-controller --tag "$controller_image" .
  docker build "${build_args[@]}" --file Dockerfile.workspace-provider --tag "$provider_image" .
  docker build "${build_args[@]}" --file Dockerfile.workspace-configurator --tag "$configurator_image" .
fi
"${compose[@]}" up --detach --wait

settings="$("${compose[@]}" exec -T postgres psql --username wasalx --dbname wasalx --tuples-only --no-align --command "SELECT current_setting('fsync') || '|' || current_setting('synchronous_commit') || '|' || current_setting('full_page_writes')")"
[[ "$settings" == 'off|off|off' ]]

"${compose[@]}" exec -T portal node -e "fetch('http://127.0.0.1:3000/api/health').then(async response=>{if(!response.ok)throw new Error(await response.text())})"
"${compose[@]}" exec -T portal node -e "Promise.all([fetch('http://127.0.0.1:3000/'),fetch('http://127.0.0.1:3000/app')]).then(async ([publicResponse,appResponse])=>{const [publicBody,appBody]=await Promise.all([publicResponse.text(),appResponse.text()]);if(!publicResponse.ok||!publicBody.includes('<h1 id=\"marketing-title\"'))throw new Error('Public site did not render');if(!appResponse.ok||!appBody.includes('<title>Operational overview · WasalX</title>')||!appBody.includes('Operational overview'))throw new Error('Portal application shell did not render')})"
"${compose[@]}" exec -T control-api node -e "fetch('http://127.0.0.1:3001/health/ready').then(async response=>{if(!response.ok)throw new Error(await response.text())})"

migration_count="$("${compose[@]}" exec -T postgres psql --username wasalx --dbname wasalx --tuples-only --no-align --command 'SELECT count(*) FROM wasalx_schema_migrations')"
expected_migration_count="$(find services/control-api/migrations -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d '[:space:]')"
if [[ "$migration_count" != "$expected_migration_count" ]]; then
  printf 'Expected %s migrations, received %s\n' "$expected_migration_count" "$migration_count" >&2
  exit 1
fi

runtime_memberships="$("${compose[@]}" exec -T postgres psql --username wasalx --dbname wasalx --tuples-only --no-align --command "SELECT count(*) FROM (VALUES ('wasalx_runtime','wasalx_app'),('wasalx_connector_worker_runtime','wasalx_connector_worker'),('wasalx_secret_cleanup_runtime','wasalx_secret_cleanup_client'),('wasalx_provisioning_runtime','wasalx_provisioning_client'),('wasalx_support_runtime','wasalx_support_client'),('wasalx_waha_registry_runtime','wasalx_waha_registry_client'),('wasalx_waha_operator_runtime','wasalx_waha_operator_client'),('wasalx_waha_rollout_gate_runtime','wasalx_waha_rollout_gate_client'),('wasalx_invitation_mailer_runtime','wasalx_invitation_mailer'),('wasalx_identity_policy_runtime','wasalx_identity_policy_activator'),('wasalx_metering_ingest_runtime','wasalx_metering_ingest_client'),('wasalx_platform_operations_runtime','wasalx_platform_operations_client')) AS expected(member_role,client_role) WHERE pg_has_role(member_role,client_role,'MEMBER')")"
if [[ "$runtime_memberships" != "12" ]]; then
  printf 'Expected 12 scoped runtime role memberships, received %s\n' "$runtime_memberships" >&2
  exit 1
fi

runtime_role_separation="$("${compose[@]}" exec -T postgres psql --username wasalx --dbname wasalx --tuples-only --no-align --command "WITH expected(member_role,client_role) AS (VALUES ('wasalx_runtime','wasalx_app'),('wasalx_connector_worker_runtime','wasalx_connector_worker'),('wasalx_secret_cleanup_runtime','wasalx_secret_cleanup_client'),('wasalx_provisioning_runtime','wasalx_provisioning_client'),('wasalx_support_runtime','wasalx_support_client'),('wasalx_waha_registry_runtime','wasalx_waha_registry_client'),('wasalx_waha_operator_runtime','wasalx_waha_operator_client'),('wasalx_waha_rollout_gate_runtime','wasalx_waha_rollout_gate_client'),('wasalx_invitation_mailer_runtime','wasalx_invitation_mailer'),('wasalx_identity_policy_runtime','wasalx_identity_policy_activator'),('wasalx_metering_ingest_runtime','wasalx_metering_ingest_client'),('wasalx_platform_operations_runtime','wasalx_platform_operations_client')) SELECT bool_and(pg_has_role(member.member_role,client.client_role,'MEMBER')=(member.client_role=client.client_role)) FROM expected member CROSS JOIN expected client")"
if [[ "$runtime_role_separation" != "t" ]]; then
  printf 'Dedicated runtime database identities are not role-separated\n' >&2
  exit 1
fi

"${compose[@]}" exec -T postgres psql --username wasalx_runtime --dbname wasalx --command 'SELECT count(*) FROM connections' >/dev/null 2>&1 && {
  printf 'Runtime database role bypassed the required tenant context\n' >&2
  exit 1
}

declare -A smoke_image_references=(
  [portal]="wasalx/portal:local"
  [control-api]="wasalx/control-api:local"
  [connector-worker]="wasalx/connector-worker:local"
  [secret-sidecar]="wasalx/dev-secret-sidecar:local"
  [invitation-mailer]="wasalx/invitation-mailer:local"
  [identity-policy-activator]="wasalx/identity-policy-activator:local"
  [tenant-provisioner]="${qualified_provisioner_image}"
  [tenant-workspace-controller]="${qualified_controller_image}"
  [workspace-provider]="${qualified_provider_image}"
  [workspace-configurator]="${qualified_configurator_image}"
)
smoke_candidate_args=()
while IFS= read -r image_id; do
  reference="${smoke_image_references[$image_id]:-}"
  if [[ -z "$reference" ]]; then
    printf 'Docker smoke image has no runtime reference: %s\n' "$image_id" >&2
    exit 2
  fi
  smoke_candidate_args+=(--candidate-image "${image_id}=${reference}")
done < <(node -e "const c=JSON.parse(require('node:fs').readFileSync(process.env.WASALX_IMAGE_CATALOG,'utf8')); for (const id of c.smokeImageIds ?? []) console.log(id)")

node "${WASALX_STACK_VERIFY_SCRIPT:?Set WASALX_STACK_VERIFY_SCRIPT}" "$project" \
  --compose-file compose.yaml --compose-file compose.smoke.yaml \
  "${smoke_candidate_args[@]}"
printf '{"portal":"healthy","control_api":"healthy","connector_worker":"healthy","migrations":%s,"tenant_context":"fail_closed","runtime_roles":"isolated","exact_stack":"verified"}\n' "$migration_count"
