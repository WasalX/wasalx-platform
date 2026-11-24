#!/usr/bin/env bash
set -euo pipefail
case "${WASALX_CI_RUNTIME-native}" in
  native) ;;
  managed) python3 scripts/release/ci-phase-guard.py --payload ;;
  *) printf 'Unknown CI runtime\n' >&2; exit 1 ;;
esac
NATIVE_INFRA=false
if [[ "${WASALX_CI_RUNTIME-native}" == managed && "${WASALX_CI_ROUTE-fullruntime}" == cloud ]]; then
  NATIVE_INFRA=true
fi
mode=${1:-}
prerequisites=(curl shasum)
case "$mode" in
  --terraform-test-only) prerequisites+=(unzip) ;;
  --render-secret-adapter) prerequisites+=(tar) ;;
  *)
    prerequisites+=(tar ruby)
    if [[ "$NATIVE_INFRA" == true ]]; then prerequisites+=(unzip); else prerequisites+=(docker); fi
    ;;
esac
for tool in "${prerequisites[@]}"; do
  command -v "$tool" >/dev/null || { printf 'missing infrastructure prerequisite: %s\n' "$tool" >&2; exit 1; }
done
if [[ "$mode" != --terraform-test-only && "$mode" != --render-secret-adapter ]]; then ruby -ryaml -e 'YAML.load_stream("--- {}")'; fi

HELM_VERSION="4.2.0"
TOFU_VERSION="1.12.1"
# Keep equal to the digest-pinned Prometheus image in compose.full.yaml.
PROMTOOL_VERSION="3.13.1"
workspace_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TOOLS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wasalx-infra-tools.XXXXXX")"
CACHE_DIR="${WASALX_INFRA_TOOL_CACHE:-${workspace_root}/.wasalx-infra-tool-cache}"
trap 'rm -rf "$TOOLS_DIR"' EXIT
install -d -m 0700 "$CACHE_DIR"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    TOOL_OS="darwin"
    TOOL_ARCH="arm64"
    ;;
  Linux:x86_64)
    TOOL_OS="linux"
    TOOL_ARCH="amd64"
    ;;
  Linux:aarch64 | Linux:arm64)
    TOOL_OS="linux"
    TOOL_ARCH="arm64"
    ;;
  *)
    printf 'unsupported infrastructure validation platform: %s/%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac
HELM_TARGET="${TOOL_OS}-${TOOL_ARCH}"
HOST_PROVIDER_TARGET="${TOOL_OS}_${TOOL_ARCH}"

prepare_verified_archive() {
  local archive_url="$1"
  local checksum_url="$2"
  local filename="$3"
  local archive="$CACHE_DIR/$filename"
  local checksum="$CACHE_DIR/$filename.sha256"
  local expected actual

  if [[ ! -s "$archive" || ! -s "$checksum" ]]; then
    local pending_archive="$TOOLS_DIR/$filename.pending"
    local pending_checksum="$TOOLS_DIR/$filename.sha256.pending"
    if ! curl --proto '=https' --proto-redir '=https' --tlsv1.2 --http1.1 --fail --location --silent --show-error \
      --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 120 \
      --output "$pending_checksum" "$checksum_url"; then
      rm -f "$pending_archive" "$pending_checksum"
      return 1
    fi
    expected=$(awk -v file="$filename" 'NF == 1 || $2 == file { print $1; exit }' "$pending_checksum")
    if bash "$workspace_root/scripts/release/fetch-verified-asset.sh" "$archive_url" "$pending_archive" "$expected"; then
      :
    else
      local status=$?
      rm -f "$pending_archive" "$pending_checksum"
      return "$status"
    fi
    install -m 0600 "$pending_archive" "$archive"
    install -m 0600 "$pending_checksum" "$checksum"
  fi

  expected=$(awk -v file="$filename" 'NF == 1 || $2 == file { print $1; exit }' "$checksum")
  actual=$(shasum -a 256 "$archive" | awk '{print $1}')
  [[ -n "$expected" && "$expected" == "$actual" ]] || {
    printf 'cached infrastructure tool failed checksum verification: %s\n' "$filename" >&2
    rm -f "$archive" "$checksum"
    return 1
  }
  cp "$archive" "$TOOLS_DIR/$filename"
}

