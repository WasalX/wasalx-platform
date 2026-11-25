# Actual Rails/PostgreSQL diagnostics. Only the outbound control HTTP boundary is simulated.
require 'json'
require 'openssl'
require 'securerandom'
require 'action_dispatch/testing/integration'
raise 'Isolated fixture required' unless ENV['WASALX_TEST_ISOLATED'] == '1'
installed_identity = Wasalx::InstalledPackage.verify!
assert = ->(condition, message) { raise message unless condition }
original_post = Wasalx::Client.method(:post)
original_get = Wasalx::Client.method(:get)
portal_source = { 'issuer' => 'https://identity.example.test', 'audience' => 'wasalx-api' }
members = {}
membership_denied = false
privileged_window = 15
privileged_recheck_hook = nil
admissions = []
source_contexts = {}
source_queries = []
source_mapping_error = nil
source_mapping_truncated = false
source_before_return = nil
owned_tickets = []
proof = []
failures = []
check = lambda do |name, &block|
  begin
    block.call
    proof << name
  rescue StandardError => error
    # Exception text can contain fixture credentials or request data.
    frames = Array(error.backtrace_locations).filter_map do |frame|
      file = File.basename(frame.path)
      "#{file}:#{frame.lineno}" if %w[portal-workspace-native.rb mailbox-admin-native.rb].include?(file)
    end
    failures << { name: name, error: error.class.name, fixture_frames: frames.first(2) }
  end
end

