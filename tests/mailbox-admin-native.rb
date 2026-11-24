# Run only against the admitted isolated TLS IMAP/SMTP fixture; never production.
require 'securerandom'
require 'action_dispatch/testing/integration'
raise 'isolated TLS fixture required' unless ENV['WASALX_ADMIN_TEST_MODE'] == 'simulated' && ENV['WASALX_ADMIN_TLS_FIXTURE'] == '1'
owner = WasalxMembership.find_by!(portal_user_id: ENV.fetch('WASALX_ADMIN_TEST_OWNER'))
actor = owner.user
actor.permissions!('admin.channel_email')
actor.permissions!('admin.group')
host = ENV.fetch('WASALX_ADMIN_TLS_HOST')
password = ENV.fetch('WASALX_ADMIN_TLS_PASSWORD')
raise 'synthetic host only' unless host.end_with?('.test') && ENV.fetch('WASALX_MAIL_ALLOWED_HOSTS').split(',').include?(host)
assert = ->(condition, message) { raise message unless condition }
invoke = ->(kind, input) do
  Wasalx::PortalMailboxAdministration.new(actor: actor, authorizer: -> { actor.reload }, envelope: { 'tenant_id' => owner.tenant_id, 'instance_id' => owner.instance_id,
    'source' => JSON.parse(ENV.fetch('WASALX_ADMIN_TEST_PORTAL_SOURCE')), 'assurance' => JSON.parse(ENV.fetch('WASALX_ADMIN_TEST_ASSURANCE_JSON')),
    'actor' => { 'user_id' => owner.portal_user_id, 'native_user_id' => owner.user_id.to_s, 'revision' => owner.revision, 'subject' => owner.subject }, 'operation' => kind, 'input' => input }).call