prepare_pinned_provider() {
  local name="$1"
  local version="$2"
  local target="$3"
  local expected="$4"
  local filename="terraform-provider-${name}_${version}_${target}.zip"
  local directory="$CACHE_DIR/provider-mirror/registry.opentofu.org/hashicorp/$name"
  local archive="$directory/$filename"
  local pending="$TOOLS_DIR/$filename.pending"
  local release_url="https://github.com/opentofu/terraform-provider-${name}/releases/download/v${version}/${filename}"
  local release_proxy="${WASALX_GITHUB_RELEASE_PROXY:-}"
  local actual

  install -d -m 0700 "$directory"
  if [[ ! -s "$archive" ]]; then
    if bash "$workspace_root/scripts/release/fetch-verified-asset.sh" "$release_url" "$pending" "$expected"; then
      :
    else
      local status=$?
      [[ "$status" == 1 && -n "$release_proxy" ]] || return "$status"
      curl --http1.1 --fail --location --silent --show-error \
        --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 120 \
        --output "$pending" "${release_proxy%/}/${release_url}"
    fi
    actual=$(shasum -a 256 "$pending" | awk '{print $1}')
    [[ "$actual" == "$expected" ]] || {
      rm -f "$pending"
      printf 'provider archive failed pinned checksum verification: %s\n' "$filename" >&2
      return 1
    }
    install -m 0600 "$pending" "$archive"
  fi
  actual=$(shasum -a 256 "$archive" | awk '{print $1}')
  [[ "$actual" == "$expected" ]] || {
    rm -f "$archive"
    printf 'cached provider failed pinned checksum verification: %s\n' "$filename" >&2
    return 1
  }
}

provider_checksum() {
  case "$1:$2" in
    kubernetes:darwin_arm64) printf '%s\n' 620fd5d0fbc2d7a24ac6b420a4922e6093020358162a62fa8cbd37b2bac1d22e ;;
    helm:darwin_arm64) printf '%s\n' 2d0a5babfa73604b3fefc9dab9c87f91c77fce756c2e32b294e9f1290aed26c0 ;;
    kubernetes:linux_amd64) printf '%s\n' 96eecc9f94938a0bc35b8a63d2c4a5f972395e44206620db06760b730d0471fc ;;
    helm:linux_amd64) printf '%s\n' 6512e2ab9f2fa31cbb90d9249647b5c5798f62eb1215ec44da2cdaa24e38ad25 ;;
    kubernetes:linux_arm64) printf '%s\n' 5082f98fcb3389c73339365f7df39fc6912bf2bd1a46d5f97778f441a67fd337 ;;
    helm:linux_arm64) printf '%s\n' c5c8575c4458835c2acbc3d1ed5570589b14baa2525d8fbd04295c097caf41eb ;;
    *)
      printf 'missing pinned provider checksum: %s/%s\n' "$1" "$2" >&2
      return 1
      ;;
  esac
}

