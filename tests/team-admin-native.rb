# Run on the isolated native fixture only, never a production instance.
require 'securerandom'
raise 'isolated simulated fixture required' unless ENV['WASALX_ADMIN_TEST_MODE'] == 'simulated'
owner = WasalxMembership.find_by!(portal_user_id: ENV.fetch('WASALX_ADMIN_TEST_OWNER'))
member = WasalxMembership.find_by!(portal_user_id: ENV.fetch('WASALX_ADMIN_TEST_MEMBER'))
raise 'fixture boundary' unless owner.tenant_id == member.tenant_id && owner.instance_id == member.instance_id && %w[tenant_owner tenant_admin].include?(owner.portal_role) && member.portal_role == 'agent'
actor = owner.user
actor.permissions!('admin.group')
actor.permissions!('admin.user')
assert = ->(condition, message) { raise message unless condition }
invoke = ->(kind, input, user = actor) do
  # Match the request boundary: native transaction dispatch can clear the current actor.
  UserInfo.with_user_id(user.id) do
    Wasalx::PortalTeamAdministration.new(actor: user, authorizer: -> { user.reload }, envelope: { 'tenant_id' => owner.tenant_id, 'instance_id' => owner.instance_id,
      'actor' => { 'user_id' => owner.portal_user_id }, 'operation' => kind, 'input' => input }).call
  end
