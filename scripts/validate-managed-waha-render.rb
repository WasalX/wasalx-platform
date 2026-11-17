# frozen_string_literal: true

require "json"
require "yaml"

path = ARGV.fetch(0)
mode = ARGV.fetch(1, "managed")
documents = YAML.load_stream(File.read(path)).compact
abort "managed WAHA render is empty" if documents.empty?
retry_environment = %w[WAHA_DELIVERY_MAX_ATTEMPTS META_DELIVERY_MAX_ATTEMPTS ZAMMAD_STATUS_MAX_ATTEMPTS]
rollout_gate = documents.find do |document|
  document["kind"] == "Job" && document.dig("metadata", "name") == "wasalx-waha-rollout-gate"
end
abort "WAHA rollout gate Job missing" unless rollout_gate
abort "WAHA rollout gate must bound startup without replaying the Job" unless rollout_gate.dig("spec", "activeDeadlineSeconds") == 90 && rollout_gate.dig("spec", "backoffLimit") == 0
gate_annotations = rollout_gate.dig("metadata", "annotations")
abort "WAHA rollout gate is not a Helm pre-sync hook" unless gate_annotations["helm.sh/hook"] == "pre-install,pre-upgrade" && gate_annotations["helm.sh/hook-weight"] == "-4"
abort "WAHA rollout gate is not an Argo pre-sync hook" unless gate_annotations["argocd.argoproj.io/hook"] == "PreSync" && gate_annotations["argocd.argoproj.io/sync-wave"] == "-4"
gate_container = rollout_gate.dig("spec", "template", "spec", "containers", 0)
gate_environment = gate_container.fetch("env").to_h { |entry| [entry["name"], entry] }
abort "WAHA rollout gate does not use its dedicated database Secret" unless gate_environment.dig("WAHA_ROLLOUT_GATE_DATABASE_URL", "valueFrom", "secretKeyRef", "key") == "WAHA_ROLLOUT_GATE_DATABASE_URL"
abort "WAHA rollout gate image is not digest-pinned" unless gate_container.fetch("image").match?(/@sha256:[0-9a-f]{64}\z/)

if mode == "external"
  abort "external rollout gate desired non-empty workers" unless JSON.parse(gate_environment.fetch("WAHA_DESIRED_MANAGED_WORKERS_JSON").fetch("value")) == []
  abort "external mode rendered managed StatefulSets" if documents.any? { |document| document["kind"] == "StatefulSet" }
  abort "external mode rendered managed registry" if documents.any? { |document| document["kind"] == "Secret" && document.dig("metadata", "name") == "wasalx-managed-waha-registry" }
  deployments = documents.select { |document| document["kind"] == "Deployment" }.to_h do |deployment|
    [deployment.dig("metadata", "name"), deployment]
  end
  environment_names = lambda do |name|
    deployments.fetch(name).dig("spec", "template", "spec", "containers", 0, "env").map { |entry| entry["name"] }
  end
  abort "portal received external WAHA infrastructure" if environment_names.call("wasalx-portal").any? { |name| name.start_with?("WAHA_") }
  abort "external connector fallback missing" unless environment_names.call("wasalx-worker").include?("WAHA_BASE_URL")
  abort "external connector secret reference missing" unless environment_names.call("wasalx-worker").include?("WAHA_ADMIN_SECRET_REFERENCE")
  abort "external connector retry bounds missing" unless retry_environment.all? { |name| environment_names.call("wasalx-worker").include?(name) }
  external_worker_environment = deployments.fetch("wasalx-worker").dig("spec", "template", "spec", "containers", 0, "env").to_h { |entry| [entry["name"], entry["value"]] }
  abort "external connector retry defaults are not eight" unless retry_environment.all? { |name| external_worker_environment[name] == "8" }
  abort "external API received a WAHA endpoint" if environment_names.call("wasalx-api").include?("WAHA_BASE_URL")
  abort "external non-connector received delivery retries" if %w[wasalx-portal wasalx-api wasalx-invitation-mailer wasalx-identity-policy-activator].any? { |name| (environment_names.call(name) & retry_environment).any? }
  puts "verified external WAHA mode without managed infrastructure"
  exit
end
abort "unknown WAHA render validation mode" unless mode == "managed"
expected_gate_workers = %w[managed-gows-0 managed-gows-1 managed-noweb-0]
desired_gate_workers = JSON.parse(gate_environment.fetch("WAHA_DESIRED_MANAGED_WORKERS_JSON").fetch("value"))
abort "managed rollout gate desired keys are incomplete" unless desired_gate_workers.map { |worker| worker.fetch("workerKey") }.sort == expected_gate_workers

stateful_sets = documents.select { |document| document["kind"] == "StatefulSet" }
abort "expected three managed WAHA StatefulSets" unless stateful_sets.length == 3

registry = documents.find do |document|
  document["kind"] == "Secret" &&
    document.dig("metadata", "name") == "wasalx-managed-waha-registry"