# Source-verified 2026-11-07 against the Prometheus and OpenTofu release manifests recorded in W7 r2 REPORT.md.
tool_checksum() {
  case "$1:$2" in
    promtool:darwin-arm64) printf '%s\n' 28d1f1224b2a22f84c801487fad4b3bd58f94a8cb58cf9340557e787030c9703 ;;
    promtool:linux-amd64) printf '%s\n' 962b812371aff838d152b6ff2d56fdb7a6396f5542f48ebf73421b9721f0d103 ;;
    promtool:linux-arm64) printf '%s\n' fbd8e5e0f6ad2e7d053e717739186caee4fd0cab2cf9335bfc86c292fe2a2bfe ;;
    tofu:darwin_arm64) printf '%s\n' 06cff265b39c437ba81f91cfa85ae91b6ae28d3112bb2273294431a3f54e8bf5 ;;
    tofu:linux_amd64) printf '%s\n' 1fc9af962e3632b7cd0ba27076cd9f1ced177567defe9e331ac37f5a40468575 ;;
    tofu:linux_arm64) printf '%s\n' 1a53dd57697dc04d243ddb81a0f70e44ab83c256f15dde173e5538120dc6a0bb ;;
    *)
      printf 'missing pinned infrastructure tool checksum: %s/%s\n' "$1" "$2" >&2
      return 1
      ;;
  esac
}

prepare_pinned_archive() {
  local archive_url="$1"
  local checksum_url="$2"
  local filename="$3"
  local expected="$4"
  local archive="$CACHE_DIR/$filename"
  local checksum="$CACHE_DIR/$filename.sha256"
  local actual upstream

  if [[ ! -s "$archive" ]]; then
    local pending_archive="$TOOLS_DIR/$filename.pending"
    local pending_checksum="$TOOLS_DIR/$filename.sha256.pending"
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 --http1.1 --fail --location --silent --show-error \
      --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 20 --max-time 120 \
      --output "$pending_checksum" "$checksum_url"
    upstream=$(awk -v file="$filename" 'NF == 1 || $2 == file { print $1; exit }' "$pending_checksum")
    [[ "$upstream" == "$expected" ]] || {
      printf 'upstream infrastructure tool checksum differs from the source pin: %s\n' "$filename" >&2
      rm -f "$pending_archive" "$pending_checksum"
      return 1
    }
    bash "$workspace_root/scripts/release/fetch-verified-asset.sh" "$archive_url" "$pending_archive" "$expected"
    install -m 0600 "$pending_archive" "$archive"
    install -m 0600 "$pending_checksum" "$checksum"
  fi

  actual=$(shasum -a 256 "$archive" | awk '{print $1}')
  [[ "$expected" == "$actual" ]] || {
    printf 'cached infrastructure tool failed source checksum verification: %s\n' "$filename" >&2
    rm -f "$archive" "$checksum"
    return 1
  }
  cp "$archive" "$TOOLS_DIR/$filename"
}

prepare_tofu_providers() {
  prepare_pinned_provider kubernetes 2.38.0 "$1" "$(provider_checksum kubernetes "$1")"
  prepare_pinned_provider helm 2.17.0 "$1" "$(provider_checksum helm "$1")"
}

prepare_native_tofu() {
  cp -R "$CACHE_DIR/provider-mirror" "$TOOLS_DIR/provider-mirror"
  printf '%s\n' \
    'provider_installation {' \
    '  filesystem_mirror {' \
    "    path = \"$TOOLS_DIR/provider-mirror\"" \
    '    include = ["registry.opentofu.org/hashicorp/helm", "registry.opentofu.org/hashicorp/kubernetes"]' \
    '  }' \
    '}' > "$TOOLS_DIR/tofurc-host"
  local TOFU_ARCHIVE="tofu_${TOFU_VERSION}_${HOST_PROVIDER_TARGET}.zip"
  prepare_pinned_archive \
    "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/${TOFU_ARCHIVE}" \
    "https://github.com/opentofu/opentofu/releases/download/v${TOFU_VERSION}/tofu_${TOFU_VERSION}_SHA256SUMS" \
    "$TOFU_ARCHIVE" "$(tool_checksum tofu "$HOST_PROVIDER_TARGET")"
  unzip -q "$TOOLS_DIR/$TOFU_ARCHIVE" -d "$TOOLS_DIR/tofu"
  export TF_CLI_CONFIG_FILE="$TOOLS_DIR/tofurc-host"
  TOFU=("$TOOLS_DIR/tofu/tofu")
  [[ "$("${TOFU[@]}" version | head -n 1)" == "OpenTofu v${TOFU_VERSION}" ]]
}

