#!/usr/bin/env ruby
require 'uri'

def prepare_temporary_directory(path)
  return if Dir.exist?(path)

  Dir.mkdir(path, 0o770)
  File.chmod(0o2770, path)
end

# Translate the existing database secret for the upstream startup probe.
def database_environment(value, command = nil)
  raise ArgumentError if value.match?(/%(?![0-9a-fA-F]{2})/)
  uri = URI.parse(value)
  raise ArgumentError unless %w[postgres postgresql].include?(uri.scheme) && uri.fragment.nil?
  decode = ->(part) { URI::DEFAULT_PARSER.unescape(part.to_s) }
  fields = {
    'POSTGRESQL_HOST' => uri.hostname,
    'POSTGRESQL_PORT' => (uri.port || 5432).to_s,
    'POSTGRESQL_DB' => decode.call(uri.path.to_s.delete_prefix('/')),
    'POSTGRESQL_USER' => decode.call(uri.user),
    'POSTGRESQL_PASS' => decode.call(uri.password)
  }
  raise ArgumentError unless fields.values.all? { |part| part && !part.empty? && !part.match?(/[\x00-\x1f\x7f]/) }
  raise ArgumentError unless (1..65_535).cover?(Integer(fields.fetch('POSTGRESQL_PORT')))
  raise ArgumentError if fields.fetch('POSTGRESQL_DB').include?('/')
  pairs = URI.decode_www_form(uri.query.to_s)
  raise ArgumentError unless pairs.map(&:first).uniq.length == pairs.length
  options = pairs.to_h
  raise ArgumentError unless (options.keys - %w[pool sslmode sslrootcert]).empty?
  raise ArgumentError unless options['sslmode'] == 'verify-full' && options['sslrootcert']&.start_with?('/')
  raise ArgumentError if options.values.any? { |part| part.match?(/[\x00-\x1f\x7f]/) }
  raise ArgumentError if options['pool'] && !options['pool'].match?(/\A[1-9][0-9]*\z/)
  # Scheduled jobs run concurrently; use Zammad's documented pool only for this process.
  if command == 'zammad-scheduler' && !options.key?('pool')
    options['pool'] = '50'
    uri.query = URI.encode_www_form(options)
    fields['DATABASE_URL'] = uri.to_s
  end
  fields.merge('POSTGRESQL_OPTIONS' => "?#{URI.encode_www_form(options)}",
               'PGSSLMODE' => options.fetch('sslmode'), 'PGSSLROOTCERT' => options.fetch('sslrootcert'))
rescue ArgumentError, URI::Error
  raise ArgumentError, 'Invalid Zammad database configuration', cause: nil
end

if $PROGRAM_NAME == __FILE__
  prepare_temporary_directory(ENV['TMP']) if ENV['TMP'] == '/opt/zammad/tmp/wasalx'
  begin
    ENV.update(database_environment(ENV.fetch('DATABASE_URL'), ARGV.first)) if ENV.key?('DATABASE_URL')
  rescue ArgumentError
    abort 'Invalid Zammad database configuration'
  end
  exec('/opt/zammad/bin/docker-entrypoint', *ARGV)
end