end
UserInfo.with_user_id(actor.id) do
  Group.transaction do
    name = "Team admin #{SecureRandom.hex(5)}"
    create_id = SecureRandom.uuid
    created = invoke.call('TEAM_CREATE', { 'operation_id' => create_id, 'name' => name })
    assert.call(created['state'] == 'APPLIED' || created[:state] == 'APPLIED', 'create outcome')
    team_id = (created['team_id'] || created[:team_id]).to_s
    assert.call(Group.find(team_id).name == name, 'create persisted')
    history_object = History::Object.find_by!(name: 'Group')
    assert.call(History.where(history_object_id: history_object.id, o_id: team_id, created_by_id: actor.id).exists?, 'native group creation history/author missing')
    replay = invoke.call('TEAM_CREATE', { 'operation_id' => create_id, 'name' => name })
    assert.call((replay['team_id'] || replay[:team_id]).to_s == team_id, 'equal key duplicate')
    detail = invoke.call('TEAM_SHOW', { 'team_id' => team_id })
    version = detail[:members].find { |item| item[:id] == member.portal_user_id }.fetch(:version)
    begin
      invoke.call('TEAM_SAVE', { 'team_id' => team_id, 'operation_id' => SecureRandom.uuid, 'expected_version' => 'stale', 'name' => 'Wrong', 'note' => '', 'active' => true })
      raise 'stale accepted'
    rescue Wasalx::PortalTeamAdministration::Conflict
    end
    inactive = Group.create!(name: "Inactive retained #{SecureRandom.hex(5)}", active: false, created_by_id: actor.id, updated_by_id: actor.id)
    UserGroup.create!(user_id: member.user_id, group_id: inactive.id, access: 'read')
    raw_map = -> { UserGroup.where(user_id: member.user_id).order(:group_id, :access).pluck(:group_id, :access).group_by(&:first).transform_keys(&:to_s).transform_values { |items| items.map(&:last) } }
    old_map = raw_map.call
    version = invoke.call('TEAM_SHOW', { 'team_id' => team_id })[:members].find { |item| item[:id] == member.portal_user_id }.fetch(:version)
    grant_id = SecureRandom.uuid
    invoke.call('TEAM_GRANT_SAVE', { 'team_id' => team_id, 'operation_id' => grant_id, 'expected_version' => version, 'member_id' => member.portal_user_id, 'access' => ['read', 'create'] })
    changed = raw_map.call
    assert.call(changed.except(team_id) == old_map.except(team_id), 'unrelated direct grants changed')
    assert.call(Array(changed[team_id]).sort == %w[create read], 'granular grant persisted')
    assert.call(member.user.reload.group_access?(team_id.to_i, 'read') && member.user.group_ids_access('create').include?(team_id.to_i), 'native permission/cache projection missed saved grants')
    # Zammad edits name_last and derives the read-only full path in name.
    workflow = CoreWorkflow.create!(name: "Team administration restriction #{SecureRandom.hex(5)}", object: 'Group',
      active: true, changeable: true, priority: 1, stop_after_match: true,
      condition_saved: { 'group.name_last' => { 'operator' => 'is', 'value' => [name] } }, condition_selected: {},
      perform: { 'group.name_last' => { 'operator' => 'set_fixed_to', 'set_fixed_to' => [name] } },
      preferences: { 'screen' => ['edit'] }, created_by_id: actor.id, updated_by_id: actor.id)
    disallowed_name = "Disallowed change #{SecureRandom.hex(5)}"
    group = Group.find(team_id)
    workflow_result = CoreWorkflow.perform(payload: { 'event' => 'core_workflow',
      'request_id' => 'ChecksCoreWorkflow.validate_workflows', 'class_name' => 'Group', 'screen' => 'edit',
      'params' => group.attributes.merge('name' => disallowed_name, 'name_last' => disallowed_name) },
      user: actor, assets: false, policy: false)
    assert.call(workflow_result.fetch(:restrict_values)['name_last'] == [name], 'native Group edit fixture has no active name restriction')
    restricted_id = SecureRandom.uuid
    workflow_denied = false
    begin
      invoke.call('TEAM_SAVE', { 'team_id' => team_id, 'operation_id' => restricted_id, 'expected_version' => invoke.call('TEAM_SHOW', { 'team_id' => team_id })[:version], 'name' => disallowed_name, 'note' => '', 'active' => true })
    rescue Exceptions::ApplicationModel => error
      raise unless error.record == group && error.message.include?("'name_last'")
      workflow_denied = true
    end
    assert.call(workflow_denied, 'native Group core workflow was bypassed')
    assert.call(Group.find(team_id).name == name && !WasalxAdminOperation.exists?(operation_id: restricted_id), 'workflow failure committed effect/receipt')
    workflow.destroy!
    role = Role.create!(name: "Inherited retained #{SecureRandom.hex(5)}", active: true, created_by_id: actor.id, updated_by_id: actor.id)
    RoleGroup.create!(role_id: role.id, group_id: team_id, access: 'overview')
    member.user.roles << role
    detail = invoke.call('TEAM_SHOW', { 'team_id' => team_id })
    member_detail = detail[:members].find { |item| item[:id] == member.portal_user_id }
    invoke.call('TEAM_GRANT_SAVE', { 'team_id' => team_id, 'operation_id' => SecureRandom.uuid, 'expected_version' => member_detail[:version], 'member_id' => member.portal_user_id, 'access' => [] })
    assert.call(UserGroup.where(user_id: member.user_id, group_id: team_id).none? && member.user.reload.group_ids_access('overview').include?(team_id.to_i), 'direct removal destroyed inherited access')
    begin
      invoke.call('TEAM_GRANT_SAVE', { 'team_id' => team_id, 'operation_id' => SecureRandom.uuid, 'expected_version' => invoke.call('TEAM_SHOW', { 'team_id' => team_id })[:members].find { |item| item[:id] == member.portal_user_id }.fetch(:version), 'member_id' => member.portal_user_id, 'access' => ['full', 'read'] })
      raise 'mixed full/granular accepted'
    rescue ArgumentError
    end
    cancelled = SecureRandom.uuid
    outcome = invoke.call('TEAM_RECEIPT', { 'operation_id' => cancelled, 'kind' => 'TEAM_CREATE', 'cancel_if_missing' => true })
    assert.call(outcome[:state] == 'CANCELLED', 'cancel fence absent')
    begin
      invoke.call('TEAM_CREATE', { 'operation_id' => cancelled.upcase, 'name' => 'Delayed' })
      raise 'late original accepted'
    rescue Wasalx::PortalTeamAdministration::Conflict
    end
    begin
      invoke.call('TEAM_CREATE', { 'operation_id' => SecureRandom.uuid, 'name' => 'Denied' }, member.user)
      raise 'agent admin accepted'
    rescue Exceptions::Forbidden
    end
    raise ActiveRecord::Rollback
  end
end
puts 'Team administration native regression passed; fixture changes rolled back.'