init_terraform() {
  "${TOFU[@]}" -chdir=infra/terraform init -backend=false -input=false -lockfile=readonly
}

run_terraform_tests() {
  printf 'Running tofu -chdir=infra/terraform test\n'
  "${TOFU[@]}" -chdir=infra/terraform test -no-color
}

if [[ "${1:-}" == --terraform-test-only ]]; then
  export TF_DATA_DIR="$TOOLS_DIR/tofu-data"
  prepare_tofu_providers "$HOST_PROVIDER_TARGET"
  prepare_native_tofu
  init_terraform
  run_terraform_tests
  exit 0
fi

HELM_ARCHIVE="helm-v${HELM_VERSION}-${HELM_TARGET}.tar.gz"
prepare_verified_archive \
  "https://get.helm.sh/${HELM_ARCHIVE}" \
  "https://get.helm.sh/${HELM_ARCHIVE}.sha256sum" \
  "$HELM_ARCHIVE"
tar -xzf "$TOOLS_DIR/$HELM_ARCHIVE" -C "$TOOLS_DIR"
HELM="$TOOLS_DIR/$HELM_TARGET/helm"
[[ "$("$HELM" version --short)" == "v${HELM_VERSION}+"* ]]

PRODUCTION_VALUES_FILE="infra/helm/wasalx/ci/production-values.yaml"
secret_adapter_values=(--namespace wasalx --values infra/helm/wasalx/ci/production-secret-sidecar-values.yaml)
render_secret_adapter() {
  "$HELM" template wasalx infra/helm/wasalx --values "$PRODUCTION_VALUES_FILE" "${secret_adapter_values[@]}"
}

if [[ "$mode" == --render-secret-adapter ]]; then
  render_secret_adapter
  exit 0
fi

install -d -m 0755 "$TOOLS_DIR/alert-checks"
install -m 0644 infra/helm/wasalx/files/observability-rules.yaml "$TOOLS_DIR/alert-checks/application-rules.yaml"
install -m 0644 tests/fixtures/production-backup-alerts.yaml "$TOOLS_DIR/alert-checks/tests.yaml"
if [[ "$NATIVE_INFRA" == true ]]; then
  PROMTOOL_ARCHIVE="prometheus-${PROMTOOL_VERSION}.${TOOL_OS}-${TOOL_ARCH}.tar.gz"
  prometheus_image=$(ruby -ryaml -e 'puts YAML.load_file("compose.full.yaml", aliases: true).fetch("services").fetch("prometheus").fetch("image")')
  [[ "$prometheus_image" == "prom/prometheus:v${PROMTOOL_VERSION}@sha256:"* ]] || {
    printf 'native promtool version differs from the pinned monitoring image\n' >&2
    exit 1
  }
  prepare_pinned_archive \
    "https://github.com/prometheus/prometheus/releases/download/v${PROMTOOL_VERSION}/${PROMTOOL_ARCHIVE}" \
    "https://github.com/prometheus/prometheus/releases/download/v${PROMTOOL_VERSION}/sha256sums.txt" \
    "$PROMTOOL_ARCHIVE" "$(tool_checksum promtool "$HELM_TARGET")"
  tar -xzf "$TOOLS_DIR/$PROMTOOL_ARCHIVE" -C "$TOOLS_DIR" \
    "prometheus-${PROMTOOL_VERSION}.${TOOL_OS}-${TOOL_ARCH}/promtool"
  PROMTOOL="$TOOLS_DIR/prometheus-${PROMTOOL_VERSION}.${TOOL_OS}-${TOOL_ARCH}/promtool"
  [[ "$("$PROMTOOL" --version 2>&1)" == "promtool, version ${PROMTOOL_VERSION} "* ]]
  printf 'infrastructure tool mode: native\n'
  (cd "$TOOLS_DIR/alert-checks" && "$PROMTOOL" test rules tests.yaml)
