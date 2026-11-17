require 'yaml'
require 'ipaddr'
docs = YAML.load_stream(File.read(ARGV.fetch(0))).compact
find = ->(kind, name) { docs.find { |d| d['kind'] == kind && d.dig('metadata', 'name') == name } || abort("missing #{kind}/#{name}") }
deployment = find.call('Deployment', 'wasalx-secret-adapter')
pod = deployment.dig('spec', 'template', 'spec')
container = pod.fetch('containers').fetch(0)
abort 'adapter identity' unless pod['serviceAccountName'] == 'wasalx-secret-adapter' && pod['automountServiceAccountToken'] == false
abort 'adapter isolation' unless container.dig('securityContext', 'readOnlyRootFilesystem') && container.dig('securityContext', 'allowPrivilegeEscalation') == false
abort 'mutable image' unless container.fetch('image').match?(/@sha256:[0-9a-f]{64}$/)
abort 'missing projected token' unless pod.fetch('volumes').any? { |v| v.dig('projected', 'sources')&.any? { |s| s.dig('serviceAccountToken', 'expirationSeconds') == 600 } }
abort 'public service' unless find.call('Service', 'secrets-agent').dig('spec', 'type').nil?
policy = find.call('NetworkPolicy', 'wasalx-secret-adapter').fetch('spec')
abort 'missing default isolation' unless policy['policyTypes'].sort == %w[Egress Ingress]
allowed = policy.dig('ingress', 0, 'from', 0, 'podSelector', 'matchExpressions', 0, 'values')
abort 'unexpected callers' unless allowed.sort == %w[wasalx-api wasalx-invitation-mailer wasalx-worker]
client = find.call('NetworkPolicy', 'wasalx-secret-adapter-clients')
abort 'missing return egress' unless client.dig('spec', 'egress', 0, 'ports') == [{ 'protocol' => 'TCP', 'port' => 8443 }]
policy.fetch('egress').flat_map { |rule| rule.fetch('to') }.filter_map { |entry| entry.dig('ipBlock', 'cidr') }.each do |cidr|
  address, prefix = cidr.split('/')
  begin
    ip = IPAddr.new(address)
    abort 'API egress must be a single host' unless prefix == (ip.ipv4? ? '32' : '128')
  rescue IPAddr::InvalidAddressError
    abort 'invalid API address'
  end
end
%w[portal api worker invitation-mailer identity-policy-activator].each do |name|
  client_pod = find.call('Deployment', "wasalx-#{name}").dig('spec', 'template', 'spec')
  env = client_pod.fetch('containers').first.fetch('env')
  abort 'missing client CA trust' unless env.any? { |e| e['name'] == 'NODE_EXTRA_CA_CERTS' && e['value'] == '/secret-adapter-ca/ca.crt' }
  abort 'missing CA volume' unless client_pod.fetch('volumes').any? { |v| v['name'] == 'secret-adapter-ca' && v.dig('configMap', 'name') }
  abort 'writer credential leaked' if name != 'api' && env.any? { |e| e['name'] == 'SECRET_SIDECAR_WRITE_TOKEN' }
end
migration = docs.find { |doc| doc['kind'] == 'Job' && doc.dig('metadata', 'name')&.start_with?('wasalx-migrate-') } || abort('missing migration Job')
migration_pod = migration.dig('spec', 'template', 'spec')
abort 'missing migration CA trust' unless migration_pod.dig('containers', 0, 'env')&.any? { |e| e['name'] == 'NODE_EXTRA_CA_CERTS' && e['value'] == '/secret-adapter-ca/ca.crt' }
abort 'missing migration CA volume' unless migration_pod.fetch('volumes').any? { |v| v['name'] == 'secret-adapter-ca' && v.dig('configMap', 'name') }
ca_name = migration_pod.fetch('volumes').find { |v| v['name'] == 'secret-adapter-ca' }.dig('configMap', 'name')
gate = find.call('Job', 'wasalx-waha-rollout-gate')
admission = docs.find { |d| d['kind'] == 'Job' && d.dig('metadata', 'labels', 'app.kubernetes.io/component') == 'commercial-go-admission' }
profile = find.call('ConfigMap', 'wasalx-runtime').dig('data', 'WASALX_DEPLOYMENT_PROFILE')
abort 'missing commercial admission' if profile != 'assisted-alpha' && !admission
[migration, gate, admission].compact.each do |job|
  job_pod = job.dig('spec', 'template', 'spec')
  client = job_pod.fetch('containers').first
  name = job.dig('metadata', 'name')
  abort "missing readonly database CA mount: #{name}" unless client.fetch('volumeMounts').any? { |m| m == { 'name' => 'secret-adapter-ca', 'mountPath' => '/secret-adapter-ca', 'readOnly' => true } }
  abort "incorrect database CA source: #{name}" unless job_pod.fetch('volumes').any? { |v| v['name'] == 'secret-adapter-ca' && v.dig('configMap', 'name') == ca_name && v.dig('configMap', 'items') == [{ 'key' => 'ca.crt', 'path' => 'ca.crt' }] }
  expected_trust = job == admission ? '/var/run/secrets/wasalx-kubernetes/ca.crt' : '/secret-adapter-ca/ca.crt'
  abort "incorrect runtime CA trust: #{name}" unless client.fetch('env').any? { |e| e['name'] == 'NODE_EXTRA_CA_CERTS' && e['value'] == expected_trust }
