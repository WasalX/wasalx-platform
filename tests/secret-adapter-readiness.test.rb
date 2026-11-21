require 'yaml'
require 'tempfile'
require 'open3'

def rejects(validator, documents, expected)
  Tempfile.create(['wasalx-readiness', '.yaml']) do |file|
    documents.each { |document| file.write(YAML.dump(document)) }
    file.flush
    output, status = Open3.capture2e('ruby', validator, file.path)
    abort "invalid readiness configuration accepted: #{validator}" if status.success?
    abort "unexpected rejection: #{output}" unless output.include?(expected)
  end
end

rendered = YAML.load_stream(File.read(ARGV.fetch(0))).compact
policy = rendered.find { |doc| doc['kind'] == 'NetworkPolicy' && doc.dig('metadata', 'name') == 'wasalx-identity-policy-activator-traffic' }
rule = policy.dig('spec', 'egress').find { |entry| entry.dig('to', 0, 'podSelector', 'matchLabels', 'app.kubernetes.io/name') == 'wasalx-keycloak' }
rule['ports'][0]['port'] = 8080
rejects('scripts/validate-secret-adapter-render.rb', rendered, 'private HTTPS identity key egress missing')
puts 'production readiness rejects missing TLS and plaintext identity egress'

rendered = YAML.load_stream(File.read(ARGV.fetch(0))).compact
rendered.reject! { |doc| doc['kind'] == 'Job' && doc.dig('metadata', 'name')&.start_with?('wasalx-control-backup-staging-') }
rejects('scripts/validate-secret-adapter-render.rb', rendered, 'missing backup staging consumer')
puts 'production readiness rejects backup staging without an initial consumer'

rendered = YAML.load_stream(File.read(ARGV.fetch(0))).compact
backup = rendered.find { |doc| doc['kind'] == 'CronJob' && doc.dig('metadata', 'name') == 'wasalx-control-backup' }
container = backup.dig('spec', 'jobTemplate', 'spec', 'template', 'spec', 'containers').first
container.fetch('volumeMounts').find { |entry| entry['name'] == 'staging' }['mountPath'] = '/var/backups/wasalx/control-plane'
rejects('scripts/validate-secret-adapter-render.rb', rendered, 'backup output must be a private child of staging')
puts 'production readiness rejects backup chmod on a root-owned volume mount'

rendered = YAML.load_stream(File.read(ARGV.fetch(0))).compact
identity = rendered.find { |doc| doc['kind'] == 'NetworkPolicy' && doc.dig('metadata', 'name') == 'wasalx-private-identity-egress' }
identity['spec']['egress'][0]['ports'][0]['port'] = 8080
rejects('scripts/validate-secret-adapter-render.rb', rendered, 'private identity egress must use Keycloak TLS')

rendered = YAML.load_stream(File.read(ARGV.fetch(0))).compact
config = rendered.find { |doc| doc['kind'] == 'ConfigMap' && doc.fetch('data', {}).key?('OIDC_ISSUER') }.fetch('data')
config['OIDC_ISSUER'] = 'https://example.test/identity/realms/wasalx'
config['OIDC_TOKEN_ENDPOINT'] = 'https://example.test/identity/realms/wasalx/protocol/openid-connect/token'
rejects('scripts/validate-secret-adapter-render.rb', rendered, 'production identity backchannel must use private HTTPS')
puts 'production readiness rejects unreachable public backchannels and plaintext private egress'