else
  prometheus_image=$(ruby -ryaml -e 'puts YAML.load_file("compose.full.yaml", aliases: true).fetch("services").fetch("prometheus").fetch("image")')
  printf 'infrastructure tool mode: docker\n'
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --cpus .5 --memory 256m --entrypoint /bin/promtool \
    --volume "$TOOLS_DIR/alert-checks:/checks:ro" \
    "$prometheus_image" test rules /checks/tests.yaml
fi
if [[ "${1:-}" == --production-only ]]; then exit 0; fi

assisted_alpha_backup_values=(--set deploymentProfile=assisted-alpha --set workspaceProvider.enabled=false --set provisioner.enabled=false)
assisted_alpha_values=("${assisted_alpha_backup_values[@]}" --set controlPlaneBackup.enabled=false)
expect_production_lint_failure() {
  local label="$1"
  shift
  if "$HELM" lint infra/helm/wasalx --values "$PRODUCTION_VALUES_FILE" "$@" \
    > "$TOOLS_DIR/invalid-production-${label}.log" 2>&1; then
    printf 'invalid production Helm values unexpectedly passed: %s\n' "$label" >&2
    exit 1
  fi
}

"$HELM" lint infra/helm/wasalx
if "$HELM" lint infra/helm/wasalx --set environment=production > "$TOOLS_DIR/incomplete-production.log" 2>&1; then
  printf 'production Helm defaults unexpectedly passed the fail-closed schema\n' >&2
  exit 1
fi
"$HELM" lint infra/helm/wasalx --values "$PRODUCTION_VALUES_FILE"
"$HELM" lint infra/helm/wasalx --values "$PRODUCTION_VALUES_FILE" "${assisted_alpha_values[@]}"
# Both profiles admit client encryption without an unused KMS reference.
for backup_profile in standard assisted-alpha; do
  backup_profile_args=(--set deploymentProfile=standard)
  if [[ $backup_profile == assisted-alpha ]]; then backup_profile_args=("${assisted_alpha_backup_values[@]}"); fi
  "$HELM" lint infra/helm/wasalx --values "$PRODUCTION_VALUES_FILE" \
    --set controlPlaneBackup.s3.encryptionMode=CLIENT_ENVELOPE \
    --set-string controlPlaneBackup.s3.ageRecipient=age1xq5ehcx9js6d2sawqu6f8emuw0vvjv0428wun3mda3n8tmtwl4csxzqhud \
    --set controlPlaneBackup.s3.kmsKeyReference=null \
    "${backup_profile_args[@]}"
 done
for forbidden in workspaceProvider provisioner; do
  if "$HELM" lint infra/helm/wasalx --values "$PRODUCTION_VALUES_FILE" "${assisted_alpha_values[@]}" \
    --set "$forbidden.enabled=true" > "$TOOLS_DIR/invalid-assisted-${forbidden}.log" 2>&1; then
    printf 'assisted alpha unexpectedly enabled deferred component: %s\n' "$forbidden" >&2
    exit 1
  fi
done
"$HELM" template wasalx infra/helm/wasalx --values "$PRODUCTION_VALUES_FILE" > "$TOOLS_DIR/rendered-production.yaml"
ruby scripts/validate-migration-render.rb "$TOOLS_DIR/rendered-production.yaml" standard
"$HELM" template wasalx infra/helm/wasalx --values "$PRODUCTION_VALUES_FILE" \
  "${assisted_alpha_values[@]}" > "$TOOLS_DIR/rendered-assisted-alpha.yaml"
