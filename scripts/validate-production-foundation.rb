#!/usr/bin/env ruby
require 'yaml'
require 'json'

documents = YAML.load_stream(File.read(ARGV.fetch(0, ENV.fetch("WASALX_FOUNDATION_MANIFEST")))).compact
find = ->(kind, name) { documents.find { |doc| doc['kind'] == kind && doc.dig('metadata', 'name') == name } || abort("missing #{kind} #{name}") }

%w[postgres redis minio clamav keycloak otel-collector].each { |component| find.call('Service', "wasalx-#{component}") }
workloads = documents.select { |doc| %w[Deployment StatefulSet Job].include?(doc['kind']) }
workloads.each do |workload|
  workload.dig('spec', 'template', 'spec').fetch('containers').each do |container|
    abort "unpinned image in #{workload.dig('metadata', 'name')}" unless container.fetch('image').match?(/@sha256:[0-9a-f]{64}\z/)
  end
end
redis_image = find.call('StatefulSet', 'wasalx-redis').dig('spec', 'template', 'spec', 'containers', 0, 'image')
redis_placeholder = "ghcr.io/wasalx/wasalx/zammad-redis@sha256:#{'0' * 64}"
abort 'foundation Redis must fail closed until bound to the signed release image' unless redis_image == redis_placeholder

foundation = workloads.reject { |workload| workload['kind'] == 'Job' }
abort 'foundation readiness labels are incomplete' unless foundation.all? { |workload| workload.dig('spec', 'template', 'metadata', 'labels', 'wasalx.io/foundation') == 'true' }
abort 'bootstrap Jobs must not block readiness selection' unless workloads.select { |workload| workload['kind'] == 'Job' }.none? { |workload| workload.dig('spec', 'template', 'metadata', 'labels', 'wasalx.io/foundation') }

claims = documents.select { |doc| doc['kind'] == 'PersistentVolumeClaim' }.map { |doc| doc.dig('spec', 'resources', 'requests', 'storage') }
claims.concat(documents.select { |doc| doc['kind'] == 'StatefulSet' }.flat_map { |doc| doc.dig('spec', 'volumeClaimTemplates').map { |claim| claim.dig('spec', 'resources', 'requests', 'storage') } })
gib = claims.sum { |size| Integer(size.delete_suffix('Gi')) }
budget = Integer(ENV.fetch("WASALX_FOUNDATION_STORAGE_BUDGET_GIB"))
abort "foundation storage exceeds the configured budget" unless budget.positive? && gib <= budget
abort 'foundation manifest must not contain credential Secret values' if documents.any? { |doc| doc['kind'] == 'Secret' }

keycloak_pod = find.call('Deployment', 'wasalx-keycloak').dig('spec', 'template', 'spec')
keycloak = keycloak_pod.fetch('containers').first
keycloak_env = keycloak.fetch('env').to_h { |entry| [entry['name'], entry['value']] }
{
  'KC_HTTP_ENABLED' => 'true',
  'KC_HOSTNAME' => ENV.fetch("WASALX_IDENTITY_ORIGIN"),
  'KC_HTTPS_CERTIFICATE_FILE' => '/https-tls/tls.crt',
  'KC_HTTPS_CERTIFICATE_KEY_FILE' => '/https-tls/tls.key'
}.each { |name, value| abort "incorrect Keycloak #{name}" unless keycloak_env[name] == value }
abort 'Keycloak private TLS key mount missing' unless keycloak.fetch('volumeMounts').include?({ 'name' => 'https-tls', 'mountPath' => '/https-tls', 'readOnly' => true })
abort 'Keycloak distinct TLS Secret missing' unless keycloak_pod.fetch('volumes').include?({ 'name' => 'https-tls', 'secret' => { 'secretName' => 'wasalx-keycloak-tls', 'defaultMode' => 0440 } })
%w[http https].zip([8080, 8443]).each do |name, port|
  abort "Keycloak #{name} listener missing" unless keycloak.fetch('ports').include?({ 'name' => name, 'containerPort' => port })
  abort "Keycloak #{name} Service missing" unless find.call('Service', 'wasalx-keycloak').dig('spec', 'ports').include?({ 'name' => name, 'port' => port, 'targetPort' => name })
end
values = YAML.load_file(ENV.fetch("WASALX_PRODUCTION_VALUES"))
abort 'production API egress must cover Service and post-DNAT endpoint only' unless values.dig('productionSecretSidecar', 'apiServerCidrs').sort == JSON.parse(ENV.fetch("WASALX_API_SERVER_CIDRS")).sort
bootstrap = File.read(ENV.fetch("WASALX_FOUNDATION_BOOTSTRAP"))
abort 'private HTTPS identity keys missing' unless bootstrap.include?("IDENTITY_POLICY_ATTESTATION_JWKS_URI=#{ENV.fetch('WASALX_IDENTITY_JWKS_URI')}")
abort 'public identity issuer changed' unless bootstrap.include?("IDENTITY_POLICY_ATTESTATION_ISSUER=#{ENV.fetch('WASALX_IDENTITY_ISSUER')}")
abort 'Keycloak certificate bootstrap missing' unless bootstrap.include?(ENV.fetch("WASALX_KEYCLOAK_CERTIFICATE_COMMAND")) && bootstrap.include?(ENV.fetch("WASALX_KEYCLOAK_TLS_SECRET_COMMAND"))

monitoring = YAML.load_stream(File.read(ENV.fetch("WASALX_MONITORING_MANIFEST"))).compact
monitoring.select { |doc| doc['kind'] == 'Deployment' }.each do |deployment|
  deployment.dig('spec', 'template', 'spec', 'containers').each do |container|
    abort "unpinned monitoring image in #{deployment.dig('metadata', 'name')}" unless container.fetch('image').match?(/@sha256:[0-9a-f]{64}\z/)
  end
end
abort 'monitoring must remain private' if monitoring.any? { |doc| doc['kind'] == 'Ingress' || doc.dig('spec', 'type') == 'LoadBalancer' }

puts "production foundation verified: #{documents.length} objects, #{gib}Gi persistent storage"
