# Actual installed native drivers, synthetic transport only. No product transport doubles.
require 'json'
require 'net/http'
require 'openssl'
require 'securerandom'
require 'timeout'
raise 'Isolated mailbox transport fixture required' unless ENV['WASALX_ADMIN_TEST_MODE'] == 'simulated' && ENV['WASALX_ADMIN_TLS_FIXTURE'] == '1'
trust_mode = ENV.fetch('WASALX_ADMIN_TLS_TRUST_MODE')
raise 'Explicit trust case required' unless %w[trusted untrusted].include?(trust_mode)
mount = '/run/wasalx-mailbox-fixture'
expected_ca = "#{mount}/#{trust_mode == 'trusted' ? 'ca.crt' : 'untrusted-ca.crt'}"
raise 'Fresh native process trust file required' unless ENV['SSL_CERT_FILE'] == expected_ca
host = 'mailbox.synthetic.test'
wrong_host = 'mismatch.mailbox.synthetic.test'
raise 'Synthetic host allowlist required' unless [host,wrong_host].all? { |name| ENV.fetch('WASALX_MAIL_ALLOWED_HOSTS','').split(',').include?(name) }
auth = JSON.parse(File.binread(ENV.fetch('WASALX_ADMIN_TLS_FIXTURE_AUTH_FILE')))
mailbox = auth.fetch('username')
raise 'Synthetic mailbox required' unless mailbox == 'owned-mailbox@mailbox.synthetic.test' && auth.fetch('password').start_with?('synthetic-')
owner = WasalxMembership.find_by!(portal_user_id: ENV.fetch('WASALX_ADMIN_TEST_OWNER'), tenant_id: ENV.fetch('WASALX_TENANT_ID'), instance_id: ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID'))
actor = owner.user.reload
actor.permissions!('admin.channel_email')
raise 'Current active managed human required' unless owner.member_state == 'ACTIVE' && actor.active && !Wasalx::ServiceIdentity.automation?(actor)
installed = Wasalx::InstalledPackage.verify!
control = URI(ENV.fetch('WASALX_ADMIN_TLS_FIXTURE_URL'))
raise 'Owned internal fixture required' unless control.to_s == 'http://mailbox.synthetic.test:8080'
control_token = File.binread(ENV.fetch('WASALX_ADMIN_TLS_FIXTURE_CONTROL_FILE')).strip
proof = []
case_name = 'setup'
original_logger_level = Rails.logger.level
original_bcc = Setting.get('system_bcc')
# Native IMAP logs the login name at INFO. Keep this test process's AUTH diagnostics private.
Rails.logger.level = Logger::WARN
http_request = lambda do |path, input = nil|
  connection = Net::HTTP.new(control.host,control.port,nil)
  connection.open_timeout = 3
  connection.read_timeout = 3
  request = input ? Net::HTTP::Post.new(path) : Net::HTTP::Get.new(path)
  if input
    request['Authorization'] = "Bearer #{control_token}"
    request['Content-Type'] = 'application/json'
    request.body = JSON.generate(input)
  end
  response = connection.start { |client| client.request(request) }
  raise 'Fixture audit/control unavailable' unless response.code == '200' && response.body.bytesize <= 131_072
  JSON.parse(response.body)
end
smtp_options = lambda do |name, starttls, password = auth.fetch('password')|
  { host: name, port: starttls ? 587 : 465, user: mailbox, password: password, domain: 'mailbox.synthetic.test',
    ssl: !starttls, ssl_verify: true, openssl_verify_mode: 'peer',
    enable_starttls_auto: false, wasalx_require_starttls: starttls }
end
imap_options = lambda do |name, starttls, password = auth.fetch('password')|
  { host: name, port: starttls ? 143 : 993, user: mailbox, password: password,
    folder: 'INBOX', ssl: starttls ? 'starttls' : 'on', ssl_verify: true }
end
send_probe = lambda do |options, marker|
  subject = "WasalX verification #{marker}"
  raise 'Native verification subject folded away its marker' unless Mail::Field.new('Subject',subject).encoded.lines.first.include?(marker)
  Timeout.timeout(12) do
    Wasalx::MailboxVerificationSmtp.new.deliver(options,
      { from: mailbox, to: mailbox, subject: subject,
        body: 'Synthetic native mailbox transport verification only.',
        'X-Zammad-Test-Message' => marker, 'X-Zammad-Ignore' => 'true', 'X-Zammad-Verify' => 'true',
        'X-Zammad-Verify-Time' => Time.current.iso8601, 'X-Loop' => 'yes', 'Auto-Submitted' => 'auto-generated' })
  end
end
receive_probe = lambda do |options, marker|
  driver = Channel::Driver::Imap.new
  begin
    Timeout.timeout(12) { driver.verify_transport(options,marker) }
  ensure
    driver.disconnect
  end
end
expect_failure = lambda do |name, classes, &action|
  case_name = name
  failed = false
  begin
    action.call
  rescue *classes => error
    proof << { name: name, result: 'PASS', rejection_class: error.class.name }
    failed = true
  end
  raise 'Expected transport boundary did not reject' unless failed
end
begin
  UserInfo.with_user_id(actor.id) do
    if trust_mode == 'untrusted'
      before = http_request.call('/audit')
      [false,true].each do |starttls|
        label = starttls ? 'STARTTLS' : 'TLS'
        expect_failure.call("smtp-#{label}-untrusted-ca",[OpenSSL::SSL::SSLError]) do
          send_probe.call(smtp_options.call(host,starttls),"wasalx-mail-#{SecureRandom.uuid}")
        end
        expect_failure.call("imap-#{label}-untrusted-ca",[OpenSSL::SSL::SSLError]) do
          receive_probe.call(imap_options.call(host,starttls),'wasalx-mail-untrusted')
        end
      end
      after = http_request.call('/audit')
      raise 'Certificate rejection leaked AUTH or sent mail' unless after.fetch('auth_attempts').length == before.fetch('auth_attempts').length &&
        after.fetch('accepted').length == before.fetch('accepted').length
    else
      Setting.set('system_bcc','bcc-audit@mailbox.synthetic.test')
      [false,true].each do |starttls|
        label = starttls ? 'STARTTLS' : 'TLS'
        case_name = "native-#{label}-owned-send-and-receive"
        marker = "wasalx-mail-#{SecureRandom.uuid}"
        send_probe.call(smtp_options.call(host,starttls),marker)
        result = receive_probe.call(imap_options.call(host,starttls),marker)
        audit = http_request.call('/audit')
        rows = audit.fetch('accepted').select { |row| row['marker'] == marker }
        raise 'Native owned TLS marker proof incomplete' unless result[:result] == 'ok' && rows.length == 1 &&
          rows.first['from'] == mailbox && rows.first['recipients'] == [mailbox] && rows.first['header_bcc_present'] == false &&
          audit.fetch('deleted_markers').count(marker) == 1
        proof << { name: case_name, result: 'PASS', marker: marker, recipient_count: rows.first['recipients'].length,
          sha256: rows.first.fetch('sha256'), bytes: rows.first.fetch('bytes') }
        expect_failure.call("smtp-#{label}-hostname-mismatch",[OpenSSL::SSL::SSLError]) do
          send_probe.call(smtp_options.call(wrong_host,starttls),"wasalx-mail-#{SecureRandom.uuid}")
        end
        expect_failure.call("imap-#{label}-hostname-mismatch",[OpenSSL::SSL::SSLError]) do
          receive_probe.call(imap_options.call(wrong_host,starttls),'wasalx-mail-mismatch')
        end
      end
      expect_failure.call('smtp-invalid-auth',[Net::SMTPAuthenticationError]) do
        send_probe.call(smtp_options.call(host,false,'synthetic-invalid-password'),"wasalx-mail-#{SecureRandom.uuid}")
      end
      expect_failure.call('imap-invalid-auth',[Net::IMAP::NoResponseError]) do
        receive_probe.call(imap_options.call(host,false,'synthetic-invalid-password'),'wasalx-mail-invalid-auth')
      end
      before = http_request.call('/audit')
      begin
        http_request.call('/control',{deny_smtp_starttls:true})
        expect_failure.call('smtp-required-starttls-unavailable',[Net::SMTPError]) do
          send_probe.call(smtp_options.call(host,true),"wasalx-mail-#{SecureRandom.uuid}")
        end
      ensure
        http_request.call('/control',{deny_smtp_starttls:false})
      end
      begin
        http_request.call('/control',{deny_imap_starttls:true})
        expect_failure.call('imap-required-starttls-unavailable',[Net::IMAP::NoResponseError]) do
          receive_probe.call(imap_options.call(host,true),'wasalx-mail-no-starttls')
        end
      ensure
        http_request.call('/control',{deny_imap_starttls:false})
      end
      after = http_request.call('/audit')
      raise 'STARTTLS denial leaked AUTH or sent mail' unless after.fetch('auth_attempts').length == before.fetch('auth_attempts').length &&
        after.fetch('accepted').length == before.fetch('accepted').length
      raise 'Probe attempted an additional recipient' unless after.fetch('recipient_attempts').all? { |row| row['allowed'] && row['address'] == mailbox }
    end
  end
  expected = trust_mode == 'trusted' ? 10 : 4
  raise 'Native mailbox matrix coverage incomplete' unless proof.length == expected
  puts JSON.generate({mode:'SIMULATED',boundary:'NATIVE_MAILBOX_TLS',trust_mode:trust_mode,native:Version.get,
    source:installed,proof:proof,check_count:proof.length})
  puts "Native mailbox TLS #{trust_mode} matrix passed (#{proof.length} checks)."
rescue StandardError => error
  puts JSON.generate({mode:'SIMULATED',boundary:'NATIVE_MAILBOX_TLS',trust_mode:trust_mode,
    failed_case:case_name,error_class:error.class.name,completed_checks:proof.length})
  raise RuntimeError,'Native mailbox TLS matrix failed; inspect its redacted case evidence',cause:nil
ensure
  Setting.set('system_bcc',original_bcc) if trust_mode == 'trusted'
  Rails.logger.level = original_logger_level
end
