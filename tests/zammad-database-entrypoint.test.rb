require 'rbconfig'
require 'tmpdir'
wrapper = ARGV[0] || File.expand_path('../infra/docker/full/zammad/entrypoint.rb', __dir__)
load(wrapper)

Dir.mktmpdir('wasalx-entrypoint-') do |parent|
  path = File.join(parent, 'private-tmp')
  prepare_temporary_directory(path)
  prepare_temporary_directory(path)
  raise unless File.directory?(path)
  raise unless Gem.win_platform? || (File.stat(path).mode & 0o7777) == 0o2770
end

url = "postgresql://fixture:placeholder@db.example.test:5432/example_db"
fields = database_environment(url)
raise unless fields.values_at('POSTGRESQL_HOST', 'POSTGRESQL_PORT', 'POSTGRESQL_DB', 'POSTGRESQL_USER', 'POSTGRESQL_PASS') ==
             ['db.example', '5433', 'tenant', 'user+name', 'p@ss+word']
raise unless fields['PGSSLMODE'] == 'verify-full' && fields['PGSSLROOTCERT'] == '/run/ca.crt'
raise unless URI.decode_www_form(fields['POSTGRESQL_OPTIONS'].delete_prefix('?')).to_h['pool'] == '50'
raise unless database_environment(url.sub(':5433', ''))['POSTGRESQL_PORT'] == '5432'
without_pool = url.sub('pool=50&', '')
scheduler = database_environment(without_pool, 'zammad-scheduler')
raise unless URI.decode_www_form(URI.parse(scheduler.fetch('DATABASE_URL')).query).to_h ==
             { 'sslmode' => 'verify-full', 'sslrootcert' => '/run/ca.crt', 'pool' => '50' }
raise unless scheduler['DATABASE_URL'].start_with?("postgresql://fixture:placeholder@db.example.test:5432/example_db")
raise unless database_environment(scheduler['DATABASE_URL'])['POSTGRESQL_OPTIONS'] == scheduler['POSTGRESQL_OPTIONS']
raise unless database_environment(url.sub('pool=50', 'pool=23'), 'zammad-scheduler')['POSTGRESQL_OPTIONS'].include?('pool=23')
%w[zammad-init zammad-railsserver zammad-websocket].each do |command|
  unchanged = database_environment(without_pool, command)
  raise if unchanged.key?('DATABASE_URL') || unchanged['POSTGRESQL_OPTIONS'].include?('pool=')
end
[
  '', 'not a URL', url.sub('postgresql:', 'https:'), url.sub('verify-full', 'disable'),
  url + '&sslmode=verify-full', url + '&unknown=value', url.sub('user%2Bname', ''),
  url.sub('p%40ss%2Bword', ''), url.sub('/tenant?', '/?'), url.sub(':5433', ':70000'),
  url.sub('p%40ss%2Bword', 'secret%00value'), url.sub('pool=50', 'pool=oops'),
  url.sub('/tenant?', '/tenant%2Fother?'), url.sub('p%40ss%2Bword', 'secret%ZZ'), url + '&pool=50'
].each do |invalid|
  begin
    database_environment(invalid, 'zammad-scheduler')
  rescue ArgumentError => error
    raise unless error.message == 'Invalid Zammad database configuration'
    next
  end
  raise 'Invalid configuration was accepted'
end
probe = <<~'RUBY'
  def exec(*args)
    raise unless args == ['/opt/zammad/bin/docker-entrypoint', 'zammad-init', 'argument with spaces']
    expected = ENV.key?('DATABASE_URL') ? 'db.example' : 'native.example'
    raise unless ENV['POSTGRESQL_HOST'] == expected
    exit 0
  end
  $PROGRAM_NAME = ARGV.shift
  load($PROGRAM_NAME)
RUBY
[nil, url].each do |value|
  raise 'Entrypoint delegation failed' unless system(
    { 'DATABASE_URL' => value, 'POSTGRESQL_HOST' => 'native.example' },
    RbConfig.ruby, '-e', probe, wrapper, 'zammad-init', 'argument with spaces'
  )
end
scheduler_probe = <<~'RUBY'
  def exec(*args)
    raise unless args == ['/opt/zammad/bin/docker-entrypoint', 'zammad-scheduler']
    pool = URI.decode_www_form(URI.parse(ENV.fetch('DATABASE_URL')).query).to_h.fetch('pool')
    raise unless pool == '50' && ENV.fetch('POSTGRESQL_OPTIONS').include?('pool=50')
    exit 0
  end
  $PROGRAM_NAME = ARGV.shift
  load($PROGRAM_NAME)
RUBY
raise 'Scheduler pool was not applied before delegation' unless system(
  { 'DATABASE_URL' => without_pool }, RbConfig.ruby, '-e', scheduler_probe, wrapper, 'zammad-scheduler'
)
puts 'Zammad database entrypoint contracts passed'