end
abort "managed WAHA registry Secret missing" unless registry
workers = JSON.parse(registry.dig("stringData", "WAHA_WORKERS_JSON").to_s)
registry_identities = workers.map { |worker| worker.slice("workerKey", "engine", "baseUrl", "secretReference") }
abort "rollout gate identity set differs from connector registry" unless desired_gate_workers == registry_identities
abort "registry/StatefulSet cardinality mismatch" unless workers.length == stateful_sets.length
abort "managed worker keys are not unique" unless workers.map { |worker| worker.fetch("workerKey") }.uniq.length == workers.length
abort "managed worker endpoints are not unique" unless workers.map { |worker| worker.fetch("baseUrl") }.uniq.length == workers.length
abort "managed secret references are not unique" unless workers.map { |worker| worker.fetch("secretReference") }.uniq.length == workers.length
abort "managed worker endpoint escaped cluster DNS" unless workers.all? { |worker| worker.fetch("baseUrl").match?(%r{\Ahttp://[^/]+\.wasalx\.svc\.cluster\.local:3000/\z}) }
abort "managed engines are incomplete" unless workers.map { |worker| worker.fetch("engine") }.uniq.sort == %w[GOWS NOWEB]
abort "canary limit missing" unless workers.one? { |worker| worker["rolloutMode"] == "CANARY" && worker["canarySessionLimit"] == 5 }

stateful_sets.each do |stateful_set|
  container = stateful_set.dig("spec", "template", "spec", "containers", 0)
  pod_security = stateful_set.dig("spec", "template", "spec", "securityContext")
  abort "managed WAHA image is not digest-pinned" unless container.fetch("image").match?(/@sha256:[0-9a-f]{64}\z/)
  abort "managed WAHA is not OnDelete" unless stateful_set.dig("spec", "updateStrategy", "type") == "OnDelete"
  abort "managed WAHA PVC is not retained" unless stateful_set.dig("spec", "persistentVolumeClaimRetentionPolicy") == { "whenDeleted" => "Retain", "whenScaled" => "Retain" }
  abort "managed WAHA service account token is mounted" unless stateful_set.dig("spec", "template", "spec", "automountServiceAccountToken") == false
  abort "managed WAHA pod is not non-root" unless pod_security["runAsNonRoot"] == true
  abort "managed WAHA pod lacks RuntimeDefault seccomp" unless pod_security.dig("seccompProfile", "type") == "RuntimeDefault"
  abort "managed WAHA container is not non-root" unless container.dig("securityContext", "runAsNonRoot") == true
  abort "managed WAHA container permits privilege escalation" unless container.dig("securityContext", "allowPrivilegeEscalation") == false
  abort "managed WAHA container retains capabilities" unless container.dig("securityContext", "capabilities", "drop").include?("ALL")
  abort "managed WAHA API key is not Secret-backed" unless container.fetch("env").any? { |entry| entry["name"] == "WAHA_API_KEY" && entry.dig("valueFrom", "secretKeyRef", "key") == "WAHA_API_KEY" }
  abort "managed WAHA health path is not safely probeable" unless container.fetch("env").any? { |entry| entry == { "name" => "WAHA_API_KEY_EXCLUDE_PATH", "value" => "health" } }
  abort "managed WAHA session volume missing" unless container.fetch("volumeMounts").any? { |mount| mount == { "name" => "sessions", "mountPath" => "/app/.sessions" } }
  %w[startupProbe readinessProbe livenessProbe].each do |probe|
    abort "managed WAHA #{probe} missing" unless container[probe]
  end
end

protected_resources = documents.select do |document|
  %w[StatefulSet Service PodDisruptionBudget].include?(document["kind"]) &&
    document.dig("metadata", "labels", "app.kubernetes.io/component") == "waha"
end
abort "managed WAHA prune protection is incomplete" unless protected_resources.length == stateful_sets.length * 3
protected_resources.each do |resource|
  annotations = resource.dig("metadata", "annotations")
  abort "managed WAHA Helm prune protection missing" unless annotations["helm.sh/resource-policy"] == "keep"
  abort "managed WAHA Argo prune protection missing" unless annotations["argocd.argoproj.io/sync-options"] == "Prune=false"
  abort "managed WAHA Flux prune protection missing" unless annotations["kustomize.toolkit.fluxcd.io/prune"] == "disabled"
end

deployments = documents.select { |document| document["kind"] == "Deployment" }.to_h do |deployment|
  [deployment.dig("metadata", "name"), deployment]
end
environment_names = lambda do |name|
  deployments.fetch(name).dig("spec", "template", "spec", "containers", 0, "env").map { |entry| entry["name"] }
end
abort "portal received WAHA infrastructure" if environment_names.call("wasalx-portal").any? { |name| name.start_with?("WAHA_") }
abort "API received WAHA registry" if environment_names.call("wasalx-api").include?("WAHA_WORKERS_JSON")
abort "connector did not receive WAHA registry" unless environment_names.call("wasalx-worker").include?("WAHA_WORKERS_JSON")
abort "connector retry bounds missing" unless retry_environment.all? { |name| environment_names.call("wasalx-worker").include?(name) }
worker_environment = deployments.fetch("wasalx-worker").dig("spec", "template", "spec", "containers", 0, "env").to_h { |entry| [entry["name"], entry["value"]] }
abort "connector retry defaults are not eight" unless retry_environment.all? { |name| worker_environment[name] == "8" }
abort "non-connector received delivery retries" if %w[wasalx-portal wasalx-api wasalx-invitation-mailer wasalx-identity-policy-activator].any? { |name| (environment_names.call(name) & retry_environment).any? }

runtime = documents.find do |document|
  document["kind"] == "ConfigMap" && document.dig("metadata", "name") == "wasalx-runtime"
end
abort "shared ConfigMap received WAHA infrastructure" if runtime.fetch("data").keys.any? { |name| name.start_with?("WAHA_") }

puts "verified #{stateful_sets.length} managed WAHA StatefulSets and connector-only registry injection"
