# frozen_string_literal: true
# Run only in an isolated native qualification database, with current package installed.
require 'json'
require 'securerandom'
raise 'Isolated native qualification is required' unless ENV['WASALX_TEST_ISOLATED'] == '1'
assert = ->(condition, message) { raise message unless condition }
deny = lambda do |message, &block|
  begin
    block.call
  rescue Wasalx::ServiceIdentity::Conflict, Exceptions::Forbidden, ActiveRecord::RecordInvalid
    next true
  end
  raise message
end
proof = {}
guard = Wasalx::ServiceIdentity
original_post = Wasalx::Client.method(:post)
original_actor = UserInfo.current_user_id
bootstrap_env_keys = %w[ZAMMAD_SERVICE_TOKEN ZAMMAD_PRIVACY_TOKEN WASALX_SERVICE_IDENTITY_INPUT_PATH]
original_bootstrap_env = bootstrap_env_keys.to_h { |key| [key, ENV[key]] }
run_startup = lambda do
  begin
    load ENV.fetch('WASALX_TEST_BOOTSTRAP_PATH', '/usr/local/lib/wasalx/bootstrap-runtime.rb')
  rescue SystemExit => outcome
    raise 'Bootstrap failed' unless outcome.success?
  end
end
begin
  UserInfo.current_user_id = 1
  User.transaction do
    raise 'A real handover already exists' if guard.handover_evidence?
    admin, agent = %w[Admin Agent].map { |name| Role.find_by!(name: name) }
    suffix = SecureRandom.hex(8)
    create_user = ->(name, roles) { User.create!(login: "service-proof-#{name}-#{suffix}", email: "#{name}-#{suffix}@example.invalid", firstname: 'Synthetic', lastname: name, active: true, roles: roles, created_by_id: 1, updated_by_id: 1) }
    legacy = create_user.call('Legacy', [admin, agent])
    owner = create_user.call('Owner', [admin, agent])
    ordinary = create_user.call('Agent', [agent])
    legacy_subject = "legacy-#{suffix}"
    legacy_auth = Authorization.create!(user_id: legacy.id, provider: 'openid_connect', uid: legacy_subject)
    owner_subject = "owner-#{suffix}"
    Authorization.create!(user_id: owner.id, provider: 'openid_connect', uid: owner_subject)
    member = WasalxMembership.create!(tenant_id: ENV.fetch('WASALX_TENANT_ID'), instance_id: ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID'), portal_user_id: SecureRandom.uuid,
      subject: owner_subject, email: owner.email, user_id: owner.id, revision: 1, member_state: 'ACTIVE', portal_role: 'tenant_owner')
    tokens = guard::LEGACY_SCOPES.to_h { |purpose, scopes| [purpose, Token.create!(user_id: legacy.id, action: 'api', persistent: true,
      name: purpose == 'runtime' ? 'WasalX Service' : 'WasalX Privacy', preferences: { permission: scopes })] }
    secrets = tokens.transform_values(&:token)
    retired = false
    control_available = true
    policy = { 'mfa_required' => true, 'session_timeout_minutes' => 60, 'policy_version' => 1,
      'subject' => owner_subject, 'mfa_amr_values' => ['mfa'], 'mfa_acr_values' => [] }
    Wasalx::Client.define_singleton_method(:post) do |path, input, scope:, **_options|
      raise Wasalx::Client::RequestFailed, 'Synthetic control unavailable' unless control_available
      raise 'Unexpected signed control scope' unless %w[zammad:membership zammad:privacy].include?(scope)
      case path
      when '/internal/v1/zammad/membership/check'
        { 'allowed' => input[:user_id] == member.portal_user_id && input[:native_user_id] == owner.id.to_s &&
          input[:revision] == member.reload.revision, 'authentication_policy' => policy }
      when '/internal/v1/zammad/membership/retired'
        { 'retired' => retired && input[:subject] == legacy_subject }
      when '/internal/v1/zammad/privacy/admission'
        value = input.with_indifferent_access
        { 'allowed' => value[:job_id] == '30000000-0000-4000-8000-000000000001', 'tenant_id' => ENV['WASALX_TENANT_ID'],
          'instance_id' => ENV['WASALX_ZAMMAD_INSTANCE_ID'], 'job_id' => value[:job_id], 'target_id' => value[:target_id],
          'operation' => value[:operation], 'native_id' => value[:native_id], 'source_native_id' => value[:native_id] }
      else raise 'Unexpected signed control request'
      end
    end
    installed = Wasalx::InstalledPackage.verify!
    input = { 'version' => 1, 'action' => 'PREPARE', 'operation_id' => SecureRandom.uuid, 'expected_revision' => 0, 'expected_receipt_sha256' => nil,
      'tenant_id' => ENV.fetch('WASALX_TENANT_ID'), 'instance_id' => ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID'),
      'human_portal_user_id' => member.portal_user_id, 'human_native_user_id' => owner.id.to_s, 'human_subject' => owner_subject,
      'human_projection_revision' => 1, 'legacy_native_user_id' => legacy.id.to_s, 'legacy_oidc_authorization_id' => legacy_auth.id.to_s, 'legacy_subject' => legacy_subject,
      'runtime_token_id' => tokens['runtime'].id.to_s, 'privacy_token_id' => tokens['privacy'].id.to_s,
      'expected_runtime_scopes' => guard::SCOPES['runtime'], 'expected_privacy_scopes' => guard::SCOPES['privacy'],
      'expected_group_grants_sha256' => guard.digest({}), 'verification_receipt_sha256' => nil }.merge(installed.slice('candidate_commit_sha', 'candidate_tree_sha', 'native_package_sha256'))
    deny.call('Foreign package was accepted') { guard.transition!(input.merge('native_package_sha256' => '0' * 64), secrets: secrets) }
    before_users = User.count
    record = guard.transition!(input, secrets: secrets)
    machine = User.find(record.fetch('automation_native_user_id'))
    assert.call(record['phase'] == 'PREPARED' && User.count == before_users + 1, 'Preparation did not create exactly one machine')
    assert.call(machine.group_ids_access_map.empty?, 'Preparation gave unapproved queue access')
    assert.call(machine.password.blank?, 'Preparation created password authentication')
    assert.call(guard.transition!(input, secrets: secrets) == record && User.count == before_users + 1, 'Preparation replay duplicated account')
    assert.call(!Wasalx::MembershipAccess.allowed?(machine), 'Machine admitted interactive workspace access')
    assert.call(!machine.permissions?('admin') && !owner.permissions?('wasalx_service') && !ordinary.permissions?('wasalx_privacy'), 'Native permission hierarchy grants machine authority to humans')
    deny.call('Machine password was set') { machine.update!(password: "Synthetic-denied-#{suffix}") }
    machine.reload
    deny.call('Machine OIDC account was linked') { Authorization.create!(user_id: machine.id, provider: 'openid_connect', uid: "forbidden-#{suffix}") }
    deny.call('Machine MFA enrollment was available') { machine.auth_two_factor }
    deny.call('Machine enrolled arbitrary API token') { Token.create!(user_id: machine.id, action: 'api', persistent: true, name: 'Arbitrary', preferences: { permission: ['ticket.agent'] }) }
    assert.call(User.password_reset_new_token(machine.login).nil? && User.signup_new_token(machine).nil?, 'Machine recovery/enrollment token created')
    proof[:prepared_noninteractive_native_permissions] = true

    # Synthetic retained receipt from the actually released 0.5.63 coordinates.
    # Current installed bytes remain verified, never stubbed. This tests receipt
    # continuation; an actual old-image/new-image replacement is separate evidence.
    retained_coordinates = { 'candidate_commit_sha' => '69d019760b2b3474e8bf07055051c0f5cb00cf06',
      'candidate_tree_sha' => '517d67d11a0329e0d781fb9d6c4f362705571084',
      'native_package_sha256' => '44371b82957544683681780566a53224eb0c73e43eafca9b09b65b61b92fa892' }
    record = record.merge(retained_coordinates)
    Setting.find_by!(name: guard::SETTING).update!(state_current: { value: record })
    record = guard.receipt
    ENV['ZAMMAD_SERVICE_TOKEN'] = secrets.fetch('runtime')
    ENV['ZAMMAD_PRIVACY_TOKEN'] = secrets.fetch('privacy')
    ENV.delete('WASALX_SERVICE_IDENTITY_INPUT_PATH')
    retained_snapshot = [record, machine.reload.attributes, tokens.values.map { |token| token.reload.attributes }, User.count]
    run_startup.call
    assert.call(retained_snapshot == [guard.receipt, machine.reload.attributes, tokens.values.map { |token| token.reload.attributes }, User.count], 'Replacement startup mutated retained preparation')
    retained_cas = { 'expected_revision' => record['revision'], 'expected_receipt_sha256' => guard.digest(record) }
    deny.call('Prepared receipt was reconciled without binding') { guard.transition!(input.merge(retained_cas).merge('action' => 'RECONCILE'), secrets: secrets) }
    deny.call('Preparation was replayed after replacement') { guard.transition!(input.merge(retained_cas), secrets: secrets) }
    unless installed.slice(*retained_coordinates.keys) == retained_coordinates
      deny.call('Old installed source input was accepted after replacement') { guard.transition!(input.merge(retained_cas).merge(retained_coordinates).merge('action' => 'BIND'), secrets: secrets) }
    end

    group = Group.create!(name: "Service proof #{suffix}", active: true, created_by_id: owner.id, updated_by_id: owner.id)
    machine.group_ids_access_map = { group.id => 'full' }
    machine.save!
    input = input.merge('action' => 'BIND', 'expected_revision' => record['revision'], 'expected_receipt_sha256' => guard.digest(record), 'expected_group_grants_sha256' => guard.group_digest(machine))
    deny.call('Stale retained receipt CAS was accepted') { guard.transition!(input.merge('expected_receipt_sha256' => '0' * 64), secrets: secrets) }
    deny.call('Stale retained owner revision was accepted') { guard.transition!(input.merge('human_projection_revision' => 2), secrets: secrets) }
    deny.call('Wrong retained queue approval was accepted') { guard.transition!(input.merge('expected_group_grants_sha256' => guard.digest({})), secrets: secrets) }
    # A native transaction failure after token mutation must preserve both rows and receipt.
    [[Token, tokens['runtime'].id], [Token, tokens['privacy'].id], [Setting, Setting.find_by!(name: guard::SETTING).id]].each do |model, failing_id|
      failure = -> { raise 'Injected native transaction failure' if id == failing_id && (is_a?(Setting) || will_save_change_to_user_id?) }
      model.set_callback(:update, :before, failure)
      begin
        begin
          User.transaction(requires_new: true) { guard.transition!(input, secrets: secrets) }
          raise 'Injected transaction failure was not reached'
        rescue RuntimeError => error
          raise unless error.message == 'Injected native transaction failure'
        end
      ensure
        model.skip_callback(:update, :before, failure)
      end
      assert.call(tokens.values.all? { |token| token.reload.user_id == legacy.id }, 'Partial token transfer committed')
      assert.call(guard.receipt == record, 'Failed transfer changed durable receipt')
    end
    bound = guard.transition!(input, secrets: secrets)
    assert.call(bound['revision'] == 2 && bound['operation_id'] == record['operation_id'] && bound['automation_native_user_id'] == machine.id.to_s &&
      bound['prior_receipt_sha256'] == guard.digest(record) && bound.slice(*retained_coordinates.keys) == installed.slice(*retained_coordinates.keys), 'Binding did not preserve prior receipt identity while recording actual replacement')
    proof[:retained_063_receipt_startup_and_exact_bind] = true
    assert.call(bound['phase'] == 'BOUND', 'Binding failed')
    tokens.each { |purpose, token| assert.call(token.reload.user_id == machine.id && token.token == secrets[purpose] && token.preferences[:permission] == guard::SCOPES[purpose], 'Token ID/value/scope transfer differs') }
    assert.call(guard.transition!(input, secrets: secrets) == bound, 'Unknown-success readback replay changed receipt')
    assert.call(machine.reload.group_ids_access('full').include?(group.id), 'Binding lost native grants')
    proof[:atomic_stable_bearer_transfer_and_readback] = true

    http = ActionDispatch::Integration::Session.new(Rails.application)
    http.host!('localhost')
    request = ->(method, path, token, body = nil) { http.public_send(method, path, params: body && JSON.generate(body), headers: { 'Authorization' => "Token token=#{token.token}", 'Content-Type' => 'application/json' }); http.response.status }
    assert.call(request.call(:get, '/api/v1/users/me', tokens['runtime']) == 200, 'Runtime native Agent API failed')
    assert.call(request.call(:get, '/api/v1/settings', tokens['runtime']) == 403, 'Runtime token retained native administration')
    assert.call(request.call(:get, '/api/v1/wasalx/service/catalog', tokens['runtime']) == 200, 'Runtime catalog permission failed')
    assert.call(request.call(:get, '/api/v1/wasalx/service/catalog', tokens['privacy']) == 403, 'Privacy token gained runtime authority')
    arbitrary = Token.create!(user_id: owner.id, action: 'api', persistent: true, name: 'WasalX Service', preferences: { permission: ['admin.system'] })
    assert.call(request.call(:get, '/api/v1/wasalx/service/catalog', arbitrary) == 403, 'Arbitrary human admin token admitted machine endpoint')
    native_input = { job_id: '30000000-0000-4000-8000-000000000001', lease_id: SecureRandom.uuid, fencing_token: 1, operation: 'READ_TICKET', native_id: '999999999', attempt: 0 }
    assert.call(request.call(:post, '/api/v1/wasalx/privacy', tokens['privacy'], native_input) == 200 && JSON.parse(http.response.body).nil?, 'Admitted absent ticket did not return explicit null')
    assert.call(request.call(:post, '/api/v1/wasalx/privacy', tokens['runtime'], native_input) == 403, 'Runtime token gained privacy authority')
    assert.call(request.call(:post, '/api/v1/wasalx/privacy', tokens['privacy'], native_input.merge(job_id: SecureRandom.uuid)) == 403, 'Unknown privacy job admitted')
    proof[:exact_native_http_scope_and_absence] = true

    machine.update!(active: false)
    deny.call('Replay certified inactive machine') { guard.transition!(input, secrets: secrets) }
    machine.update!(active: true)
    machine.roles << admin
    deny.call('Reconcile certified native Admin drift') { guard.verify_current!(bound, secrets: secrets) }
    machine.roles.delete(admin)
    setting = Setting.find_by!(name: guard::SETTING)
    stored = setting.state_current
    [nil, { corrupt: true }].each do |bad|
      setting.update!(state_current: { value: bad })
      deny.call('Missing/corrupt receipt permitted legacy bootstrap') { guard.legacy_bootstrap_allowed! }
      assert.call(guard.automation?(machine), 'Receipt loss made automation interactive')
    end
    setting.update!(state_current: stored)
    member.update!(revision: 2)
    assert.call(guard.verify_current!(bound, secrets: secrets) == bound, 'Unrelated owner revision blocked current verified owner')
    revision_snapshot = [guard.receipt, tokens.values.map { |token| token.reload.attributes }, machine.reload.attributes]
    assert.call(guard.transition!(input, secrets: secrets) == bound, 'Current owner revision blocked lost-response readback')
    reconcile_input = input.merge('action' => 'RECONCILE', 'expected_revision' => bound['revision'], 'expected_receipt_sha256' => guard.digest(bound))
    deny.call('Reconcile accepted stale owner approval') { guard.transition!(reconcile_input, secrets: secrets) }
    assert.call(revision_snapshot == [guard.receipt, tokens.values.map { |token| token.reload.attributes }, machine.reload.attributes], 'Readback or stale approval mutated handover')
    User.transaction(requires_new: true) do
      reconciled = guard.transition!(reconcile_input.merge('human_projection_revision' => 2), secrets: secrets)
      assert.call(reconciled['phase'] == 'BOUND' && reconciled['human_projection_revision_at_admission'] == 1, 'Current owner reconciliation changed historical admission')
      raise ActiveRecord::Rollback
    end
    assert.call(guard.receipt == bound, 'Reconciliation fixture rollback changed receipt')
    proof[:reconciliation_current_authority_and_receipt_loss] = true
    before_startup = [guard.receipt, tokens.values.map { |token| token.reload.attributes }, machine.reload.attributes, owner.reload.attributes]
    control_available = false
    ENV['ZAMMAD_SERVICE_TOKEN'] = secrets['runtime']
    ENV['ZAMMAD_PRIVACY_TOKEN'] = secrets['privacy']
    ENV['WASALX_SERVICE_IDENTITY_INPUT_PATH'] = ''
    run_startup.call
    assert.call(guard.verify_startup!(bound, secrets: secrets) == bound, 'Offline startup required the not-yet-active control instance')
    deny.call('Offline transition readback skipped live owner authority') { guard.transition!(input, secrets: secrets) }
    assert.call(before_startup == [guard.receipt, tokens.values.map { |token| token.reload.attributes }, machine.reload.attributes, owner.reload.attributes], 'Startup mutated identity, token or receipt')
    control_available = true
    proof[:offline_startup_without_online_transition] = true

    # Retire fixture legacy identity through native mechanisms, without touching
    # unrelated real data: the outer transaction rolls every fixture change back.
    legacy_auth.destroy!
    legacy.roles = [agent]
    legacy.update!(active: false)
    User.where(active: true).where.not(id: owner.id).joins(roles: :permissions).where(permissions: { name: 'admin' }).distinct.each { |user| user.update!(active: false) }
    retired = true
    complete_input = input.merge('action' => 'COMPLETE', 'expected_revision' => bound['revision'], 'expected_receipt_sha256' => guard.digest(bound), 'human_projection_revision' => 2, 'verification_receipt_sha256' => Digest::SHA256.hexdigest(JSON.generate(proof)))
    deny.call('Completion accepted stale owner approval') { guard.transition!(complete_input.merge('human_projection_revision' => 1), secrets: secrets) }
    assert.call(guard.receipt == bound, 'Stale completion mutated receipt')
    complete = guard.transition!(complete_input, secrets: secrets)
    assert.call(complete['phase'] == 'COMPLETE', 'Verified retirement not completed')
    legacy.update!(active: true)
    deny.call('Complete replay ignored reactivated legacy human') { guard.transition!(complete_input, secrets: secrets) }
    deny.call('Complete bootstrap readback ignored reactivated human') { guard.verify_current!(complete, secrets: secrets) }
    legacy.update!(active: false)
    assert.call(guard.verify_current!(complete, secrets: secrets) == complete, 'Stable complete readback failed')
    control_available = false
    run_startup.call
    assert.call(guard.verify_startup!(complete, secrets: secrets) == complete, 'Offline complete startup required live retirement callback')
    legacy.update!(active: true)
    deny.call('Offline complete startup ignored native retirement drift') { run_startup.call }
    legacy.update!(active: false)
    control_available = true
    proof[:completed_retirement_rechecked] = true
    raise ActiveRecord::Rollback
  end
ensure
  Wasalx::Client.define_singleton_method(:post, original_post)
  UserInfo.current_user_id = original_actor
  original_bootstrap_env.each { |key, value| value.nil? ? ENV.delete(key) : ENV[key] = value }
end
puts JSON.generate(proof)