ruby scripts/validate-migration-render.rb "$TOOLS_DIR/rendered-assisted-alpha.yaml" assisted-alpha
"$HELM" lint infra/helm/wasalx --values "$PRODUCTION_VALUES_FILE" "${secret_adapter_values[@]}"
expect_production_lint_failure secret-adapter-credentials "${secret_adapter_values[@]}" --set-string productionSecretSidecar.credentialsSecretName=
expect_production_lint_failure secret-adapter-tls "${secret_adapter_values[@]}" --set-string productionSecretSidecar.tlsSecretName=
expect_production_lint_failure secret-adapter-ca "${secret_adapter_values[@]}" --set-string productionSecretSidecar.caConfigMapName=
expect_production_lint_failure secret-adapter-egress "${secret_adapter_values[@]}" --set-json 'productionSecretSidecar.apiServerCidrs=[]'
expect_production_lint_failure secret-adapter-wildcard "${secret_adapter_values[@]}" --set-string 'productionSecretSidecar.apiServerCidrs[0]=0.0.0.0/0'
expect_production_lint_failure secret-adapter-image "${secret_adapter_values[@]}" --set-string productionSecretSidecar.image=example.test/secret-sidecar:latest
expect_production_lint_failure secret-adapter-url "${secret_adapter_values[@]}" --set-string secretSidecarUrl=https://example.test
render_secret_adapter > "$TOOLS_DIR/rendered-secret-adapter.yaml"
ruby scripts/validate-secret-adapter-render.rb "$TOOLS_DIR/rendered-secret-adapter.yaml"
"$HELM" template wasalx infra/helm/wasalx --values "$PRODUCTION_VALUES_FILE" \
  "${assisted_alpha_values[@]}" "${secret_adapter_values[@]}" > "$TOOLS_DIR/rendered-assisted-secret-adapter.yaml"
ruby scripts/validate-secret-adapter-render.rb "$TOOLS_DIR/rendered-assisted-secret-adapter.yaml"
scoped_namespace=release-fixture-production
"$HELM" template wasalx infra/helm/wasalx --values "$PRODUCTION_VALUES_FILE" "${secret_adapter_values[@]}" \
  --namespace "$scoped_namespace" --set-string "secretSidecarUrl=https://secrets-agent.${scoped_namespace}.svc.cluster.local:8443" \
  --set-string "productionSecretSidecar.storeNamespace=${scoped_namespace}-secrets" > "$TOOLS_DIR/rendered-secret-adapter-scoped.yaml"
ruby scripts/validate-secret-adapter-render.rb "$TOOLS_DIR/rendered-secret-adapter-scoped.yaml"
ruby tests/secret-adapter-readiness.test.rb "$TOOLS_DIR/rendered-secret-adapter.yaml"
if "$HELM" template wasalx infra/helm/wasalx --values "$PRODUCTION_VALUES_FILE" "${secret_adapter_values[@]}" \
  --set-string productionSecretSidecar.storeNamespace=wasalx > "$TOOLS_DIR/invalid-secret-namespace.log" 2>&1; then
  printf 'secret adapter accepted application namespace as secret store\n' >&2
  exit 1
fi
for invalid_api_address in 999.999.999.999/32 192.0.2.10/128; do
  "$HELM" template wasalx infra/helm/wasalx --values "$PRODUCTION_VALUES_FILE" "${secret_adapter_values[@]}" \
    --set-string "productionSecretSidecar.apiServerCidrs[0]=$invalid_api_address" > "$TOOLS_DIR/invalid-secret-address.yaml"
  if ruby scripts/validate-secret-adapter-render.rb "$TOOLS_DIR/invalid-secret-address.yaml"; then
    printf 'invalid secret adapter API address unexpectedly passed\n' >&2
    exit 1
  fi