end
policy.fetch('egress').select { |rule| rule.fetch('to').any? { |entry| entry['ipBlock'] } }.each do |rule|
  abort 'unexpected Kubernetes API ports' unless rule.fetch('ports') == [{ 'protocol' => 'TCP', 'port' => 443 }, { 'protocol' => 'TCP', 'port' => 6443 }]
end
identity_egress = find.call('NetworkPolicy', 'wasalx-identity-policy-activator-traffic').dig('spec', 'egress')
identity_rule = { 'to' => [{ 'podSelector' => { 'matchLabels' => { 'app.kubernetes.io/name' => 'wasalx-keycloak' } } }], 'ports' => [{ 'protocol' => 'TCP', 'port' => 8443 }] }
abort 'private HTTPS identity key egress missing' unless identity_egress.include?(identity_rule)
backup = docs.find { |doc| doc['kind'] == 'CronJob' && doc.dig('metadata', 'name') == 'wasalx-control-backup' }
if backup
  staging = docs.find { |doc| doc['kind'] == 'Job' && doc.dig('metadata', 'name')&.start_with?('wasalx-control-backup-staging-') } || abort('missing backup staging consumer')
  staging_pod = staging.dig('spec', 'template', 'spec')
  staging_container = staging_pod.fetch('containers').first
  backup_container = backup.dig('spec', 'jobTemplate', 'spec', 'template', 'spec', 'containers').first
  mount = backup_container.fetch('volumeMounts').find { |entry| entry['name'] == 'staging' }.fetch('mountPath')
  output = backup_container.fetch('env').find { |entry| entry['name'] == 'CONFIGURATOR_OUTPUT_DIRECTORY' }.fetch('value')
  abort 'backup output must be a private child of staging' unless mount == '/var/backups/wasalx' && output == "#{mount}/control-plane"
  abort 'backup staging must verify private directory ownership' unless staging_container.fetch('args').join.include?("fs.chmodSync(output, 0o700)")
  abort 'backup staging must be persistent' unless staging_pod.fetch('volumes') == [{ 'name' => 'staging', 'persistentVolumeClaim' => { 'claimName' => 'wasalx-control-backup-staging' } }]
  abort 'backup staging must use backup image' unless staging_container['image'] == backup.dig('spec', 'jobTemplate', 'spec', 'template', 'spec', 'containers', 0, 'image')
  abort 'backup staging must be bounded and unprivileged' unless staging.dig('spec', 'backoffLimit') == 0 && staging.dig('spec', 'activeDeadlineSeconds') == 120 && staging_pod['automountServiceAccountToken'] == false && staging_pod.dig('securityContext', 'runAsUser') == 1000 && staging_container.dig('securityContext', 'readOnlyRootFilesystem') == true && !staging_container.key?('envFrom') && !staging_container.key?('env')
end
identity = find.call('NetworkPolicy', 'wasalx-private-identity-egress').fetch('spec')
abort 'private identity callers must be portal and API only' unless identity.dig('podSelector', 'matchExpressions') == [{ 'key' => 'app.kubernetes.io/name', 'operator' => 'In', 'values' => %w[wasalx-portal wasalx-api] }]
abort 'private identity egress must use Keycloak TLS' unless identity['egress'] == [{ 'to' => [{ 'podSelector' => { 'matchLabels' => { 'app.kubernetes.io/name' => 'wasalx-keycloak' } } }], 'ports' => [{ 'protocol' => 'TCP', 'port' => 8443 }] }]
config = docs.find { |doc| doc['kind'] == 'ConfigMap' && doc.fetch('data', {}).key?('OIDC_ISSUER') }.fetch('data')
{ 'OIDC' => 'wasalx', 'PLATFORM_OPERATOR_OIDC' => 'wasalx-platform' }.each do |prefix, realm|
  next unless config["#{prefix}_ISSUER"] == "https://example.test/identity/realms/#{realm}"
  { 'TOKEN_ENDPOINT' => 'token', 'JWKS_URI' => 'certs' }.each do |key, endpoint|
    abort 'production identity backchannel must use private HTTPS' unless config["#{prefix}_#{key}"] == "https://wasalx-keycloak:8443/identity/realms/#{realm}/protocol/openid-connect/#{endpoint}"
  end
end
puts 'production secret adapter rendering verified'
