require 'yaml'

path, profile = ARGV
expected_count = { 'assisted-alpha' => 1, 'standard' => 2 }[profile]
abort 'Usage: ruby scripts/validate-migration-render.rb MANIFEST {assisted-alpha|standard}' unless ARGV.length == 2 && expected_count

begin
  documents = YAML.parse_stream(File.read(path), filename: path).children.map do |document|
    stream = Psych::Nodes::Stream.new
    stream.children << document
    YAML.safe_load(stream.to_yaml)
  end
  jobs = documents.select do |document|
    next false unless document.is_a?(Hash) && document['kind'] == 'Job'

    name = document.dig('metadata', 'name')
    name.is_a?(String) && name.include?('migrate')
  end
rescue SystemCallError, Psych::Exception, TypeError => error
  abort "#{profile}: invalid migration render: #{error.message}"
end

abort "#{profile}: expected #{expected_count} migration Jobs, found #{jobs.length}" unless jobs.length == expected_count

jobs.each do |job|
  name = job.dig('metadata', 'name')
  abort "#{profile}: #{name}: spec.backoffLimit must be 0" unless 0.eql?(job.dig('spec', 'backoffLimit'))
  abort "#{profile}: #{name}: spec.template.spec.restartPolicy must be Never" unless job.dig('spec', 'template', 'spec', 'restartPolicy') == 'Never'
  abort "#{profile}: #{name}: spec.activeDeadlineSeconds must be 720" unless 720.eql?(job.dig('spec', 'activeDeadlineSeconds'))

  hook = job.dig('metadata', 'annotations', 'helm.sh/hook')
  unless hook.is_a?(String) && (%w[pre-install pre-upgrade] - hook.split(',').map(&:strip)).empty?
    abort "#{profile}: #{name}: helm.sh/hook must include pre-install and pre-upgrade"
  end
rescue TypeError
  abort "#{profile}: #{name}: expected mappings in Job spec and annotations"
end

puts "#{profile}: verified #{jobs.length} migration Jobs"
