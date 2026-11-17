# frozen_string_literal: true
# Execute with the pinned native application's rails runner and isolated database.
require 'json'
require 'securerandom'

root = ENV.fetch('WASALX_TEST_PACKAGE_ROOT', Rails.root.to_s)
load File.join(root, 'db/addon/wasalx/202610070001_add_wasalx_memberships.rb')
AddWasalxMemberships.up
load File.join(root, 'app/models/wasalx_membership.rb') unless defined?(WasalxMembership)
load File.join(root, 'lib/wasalx/membership_projection.rb') unless defined?(Wasalx::MembershipProjection)
load File.join(root, 'lib/wasalx/membership_access.rb') unless defined?(Wasalx::MembershipAccess)
assertion = ->(condition, message) { raise message unless condition }
proof = {}
original_actor = UserInfo.current_user_id
client_ids = []
begin
  UserInfo.current_user_id = 1
  User.transaction do
    admin_role, agent_role = %w[Admin Agent].map { |name| Role.find_by!(name: name) }
    create_user = lambda do |email, roles = [agent_role]|
      User.create!(login: "membership-#{SecureRandom.uuid}", email: email, firstname: 'Synthetic', lastname: 'Staff', active: true, roles: roles, created_by_id: 1, updated_by_id: 1)
    end
    suffix = SecureRandom.hex(8)
    service = create_user.call("service-#{suffix}@example.invalid", [admin_role, agent_role])
    existing = create_user.call("staff-#{suffix}@example.invalid")
    group = Group.create!(name: "Membership #{suffix}", active: true, created_by_id: 1, updated_by_id: 1)
    existing.group_ids_access_map = { group.id => 'full' }
    existing.save!
    payload = {
      'action' => 'APPLY', 'tenant_id' => ENV.fetch('WASALX_TENANT_ID'), 'instance_id' => ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID'),
      'user_id' => SecureRandom.uuid, 'subject' => "staff-#{suffix}", 'email' => existing.email, 'name' => 'Synthetic Staff',
      'role' => 'agent', 'state' => 'ACTIVE', 'revision' => 1, 'native_user_id' => nil, 'adopt_user_id' => nil,
    }
    apply = ->(value) { Wasalx::MembershipProjection.call(value, service_user: service) }
    initial_count = User.count
    assertion.call(apply.call(payload)[:state] == 'ADOPTION_REQUIRED', 'Matching email was claimed without explicit adoption')
    assertion.call(!WasalxMembership.exists?(portal_user_id: payload['user_id']), 'Unreviewed adoption created a binding')
    adopted = apply.call(payload.merge('adopt_user_id' => existing.id.to_s))
    assertion.call(adopted[:state] == 'READY' && adopted[:native_user_id] == existing.id.to_s, 'Explicit adoption did not preserve the existing account')
    assertion.call(User.count == initial_count, 'Explicit adoption duplicated a native user')
    assertion.call(existing.reload.group_ids_access('full').include?(group.id), 'Adoption changed native group permissions')
    bound = payload.merge('native_user_id' => existing.id.to_s)
    assertion.call(apply.call(bound) == adopted, 'Exact immutable replay changed its receipt')
    assertion.call(apply.call(bound.merge('name' => 'Changed at same revision'))[:state] == 'CONFLICT', 'Same-revision payload drift accepted')
    assertion.call(apply.call(bound.merge('native_user_id' => service.id.to_s))[:state] == 'CONFLICT', 'Bound native identity changed')
    cached_socket_user = User.find(existing.id)
    cached_socket_user.roles.load
    existing.roles = [admin_role, agent_role]
    existing.save!
    assertion.call(!Wasalx::MembershipAccess.allowed?(cached_socket_user, bound_revision: 1), 'Cached subscription admitted native role drift at the original portal revision')
    assertion.call(apply.call(bound)[:state] == 'CONFLICT', 'READY replay certified drifted native roles')
    proof[:explicit_adoption_without_duplicates] = true

    session = Session.create!(session_id: SecureRandom.hex(32), data: { 'user_id' => existing.id })
    unrelated = Session.create!(session_id: SecureRandom.hex(32), data: { 'user_id' => service.id })
    client_id = "membership-#{SecureRandom.uuid}"
    client_ids << client_id
    Sessions.create(client_id, { 'id' => existing.id }, { type: 'websocket' })
    assertion.call(apply.call(bound.merge('revision' => 2, 'role' => 'tenant_admin'))[:state] == 'READY', 'Admin projection failed')
    assertion.call(existing.reload.roles.map(&:name).sort == %w[Admin Agent], 'Owner/admin role mapping differs')
    assertion.call(!Session.exists?(id: session.id) && Session.exists?(id: unrelated.id), 'HTTP session revocation scope differs')
    assertion.call(Sessions.get(client_id).nil?, 'Legacy native session persisted')
    assertion.call(apply.call(bound.merge('revision' => 3))[:state] == 'READY', 'Role downgrade failed')
    assertion.call(existing.reload.roles.map(&:name) == ['Agent'], 'Role downgrade retained native administration')
    %w[SUSPENDED REMOVED ACTIVE].each_with_index do |state, index|
      value = apply.call(bound.merge('revision' => 4 + index, 'state' => state))
      assertion.call(value[:native_user_id] == existing.id.to_s && value[:state] == 'READY', 'Lifecycle changed the native binding')
      assertion.call(existing.reload.active == (state == 'ACTIVE'), 'Lifecycle native active state differs')
    end
    assertion.call(existing.reload.group_ids_access('full').include?(group.id), 'Role/state lifecycle destroyed native grants')
    assertion.call(existing.authorizations.where(provider: 'openid_connect', uid: payload['subject']).count == 1, 'Lifecycle duplicated immutable authorization')
    proof[:role_state_sessions_and_native_groups] = true

    auditor = payload.merge('user_id' => SecureRandom.uuid, 'subject' => "auditor-#{suffix}", 'email' => "auditor-#{suffix}@example.invalid", 'role' => 'auditor')
    receipt = apply.call(auditor)
    assertion.call(receipt == { state: 'READY', native_user_id: nil, revision: 1 }, 'Auditor created native access')
    promoted = apply.call(auditor.merge('role' => 'agent', 'revision' => 2))
    assertion.call(promoted[:state] == 'READY' && promoted[:native_user_id], 'Auditor to agent failed to provision one account')
    assertion.call(apply.call(auditor.merge('role' => 'agent', 'revision' => 2)) == promoted, 'Auditor promotion replay changed identity')
    proof[:auditor_absence_and_promotion] = true

    foreign = create_user.call("foreign-#{suffix}@example.invalid")
    Authorization.create!(provider: 'openid_connect', uid: "another-subject-#{suffix}", user_id: foreign.id)
    unsafe = payload.merge('user_id' => SecureRandom.uuid, 'subject' => "requested-#{suffix}", 'email' => foreign.email, 'adopt_user_id' => foreign.id.to_s)
    assertion.call(apply.call(unsafe)[:state] == 'CONFLICT', 'An existing foreign subject was adopted')
    protected_payload = payload.merge('user_id' => SecureRandom.uuid, 'subject' => "service-#{suffix}", 'email' => service.email, 'adopt_user_id' => service.id.to_s)
    assertion.call(apply.call(protected_payload)[:state] == 'PROTECTED', 'Service account was adopted')
    independent_admin = create_user.call("admin-#{suffix}@example.invalid", [admin_role, agent_role])
    assertion.call(apply.call(protected_payload.merge('email' => independent_admin.email, 'adopt_user_id' => independent_admin.id.to_s))[:state] == 'PROTECTED', 'Initial adoption removed independently managed administration')
    assertion.call(independent_admin.reload.roles.include?(admin_role), 'Protected native admin changed')
    proof[:foreign_subject_and_service_admin_protection] = true

    # Exercise the pinned native creation entrypoint with opt-in enabled but no
    # local row, including an existing manually created account of the same email.
    Authorization.singleton_class.prepend(Wasalx::MembershipAccess::OidcCreation) unless Authorization.singleton_class < Wasalx::MembershipAccess::OidcCreation
    original_post = Wasalx::Client.method(:post)
    begin
      Wasalx::Client.define_singleton_method(:post) do |path, _body, **_options|
        raise "Unexpected membership readiness endpoint" unless path == '/internal/v1/zammad/membership/identity'
        { 'enabled' => true, 'native_user_id' => nil }
      end
      first_login = { 'provider' => 'openid_connect', 'uid' => "pending-#{suffix}", 'info' => { 'email' => foreign.email, 'name' => 'Pending Staff' } }
      begin
        Authorization.create_from_hash(first_login)
        raise 'Pending first login was admitted with zero matching native rows'
      rescue Authorization::Provider::AccountError
        assertion.call(!Authorization.exists?(provider: 'openid_connect', uid: first_login['uid']), 'Pending login persisted an authorization')
        assertion.call(User.where(email: foreign.email).count == 1, 'Pending login created a duplicate native user')
      end
    ensure
      Wasalx::Client.define_singleton_method(:post, original_post)
    end
    proof[:pending_first_login_without_native_row] = true

    # Request authorization is exercised through the real native controller, not
    # just by invoking the projection. All credentials below are isolated fixtures.
    token = Token.create!(action: 'api', persistent: true, user_id: service.id, name: "WasalX Service", preferences: { permission: ['admin.system'] })
    http = ActionDispatch::Integration::Session.new(Rails.application)
    http.host!('localhost')
    endpoint_payload = payload.merge('user_id' => SecureRandom.uuid, 'subject' => "http-#{suffix}", 'email' => "http-#{suffix}@example.invalid", 'role' => 'auditor')
    post_identity = lambda do |value, signed: true, offset: 0|
      body = JSON.generate(value)
      timestamp = (Time.now.to_i + offset).to_s
      signature = OpenSSL::HMAC.hexdigest('SHA256', ENV.fetch('WASALX_SERVICE_JWT_SECRET'), "#{timestamp}\n#{body}")
      headers = { 'Authorization' => "Token token=#{token.token}", 'Content-Type' => 'application/json', 'X-Wasalx-Timestamp' => timestamp }
      headers['X-Wasalx-Signature'] = signature if signed
      http.post('/api/v1/wasalx/membership', params: body, headers: headers)
    end
    post_identity.call(endpoint_payload, signed: false)
    assertion.call(http.response.status == 403, 'Native admin token admitted an unsigned identity assertion')
    post_identity.call(endpoint_payload, offset: -60)
    assertion.call(http.response.status == 403, 'Stale signed identity assertion was admitted')
    post_identity.call(endpoint_payload.merge('tenant_id' => SecureRandom.uuid))
    assertion.call(http.response.status == 400, 'Cross-tenant identity assertion was admitted')
    post_identity.call(endpoint_payload)
    assertion.call(http.response.status == 200 && JSON.parse(http.response.body) == { 'state' => 'READY', 'native_user_id' => nil, 'revision' => 1 }, 'Exact authenticated native membership request failed')
    proof[:native_signed_endpoint_fences] = true
    raise ActiveRecord::Rollback
  end
ensure
  client_ids.each { |id| Sessions.destroy(id) }
  UserInfo.current_user_id = original_actor
end
puts JSON.generate(proof)