end
UserInfo.with_user_id(actor.id) do
  Transaction.execute do
    if ENV['WASALX_ADMIN_TEST_SOLE_GROUP'] == '1'
      raise 'exact isolated sole group with no sender required' unless Group.count == 1 && Group.first.email_address_id.nil?
      group = Group.first
    else
      group = Group.create!(name: "Mail admin #{SecureRandom.hex(4)}", active: true, created_by_id: actor.id, updated_by_id: actor.id)
    end
    actor.group_ids_access_map = actor.group_ids_access_map.merge(group.id => 'full')
    actor.save!
    before_sender = group.email_address_id
    config = { 'email' => ENV.fetch('WASALX_ADMIN_TLS_EMAIL'), 'name' => 'WasalX test mailbox', 'team_id' => group.id.to_s,
      'inbound' => { 'host' => host, 'port' => Integer(ENV.fetch('WASALX_ADMIN_TLS_IMAP_PORT')), 'user' => ENV.fetch('WASALX_ADMIN_TLS_USER'), 'folder' => 'INBOX', 'security' => 'TLS' },
      'outbound' => { 'host' => host, 'port' => Integer(ENV.fetch('WASALX_ADMIN_TLS_SMTP_PORT')), 'user' => ENV.fetch('WASALX_ADMIN_TLS_USER'), 'security' => 'TLS' } }
    original_bcc = Setting.get('system_bcc')
    begin
      Setting.set('system_bcc', 'archive-outside@example.test')
      probe = Wasalx::MailboxVerificationSmtp.new.prepare_message_attrs({ from: config['email'], to: config['email'] }, false)
      ordinary = Channel::Driver::Smtp.new.prepare_message_attrs({ from: config['email'], to: config['email'] }, false)
      assert.call(probe[:bcc].blank? && probe['bcc'].blank? && probe[:to] == config['email'], 'probe added an unowned recipient')
      assert.call(ordinary[:bcc].to_s.include?('archive-outside@example.test'), 'ordinary email lost native BCC behavior')
    ensure
      Setting.set('system_bcc', original_bcc)
    end
    operation = SecureRandom.uuid
    result = invoke.call('MAILBOX_CREATE', { 'operation_id' => operation, 'config' => config, 'credentials' => { 'inbound' => password, 'outbound' => password } })
    id = result[:mailbox_id]
    channel = Channel.find(id)
    assert.call(!channel.active && group.reload.email_address_id == before_sender, 'draft activated or changed sender')
    shown = invoke.call('MAILBOX_SHOW', { 'mailbox_id' => id })
    assert.call(!JSON.generate(shown).include?(password) && !WasalxAdminOperation.find_by!(operation_id: operation).attributes.to_json.include?(password), 'secret leaked to response/receipt')
    begin
      invoke.call('MAILBOX_ACTIVATE', { 'operation_id' => SecureRandom.uuid, 'mailbox_id' => id, 'expected_version' => shown[:version] })
      raise 'unverified activation allowed'
    rescue Wasalx::PortalMailboxAdministration::Conflict
    end
    [true, false].each do |uppercase_cancel|
      cancelled = SecureRandom.uuid
      cancel_id = uppercase_cancel ? cancelled.upcase : cancelled
      send_id = uppercase_cancel ? cancelled : cancelled.upcase
      invoke.call('MAILBOX_RECEIPT', { 'operation_id' => cancel_id, 'kind' => 'MAILBOX_VERIFY_START', 'mailbox_id' => id, 'cancel_if_missing' => true })
      begin
        invoke.call('MAILBOX_VERIFY_START', { 'operation_id' => send_id, 'mailbox_id' => id, 'expected_version' => shown[:version] })
        raise 'UUID case bypassed terminal cancellation'
      rescue Wasalx::PortalMailboxAdministration::Conflict
      end
    end
    verification = SecureRandom.uuid
    invoke.call('MAILBOX_VERIFY_START', { 'operation_id' => verification, 'mailbox_id' => id, 'expected_version' => shown[:version] })
    job = Delayed::Job.where('handler LIKE ?', "%#{verification}%").order(:id).last!
    assert.call(!job.handler.include?(password) && !job.handler.include?('credentials'), 'credentials entered job arguments')
    # Exercise actual native drivers and the owned fixture transport; no success doubles.
    job.payload_object.perform
    status = invoke.call('MAILBOX_VERIFY_STATUS', { 'mailbox_id' => id, 'operation_id' => verification })
    assert.call(status[:verification] == 'VERIFIED' && !Channel.find(id).active, 'exact native verification absent or auto-activated')
    if Wasalx::PortalMailboxAdministration.seed_signature?(group)
      begin
        invoke.call('MAILBOX_ACTIVATE', { 'operation_id' => SecureRandom.uuid, 'mailbox_id' => id, 'expected_version' => status[:version] })
        raise 'fictional signature activated'
      rescue Wasalx::PortalMailboxAdministration::Conflict
      end
      seed_signature = invoke.call('MAILBOX_SIGNATURE_SHOW', { 'team_id' => group.id.to_s })
      invoke.call('MAILBOX_SIGNATURE_SAVE', { 'operation_id' => SecureRandom.uuid, 'team_id' => group.id.to_s, 'expected_version' => seed_signature[:version], 'body' => '', 'replace_formatting' => true })
      assert.call(group.reload.signature_id.nil?, 'empty reviewed signature did not remove the seed')
    end
    invoke.call('MAILBOX_ACTIVATE', { 'operation_id' => SecureRandom.uuid, 'mailbox_id' => id, 'expected_version' => status[:version] })
    assert.call(Channel.find(id).active && group.reload.email_address_id == EmailAddress.find_by!(channel_id: id).id, 'activation/sender binding not atomic')
    paused = invoke.call('MAILBOX_SHOW', { 'mailbox_id' => id })
    invoke.call('MAILBOX_PAUSE', { 'operation_id' => SecureRandom.uuid, 'mailbox_id' => id, 'expected_version' => paused[:version] })
    assert.call(!Channel.find(id).active, 'pause not persisted')
    { 'Google::Account' => 'smtp', 'Microsoft365::Account' => 'smtp', 'MicrosoftGraph::Account' => 'microsoft_graph_outbound' }.each do |area, adapter|
      native_sender = Channel.new(area: area, options: { outbound: { adapter: adapter } })
      assert.call(Wasalx::PortalEmailSender.customer_account?(native_sender) && Wasalx::PortalEmailSender.outbound?(native_sender),
        'native OAuth/Graph email account lost send capability')
    end
    # Use the same signed portal HTTP contract as the operator application.
    runtime = Token.find(Wasalx::ServiceIdentity.receipt.fetch('runtime_token_id'))
    portal = ->(operation, input) do
      envelope = { purpose: Wasalx::PortalDelegation::PURPOSE, tenant_id: owner.tenant_id, instance_id: owner.instance_id,
        source: JSON.parse(ENV.fetch('WASALX_ADMIN_TEST_PORTAL_SOURCE')),
        assurance: JSON.parse(ENV.fetch('WASALX_ADMIN_TEST_ASSURANCE_JSON')),
        actor: { user_id: owner.portal_user_id, native_user_id: actor.id.to_s, revision: owner.revision, subject: owner.subject },
        operation: operation, input: input }.deep_stringify_keys
      body = JSON.generate(envelope)
      timestamp = Time.now.to_i.to_s
      signature = OpenSSL::HMAC.hexdigest('SHA256', ENV.fetch('WASALX_SERVICE_JWT_SECRET'),
        "#{Wasalx::PortalDelegation::PURPOSE}\nPOST\n#{Wasalx::PortalDelegation::PATH}\n#{timestamp}\n#{body}")
      http = ActionDispatch::Integration::Session.new(Rails.application)
      http.host!('localhost')
      http.post(Wasalx::PortalDelegation::PATH, params: body, headers: { 'Authorization' => "Token token=#{runtime.token}",
        'Content-Type' => 'application/json', 'Accept' => 'application/json',
        'X-Wasalx-Timestamp' => timestamp, 'X-Wasalx-Signature' => signature })
      response = http.response
      assert.call(response.media_type == 'application/json', "Signed portal #{operation} returned non-JSON (HTTP #{response.status})")
      [response.status, JSON.parse(response.body)]
    end
    customer = ticket = expected_sender = nil
    Transaction.execute do
    customer = User.create!(login: "paused-mail-#{SecureRandom.hex(6)}", email: "customer-#{SecureRandom.hex(6)}@example.test",
      firstname: 'Synthetic customer', active: true, roles: [Role.find_by!(name: 'Customer')], created_by_id: actor.id, updated_by_id: actor.id)
    ticket = Ticket.create!(title: 'Paused mailbox admission', group: group.reload, customer: customer,
      created_by_id: actor.id, updated_by_id: actor.id)
    Ticket::Article.create!(ticket: ticket, sender: Ticket::Article::Sender.find_by!(name: 'Customer'),
      type: Ticket::Article::Type.find_by!(name: 'email'), internal: false, content_type: 'text/plain',
      from: customer.email, to: config['email'], body: 'Synthetic incoming email', created_by_id: customer.id, updated_by_id: customer.id)
    # A different active account must not rescue the paused exact sender.
    fallback_options = channel.reload.options.deep_dup
    fallback_options.fetch(:inbound).fetch(:options)[:user] = "unselected-#{SecureRandom.hex(6)}"
    fallback_options.fetch(:inbound).fetch(:options)[:folder] = "unselected-#{SecureRandom.hex(6)}"
    fallback = Channel.create!(area: 'Email::Account', group_id: group.id, active: true,
      options: fallback_options, created_by_id: actor.id, updated_by_id: actor.id)
    EmailAddress.create!(name: 'Unselected fallback', email: "fallback-#{SecureRandom.hex(6)}@example.test",
      channel_id: fallback.id, created_by_id: actor.id, updated_by_id: actor.id)
    expected_sender = EmailAddress.find_by!(channel_id: id)
    assert.call(group.reload.email_address_id == expected_sender.id, 'fallback fixture replaced exact sender')
    end
    draft = -> { { ticket_id: ticket.id.to_s, expected_updated_at: ticket.reload.updated_at.utc.iso8601(6), body: 'Paused response', internal: false } }
    denied_reply, denied_create = SecureRandom.uuid, SecureRandom.uuid
    before = [Ticket.count, Ticket::Article.count, Delayed::Job.pluck(:id).sort, WasalxTicketOperation.count]
    code, options = portal.call('CREATE_OPTIONS', { group_id: group.id.to_s })
    assert.call(code == 200 && options.dig('channels', 'email') == false, 'paused mailbox advertised new email readiness')
    code, shown_ticket = portal.call('SHOW', { ticket_id: ticket.id.to_s })
    assert.call(code == 200 && shown_ticket['can_reply'] == false, 'paused mailbox advertised reply readiness')
    code, preview = portal.call('PREVIEW', draft.call)
    assert.call(code == 200 && preview['can_send'] == false && preview['recipient'].nil? && preview['text'].nil?, 'paused mailbox preview claimed send readiness')
    code, = portal.call('REPLY', draft.call.merge(operation_id: denied_reply))
    assert.call(code == 403, 'paused mailbox admitted reply')
    create = { operation_id: denied_create, title: 'Paused new email', group_id: group.id.to_s,
      customer_id: customer.id.to_s, state_id: Ticket::State.find_by!(name: 'open').id.to_s, body: 'Must not queue', internal: false }
    code, = portal.call('CREATE_TICKET', create)
    assert.call(code == 403, 'paused mailbox admitted new email')
    assert.call(before == [Ticket.count, Ticket::Article.count, Delayed::Job.pluck(:id).sort, WasalxTicketOperation.count],
      'paused sends created a ticket/article/job/receipt')
    assert.call(!WasalxTicketOperation.exists?(operation_id: [denied_reply, denied_create]), 'paused send committed a receipt')
    note_status, = portal.call('REPLY', draft.call.merge(operation_id: SecureRandom.uuid, internal: true))
    assert.call(note_status == 200, 'mailbox pause blocked internal notes')
    # PAUSE does not change the verified configuration version. Only exact reviewed
    # activation restores readiness; never set Channel.active directly for recovery.
    current_status = invoke.call('MAILBOX_SHOW', { 'mailbox_id' => id })
    invoke.call('MAILBOX_ACTIVATE', { 'operation_id' => SecureRandom.uuid, 'mailbox_id' => id, 'expected_version' => current_status[:version] })
    assert.call(Channel.find(id).active && group.reload.email_address_id == expected_sender.id, 'verified activation did not restore exact sender')
    code, options = portal.call('CREATE_OPTIONS', { group_id: group.id.to_s })
    assert.call(code == 200 && options.dig('channels', 'email') == true, 'verified activation did not restore email options')
    code, preview = portal.call('PREVIEW', draft.call)
    assert.call(code == 200 && preview['can_send'] == true && preview['recipient'] == customer.email, 'verified activation did not restore preview')
    code, restored = portal.call('REPLY', draft.call.merge(operation_id: SecureRandom.uuid))
    assert.call(code == 200 && Ticket::Article.find(restored.fetch('article_id')).preferences['email_address_id'] == expected_sender.id,
      'restored reply did not preserve native exact sender metadata')
    code, created = portal.call('CREATE_TICKET', create.merge(operation_id: SecureRandom.uuid))
    assert.call(code == 200 && Ticket::Article.find(created.fetch('article_id')).preferences['email_address_id'] == expected_sender.id,
      'restored new email did not preserve native exact sender metadata')
    # Outer transaction rolls back; no outbound after-commit job can escape.

    mandatory = Channel::Driver::Smtp.new.build_smtp_params({ host: host, port: 587, ssl: false, ssl_verify: true, openssl_verify_mode: 'peer', wasalx_require_starttls: true })
    assert.call(mandatory[:enable_starttls] == :always && !mandatory.key?(:enable_starttls_auto), 'opportunistic TLS fallback retained')
    signature = invoke.call('MAILBOX_SIGNATURE_SHOW', { 'team_id' => group.id.to_s })
    invoke.call('MAILBOX_SIGNATURE_SAVE', { 'operation_id' => SecureRandom.uuid, 'team_id' => group.id.to_s, 'expected_version' => signature[:version], 'body' => "Support team\nWasalX", 'replace_formatting' => false })
    assert.call(group.reload.signature.body.to_s.include?('Support team'), 'native signature not saved')
    raise ActiveRecord::Rollback
  end
end
puts 'Mailbox administration TLS/native regression passed; database fixture rolled back.'