done
expect_production_lint_failure example-origin --set-string 'allowedOrigins[0]=https://portal.example'
expect_production_lint_failure local-origin --set-string 'allowedOrigins[0]=https://localhost'
expect_production_lint_failure insecure-cookie --set-string 'portalCookieSecure=false'
expect_production_lint_failure observability-disabled --set observability.enabled=false
expect_production_lint_failure alerts-disabled --set observability.prometheusRule.enabled=false
expect_production_lint_failure external-plain-http-api --set-string 'controlApiUrl=http://api.customer.internal:3001'
expect_production_lint_failure example-kms --set-string 'media.s3.kmsKeyId=replace-me'
expect_production_lint_failure local-kms --set-string 'controlPlaneBackup.s3.kmsKeyReference=localhost'
expect_production_lint_failure backup-disabled --set controlPlaneBackup.enabled=false
expect_production_lint_failure provider-disabled --set workspaceProvider.enabled=false
expect_production_lint_failure provisioner-disabled --set provisioner.enabled=false
expect_production_lint_failure controller-policy-disabled --set provisioner.controller.admissionPolicy.enabled=false
expect_production_lint_failure managed-waha-disabled --set managedWaha.enabled=false
expect_production_lint_failure managed-gows-disabled --set managedWaha.gows.enabled=false
expect_production_lint_failure mutable-image --set-string 'worker.image=example.test/connector-worker:latest'
expect_production_lint_failure empty-egress --set-json 'workerAllowedEgressCidrs=[]'
"$HELM" lint infra/helm/wasalx \
  --values "$PRODUCTION_VALUES_FILE" \
  --values infra/helm/wasalx/ci/managed-waha-values.yaml