begin
  Wasalx::Client.define_singleton_method(:post) do |path, input, scope:, actor: nil|
    case path
    when '/internal/v1/zammad/membership/check'
      row = WasalxMembership.find_by(portal_user_id: input[:user_id])
      allowed = !membership_denied && row && row.reload.member_state == 'ACTIVE' &&
        row.revision == input[:revision] && row.user_id.to_s == input[:native_user_id].to_s
      privileged_recheck_hook&.call(input)
      { 'allowed' => !!allowed, 'portal_source' => portal_source, 'privileged_reauth_minutes' => privileged_window, 'authentication_policy' => row && {
        'mfa_required' => true, 'session_timeout_minutes' => 480, 'policy_version' => 1,
        'subject' => row.subject, 'mfa_amr_values' => ['mfa'], 'mfa_acr_values' => [] } }
    when '/internal/v1/zammad/membership/retired'
      { 'retired' => false }
    when '/internal/v1/zammad/outbound'
      raise 'Unexpected outbound ticket' unless scope == 'zammad:outbound' && owned_tickets.include?(input[:ticket_id].to_i)
      admissions << input.deep_dup
      { 'id' => SecureRandom.uuid, 'state' => 'QUEUED' }
    else
      raise "Unexpected synthetic boundary: #{path}"
    end
  end
  Wasalx::Client.define_singleton_method(:get) do |path, scope:, actor: nil|
    uri = URI.parse(path)
    query = URI.decode_www_form(uri.query.to_s).to_h
    if (match = %r{\A/internal/v1/zammad/group-workspace/tickets/([1-9][0-9]*)/message-context\z}.match(uri.path))
      raise 'Unexpected source scope or actor' unless scope == 'zammad:groups' && owned_tickets.include?(match[1].to_i) &&
        actor && members.values.any? { |row| row.user_id.to_s == actor[:user_id].to_s }
      ids = query.fetch('article_ids').split(',')
      raise 'Unbounded source lookup' unless ids.length.between?(1, 20) && ids.uniq.length == ids.length
      source_queries << [match[1], ids]
      source_before_return&.call
      raise source_mapping_error if source_mapping_error
      items = source_contexts.fetch(match[1], {}).values.select { |item| ids.include?(item.fetch('article_id')) }
      next({ 'items' => items, 'truncated' => source_mapping_truncated })
    end
    raise 'Unexpected preflight boundary' unless scope == 'zammad:outbound'  &&
      uri.path == '/internal/v1/zammad/outbound/preflight' && owned_tickets.include?(query['ticket_id'].to_i) &&
      actor && members.values.any? { |row| row.user_id.to_s == actor[:user_id].to_s }
    { 'available' => true }
  end

  guard = Wasalx::ServiceIdentity
  marker = '/var/tmp/portal-workspace-fixture.json'
  if !File.exist?(marker) && guard.handover_evidence?
    record = guard.receipt
    owner_member = WasalxMembership.find_by!(portal_user_id: record.fetch('human_portal_user_id'))
    match = /\Aportal-owner-([a-f0-9]{12})\z/.match(owner_member.user.login)
    raise 'Foreign handover in isolated fixture' unless match
    suffix = match[1]
    saved = %w[owner agent reader].to_h do |key|
      user = User.find_by!(login: "portal-#{key}-#{suffix}")
      [key, WasalxMembership.find_by!(user_id: user.id).id]
    end
    saved.merge!('runtime' => record.fetch('runtime_token_id'), 'group' => Group.find_by!(name: "Portal team #{suffix}").id,
      'other_group' => Group.find_by!(name: "Other team #{suffix}").id,
      'customer' => User.find_by!(login: "portal-customer-#{suffix}").id)
    File.write(marker, JSON.generate(saved))
  end
  if File.exist?(marker)
    saved = JSON.parse(File.read(marker))
    %w[owner agent reader].each { |key| members[key] = WasalxMembership.find(saved.fetch(key)) }
    runtime = Token.find(saved.fetch('runtime'))
    group = Group.find(saved.fetch('group'))
    other_group = Group.find(saved.fetch('other_group'))
    customer = User.find(saved.fetch('customer'))
  else
    UserInfo.current_user_id = 1
    User.transaction do
      raise 'Foreign handover in isolated fixture' if guard.handover_evidence?
      admin_role = Role.find_by!(name: 'Admin')
      agent_role = Role.find_by!(name: 'Agent')
      suffix = SecureRandom.hex(6)
      make_user = ->(name, roles) { User.create!(login: "portal-#{name}-#{suffix}", email: "#{name}-#{suffix}@example.test",
        firstname: name, lastname: 'Synthetic', active: true, roles: roles, created_by_id: 1, updated_by_id: 1) }
      legacy = make_user.call('legacy', [admin_role, agent_role])
      legacy_auth = Authorization.create!(user_id: legacy.id, provider: 'openid_connect', uid: "legacy-#{suffix}")
      %w[owner agent reader].each do |key|
        user = make_user.call(key, key == 'owner' ? [admin_role, agent_role] : [agent_role])
        subject = "portal-#{key}-#{suffix}"
        Authorization.create!(provider: 'openid_connect', uid: subject, user_id: user.id)
        members[key] = WasalxMembership.create!(tenant_id: ENV.fetch('WASALX_TENANT_ID'),
          instance_id: ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID'), portal_user_id: SecureRandom.uuid,
          subject: subject, email: user.email, user_id: user.id, revision: 1, member_state: 'ACTIVE',
          portal_role: key == 'owner' ? 'tenant_owner' : 'agent')
      end
      tokens = guard::LEGACY_SCOPES.to_h { |purpose, scopes| [purpose, Token.create!(user_id: legacy.id,
        action: 'api', persistent: true, name: purpose == 'runtime' ? 'WasalX Service' : 'WasalX Privacy',
        preferences: { permission: scopes })] }
      secrets = tokens.transform_values(&:token)
      installed = installed_identity
      input = { 'version' => 1, 'action' => 'PREPARE', 'operation_id' => SecureRandom.uuid,
        'expected_revision' => 0, 'expected_receipt_sha256' => nil,
        'tenant_id' => ENV.fetch('WASALX_TENANT_ID'), 'instance_id' => ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID'),
        'human_portal_user_id' => members['owner'].portal_user_id, 'human_native_user_id' => members['owner'].user_id.to_s,
        'human_subject' => members['owner'].subject, 'human_projection_revision' => 1,
        'legacy_native_user_id' => legacy.id.to_s, 'legacy_oidc_authorization_id' => legacy_auth.id.to_s,
        'legacy_subject' => legacy_auth.uid, 'runtime_token_id' => tokens['runtime'].id.to_s,
        'privacy_token_id' => tokens['privacy'].id.to_s, 'expected_runtime_scopes' => guard::SCOPES['runtime'],
        'expected_privacy_scopes' => guard::SCOPES['privacy'], 'expected_group_grants_sha256' => guard.digest({}),
        'verification_receipt_sha256' => nil }.merge(installed.slice('candidate_commit_sha', 'candidate_tree_sha', 'native_package_sha256'))
      receipt = guard.transition!(input, secrets: secrets)
      group = Group.create!(name: "Portal team #{suffix}", active: true, created_by_id: 1, updated_by_id: 1)
      other_group = Group.create!(name: "Other team #{suffix}", active: true, created_by_id: 1, updated_by_id: 1)
      machine = User.find(receipt.fetch('automation_native_user_id'))
      machine.group_ids_access_map = { group.id => 'full', other_group.id => 'full' }
      machine.save!
      %w[owner agent reader].each do |key|
        user = members[key].user
        user.group_ids_access_map = { group.id => key == 'reader' ? 'read' : 'full' }
        user.save!
      end
      guard.transition!(input.merge('action' => 'BIND', 'expected_revision' => receipt['revision'],
        'expected_receipt_sha256' => guard.digest(receipt), 'expected_group_grants_sha256' => guard.group_digest(machine)), secrets: secrets)
      runtime = tokens['runtime'].reload
      customer = make_user.call('customer', [Role.find_by!(name: 'Customer')])
    end
    File.write(marker, JSON.generate(members.transform_values(&:id).merge('runtime' => runtime.id,
      'group' => group.id, 'other_group' => other_group.id, 'customer' => customer.id)))
  end

  make_ticket = lambda do |team, suffix, whatsapp = false|
    UserInfo.with_user_id(members['agent'].user_id) do
      Transaction.execute do
      ticket = Ticket.create!(title: "Portal diagnostic #{SecureRandom.hex(4)} #{suffix}", group: team,
        customer: customer, created_by_id: members['agent'].user_id, updated_by_id: members['agent'].user_id)
      ticket.update!(wasalx_connection_id: '00000000-0000-4000-8000-000000000011',
        wasalx_group_id: 'fixture-0027@example.test', wasalx_provider: 'WAHA') if whatsapp
      owned_tickets << ticket.id
      ticket
      end
    end
  end
  ticket = make_ticket.call(group, 'group', true)
  hidden = make_ticket.call(other_group, 'hidden', false)
  plain = make_ticket.call(group, 'unsupported', false)
  customer_sender = Ticket::Article::Sender.find_by!(name: 'Customer')
  note_type = Ticket::Article::Type.find_by!(name: 'note')
  original_article = UserInfo.with_user_id(customer.id) do
    Ticket::Article.create!(ticket: ticket, sender: customer_sender, type: note_type, internal: false,
      content_type: 'text/plain', body: 'Customer request', created_by_id: customer.id, updated_by_id: customer.id,
      attachments: [{ filename: 'request.txt', data: 'Synthetic customer attachment', preferences: { 'Content-Type' => 'text/plain' } }])
  end

  call = lambda do |operation, input, member = members['agent'], changes = {}|
    envelope = { purpose: Wasalx::PortalDelegation::PURPOSE, tenant_id: ENV.fetch('WASALX_TENANT_ID'),
      instance_id: ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID'), source: portal_source,
      actor: { user_id: member.portal_user_id, subject: member.subject, revision: member.revision, native_user_id: member.user_id.to_s },
      assurance: { auth_time: Time.now.to_i, amr: ['mfa'], acr: nil }, operation: operation, input: input }.deep_stringify_keys
    envelope.merge!(changes)
    body = JSON.generate(envelope)
    timestamp = Time.now.to_i.to_s
    signature = OpenSSL::HMAC.hexdigest('SHA256', ENV.fetch('WASALX_SERVICE_JWT_SECRET'),
      "#{Wasalx::PortalDelegation::PURPOSE}\nPOST\n#{Wasalx::PortalDelegation::PATH}\n#{timestamp}\n#{body}")
    http = ActionDispatch::Integration::Session.new(Rails.application)
    http.host!('localhost')
    http.post(Wasalx::PortalDelegation::PATH, params: body, headers: { 'Authorization' => "Token token=#{runtime.token}",
      'Content-Type' => 'application/json', 'X-Wasalx-Timestamp' => timestamp, 'X-Wasalx-Signature' => signature })
    parsed = begin JSON.parse(http.response.body); rescue JSON::ParserError; http.response.body; end
    [http.response.status, parsed]
  end
  version = -> { ticket.reload.updated_at.utc.iso8601(6) }
  new_note_draft = ->(id = SecureRandom.uuid, text = 'Internal diagnostic') { {
    'ticket_id' => ticket.id.to_s, 'operation_id' => id, 'expected_updated_at' => version.call,
    'body' => text, 'internal' => true } }

  check.call('native-team-read-write-and-channel-boundaries') do
  status, page = call.call('LIST', { limit: 100 })
  assert.call(status == 200 && page['items'].any? { |row| row['id'] == ticket.id.to_s } &&
    page['items'].none? { |row| row['id'] == hidden.id.to_s }, 'Native ticket list visibility differs')
  assert.call(call.call('SHOW', { ticket_id: hidden.id.to_s }).first == 403, 'Foreign team ticket was readable')
  assert.call(call.call('SHOW', { ticket_id: ticket.id.to_s }, members['reader']).last['can_update'] == false, 'Read-only native grant gained writes')
  assert.call(call.call('REPLY', new_note_draft.call, members['reader']).first == 403, 'Read-only native actor created article')
  assert.call(call.call('SHOW', { ticket_id: plain.id.to_s }).last['can_reply'] == false, 'Unsupported channel became email')
  end

  check.call('article-and-attachment-authorization') do
  pointer = { 'article_id' => original_article.id.to_s, 'group_id' => SecureRandom.uuid, 'message_id' => SecureRandom.uuid }
  source_contexts[ticket.id.to_s] = { original_article.id.to_s => pointer }
  before_sources = source_queries.length
  status, rows = call.call('ARTICLES', { ticket_id: ticket.id.to_s })
  assert.call(status == 200 && rows['items'].any? { |row| row['id'] == original_article.id.to_s }, 'Native article projection missing')
  assert.call(source_queries.length == before_sources + 1 && source_queries.last == [ticket.id.to_s, rows['items'].map { |row| row['id'] }],
    'Article page did not use one exact bounded source lookup')
  assert.call(rows['items'].find { |row| row['id'] == original_article.id.to_s }['has_source'] == true, 'Linked article has no source action')
  status, exact_source = call.call('SOURCE_CONTEXT', { ticket_id: ticket.id.to_s, article_id: original_article.id.to_s })
  assert.call(status == 200 && exact_source == pointer.slice('group_id', 'message_id'), 'Native source navigation differs from exact authorized article mapping')
  assert.call(call.call('SOURCE_CONTEXT', { ticket_id: hidden.id.to_s, article_id: original_article.id.to_s }).first == 403,
    'Source pointer crossed native ticket/article policy')
  source_contexts[ticket.id.to_s] = {}
  assert.call(call.call('SOURCE_CONTEXT', { ticket_id: ticket.id.to_s, article_id: original_article.id.to_s }).first == 404,
    'Revoked source mapping reused stale article metadata')
  source_contexts[ticket.id.to_s] = { original_article.id.to_s => pointer }
  begin
    source_mapping_error = Wasalx::Client::TemporaryRequestFailed.new('Synthetic mapping-only outage')
    status, unavailable_page = call.call('ARTICLES', { ticket_id: ticket.id.to_s })
    projected = unavailable_page['items']&.find { |item| item['id'] == original_article.id.to_s } if unavailable_page.is_a?(Hash)
    assert.call(status == 200 && projected && projected['body'] == original_article.body && !projected.key?('has_source'),
      'Optional mapping outage hid authorized current history or claimed source absence')
    assert.call(call.call('SOURCE_CONTEXT', { ticket_id: ticket.id.to_s, article_id: original_article.id.to_s }).first == 503,
      'Explicit source lookup softened an unavailable mapping')
    source_mapping_error = nil
    source_mapping_truncated = true
    status, unavailable_page = call.call('ARTICLES', { ticket_id: ticket.id.to_s })
    assert.call(status == 200 && unavailable_page['items'].none? { |item| item.key?('has_source') },
      'Truncated optional source hints blocked history or claimed absence')
    assert.call(call.call('SOURCE_CONTEXT', { ticket_id: ticket.id.to_s, article_id: original_article.id.to_s }).first == 503,
      'Explicit source lookup silently used truncated mappings')
    source_mapping_truncated = false
    source_mapping_error = Wasalx::Client::PermanentRequestFailed.new('Synthetic control denial', http_status: 403)
    assert.call(call.call('ARTICLES', { ticket_id: ticket.id.to_s }).first != 200, 'Control source denial was swallowed as an outage')
    source_mapping_error = Wasalx::Client::TemporaryRequestFailed.new('Synthetic mapping-only outage')
    source_before_return = -> { membership_denied = true }
    status, rejected_page = call.call('ARTICLES', { ticket_id: ticket.id.to_s })
    assert.call(status != 200 && !JSON.generate(rejected_page).include?(original_article.body),
      'Mapping outage bypassed current membership proof or exposed denied article content')
  ensure
    membership_denied = false; source_mapping_error = nil; source_mapping_truncated = false; source_before_return = nil
  end
  file = original_article.attachments.first
  assert.call(rows['items'].find { |row| row['id'] == original_article.id.to_s }['attachments'].first['size'] == 29,
    'Attachment size is not numeric bytes')
  size_reader = Api::V1::WasalxPortalWorkspaceController.new
  %w[-1 malformed 0x10].each do |value|
    rejected = false
    begin
      size_reader.send(:attachment_size, Struct.new(:size).new(value))
    rescue ArgumentError
      rejected = true
    end
    assert.call(rejected, "Invalid attachment size accepted: #{value}")
  end
  status, bytes = call.call('ATTACHMENT', { ticket_id: ticket.id.to_s, article_id: original_article.id.to_s, attachment_id: file.id.to_s })
  assert.call(status == 200 && bytes == 'Synthetic customer attachment', "Native attachment read differs (#{status}; #{bytes.inspect[0, 180]})")
  assert.call(call.call('ATTACHMENT', { ticket_id: hidden.id.to_s, article_id: original_article.id.to_s, attachment_id: file.id.to_s }).first == 403,
    'Attachment crossed ticket/team boundary')
  original_size = file.size
  begin
    file.update_column(:size, '50000001')
    status, page = call.call('ARTICLES', { ticket_id: ticket.id.to_s })
    assert.call(status == 200 && page['items'].find { |row| row['id'] == original_article.id.to_s }['attachments'].first['size'] == 50_000_001,
      'Oversized attachment hid readable article history')
    assert.call(call.call('ATTACHMENT', { ticket_id: ticket.id.to_s, article_id: original_article.id.to_s, attachment_id: file.id.to_s }).first == 400,
      'Oversized attachment crossed transfer limit')
  ensure
    file.update_column(:size, original_size)
  end
  end

  check.call('native-receipt-replay-conflict-and-terminal-cancellation') do
  operation = new_note_draft.call
  before = Ticket::Article.where(ticket_id: ticket.id).count
  status, result = call.call('REPLY', operation)
  assert.call(status == 200 && result['state'] == 'APPLIED', "Native internal note failed (#{status})")
  assert.call(Ticket::Article.find(result['article_id']).created_by_id == members['agent'].user_id, 'Reply used machine authorship')
  assert.call(call.call('REPLY', operation).last == result && Ticket::Article.where(ticket_id: ticket.id).count == before + 1, 'Reply replay duplicated article')
  assert.call(call.call('REPLY', operation.merge('body' => 'Changed replay')).first == 409, 'Changed payload reused receipt')
  assert.call(call.call('RECEIPT', { ticket_id: ticket.id.to_s, operation_id: operation['operation_id'] }).last == result, 'Lost response did not reconcile')
  late = new_note_draft.call
  assert.call(call.call('RECEIPT', { ticket_id: ticket.id.to_s, operation_id: late['operation_id'], action: 'LOOKUP' }).last['state'] == 'UNKNOWN', 'Passive lookup claimed no effect')
  cancelled = call.call('RECEIPT', { ticket_id: ticket.id.to_s, operation_id: late['operation_id'].upcase, action: 'CANCEL_IF_UNADMITTED' }).last
  assert.call(cancelled['state'] == 'NOT_APPLIED' && cancelled['terminal'] == true, 'Explicit cancellation lacks terminal outcome')
  assert.call(call.call('REPLY', late).first == 409, 'Delayed original crossed terminal cancellation')
  end

  check.call('native-public-article-callback-and-single-delivery-admission') do
  public_input = new_note_draft.call.merge('internal' => false, 'body' => 'Public diagnostic')
  before_jobs = Delayed::Job.pluck(:id)
  status, result = call.call('REPLY', public_input)
  assert.call(status == 200, "Native public reply failed (#{status})")
  jobs = (Delayed::Job.pluck(:id) - before_jobs).filter_map do |id|
    data = Delayed::Job.find(id).payload_object.instance_variable_get(:@job_data)
    id if data && data['job_class'] == 'CommunicateWasalxJob' && data.fetch('arguments').first == result['article_id'].to_i
  end
  assert.call(jobs.length == 1, 'Public reply did not queue exactly one native communication job')
  CommunicateWasalxJob.new.perform(result['article_id'].to_i)
  assert.call(admissions.length == 1 && admissions.first[:article_id].to_s == result['article_id'], 'Native public reply did not use existing delivery admission')
  assert.call(call.call('REPLY', public_input).first == 200 && admissions.length == 1, 'Receipt replay re-sent provider effect')
  end

  check.call('postgres-concurrent-replay-and-stale-version-fence') do
  concurrent_input = new_note_draft.call
  results = 2.times.map { Thread.new { ActiveRecord::Base.connection_pool.with_connection { call.call('REPLY', concurrent_input) } } }.map(&:value)
  assert.call(results.all? { |row| row.first == 200 } && results.map(&:last).uniq.length == 1, 'Concurrent equal-key requests diverged')
  assert.call(WasalxTicketOperation.where(operation_id: concurrent_input['operation_id']).count == 1, 'Concurrent requests duplicated receipt')
  assert.call(call.call('UPDATE', { ticket_id: ticket.id.to_s, operation_id: SecureRandom.uuid,
    expected_updated_at: '2000-01-01T00:00:00.000000Z', owner_id: members['owner'].user_id.to_s }).first == 409, 'Stale assignment overwrote current ticket')
  end

  check.call('native-email-reply-and-unsupported-channel-in-email-team') do
    UserInfo.with_user_id(members['owner'].user_id) do
      unless group.reload.email_address
        address_email = "portal-#{SecureRandom.hex(5)}@example.test"
        channel = Channel.create!(area: 'Email::Account', group_id: group.id, active: true,
          options: { inbound: { adapter: 'null', options: {} },
            outbound: { adapter: 'smtp', options: { host: 'unreachable.invalid', port: 2525,
              enable_starttls_auto: false, domain: 'example.test' } } },
          preferences: { portal_diagnostic: true }, created_by_id: 1, updated_by_id: 1)
        address = EmailAddress.create!(name: 'Synthetic support', email: address_email, channel_id: channel.id,
          created_by_id: 1, updated_by_id: 1)
        group.update!(email_address_id: address.id)
      end
    end
    mail_ticket = make_ticket.call(group.reload, 'email', false)
    incoming = UserInfo.with_user_id(customer.id) do
      Ticket::Article.create!(ticket: mail_ticket, sender: customer_sender,
        type: Ticket::Article::Type.find_by!(name: 'email'), internal: false, content_type: 'text/plain',
        from: customer.email, reply_to: 'Customer Replies <replies@example.test>', to: group.email_address.email,
        subject: 'Original subject', message_id: '<portal-fixture@example.test>',
        body: 'Inbound email question', created_by_id: customer.id, updated_by_id: customer.id)
    end
    latest = UserInfo.with_user_id(customer.id) do
      Ticket::Article.create!(ticket: mail_ticket, sender: customer_sender,
        type: Ticket::Article::Type.find_by!(name: 'email'), internal: false, content_type: 'text/plain',
        from: customer.email, reply_to: 'Latest Customer <latest@example.test>', to: group.email_address.email,
        subject: 'Latest subject', message_id: '<portal-latest@example.test>', body: 'Latest customer question',
        created_by_id: customer.id, updated_by_id: customer.id)
    end
    UserInfo.with_user_id(members['agent'].user_id) do
      Ticket::Article.create!(ticket: mail_ticket, sender: customer_sender,
        type: Ticket::Article::Type.find_by!(name: 'email'), internal: true, content_type: 'text/plain',
        from: 'internal@example.test', to: group.email_address.email, message_id: '<portal-internal@example.test>',
        body: 'Internal email must not choose reply target', created_by_id: members['agent'].user_id, updated_by_id: members['agent'].user_id)
    end
    assert.call(call.call('SHOW', { ticket_id: mail_ticket.id.to_s }).last['channel'] == 'email', 'Email ticket channel missing')
    assert.call(call.call('SHOW', { ticket_id: plain.id.to_s }).last['can_reply'] == false, 'Email-enabled team converted unsupported channel')
    status, reply = call.call('REPLY', { ticket_id: mail_ticket.id.to_s, operation_id: SecureRandom.uuid,
      expected_updated_at: mail_ticket.reload.updated_at.utc.iso8601(6), body: 'Email response', internal: false })
    assert.call(status == 200, "Native email reply failed (#{status}; #{reply.inspect[0, 200]})")
    outgoing = Ticket::Article.find(reply['article_id'])
    assert.call(outgoing.type.name == 'email' && outgoing.to == 'latest@example.test' && outgoing.from.include?(group.email_address.email),
      'Email sender/recipient differ from native account')
    assert.call(outgoing.in_reply_to == latest.message_id && outgoing.in_reply_to != incoming.message_id && outgoing.subject == 'Latest subject',
      'Email reply lost latest public customer thread')
    latest.update_column(:reply_to, group.email_address.email)
    assert.call(call.call('REPLY', { ticket_id: mail_ticket.id.to_s, operation_id: SecureRandom.uuid,
      expected_updated_at: mail_ticket.reload.updated_at.utc.iso8601(6), body: 'Must not email own account', internal: false }).first == 400,
      'Reply targeted a configured system address')
  end

  check.call('native-assignment-state-and-ineligible-owner') do
    status, _result = call.call('UPDATE', { ticket_id: ticket.id.to_s, operation_id: SecureRandom.uuid,
      expected_updated_at: version.call, owner_id: members['owner'].user_id.to_s })
    assert.call(status == 200 && ticket.reload.owner_id == members['owner'].user_id, 'Native assignment did not persist')
    assert.call(call.call('UPDATE', { ticket_id: ticket.id.to_s, operation_id: SecureRandom.uuid,
      expected_updated_at: version.call, owner_id: members['reader'].user_id.to_s }).first == 403, 'Read-only agent became owner')
    closed = Ticket::State.find_by!(name: 'closed')
    status, _result = call.call('UPDATE', { ticket_id: ticket.id.to_s, operation_id: SecureRandom.uuid,
      expected_updated_at: version.call, state_id: closed.id.to_s })
    assert.call(status == 200 && ticket.reload.state_id == closed.id, 'Native status did not persist')
  end

  check.call('native-handoff-and-internal-note-boundaries') do
    direct = make_ticket.call(group, 'direct', true)
    UserInfo.with_user_id(members['agent'].user_id) do
      direct.update!(wasalx_bot_conversation: true, wasalx_bot_state: 'BOT', wasalx_bot_keep_open: 'false')
    end
    input = { ticket_id: direct.id.to_s, operation_id: SecureRandom.uuid,
      expected_updated_at: direct.reload.updated_at.utc.iso8601(6), body: 'Must not reply', internal: false }
    assert.call(call.call('REPLY', input).first == 403, 'Active bot accepted public human reply')
    status, result = call.call('REPLY', input.merge(operation_id: SecureRandom.uuid, internal: true))
    assert.call(status == 200 && Ticket::Article.find(result['article_id']).internal, 'Internal note blocked by bot state')
  end

  check.call('native-effect-and-receipt-rollback') do
    rollback_ticket = make_ticket.call(group, 'rollback', true)
    operation_id = SecureRandom.uuid
    failure = -> { raise ArgumentError, 'Synthetic receipt failure' if self.operation_id == operation_id }
    before_count = Ticket::Article.where(ticket_id: rollback_ticket.id).count
    before_jobs = Delayed::Job.pluck(:id)
    before_admissions = admissions.length
    WasalxTicketOperation.set_callback(:create, :before, failure)
    begin
      status, _result = call.call('REPLY', { ticket_id: rollback_ticket.id.to_s, operation_id: operation_id,
        expected_updated_at: rollback_ticket.reload.updated_at.utc.iso8601(6), body: 'Rollback public message', internal: false })
      assert.call(status == 400, 'Injected receipt failure was not observed')
      assert.call(Ticket::Article.where(ticket_id: rollback_ticket.id).count == before_count &&
        !WasalxTicketOperation.exists?(operation_id: operation_id), 'Partial native effect or receipt committed')
      assert.call(Delayed::Job.pluck(:id).sort == before_jobs.sort, 'Rolled-back article queued a native effect')
      assert.call(EventBuffer.list('transaction').empty?, 'Rolled-back native events survived request')
      assert.call(admissions.length == before_admissions, 'Rolled-back article admitted a provider effect')
    ensure
      WasalxTicketOperation.skip_callback(:create, :before, failure)
    end
    status, result = call.call('REPLY', { ticket_id: rollback_ticket.id.to_s, operation_id: SecureRandom.uuid,
      expected_updated_at: rollback_ticket.reload.updated_at.utc.iso8601(6), body: 'Successful follow-up', internal: false })
    assert.call(status == 200 && Ticket::Article.where(ticket_id: rollback_ticket.id).count == before_count + 1,
      'Successful follow-up flushed a rolled-back article')
    follow_up_jobs = (Delayed::Job.pluck(:id) - before_jobs).filter_map do |id|
      data = Delayed::Job.find(id).payload_object.instance_variable_get(:@job_data)
      data if data && data['job_class'] == 'CommunicateWasalxJob'
    end
    assert.call(follow_up_jobs.length == 1 && follow_up_jobs.first['arguments'].first == result['article_id'].to_i,
      'Follow-up queued effects beyond its own article')
  end

  check.call('native-shared-group-workflow-and-read-only-replay') do
    native_actor = members['agent'].user.reload
    read_only_actor = members['reader'].user.reload
    boundary_get = Wasalx::Client.method(:get)
    boundary_post = Wasalx::Client.method(:post)
    workflow = nil
    source_group = SecureRandom.uuid
    source_message = SecureRandom.uuid
    connection = SecureRandom.uuid
    remote_links = []
    remote_attempts = 0
    fail_link = false
    marker_title = "Group native workflow #{SecureRandom.hex(5)}"
    incoming_source = { 'id' => source_message, 'group_id' => source_group,
      'connection_id' => connection, 'external_group_id' => 'fixture-0028@example.test',
      'group_name' => group.name, 'external_message_id' => "native-#{source_message}",
      'external_participant_id' => '12025550122@c.us', 'participant_name' => 'Synthetic participant',
      'provider' => 'WAHA', 'zammad_customer_id' => customer.id.to_s, 'message_text' => 'Synthetic source',
      'from_me' => false, 'ticket_creatable' => true, 'media_available' => false }
    source_path = "/internal/v1/zammad/group-workspace/groups/#{source_group}/messages/#{source_message}/source"
    link_path = "/internal/v1/zammad/group-workspace/groups/#{source_group}/messages/#{source_message}/tickets"
    Wasalx::Client.define_singleton_method(:get) do |path, **options|
      if path.start_with?('/internal/v1/zammad/group-workspace/groups?') && URI.decode_www_form(URI.parse(path).query).to_h['selected'] == source_group
        { 'items' => [{ 'id' => source_group }] }
      else
        path == source_path ? incoming_source.merge('links' => remote_links) : boundary_get.call(path, **options)
      end
    end
    Wasalx::Client.define_singleton_method(:post) do |path, input, **options|
      if path == link_path
        raise 'Wrong group actor' unless options.dig(:actor, :user_id) == native_actor.id && options[:scope] == 'zammad:groups'
        remote_attempts += 1
        raise Wasalx::Client::TemporaryRequestFailed, 'Synthetic link response lost' if fail_link
        remote_links << { 'ticket_id' => input[:ticketId].to_s, 'article_id' => input[:articleId].to_s }
        { 'linked' => true }
      else
        boundary_post.call(path, input, **options)
      end
    end
    begin
      unbound = make_ticket.call(group, 'group-workflow-unbound', false)
      # Real CoreWorkflow restriction: selected connection can only be a different value.
      # Without create_middle/edit, native ChecksCoreWorkflow skips this rule entirely.
      workflow = UserInfo.with_user_id(members['owner'].user_id) do
        CoreWorkflow.create!(name: "Portal group restriction #{SecureRandom.hex(5)}", object: 'Ticket',
          active: true, changeable: true, priority: 1, stop_after_match: true,
          condition_saved: {}, condition_selected: { 'ticket.group_id' => { 'operator' => 'is', 'value' => [group.id.to_s] } },
          perform: { 'ticket.wasalx_connection_id' => { 'operator' => 'set_fixed_to', 'set_fixed_to' => [SecureRandom.uuid] } },
          preferences: { 'screen' => %w[create_middle edit] },
          created_by_id: members['owner'].user_id, updated_by_id: members['owner'].user_id)
      end
      create_input = { group_id: source_group, message_id: source_message, target_group_id: group.id.to_s,
        request_token: SecureRandom.uuid, title: marker_title }
      create_denied = false
      begin
        Wasalx::GroupWorkspace.new(actor: native_actor).create_ticket(**create_input)
      rescue Wasalx::GroupWorkspace::Rejected
        create_denied = true
      end
      assert.call(create_denied && !Ticket.exists?(title: marker_title) && remote_attempts.zero?,
        'Native create skipped restrictive workflow or left a remote effect')
      link_denied = false
      begin
        Wasalx::GroupWorkspace.new(actor: native_actor).link_ticket(group_id: source_group, message_id: source_message,
          ticket_number: unbound.number.to_s, request_token: SecureRandom.uuid)
      rescue Wasalx::GroupWorkspace::Rejected
        link_denied = true
      end
      assert.call(link_denied && unbound.reload.wasalx_connection_id.blank? &&
        !Ticket::Article.exists?(ticket_id: unbound.id) && remote_attempts.zero?,
        'Native linking skipped restrictive workflow or escaped rollback')
      workflow.destroy!
      workflow = nil
      create_input = create_input.merge(request_token: SecureRandom.uuid)
      fail_link = true
      begin
        Wasalx::GroupWorkspace.new(actor: native_actor).create_ticket(**create_input)
        raise 'Synthetic partial link was not exercised'
      rescue Wasalx::Client::TemporaryRequestFailed
        # Native effect is committed; remote group link remains unconfirmed.
      end
      native_article = Ticket::Article.find_by!(wasalx_operation_key: "wasalx:group:#{ENV.fetch('WASALX_TENANT_ID')}:create:#{source_message}")
      assert.call(native_article.created_by_id == native_actor.id && remote_attempts == 1,
        'Partial create lost human attribution or duplicated remote attempt')
      reader_input = create_input.merge(request_token: SecureRandom.uuid)
      denied_repair = false
      begin
        Wasalx::GroupWorkspace.new(actor: read_only_actor).create_ticket(**reader_input)
      rescue Exceptions::Forbidden
        denied_repair = true
      end
      assert.call(denied_repair && remote_attempts == 1, 'Read-only replay repaired an unconfirmed remote link')
      remote_links << { 'ticket_id' => native_article.ticket_id.to_s, 'article_id' => native_article.id.to_s }
      result = Wasalx::GroupWorkspace.new(actor: read_only_actor).create_ticket(**reader_input)
      assert.call(result.data[:article_id] == native_article.id.to_s && !result.created && remote_attempts == 1,
        'Read-only completed replay either failed or mutated the remote link')
    ensure
      workflow&.destroy!
      Wasalx::Client.define_singleton_method(:get, boundary_get)
      Wasalx::Client.define_singleton_method(:post, boundary_post)
    end
  end

  check.call('native-ticket-create-options-idempotency-and-absence-fence') do
    state = Ticket::State.find_by!(name: 'open', active: true)
    new_input = { operation_id: SecureRandom.uuid, title: "Created in WasalX #{SecureRandom.hex(5)}",
      group_id: group.id.to_s, customer_id: customer.id.to_s, state_id: state.id.to_s, body: 'Synthetic internal case', internal: true }
    status, options = call.call('CREATE_OPTIONS', { group_id: group.id.to_s, query: 'customer' })
    assert.call(status == 200 && options['can_create'] && options['groups'].any? { |row| row['id'] == group.id.to_s }, 'Create options omitted native create group')
    assert.call(options['groups'].none? { |row| row['id'] == other_group.id.to_s }, 'Create options exposed denied native group')
    assert.call(call.call('CREATE_OPTIONS', { group_id: other_group.id.to_s }).first == 403, 'Denied create group selectable')
    assert.call(call.call('CREATE_OPTIONS', {}, members['reader']).last['can_create'] == false, 'Read-only native agent can create')
    status, created = call.call('CREATE_TICKET', new_input)
    assert.call(status == 200 && created['state'] == 'APPLIED', "Native creation failed #{status}")
    new_ticket = Ticket.find(created.fetch('ticket_id'))
    new_article = Ticket::Article.find(created.fetch('article_id'))
    assert.call(new_ticket.customer_id == customer.id && new_ticket.group_id == group.id && new_ticket.created_by_id == members['agent'].user_id, 'Native create changed customer/team/actor')
    assert.call(new_article.internal && new_article.type.name == 'note' && new_article.created_by_id == members['agent'].user_id, 'Internal create admitted public article')
    assert.call(call.call('CREATE_TICKET', new_input).last['ticket_id'] == created['ticket_id'] && Ticket.where(title: new_input[:title]).count == 1, 'Create replay duplicated ticket')
    assert.call(call.call('CREATE_TICKET', new_input.merge(title: 'Changed intent')).first == 409, 'Same create UUID accepted changed intent')
    assert.call(call.call('CREATE_RECEIPT', { operation_id: new_input[:operation_id], action: 'LOOKUP' }).last['state'] == 'APPLIED', 'Committed create receipt missing')
    assert.call(call.call('RECEIPT', { ticket_id: new_ticket.id.to_s, operation_id: new_input[:operation_id] }).first == 409, 'Ticket-only receipt exposed create family')
    cancelled = new_input.merge(operation_id: SecureRandom.uuid, title: "Cancelled create #{SecureRandom.hex(5)}")
    assert.call(call.call('CREATE_RECEIPT', { operation_id: cancelled[:operation_id], action: 'LOOKUP' }).last['state'] == 'UNKNOWN', 'Absent create lookup claimed no effect')
    status, result = call.call('CREATE_RECEIPT', { operation_id: cancelled[:operation_id], action: 'CANCEL_IF_UNADMITTED' })
    assert.call(status == 200 && result['state'] == 'NOT_APPLIED' && result['terminal'], 'Create cancellation lacks terminal fence')
    assert.call(WasalxTicketOperation.find_by!(operation_id: cancelled[:operation_id]).ticket_id.nil?, 'Absent-ticket fence fabricated a ticket')
    assert.call(call.call('CREATE_TICKET', cancelled).last['state'] == 'NOT_APPLIED' && !Ticket.exists?(title: cancelled[:title]), 'Delayed cancelled create wrote native ticket')
    missing = new_input.merge(operation_id: SecureRandom.uuid, customer_id: '999999999999999', title: "Missing customer #{SecureRandom.hex(5)}")
    assert.call(call.call('CREATE_TICKET', missing).first == 404, 'Missing customer did not fail before effect')
    assert.call(call.call('CREATE_RECEIPT', { operation_id: missing[:operation_id], action: 'LOOKUP' }).last['state'] == 'UNKNOWN', 'Missing customer produced false terminal lookup')
    assert.call(call.call('CREATE_RECEIPT', { operation_id: missing[:operation_id], action: 'CANCEL_IF_UNADMITTED' }).last['state'] == 'NOT_APPLIED', 'Lost pre-effect failure cannot be stopped after reload')
    assert.call(call.call('CREATE_RECEIPT', { operation_id: new_input[:operation_id], action: 'LOOKUP' }, members['reader']).first == 409, 'Another actor recovered create receipt')
    assert.call(call.call('CREATE_TICKET', new_input.merge(operation_id: SecureRandom.uuid), members['reader']).first == 403, 'Read-only native grant created a ticket')
  end

  check.call('native-ticket-create-cancel-race-and-receipt-rollback') do
    input = { operation_id: SecureRandom.uuid, title: "Raced native creation #{SecureRandom.hex(5)}",
      group_id: group.id.to_s, customer_id: customer.id.to_s, state_id: Ticket::State.find_by!(name: 'open').id.to_s,
      body: 'Single admitted creation', internal: true }
    start = Queue.new
    workers = [
      Thread.new { ActiveRecord::Base.connection_pool.with_connection { start.pop; call.call('CREATE_TICKET', input) } },
      Thread.new { ActiveRecord::Base.connection_pool.with_connection { start.pop; call.call('CREATE_RECEIPT', { operation_id: input[:operation_id], action: 'CANCEL_IF_UNADMITTED' }) } }
    ]
    2.times { start << true }
    results = workers.map(&:value)
    assert.call(results.all? { |status, _| status == 200 }, 'Create/cancel race failed instead of serializing')
    row = WasalxTicketOperation.find_by!(operation_id: input[:operation_id])
    expected = row.kind == 'CREATE_TICKET' ? 1 : 0
    assert.call(Ticket.where(title: input[:title]).count == expected && %w[CREATE_TICKET CANCELLED_CREATE_TICKET].include?(row.kind), 'Create/cancel race committed inconsistent native effect')
    rollback = input.merge(operation_id: SecureRandom.uuid, title: "Rolled back creation #{SecureRandom.hex(5)}")
    failed = -> { raise ArgumentError, 'Synthetic creation receipt failure' if operation_id == rollback[:operation_id] }
    WasalxTicketOperation.set_callback(:create, :before, failed)
    begin
      before_jobs = Delayed::Job.pluck(:id).sort
      assert.call(call.call('CREATE_TICKET', rollback).first == 400, 'Injected create receipt error did not surface')
      assert.call(!Ticket.exists?(title: rollback[:title]) && !WasalxTicketOperation.exists?(operation_id: rollback[:operation_id]), 'Create/receipt rollback leaked native effect')
      assert.call(Delayed::Job.pluck(:id).sort == before_jobs, 'Rolled back create queued native work')
    ensure
      WasalxTicketOperation.skip_callback(:create, :before, failed)
    end
  end

  check.call('native-ticket-transfer-create-workflow-and-email-driver') do
    actor = members['agent'].user.reload
    original_grants = actor.group_ids_access_map
    workflow = nil
    input = { operation_id: SecureRandom.uuid, title: "Workflow creation #{SecureRandom.hex(5)}",
      group_id: group.id.to_s, customer_id: customer.id.to_s, state_id: Ticket::State.find_by!(name: 'open').id.to_s,
      body: 'Native workflow applies', internal: true }
    begin
      workflow = UserInfo.with_user_id(members['owner'].user_id) do
        CoreWorkflow.create!(name: "Portal create restriction #{SecureRandom.hex(5)}", object: 'Ticket', active: true,
          changeable: true, priority: 1, stop_after_match: true, condition_saved: {},
          condition_selected: { 'ticket.group_id' => { 'operator' => 'is', 'value' => [group.id.to_s] } },
          perform: { 'ticket.title' => { 'operator' => 'set_fixed_to', 'set_fixed_to' => ['Another required title'] } },
          preferences: { 'screen' => ['create_middle'] }, created_by_id: actor.id, updated_by_id: actor.id)
      end
      assert.call(call.call('CREATE_TICKET', input).first != 200 && !Ticket.exists?(title: input[:title]), 'Native create bypassed workflow screen')
      workflow.destroy!; workflow = nil
      transfer = make_ticket.call(group, 'transfer', false)
      update = { ticket_id: transfer.id.to_s, operation_id: SecureRandom.uuid, expected_updated_at: transfer.updated_at.utc.iso8601(6), group_id: other_group.id.to_s }
      assert.call(call.call('UPDATE', update).first == 403 && transfer.reload.group_id == group.id, 'Transfer bypassed target native create grant')
      actor.group_ids_access_map = original_grants.merge(other_group.id => 'full'); actor.save!
      assert.call(call.call('UPDATE', update.merge(operation_id: SecureRandom.uuid, owner_id: members['owner'].user_id.to_s)).first == 403, 'Transfer assigned owner outside target team')
      status, result = call.call('UPDATE', update.merge(operation_id: SecureRandom.uuid, owner_id: actor.id.to_s))
      assert.call(status == 200 && transfer.reload.group_id == other_group.id && transfer.owner_id == actor.id, 'Authorized native transfer failed')
      assert.call(call.call('UPDATE', update.merge(operation_id: SecureRandom.uuid)).first == 409, 'Stale transfer bypassed optimistic version')
      email_input = input.merge(operation_id: SecureRandom.uuid, title: "Native outbound email #{SecureRandom.hex(5)}", internal: false)
      status, created = call.call('CREATE_TICKET', email_input)
      assert.call(status == 200, 'Configured native email ticket creation failed')
      article = Ticket::Article.find(created.fetch('article_id'))
      assert.call(article.type.name == 'email' && !article.internal && article.to == customer.email && article.from.include?(group.email_address.email), 'New email bypassed native recipient/from driver')
      outgoing_ticket = Ticket.find(created.fetch('ticket_id'))
      status, followup = call.call('REPLY', { ticket_id: outgoing_ticket.id.to_s, operation_id: SecureRandom.uuid,
        expected_updated_at: outgoing_ticket.updated_at.utc.iso8601(6), body: 'Proactive follow-up', internal: false })
      assert.call(status == 200 && Ticket::Article.find(followup.fetch('article_id')).to == customer.email, 'Initiated email lacks valid native follow-up recipient')
    ensure
      workflow&.destroy!
      actor.group_ids_access_map = original_grants; actor.save!
    end
  end

  check.call('native-full-article-text-bounds-version-and-policy') do
    full_ticket = make_ticket.call(group, 'full-text', false)
    text = ([0x0633, 0x1F600].pack('U*') * 30_000)
    article = UserInfo.with_user_id(customer.id) do
      Ticket::Article.create!(ticket: full_ticket, sender: customer_sender, type: note_type, internal: false,
        content_type: 'text/plain', body: text, created_by_id: customer.id, updated_by_id: customer.id)
    end
    status, listing = call.call('ARTICLES', { ticket_id: full_ticket.id.to_s })
    prefix = listing.fetch('items').find { |item| item['id'] == article.id.to_s }
    assert.call(status == 200 && prefix['body'] == text[0, 50_000] && !prefix['body_complete'] && prefix['total_characters'] == text.length, 'Initial article body truncation is hidden or loses codepoints')
    status, rest = call.call('ARTICLE_CONTENT', { ticket_id: full_ticket.id.to_s, article_id: article.id.to_s,
      offset: 50_000, limit: 50_000, expected_sha256: prefix.fetch('body_sha256') })
    assert.call(status == 200 && prefix['body'] + rest['body'] == text && rest['next_offset'].nil?, 'Full article pagination lost or split Unicode text')
    assert.call(call.call('ARTICLE_CONTENT', { ticket_id: ticket.id.to_s, article_id: article.id.to_s }).first == 403, 'Full text crossed ticket policy boundary')
    assert.call(call.call('ARTICLE_CONTENT', { ticket_id: full_ticket.id.to_s, article_id: article.id.to_s, offset: -1 }).first == 400, 'Negative text offset accepted')
    article.update!(body: text + ' edited')
    assert.call(call.call('ARTICLE_CONTENT', { ticket_id: full_ticket.id.to_s, article_id: article.id.to_s,
      offset: 50_000, expected_sha256: prefix.fetch('body_sha256') }).first == 409, 'Full text stitched different article versions')
  end

  check.call('native-ticket-upload-ownership-target-and-selected-set') do
    caches = []
    make_upload = lambda do |actor_id, target, name|
      cache = SecureRandom.uuid
      caches << [cache, actor_id]
      store = UserInfo.with_user_id(actor_id) do
        UploadCache.new(cache).add(filename: name, data: 'Owned native cache fixture',
          preferences: { 'Content-Type' => 'text/plain', 'Wasalx-Portal-Target' => target }, created_by_id: actor_id)
      end
      [cache, store]
    end
    input = { operation_id: SecureRandom.uuid, title: "Upload creation #{SecureRandom.hex(5)}",
      group_id: group.id.to_s, customer_id: customer.id.to_s, state_id: Ticket::State.find_by!(name: 'open').id.to_s,
      body: 'Only selected owned files', internal: true }
    target = { 'kind' => 'CREATE_GROUP', 'id' => group.id.to_s }
    begin
      foreign_cache, foreign = make_upload.call(members['reader'].user_id, target, 'foreign.txt')
      assert.call(call.call('CREATE_TICKET', input.merge(form_id: foreign_cache, attachment_ids: [foreign.id.to_s])).first == 403, 'Create consumed another actor upload')
      wrong_cache, wrong = make_upload.call(members['agent'].user_id, { 'kind' => 'CREATE_GROUP', 'id' => other_group.id.to_s }, 'wrong-team.txt')
      assert.call(call.call('CREATE_TICKET', input.merge(form_id: wrong_cache, attachment_ids: [wrong.id.to_s])).first == 403, 'Create consumed another target cache')
      own_cache, own = make_upload.call(members['agent'].user_id, target, 'selected.txt')
      assert.call(call.call('CREATE_TICKET', input.merge(form_id: own_cache, attachment_ids: [])).first == 403, 'Native form attached an unselected file')
      status, result = call.call('CREATE_TICKET', input.merge(body: '', form_id: own_cache, attachment_ids: [own.id.to_s]))
      assert.call(status == 200 && Ticket::Article.find(result.fetch('article_id')).attachments.map(&:filename) == ['selected.txt'], 'Native article did not consume exact selected cache')
      assert.call(UploadCache.new(foreign_cache).attachments(created_by_id: members['reader'].user_id).any?, 'Foreign cache was deleted on rejection')
      assert.call(UploadCache.new(own_cache).attachments(created_by_id: members['agent'].user_id).empty?, 'Native successful create skipped upload cache callback')
    ensure
      caches.each { |cache, actor_id| UserInfo.with_user_id(actor_id) { UploadCache.new(cache).destroy } }
    end
  end

  check.call('native-attachment-only-group-reply-keeps-empty-caption') do
    media_ticket = make_ticket.call(group, 'attachment-only', true)
    actor_id = members['agent'].user_id
    cache_id = SecureRandom.uuid
    begin
      upload = UserInfo.with_user_id(actor_id) do
        UploadCache.new(cache_id).add(filename: 'reply.txt', data: 'Synthetic media-only reply',
          preferences: { 'Content-Type' => 'text/plain', 'Wasalx-Portal-Target' => { 'kind' => 'TICKET', 'id' => media_ticket.id.to_s } },
          created_by_id: actor_id)
      end
      before_admissions = admissions.length
      status, result = call.call('REPLY', { ticket_id: media_ticket.id.to_s, operation_id: SecureRandom.uuid,
        expected_updated_at: media_ticket.reload.updated_at.utc.iso8601(6), body: '', internal: false,
        form_id: cache_id, attachment_ids: [upload.id.to_s] })
      assert.call(status == 200, "Native attachment-only group reply failed (#{status})")
      attachment_reply = Ticket::Article.find(result.fetch('article_id'))
      assert.call(attachment_reply.type.name == 'wasalx group message' && attachment_reply.body == '' &&
        attachment_reply.attachments.map(&:filename) == ['reply.txt'], 'Native group reply changed the blank caption or selected attachment')
      CommunicateWasalxJob.new.perform(attachment_reply.id)
      assert.call(admissions.length == before_admissions + 1 && admissions.last[:article_id] == attachment_reply.id &&
        admissions.last[:body] == '' && admissions.last[:attachments].map { |file| file.fetch(:filename) } == ['reply.txt'],
        'Outbound group reply lost the attachment or added a caption')
    ensure
      UserInfo.with_user_id(actor_id) { UploadCache.new(cache_id).destroy }
    end
  end

  check.call('native-group-receipt-fences-races-and-savepoints') do
    require 'timeout'
    actor = members['agent'].user.reload
    boundary_get = Wasalx::Client.method(:get)
    boundary_post = Wasalx::Client.method(:post)
    group_uuid = SecureRandom.uuid
    connection_uuid = SecureRandom.uuid
    sources = {}
    links = Hash.new { |hash, key| hash[key] = [] }
    lost_links = []
    remote_calls = []
    add_case = lambda do
      message = SecureRandom.uuid
      sources[message] = { 'id' => message, 'group_id' => group_uuid, 'connection_id' => connection_uuid,
        'external_group_id' => 'fixture-0029@example.test', 'group_name' => group.name,
        'external_message_id' => "native-receipt-#{message}", 'external_participant_id' => '12025550181@c.us',
        'participant_name' => 'Synthetic participant', 'provider' => 'WAHA',
        'zammad_customer_id' => customer.id.to_s, 'message_text' => 'Synthetic native receipt',
        'from_me' => false, 'ticket_creatable' => true, 'media_available' => false }
      { group_id: group_uuid, message_id: message, request_token: SecureRandom.uuid,
        target_group_id: group.id.to_s, title: "Receipt native #{message}" }
    end
    receipt_input = lambda do |kind, input|
      value = input.slice(:group_id, :message_id, :request_token).merge(kind: kind)
      value[:ticket_number] = input.fetch(:ticket_number) if kind == 'GROUP_LINK'
      value
    end
    submit = lambda do |kind, input|
      workspace = Wasalx::GroupWorkspace.new(actor: actor)
      kind == 'GROUP_CREATE' ? workspace.create_ticket(**input) :
        workspace.link_ticket(**input.slice(:group_id, :message_id, :request_token, :ticket_number))
    end
    Wasalx::Client.define_singleton_method(:get) do |path, **options|
      if path.start_with?('/internal/v1/zammad/group-workspace/groups?') && URI.decode_www_form(URI.parse(path).query).to_h['selected'] == group_uuid
        next({ 'items' => [{ 'id' => group_uuid }] })
      end
      match = %r{\A/internal/v1/zammad/group-workspace/groups/#{group_uuid}/messages/([0-9a-f-]+)/source\z}.match(path)
      if match
        message_source = sources.fetch(match[1])
        raise Wasalx::Client::PermanentRequestFailed.new('Synthetic retained source absent', http_status: 404) unless message_source
        message_source.merge('links' => links[match[1]].dup)
      else
        boundary_get.call(path, **options)
      end
    end
    Wasalx::Client.define_singleton_method(:post) do |path, input, **options|
      match = %r{\A/internal/v1/zammad/group-workspace/groups/#{group_uuid}/messages/([0-9a-f-]+)/tickets\z}.match(path)
      if match
        raise 'Native group receipt actor/scope differs' unless options[:scope] == 'zammad:groups' && options.dig(:actor, :user_id) == actor.id
        remote_calls << [match[1], input]
        raise Wasalx::Client::TemporaryRequestFailed, 'Synthetic lost link response' if lost_links.include?(match[1])
        link = { 'ticket_id' => input[:ticketId].to_s, 'article_id' => input[:articleId].to_s }
        links[match[1]] << link unless links[match[1]].include?(link)
        { 'linked' => true }
      else
        boundary_post.call(path, input, **options)
      end
    end
    begin
      %w[GROUP_CREATE GROUP_LINK].each do |kind|
        %w[cancel submit].each do |winner|
          input = add_case.call
          input[:ticket_number] = make_ticket.call(group, 'receipt-race-target', false).number.to_s if kind == 'GROUP_LINK'
          operation = input[:request_token]
          before = Ticket::Article.count
          reached = Queue.new
          release = Queue.new
          hook = lambda do
            if operation_id == operation && Thread.current[:native_group_leader]
              reached << true
              Timeout.timeout(15) { release.pop }
            end
          end
          WasalxTicketOperation.set_callback(:create, :before, hook)
          action = lambda do |name|
            name == 'cancel' ? Wasalx::GroupWorkspace.new(actor: actor).group_receipt(**receipt_input.call(kind, input), action: 'CANCEL_IF_UNADMITTED') : submit.call(kind, input)
          end
          leader = nil
          follower = nil
          begin
            leader = Thread.new do
              ActiveRecord::Base.connection_pool.with_connection do
                Thread.current[:native_group_leader] = true
                begin action.call(winner); rescue StandardError => error; error; ensure Thread.current[:native_group_leader] = nil; end
              end
            end
            Timeout.timeout(15) { reached.pop }
            follower_started = Queue.new
            follower = Thread.new do
              ActiveRecord::Base.connection_pool.with_connection do
                follower_started << true
                begin action.call(winner == 'cancel' ? 'submit' : 'cancel'); rescue StandardError => error; error; end
              end
            end
            Timeout.timeout(15) { follower_started.pop }
            release << true
            outcomes = Timeout.timeout(30) { [leader.value, follower.value] }
            row = WasalxTicketOperation.find_by!(operation_id: operation)
            if winner == 'cancel'
              assert.call(outcomes.first.is_a?(Hash) && outcomes.first['state'] == 'NOT_APPLIED' &&
                outcomes.last.is_a?(Wasalx::GroupWorkspace::Conflict) && row.ticket_id.nil? &&
                row.kind == "CANCELLED_#{kind}" && Ticket::Article.count == before,
                "#{kind} cancellation failed to fence delayed native submission")
            else
              assert.call(outcomes.none? { |item| item.is_a?(Exception) } && row.kind == kind && row.ticket_id.present? &&
                %w[PARTIAL COMPLETE].include?(outcomes.last['state']) && Ticket::Article.count == before + 1,
                "#{kind} committed submission was overwritten by cancellation")
            end
          ensure
            release << true
            leader&.join(20)
            follower&.join(20)
            WasalxTicketOperation.skip_callback(:create, :before, hook)
          end
        end
      end

      missing = add_case.call.merge(ticket_number: '999999999999999')
      begin
        submit.call('GROUP_LINK', missing)
        raise 'Missing target did not return explicit rejection'
      rescue Wasalx::GroupWorkspace::RejectedMissing => error
        assert.call(error.status == 404 && error.result['terminal'] == true && error.result['effect'] == 'NONE',
          'Missing target rejection preceded committed fence')
      end
      missing_row = WasalxTicketOperation.find_by!(operation_id: missing[:request_token])
      assert.call(missing_row.kind == 'CANCELLED_GROUP_LINK' && missing_row.ticket_id.nil?, 'Missing target lacks durable zero-effect receipt')
      replay = Wasalx::GroupWorkspace.new(actor: actor).group_receipt(**receipt_input.call('GROUP_LINK', missing), action: 'CANCEL_IF_UNADMITTED')
      assert.call(replay['state'] == 'NOT_APPLIED', 'Reload lost missing-target cancellation')

      partial = add_case.call
      lost_links << partial[:message_id]
      begin submit.call('GROUP_CREATE', partial); rescue Wasalx::Client::TemporaryRequestFailed; end
      workspace = Wasalx::GroupWorkspace.new(actor: actor)
      args = receipt_input.call('GROUP_CREATE', partial)
      projection = workspace.group_receipt(**args, action: 'CANCEL_IF_UNADMITTED')
      assert.call(projection['state'] == 'PARTIAL' && projection['ticket_number'].present?, 'Partial native effect was misreported as cancelled')
      before = [Ticket.count, Ticket::Article.count]
      lost_links.delete(partial[:message_id])
      repaired = workspace.repair_ticket_link(**args)
      assert.call(repaired['state'] == 'COMPLETE' && before == [Ticket.count, Ticket::Article.count], 'Repair recreated native effect')
      prior_links = links[partial[:message_id]]
      links[partial[:message_id]] = [{ 'ticket_id' => repaired['ticket_id'], 'article_id' => (repaired['article_id'].to_i + 1).to_s }]
      posts_before = remote_calls.length
      [-> { workspace.group_receipt(**args) }, -> { workspace.repair_ticket_link(**args) }].each do |operation|
        begin operation.call; raise 'Changed same-ticket article mapping accepted'; rescue Wasalx::GroupWorkspace::Conflict; end
      end
      assert.call(remote_calls.length == posts_before, 'Conflicting mapping attempted remote repair')
      links[partial[:message_id]] = prior_links

      begin
        submit.call('GROUP_CREATE', partial.merge(title: 'Changed same UUID intent'))
        raise 'Changed fingerprint was admitted'
      rescue Wasalx::GroupWorkspace::Conflict
      end

      failed = add_case.call
      hook = -> { raise 'Synthetic receipt storage failure' if operation_id == failed[:request_token] }
      jobs_before = Delayed::Job.pluck(:id).sort
      counts_before = [Ticket.count, Ticket::Article.count]
      WasalxTicketOperation.set_callback(:create, :before, hook)
      begin
        begin submit.call('GROUP_CREATE', failed); raise 'Receipt failure not exercised'; rescue RuntimeError => error; raise unless error.message == 'Synthetic receipt storage failure'; end
      ensure
        WasalxTicketOperation.skip_callback(:create, :before, hook)
      end
      assert.call(!WasalxTicketOperation.exists?(operation_id: failed[:request_token]) && counts_before == [Ticket.count, Ticket::Article.count] &&
        jobs_before == Delayed::Job.pluck(:id).sort, 'Native effect/receipt/jobs escaped atomic rollback')

      # Retention must not strand committed cancellation, nor turn native effect into no-effect.
      retired = add_case.call
      retired_args = receipt_input.call('GROUP_CREATE', retired)
      sources[retired[:message_id]] = nil
      begin
        submit.call('GROUP_CREATE', retired)
        raise 'Missing source was not rejected'
      rescue Wasalx::GroupWorkspace::RejectedMissing => error
        assert.call(error.result['state'] == 'NOT_APPLIED', 'Missing source lost durable pre-effect proof')
      end
      assert.call(workspace.group_receipt(**retired_args)['state'] == 'NOT_APPLIED', 'Retained source blocked cancellation recovery')
      assert.call(workspace.repair_ticket_link(**retired_args)['state'] == 'NOT_APPLIED', 'Retained source blocked terminal repair projection')

      retired = add_case.call
      submit.call('GROUP_CREATE', retired)
      retired_args = receipt_input.call('GROUP_CREATE', retired)
      sources[retired[:message_id]] = nil
      before = remote_calls.length
      assert.call(workspace.group_receipt(**retired_args, action: 'CANCEL_IF_UNADMITTED')['state'] == 'PARTIAL', 'Retained source falsely cancelled committed native effect')
      assert.call(workspace.repair_ticket_link(**retired_args)['state'] == 'PARTIAL' && remote_calls.length == before, 'Repair posted without current source')

      # Historical explicit control link may name an existing note on an unbound native ticket.
      explicit = add_case.call
      target = make_ticket.call(group, 'explicit-old-link', false)
      historical_article = UserInfo.with_user_id(actor.id) do
        Transaction.execute do
          Ticket::Article.create!(ticket: target, sender: customer_sender, type: note_type, internal: false,
            content_type: 'text/plain', body: 'Synthetic historical group note', created_by_id: actor.id, updated_by_id: actor.id)
        end
      end
      links[explicit[:message_id]] << { 'ticket_id' => target.id.to_s, 'article_id' => historical_article.id.to_s }
      explicit[:ticket_number] = target.number.to_s
      read_only_denied = false
      begin
        Wasalx::GroupWorkspace.new(actor: members['reader'].user.reload).link_ticket(**explicit.slice(:group_id, :message_id, :request_token, :ticket_number))
      rescue Exceptions::Forbidden
        read_only_denied = true
      end
      assert.call(read_only_denied && target.reload.wasalx_connection_id.blank? && !WasalxTicketOperation.exists?(operation_id: explicit[:request_token]), 'Read-only historical LINK mutated binding or receipt')
      before = [Ticket::Article.count, remote_calls.length]
      result = submit.call('GROUP_LINK', explicit)
      assert.call(result[:article_id] == historical_article.id.to_s && target.reload.wasalx_connection_id == connection_uuid &&
        before == [Ticket::Article.count, remote_calls.length], 'Historical LINK failed to bind exact existing article without extra effects')

      # Different source locks may still race on one customer login. Real uniqueness and
      # requires_new savepoints must recover without leaving either outer receipt aborted.
      inputs = [add_case.call, add_case.call]
      inputs.each { |input| sources[input[:message_id]].delete('zammad_customer_id') }
      login = "wasalx-#{Digest::SHA256.hexdigest([ENV.fetch('WASALX_TENANT_ID'), connection_uuid, '12025550181@c.us'].join("\u001f"))}"
      arrived = Queue.new
      release = Queue.new
      hook = lambda do
        if self.login == login
          arrived << true
          Timeout.timeout(15) { release.pop }
        end
      end
      User.set_callback(:create, :before, hook)
      threads = []
      begin
        threads = inputs.map do |input|
          Thread.new { ActiveRecord::Base.connection_pool.with_connection { begin submit.call('GROUP_CREATE', input); rescue StandardError => error; error; end } }
        end
        2.times { Timeout.timeout(15) { arrived.pop } }
        2.times { release << true }
        outcomes = Timeout.timeout(30) { threads.map(&:value) }
        assert.call(outcomes.none? { |item| item.is_a?(Exception) } && User.where(login: login).count == 1 &&
          WasalxTicketOperation.where(operation_id: inputs.map { |input| input[:request_token] }, kind: 'GROUP_CREATE').count == 2,
          'Concurrent customer identity race poisoned a native receipt transaction')
      ensure
        2.times { release << true }
        threads.each { |thread| thread.join(20) }
        User.skip_callback(:create, :before, hook)
      end

      # Actual PostgreSQL CHECK must reject null ticket IDs for old/committed kinds.
      %w[REPLY UPDATE CANCELLED GROUP_CREATE GROUP_LINK CREATE_TICKET].each do |kind|
        rejected_null = false
        begin
          WasalxTicketOperation.transaction(requires_new: true) do
            WasalxTicketOperation.create!(operation_id: SecureRandom.uuid, portal_user_id: members['agent'].portal_user_id,
              native_user_id: actor.id, ticket_id: nil, kind: kind, request_sha256: '0' * 64, result: {})
          end
        rescue ActiveRecord::StatementInvalid
          rejected_null = true
        end
        assert.call(rejected_null, "NULL ticket receipt admitted for #{kind}")
      end
    ensure
      Wasalx::Client.define_singleton_method(:get, boundary_get)
      Wasalx::Client.define_singleton_method(:post, boundary_post)
    end
  end

  check.call('native-binary-staging-target-ownership-and-idempotent-retry') do
    staged_cache = SecureRandom.uuid
    raw_upload = lambda do |input, member = members['agent'], content = 'Synthetic staged attachment', digest = nil|
      envelope = { purpose: Wasalx::PortalDelegation::UPLOAD_PURPOSE, tenant_id: ENV.fetch('WASALX_TENANT_ID'),
        instance_id: ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID'), source: portal_source,
        actor: { user_id: member.portal_user_id, subject: member.subject, revision: member.revision, native_user_id: member.user_id.to_s },
        assurance: { auth_time: Time.now.to_i, amr: ['mfa'], acr: nil }, operation: 'TICKET_UPLOAD', input: input,
        file: { filename: 'owned.txt', mime_type: 'text/plain', byte_size: content.bytesize, sha256: digest || Digest::SHA256.hexdigest(content) } }
      body = JSON.generate(envelope)
      timestamp = Time.now.to_i.to_s
      signature = OpenSSL::HMAC.hexdigest('SHA256', ENV.fetch('WASALX_SERVICE_JWT_SECRET'),
        "#{Wasalx::PortalDelegation::UPLOAD_PURPOSE}\nPOST\n#{Wasalx::PortalDelegation::UPLOAD_PATH}\n#{timestamp}\n#{body}")
      http = ActionDispatch::Integration::Session.new(Rails.application)
      http.host!('localhost')
      http.post(Wasalx::PortalDelegation::UPLOAD_PATH, params: content,
        headers: { 'Authorization' => "Token token=#{runtime.token}", 'Content-Type' => 'application/octet-stream',
          'Accept' => 'application/json', 'Content-Length' => content.bytesize.to_s,
          'X-Wasalx-Upload-Envelope' => Base64.urlsafe_encode64(body, padding: false),
          'X-Wasalx-Timestamp' => timestamp, 'X-Wasalx-Signature' => signature })
      response = http.response
      json = response.media_type == 'application/json'
      assert.call(json, 'Successful staging response must be JSON') if response.status == 200
      [response.status, json ? JSON.parse(response.body) : nil]
    end
    input = { ticket_id: ticket.id.to_s, upload_cache_id: staged_cache }
    status, result = raw_upload.call(input)
    assert.call(status == 200 && result['items'].length == 1, "Native staging failed (#{status})")
    item = result.fetch('items').first
    stored = UploadCache.new(staged_cache).attachments(created_by_id: members['agent'].user_id).find_by!(id: item.fetch('id'))
    assert.call(stored.content == 'Synthetic staged attachment' && stored.preferences['Wasalx-Portal-Target'] ==
      { 'kind' => 'TICKET', 'id' => ticket.id.to_s }, 'Staging lost actor, bytes or destination binding')
    assert.call(raw_upload.call(input).last == result, 'Lost staging result duplicated the native item')

    concurrent_cache = SecureRandom.uuid
    begin
      UserInfo.with_user_id(members['agent'].user_id) do
        9.times do |index|
          UploadCache.new(concurrent_cache).add(filename: "existing-#{index}.txt", data: 'existing',
            preferences: { 'Content-Type' => 'text/plain', 'Wasalx-Portal-Target' => { 'kind' => 'TICKET', 'id' => ticket.id.to_s } },
            created_by_id: members['agent'].user_id)
        end
      end
      rows = 2.times.map do |index|
        Thread.new do
          ActiveRecord::Base.connection_pool.with_connection do
            raw_upload.call(input.merge(upload_cache_id: concurrent_cache), members['agent'], "Concurrent staged item #{index}")
          end
        end
      end.map(&:value)
      assert.call(rows.map(&:first).sort == [200, 400] &&
        UploadCache.new(concurrent_cache).attachments(created_by_id: members['agent'].user_id).count == 10,
        'Concurrent staged files crossed the cache limit')
    ensure
      UserInfo.with_user_id(members['agent'].user_id) { UploadCache.new(concurrent_cache).destroy }
    end

    assert.call(raw_upload.call(input, members['agent'], 'Changed staged bytes', '0' * 64).first == 400, 'Tampered upload content reached Store')
    assert.call(raw_upload.call(input, members['reader']).first == 403, 'Read-only actor staged a ticket attachment')
    assert.call(raw_upload.call(input.merge(ticket_id: hidden.id.to_s)).first == 403, 'Foreign team accepted a staged attachment')
    assert.call(raw_upload.call(input.merge(ticket_id: plain.id.to_s)).first == 400, 'One cache crossed destination binding')
    remove = input.merge(upload_store_id: item.fetch('id'))
    assert.call(call.call('REMOVE_UPLOAD', remove, members['owner']).first == 404, 'Another actor deleted a staged item')
    assert.call(Store.exists?(stored.id), 'Foreign deletion altered own cache')
    assert.call(call.call('REMOVE_UPLOAD', remove).first == 200 && !Store.exists?(stored.id), 'Owner could not remove staged file')
  ensure
    if staged_cache
      UserInfo.with_user_id(members['agent'].user_id) { UploadCache.new(staged_cache).destroy }
    end
  end

  check.call('native-portal-preview-reuses-route-and-does-not-admit-effects') do
    boundary = Wasalx::Client.method(:post)
    previews = []
    begin
      Wasalx::Client.define_singleton_method(:post) do |path, input, **options|
        if path == '/internal/v1/zammad/reply-preview'
          raise 'Preview attribution mismatch' unless options[:scope] == 'zammad:outbound' && options.dig(:actor, :user_id) == members['agent'].user_id
          previews << input.deep_dup
          { 'text' => "Rendered #{input.fetch(:body)}", 'replyToMessageId' => 'private-provider-target' }
        else
          boundary.call(path, input, **options)
        end
      end
      snapshot = [Ticket.count, Ticket::Article.count, Store.count, WasalxTicketOperation.count, Delayed::Job.count]
      input = { ticket_id: ticket.id.to_s, expected_updated_at: ticket.reload.updated_at.utc.iso8601(6),
        body: 'Exact preview draft', internal: false }
      status, result = call.call('PREVIEW', input)
      assert.call(status == 200 && result['text'] == 'Rendered Exact preview draft' && result['quoted'] && result['can_send'], 'Portal preview did not use shared outbound preparation')
      assert.call(previews.length == 1 && previews.last[:body] == input[:body] && previews.last[:ticket_id] == ticket.id, 'Preview altered draft/native ticket identity')
      assert.call(!result.to_json.include?('private-provider-target') && result['draft_sha256'].match?(/\A[a-f0-9]{64}\z/), 'Preview leaked provider target or lacks snapshot hash')
      assert.call(snapshot == [Ticket.count, Ticket::Article.count, Store.count, WasalxTicketOperation.count, Delayed::Job.count], 'Read-only preview wrote native effects')
      status, internal_preview = call.call('PREVIEW', input.merge(internal: true))
      assert.call(status == 200 && internal_preview['channel'] == 'internal_note' && internal_preview['text'] == input[:body] &&
        internal_preview['recipient'].nil? && previews.length == 1, 'Internal-note preview dispatched or named external recipient')
      assert.call(internal_preview['draft_sha256'] != result['draft_sha256'], 'Preview hash ignored internal/public mode')
      assert.call(call.call('PREVIEW', input.merge(expected_updated_at: 'stale')).first == 409, 'Preview accepted stale ticket snapshot')
      assert.call(call.call('PREVIEW', input, members['reader']).first == 403, 'Read-only native ticket grant previewed a write')
      status, absent = call.call('PREVIEW', input.merge(form_id: SecureRandom.uuid, attachment_ids: ['999999999']))
      assert.call(status == 403, 'Preview accepted unowned attachment identifiers')
      direct = make_ticket.call(group, 'preview-handover', true)
      direct.update!(wasalx_bot_state: 'BOT', wasalx_bot_conversation: 'true', wasalx_bot_keep_open: 'false')
      status, blocked = call.call('PREVIEW', input.merge(ticket_id: direct.id.to_s, expected_updated_at: direct.updated_at.utc.iso8601(6)))
      assert.call(status == 200 && blocked['handover_required'] && !blocked['can_send'] && blocked['text'].nil? && previews.length == 1, 'Preview bypassed direct handover or fabricated outgoing text')
      changing = Ticket.find(ticket.id)
      before_preview = Wasalx::Client.method(:post)
      Wasalx::Client.define_singleton_method(:post) do |path, data, **options|
        if path == '/internal/v1/zammad/reply-preview'
          changing.update!(title: "Changed during preview #{SecureRandom.hex(3)}")
        end
        before_preview.call(path, data, **options)
      end
      assert.call(call.call('PREVIEW', input.merge(expected_updated_at: changing.updated_at.utc.iso8601(6))).first == 409, 'Preview returned stale result after native ticket changed')
    ensure
      Wasalx::Client.define_singleton_method(:post, boundary)
    end
  end

  check.call('native-portal-cache-one-hour-expiry-and-scoped-cleanup') do
    caches = []
    stable = nil
    create_cache = lambda do |marked, age|
      id = SecureRandom.uuid
      caches << id
      preferences = { 'Content-Type' => 'text/plain' }
      preferences['Wasalx-Portal-Target'] = { 'kind' => 'TICKET', 'id' => ticket.id.to_s } if marked
      row = UserInfo.with_user_id(members['agent'].user_id) do
        UploadCache.new(id).add(filename: 'expiry.txt', data: 'Synthetic expiry file', preferences: preferences,
          created_by_id: members['agent'].user_id)
      end
      row.update_column(:created_at, Time.now - age)
      [id,row]
    end
    expired_cache, expired = create_cache.call(true,7200)
    _, fresh = create_cache.call(true,60)
    _, legacy = create_cache.call(false,7200)
    stable = Store.create!(object: 'Wasalx::GroupWorkspaceUpload', o_id: SecureRandom.uuid, filename: 'admitted.txt',
      data: 'Synthetic admitted file', preferences: { 'Content-Type' => 'text/plain',
        'Wasalx-Portal-Target' => { 'kind' => 'GROUP', 'id' => SecureRandom.uuid } }, created_by_id: members['agent'].user_id)
    stable.update_column(:created_at, Time.now - 7200)
    before = Ticket::Article.where(ticket_id: ticket.id).count
    input = new_note_draft.call.merge('form_id' => expired_cache, 'attachment_ids' => [expired.id.to_s])
    assert.call(call.call('REPLY',input).first == 400 && Ticket::Article.where(ticket_id: ticket.id).count == before,
      'Expired portal cache created a native article')
    schedule = Scheduler.find_by!(method: 'UploadCacheCleanupJob.perform_now')
    assert.call(schedule.active && schedule.period <= 600, 'Existing native cleanup cadence was not updated')
    UploadCacheCleanupJob.perform_now
    assert.call(!Store.exists?(expired.id) && Store.exists?(fresh.id) && Store.exists?(legacy.id) && Store.exists?(stable.id),
      'Portal expiry crossed fresh, legacy, or admitted staging boundaries')
  ensure
    Array(caches).each do |id|
      UserInfo.with_user_id(members['agent'].user_id) { UploadCache.new(id).destroy }
    end
    Store.remove_item(stable.id) if stable && Store.exists?(stable.id)
  end

  check.call('native-inline-customer-create-reuse-and-identity-boundaries') do
    email = "first-contact-#{SecureRandom.hex(6)}@example.test"
    input = { operation_id: SecureRandom.uuid, title: "First contact #{SecureRandom.hex(4)}", group_id: group.id.to_s,
      customer: { email: email.upcase, name: 'First Contact' }, state_id: Ticket::State.find_by!(name: 'open').id.to_s,
      body: 'First customer request', internal: true }
    status, result = call.call('CREATE_TICKET', input)
    assert.call(status == 200, 'Native inline customer creation failed')
    created_ticket = Ticket.find(result.fetch('ticket_id'))
    person = created_ticket.customer
    original_name = person.fullname
    assert.call(person.email == email && person.permissions?('ticket.customer') && !person.permissions?(['ticket.agent', 'admin.*']) &&
      !Wasalx::ServiceIdentity.automation?(person), 'Inline customer changed canonical identity or received staff authority')
    assert.call(person.created_by_id == members['agent'].user_id, 'Inline customer lost native human attribution')
    assert.call(call.call('CREATE_TICKET', input).last['ticket_id'] == result['ticket_id'] && User.where('LOWER(email) = ?', email).count == 1, 'Exact inline replay duplicated customer/ticket')
    reuse = input.merge(operation_id: SecureRandom.uuid, title: "Reuse first contact #{SecureRandom.hex(4)}", customer: { email: email, name: 'Do Not Overwrite' })
    status, reused = call.call('CREATE_TICKET', reuse)
    assert.call(status == 200 && Ticket.find(reused.fetch('ticket_id')).customer_id == person.id && person.reload.fullname == original_name, 'Existing exact customer identity was changed or duplicated')
    malformed = input.merge(operation_id: SecureRandom.uuid, customer: { email: email, role_ids: [Role.find_by!(name: 'Admin').id] })
    assert.call(call.call('CREATE_TICKET', malformed).first == 400, 'Customer role input reached native creation')
    assert.call(call.call('CREATE_TICKET', input.merge(operation_id: SecureRandom.uuid, customer_id: customer.id.to_s)).first == 400, 'Conflicting customer identity forms accepted')
    staff = input.merge(operation_id: SecureRandom.uuid, customer: { email: members['agent'].email, name: 'Pretend Customer' })
    assert.call(call.call('CREATE_TICKET', staff).first == 409, 'Inline contact reused staff identity')
    suspended_email = "inactive-#{SecureRandom.hex(5)}@example.test"
    UserInfo.with_user_id(members['agent'].user_id) do
      User.create!(login: suspended_email, email: suspended_email, firstname: 'Inactive Customer', active: false, role_ids: Role.signup_role_ids)
    end
    assert.call(call.call('CREATE_TICKET', input.merge(operation_id: SecureRandom.uuid, customer: { email: suspended_email })).first == 409, 'Inline contact revived inactive identity')
    duplicate_email = "ambiguous-#{SecureRandom.hex(5)}@example.test"
    UserInfo.with_user_id(members['agent'].user_id) do
      User.create!(login: "one-#{SecureRandom.hex(4)}", email: duplicate_email, firstname: 'Duplicate One', active: true, role_ids: Role.signup_role_ids)
      # Skipping validation also skips the native audit-column callback.
      duplicate = User.new(login: "two-#{SecureRandom.hex(4)}", email: duplicate_email, firstname: 'Duplicate Two', active: true,
        role_ids: Role.signup_role_ids, created_by_id: members['agent'].user_id, updated_by_id: members['agent'].user_id)
      duplicate.save!(validate: false)
    end
    assert.call(call.call('CREATE_TICKET', input.merge(operation_id: SecureRandom.uuid, customer: { email: duplicate_email })).first == 409, 'Ambiguous email used first matching customer')
    status, outgoing = call.call('CREATE_TICKET', input.merge(operation_id: SecureRandom.uuid, internal: false))
    article = Ticket::Article.find(outgoing.fetch('article_id')) if status == 200
    assert.call(status == 200 && article.type.name == 'email' && article.to == email && article.from.include?(group.email_address.email), 'First-contact email bypassed exact native recipient/sender')
  end

  check.call('native-inline-customer-uniqueness-savepoint-and-receipt-rollback') do
    email = "raced-first-contact-#{SecureRandom.hex(6)}@example.test"
    input = { operation_id: SecureRandom.uuid, title: "Raced first contact #{SecureRandom.hex(4)}", group_id: group.id.to_s,
      customer: { email: email, name: 'Concurrent Customer' }, state_id: Ticket::State.find_by!(name: 'open').id.to_s,
      body: 'Native uniqueness recovery', internal: true }
    checkpoints = Queue.new
    release = Queue.new
    worker = nil
    hook = lambda do
      if Thread.current == worker && self.email == email
        checkpoints << :before_insert
        release.pop
      end
    end
    User.set_callback(:create, :before, hook)
    begin
      ready = Queue.new
      worker = Thread.new do
        ready.pop
        ActiveRecord::Base.connection_pool.with_connection { call.call('CREATE_TICKET', input) }
      ensure
        checkpoints << :worker_finished
      end
      worker.report_on_exception = false
      ready << true
      if Timeout.timeout(20) { checkpoints.pop } == :worker_finished
        status, = worker.value
        raise "Native uniqueness worker returned HTTP #{status} before reaching the insert callback"
      end
      # A native ingestion path can win without using the portal email advisory lock.
      external = UserInfo.with_user_id(members['agent'].user_id) do
        User.create!(login: email, email: email, firstname: 'Native Ingestion', active: true, role_ids: Role.signup_role_ids)
      end
      release << true
      status, result = Timeout.timeout(20) { worker.value }
      assert.call(status == 200 && Ticket.find(result.fetch('ticket_id')).customer_id == external.id &&
        User.where('LOWER(email) = ?', email).count == 1, 'Native uniqueness race poisoned ticket transaction or duplicated contact')
    ensure
      release << true
      worker&.join(20)
      User.skip_callback(:create, :before, hook)
    end
    rollback_email = "rollback-first-contact-#{SecureRandom.hex(6)}@example.test"
    rollback = input.merge(operation_id: SecureRandom.uuid, title: "Rolled-back first contact #{SecureRandom.hex(4)}", customer: { email: rollback_email, name: 'Rollback Customer' })
    failure = -> { raise ArgumentError, 'Synthetic inline receipt failure' if operation_id == rollback[:operation_id] }
    WasalxTicketOperation.set_callback(:create, :before, failure)
    begin
      before_jobs = Delayed::Job.pluck(:id).sort
      assert.call(call.call('CREATE_TICKET', rollback).first == 400, 'Inline receipt failure did not surface')
      assert.call(!User.exists?(email: rollback_email) && !Ticket.exists?(title: rollback[:title]) &&
        !WasalxTicketOperation.exists?(operation_id: rollback[:operation_id]), 'Customer escaped native ticket/receipt rollback')
      assert.call(Delayed::Job.pluck(:id).sort == before_jobs, 'Rolled-back customer creation queued native effects')
    ensure
      WasalxTicketOperation.skip_callback(:create, :before, failure)
    end
  end

  check.call('native-inline-customer-create-workflow-is-enforced') do
    email = "workflow-first-contact-#{SecureRandom.hex(6)}@example.test"
    workflow = nil
    begin
      workflow = UserInfo.with_user_id(members['owner'].user_id) do
        CoreWorkflow.create!(name: "Inline customer restriction #{SecureRandom.hex(5)}", object: 'User', active: true,
          changeable: true, priority: 1, stop_after_match: true, condition_saved: {},
          condition_selected: { 'user.email' => { 'operator' => 'is', 'value' => [email] } },
          perform: { 'user.login' => { 'operator' => 'set_fixed_to', 'set_fixed_to' => ['different-required@example.test'] } },
          preferences: { 'screen' => ['create'] }, created_by_id: members['owner'].user_id, updated_by_id: members['owner'].user_id)
      end
      title = "Customer workflow denial #{SecureRandom.hex(4)}"
      status, _ = call.call('CREATE_TICKET', { operation_id: SecureRandom.uuid, title: title, group_id: group.id.to_s,
        customer: { email: email, name: 'Workflow Customer' }, state_id: Ticket::State.find_by!(name: 'open').id.to_s,
        body: 'Native user workflow', internal: true })
      assert.call(status != 200 && !User.exists?(email: email) && !Ticket.exists?(title: title), 'Inline customer bypassed native User create workflow')
    ensure
      workflow&.destroy!
    end
  end

  check.call('native-privileged-expiry-after-lock-retains-true-denials') do
    stale = { 'auth_time' => Time.now.to_i - 16 * 60, 'amr' => ['mfa'], 'acr' => nil }
    owner = members['owner']
    mailbox = group.reload.email_address.channel
    old_group_count, old_operations = Group.count, WasalxAdminOperation.count
    [
      ['TEAM_CREATE', { operation_id: SecureRandom.uuid, name: "Expired admin #{SecureRandom.hex(4)}" }, 3],
      ['MAILBOX_PAUSE', { operation_id: SecureRandom.uuid, mailbox_id: mailbox.id.to_s,
        expected_version: Wasalx::PortalMailboxAdministration.version(mailbox) }, 4]
    ].each do |kind, input, recheck_number|
      original_now = Time.method(:now)
      clock = nil
      calls = 0
      original_active = mailbox.reload.active
      begin
        # Only the isolated fixture clock advances. Signature/admission are valid,
        # then the actual package authorizer rechecks after acquiring its lock.
        Time.define_singleton_method(:now) { clock || original_now.call }
        privileged_recheck_hook = ->(check_input) do
          next unless check_input[:privileged]
          calls += 1
          if calls == recheck_number
            locked = ActiveRecord::Base.connection.select_value("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted)")
            assert.call(locked == true, 'privileged expiry fixture did not reach the native advisory lock')
            clock = original_now.call + 16 * 60
          end
        end
        status, result = call.call(kind, input, owner)
        assert.call(calls == recheck_number && status == 403 && result == { 'code' => 'REAUTHENTICATION_REQUIRED' },
          'after-lock privileged expiry lost typed reauthentication')
        assert.call(Group.count == old_group_count && WasalxAdminOperation.count == old_operations &&
          !WasalxAdminOperation.exists?(operation_id: input[:operation_id]) && mailbox.reload.active == original_active,
          'expired privileged recheck committed an effect/receipt')
      ensure
        privileged_recheck_hook = nil
        Time.define_singleton_method(:now, original_now)
      end
    end
    operation = { operation_id: SecureRandom.uuid, name: "Denied admin #{SecureRandom.hex(4)}" }
    status, result = call.call('TEAM_CREATE', operation, owner, 'assurance' => stale)
    assert.call(status == 403 && result == { 'code' => 'REAUTHENTICATION_REQUIRED' }, 'valid stale privileged MFA lost step-up code')
    [{}, { 'assurance' => stale }].each do |changes|
      status, = call.call('TEAM_CREATE', operation, members['agent'], changes)
      assert.call(status == 403 && Group.count == old_group_count && WasalxAdminOperation.count == old_operations &&
        !WasalxAdminOperation.exists?(operation_id: operation[:operation_id]), 'native non-administrator gained an effect or receipt')
    end
    [
      stale.merge('amr' => ['pwd']),
      stale.merge('auth_time' => Time.now.to_i - 100_000)
    ].each do |assurance|
      status, result = call.call('TEAM_CREATE', operation, owner, 'assurance' => assurance)
      assert.call(status == 403 && result['code'] != 'REAUTHENTICATION_REQUIRED', 'invalid MFA/session was mislabeled as privileged expiry')
    end
    begin
      membership_denied = true
      status, result = call.call('TEAM_CREATE', operation, owner, 'assurance' => stale)
      assert.call(status == 403 && result['code'] != 'REAUTHENTICATION_REQUIRED', 'revoked membership was mislabeled as privileged expiry')
    ensure
      membership_denied = false
    end
    begin
      privileged_window = '15'
      status, result = call.call('TEAM_CREATE', operation, owner)
      assert.call(status == 403 && result['code'] != 'REAUTHENTICATION_REQUIRED', 'malformed privileged policy was mislabeled as expiry')
    ensure
      privileged_window = 15
    end
    status, = call.call('SHOW', { ticket_id: ticket.id.to_s }, owner, 'assurance' => stale)
    assert.call(status == 200, 'privileged expiry incorrectly revoked ordinary workspace reads')
  end

  check.call('current-membership-and-assurance-denials') do
    begin
      membership_denied = true
      assert.call(call.call('SHOW', { ticket_id: ticket.id.to_s }).first == 403, 'Revoked membership exposed conversation')
    ensure
      membership_denied = false
    end
  bad_assurance = { 'auth_time' => Time.now.to_i - 100_000, 'amr' => ['mfa'], 'acr' => nil }
  assert.call(call.call('SHOW', { ticket_id: ticket.id.to_s }, members['agent'], 'assurance' => bad_assurance).first == 403, 'Expired assurance admitted')
  assert.call(call.call('SHOW', { ticket_id: ticket.id.to_s }, members['agent'],
    'assurance' => bad_assurance.merge('auth_time' => Time.now.to_i, 'amr' => ['pwd'])).first == 403, 'Missing current MFA admitted')
  end
  check.call('native-backend-health-has-no-operator-content') do
    http = ActionDispatch::Integration::Session.new(Rails.application)
    http.host!('localhost')
    http.get('/api/v1/wasalx/health')
    assert.call(http.response.status == 200, 'Initialized native backend did not pass health')
    assert.call(http.response.body.empty?, 'Backend health exposed content')
    assert.call(http.response.headers['Cache-Control'].include?('no-store'), 'Backend health was cacheable')
  end

  check.call('wasalx-mail-default-reconciliation-preserves-native-contract') do
    Trigger.transaction(requires_new: true) do
      row = Trigger.find_by!(name: 'auto reply (on new tickets)')
      seed_source = File.read(Rails.root.join('db/seeds/triggers.rb'))
      body = seed_source.scan(/'body'\s*=> '([\s\S]*?)',\s*'recipient'/).first.first
      original_fields = row.attributes.slice('active', 'condition', 'activator', 'execution_condition_mode')
      perform = row.perform.deep_dup
      perform['notification.email']['body'] = body
      row.update!(perform: perform)
      changed = Wasalx::PortalMail.reconcile_customer_defaults!
      assert.call(changed.include?(row.id), 'Canonical seed was not reconciled')
      row.reload
      assert.call(row.attributes.slice(*original_fields.keys) == original_fields, 'Reconciliation changed native flags or conditions')
      assert.call(row.perform['notification.email'].except('body') == perform['notification.email'].except('body'), 'Reconciliation changed native recipients or subject')
      assert.call(Wasalx::PortalMail.reconcile_customer_defaults!.empty?, 'Native reconciliation was not idempotent')
      custom = row.perform.deep_dup
      custom['notification.email']['body'] += '<p>Custom owner text</p>'
      row.update!(perform: custom)
      Wasalx::PortalMail.reconcile_customer_defaults!
      assert.call(row.reload.perform == custom, 'Customized native trigger was overwritten')
      raise ActiveRecord::Rollback
    end
  end

  check.call('wasalx-mail-links-through-native-renderer') do
    old_origin = ENV['WASALX_PORTAL_URL']
    begin
      ENV['WASALX_PORTAL_URL'] = 'https://portal.synthetic.wasalx.invalid'
      article = Ticket::Article.where(ticket_id: ticket.id).order(:id).first!
      objects = { ticket: ticket, article: article, recipient: members['agent'].user,
        current_user: members['agent'].user, changes: {}, reason: 'You are receiving this because you are the owner of this ticket.' }
      %w[en ar].each do |locale|
        %w[ticket_create ticket_update ticket_reminder_reached ticket_escalation ticket_escalation_warning
           ticket_update_merged_into ticket_update_received_merge].each do |template|
          mail = NotificationFactory::Mailer.template(template: template, locale: locale, objects: objects.dup)
          expected = Wasalx::PortalMail.ticket_link_source!.sub('#{ticket.number}', ticket.number.to_s)
          assert.call(mail[:body].include?(expected), 'Native mail did not open WasalX ticket number')
          assert.call(!mail[:body].include?('/#ticket/zoom/') && !mail[:body].include?('/#profile/notifications'), 'Native mail leaked a native UI link')
          assert.call(!mail[:subject].to_s.empty?, 'Native mail subject was lost')
        end
      end
    ensure
      old_origin ? ENV['WASALX_PORTAL_URL'] = old_origin : ENV.delete('WASALX_PORTAL_URL')
    end
  end
  check.call('native-mailbox-administration-tls') do
    previous = ENV.to_h.slice('WASALX_ADMIN_TEST_OWNER', 'WASALX_ADMIN_TEST_PORTAL_SOURCE', 'WASALX_ADMIN_TEST_ASSURANCE_JSON', 'WASALX_ADMIN_TLS_PASSWORD')
    level = Rails.logger.level
    begin
      Rails.logger.level = Logger::WARN
      auth = JSON.parse(File.binread(ENV.fetch('WASALX_ADMIN_TLS_FIXTURE_AUTH_FILE')))
      ENV['WASALX_ADMIN_TEST_OWNER'] = members.fetch('owner').portal_user_id
      ENV['WASALX_ADMIN_TEST_PORTAL_SOURCE'] = JSON.generate(portal_source)
      ENV['WASALX_ADMIN_TEST_ASSURANCE_JSON'] = JSON.generate('auth_time' => Time.now.to_i, 'amr' => ['mfa'], 'acr' => nil)
      ENV['WASALX_ADMIN_TLS_PASSWORD'] = auth.fetch('password')
      load ENV.fetch('WASALX_NATIVE_MAILBOX_TEST_PATH'), true
    ensure
      %w[WASALX_ADMIN_TEST_OWNER WASALX_ADMIN_TEST_PORTAL_SOURCE WASALX_ADMIN_TEST_ASSURANCE_JSON WASALX_ADMIN_TLS_PASSWORD].each do |key|
        previous.key?(key) ? ENV[key] = previous[key] : ENV.delete(key)
      end
      Rails.logger.level = level
    end
  end

  check.call('privacy-exact-friendly-target-current-native-policy-and-selection-race') do
    before = [Ticket.count, Ticket::Article.count, User.count, WasalxTicketOperation.count]
    status, selected = call.call('PRIVACY_TARGET', { scope_type: 'ZAMMAD_TICKET', reference: ticket.number.to_s })
    assert.call(status == 200 && selected['scope_value'] == ticket.id.to_s && selected['display'] == "##{ticket.number}", 'Friendly case lookup did not resolve exact native target')
    assert.call(call.call('PRIVACY_TARGET', { scope_type: 'ZAMMAD_TICKET', reference: hidden.number.to_s }).first == 403, 'Privacy lookup bypassed native team visibility')
    status, selected_customer = call.call('PRIVACY_TARGET', { scope_type: 'ZAMMAD_USER', reference: customer.email.upcase })
    assert.call(status == 200 && selected_customer['scope_value'] == customer.id.to_s, 'Exact customer email lookup failed')
    assert.call(call.call('PRIVACY_TARGET', { scope_type: 'ZAMMAD_USER', reference: members['agent'].user.email }).first == 409, 'Staff identity accepted as privacy customer')
    User.transaction(requires_new: true) do
      old_email = customer.email
      customer.update!(email: "retired-#{SecureRandom.hex(8)}@example.test")
      replacement = User.create!(login: "replacement-#{SecureRandom.hex(8)}", email: old_email,
        firstname: 'Replacement', active: true, roles: [Role.find_by!(name: 'Customer')], created_by_id: 1, updated_by_id: 1)
      status, _ = call.call('PRIVACY_TARGET', { scope_type: 'ZAMMAD_USER', reference: old_email,
        expected_sha256: selected_customer['selection_sha256'] })
      assert.call(status == 409, 'Email reuse silently selected a different customer')
      raise ActiveRecord::Rollback
    end
    customer.reload
    assert.call(before == [Ticket.count, Ticket::Article.count, User.count, WasalxTicketOperation.count], 'Privacy target confirmation wrote native effects')
  end

  raise "Native diagnostic checks failed: #{JSON.generate(failures)}", cause: nil unless failures.empty?

  puts JSON.generate({ mode: 'isolated-native-diagnostic', native: Version.get, source: installed_identity,
    proof: proof, failures: failures, provider_admissions: admissions.length })
ensure
  Wasalx::Client.define_singleton_method(:post, original_post)
  Wasalx::Client.define_singleton_method(:get, original_get)
end