"$HELM" template wasalx infra/helm/wasalx --set observability.prometheusRule.enabled=true > "$TOOLS_DIR/rendered.yaml"
ruby -e '
require "yaml"
runbook = "docs/runbooks/alert-response.md"
headings = File.read(runbook).scan(/^## ([a-zA-Z0-9 -]+)\r?$/).flatten.map { |title| title.downcase.tr(" ", "-") }.tally
default_url = "https://github.com/WasalX/wasalx-platform/blob/main/#{runbook}"
production_url = YAML.load_file(ARGV[3]).fetch("observability").fetch("prometheusRule").fetch("runbookBaseUrl").delete_suffix("/")
rule_sets = { "Compose" => [YAML.load_file("infra/docker/full/prometheus/alerts.yaml"), default_url] }
[
  ["Helm default", ARGV[0], "PrometheusRule", "wasalx-pilot-observability", default_url],
  ["Helm standard", ARGV[1], "PrometheusRule", "wasalx-pilot-observability", production_url],
  ["Helm assisted alpha", ARGV[2], "ConfigMap", "wasalx-prometheus-rules", production_url]
].each do |label, path, kind, name, url|
  doc = YAML.load_stream(File.read(path)).compact.find { |entry| entry["kind"] == kind && entry.dig("metadata", "name") == name }
  abort "#{label} did not render #{kind}/#{name}" unless doc
  rules = kind == "ConfigMap" ? YAML.safe_load(doc.fetch("data").fetch("wasalx.yaml")) : doc.fetch("spec")
  rule_sets[label] = [rules, url]
end

anchors = {}
rule_sets.each do |label, (rules, expected_url)|
  alerts = rules.fetch("groups").flat_map { |group| group.fetch("rules") }.select { |rule| rule.key?("alert") }
  abort "#{label} has no alert rules" if alerts.empty?
  alerts.each do |rule|
    name = rule.fetch("alert")
    url, anchor = rule.dig("annotations", "runbook_url")&.split("#", 2)
    abort "#{label}: #{name} has no unique heading at #{expected_url}##{anchor}" unless url == expected_url && headings[anchor] == 1
    abort "#{label}: #{name} uses a different anchor" if anchors.fetch(name, anchor) != anchor
    anchors[name] = anchor
  end
end
abort "Every distinct alert must have its own runbook anchor" unless anchors.values.uniq.size == anchors.size
puts "Verified runbook anchors for #{anchors.size} alerts across #{rule_sets.keys.join(", ")}"
' "$TOOLS_DIR/rendered.yaml" "$TOOLS_DIR/rendered-production.yaml" "$TOOLS_DIR/rendered-assisted-alpha.yaml" "$PRODUCTION_VALUES_FILE"
ruby -e '
require "yaml"
require "uri"
docs = YAML.load_stream(File.read(ARGV[0])).compact
origin = URI(docs.find { |d| d["kind"] == "ConfigMap" && d.dig("metadata", "name") == "wasalx-runtime" }.fetch("data").fetch("PORTAL_PUBLIC_ORIGIN"))
host = origin.host + (origin.port == origin.default_port ? "" : ":#{origin.port}")
docs.select { |d| d["kind"] == "Deployment" }.each do |d|
  d.dig("spec", "template", "spec", "containers").each do |c|
    trust = (c["env"] || []).select { |e| e["name"] == "VINEXT_TRUSTED_HOSTS" }
    expected = c["name"] == "portal" ? [{"name" => "VINEXT_TRUSTED_HOSTS", "value" => host}] : []
    abort "incorrect portal proxy trust boundary" unless trust == expected
  end
end
puts "rendered #{docs.length} Kubernetes resources with portal-only proxy trust"
' "$TOOLS_DIR/rendered.yaml"
"$HELM" template wasalx infra/helm/wasalx \
  --namespace wasalx \
  --set 'worker.image=example.test/connector-worker@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' \
  > "$TOOLS_DIR/rendered-external.yaml"
ruby scripts/validate-managed-waha-render.rb "$TOOLS_DIR/rendered-external.yaml" external
"$HELM" template wasalx infra/helm/wasalx \
  --namespace wasalx \
  --values "$PRODUCTION_VALUES_FILE" \
  --values infra/helm/wasalx/ci/managed-waha-values.yaml \
  > "$TOOLS_DIR/rendered-managed-waha.yaml"
ruby scripts/validate-managed-waha-render.rb "$TOOLS_DIR/rendered-managed-waha.yaml"

export TF_DATA_DIR="$TOOLS_DIR/tofu-data"
prepare_tofu_providers "$HOST_PROVIDER_TARGET"
if [[ "$NATIVE_INFRA" == true ]]; then
  prepare_native_tofu
else
  prepare_tofu_providers "linux_${TOOL_ARCH}"
  cp -R "$CACHE_DIR/provider-mirror" "$TOOLS_DIR/provider-mirror"
  printf '%s\n' \
    'provider_installation {' \
    '  filesystem_mirror {' \
    "    path = \"$TOOLS_DIR/provider-mirror\"" \
    '    include = ["registry.opentofu.org/hashicorp/helm", "registry.opentofu.org/hashicorp/kubernetes"]' \
    '  }' \
    '}' > "$TOOLS_DIR/tofurc-host"
  printf '%s\n' \
    'provider_installation {' \
    '  filesystem_mirror {' \
    '    path = "/tools/provider-mirror"' \
    '    include = ["registry.opentofu.org/hashicorp/helm", "registry.opentofu.org/hashicorp/kubernetes"]' \
    '  }' \
    '}' > "$TOOLS_DIR/tofurc-container"
  TOFU_IMAGE="ghcr.io/opentofu/opentofu@sha256:1cdf44e7a44a67c7838ada83c71ad28b4c4e1571b47ad1c5b592624c2c8f35b5"
  docker image inspect "$TOFU_IMAGE" >/dev/null 2>&1 || docker pull "$TOFU_IMAGE"
  container_user="$(id -u):$(id -g)"
  if docker info --format '{{json .SecurityOptions}}' | grep -Fq 'name=rootless'; then
    container_user=0:0
  fi
  TOFU=(docker run --rm --user "$container_user" \
    --env TF_DATA_DIR=/tools/tofu-data \
    --env TF_CLI_CONFIG_FILE=/tools/tofurc-container \
    --volume "$workspace_root:/workspace:ro" \
    --volume "$TOOLS_DIR:/tools" \
    --workdir /workspace \
    "$TOFU_IMAGE")
fi
"${TOFU[@]}" -chdir=infra/terraform fmt -check -recursive
init_terraform
"${TOFU[@]}" -chdir=infra/terraform validate
run_terraform_tests
