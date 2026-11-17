# Actual committed two-connection native grant CAS race; isolated fixture only.
require 'securerandom'
require 'timeout'
raise 'isolated simulated native fixture required' unless ENV['WASALX_TEST_ISOLATED'] == '1' && ENV['WASALX_ADMIN_TEST_MODE'] == 'simulated'
owner = WasalxMembership.find_by!(portal_user_id: ENV.fetch('WASALX_ADMIN_TEST_OWNER'))
member = WasalxMembership.find_by!(portal_user_id: ENV.fetch('WASALX_ADMIN_TEST_MEMBER'))
raise 'cross-scope race fixture' unless owner.tenant_id == member.tenant_id && owner.instance_id == member.instance_id
operations = [SecureRandom.uuid, SecureRandom.uuid, SecureRandom.uuid]
team = nil
threads = []
invoke = lambda do |kind, input|
  human = User.find(owner.user_id)
  UserInfo.with_user_id(human.id) do
    Wasalx::PortalTeamAdministration.new(actor: human, authorizer: -> { human.reload }, envelope: {
      'tenant_id' => owner.tenant_id, 'instance_id' => owner.instance_id,
      'actor' => { 'user_id' => owner.portal_user_id }, 'operation' => kind, 'input' => input }).call
  end
end
begin
  result = invoke.call('TEAM_CREATE', { 'operation_id' => operations[0], 'name' => "Concurrent grant #{SecureRandom.hex(5)}" })
  team = Group.find(result[:team_id] || result['team_id'])
  detail = invoke.call('TEAM_SHOW', { 'team_id' => team.id.to_s })
  member_row = detail.fetch(:members).find { |row| row[:id] == member.portal_user_id }
  raise 'managed member absent from isolated first page' unless member_row
  version = member_row.fetch(:version)
  ready, start = Queue.new, Queue.new
  threads = [%w[read], %w[read create]].each_with_index.map do |access, index|
    Thread.new do
      ActiveRecord::Base.connection_pool.with_connection do |connection|
        connection.execute("SET lock_timeout = '10s'")
        ready << connection.select_value('SELECT pg_backend_pid()')
        start.pop
        begin
          outcome = invoke.call('TEAM_GRANT_SAVE', { 'operation_id' => operations[index + 1], 'team_id' => team.id.to_s,
            'member_id' => member.portal_user_id, 'expected_version' => version, 'access' => access })
          [:applied, access, outcome]
        rescue Wasalx::PortalTeamAdministration::Conflict
          [:conflict, access]
        ensure
          connection.execute('RESET lock_timeout')
        end
      end
    end
  end
  pids = Timeout.timeout(15) { [ready.pop, ready.pop] }
  raise 'race did not use independent native database sessions' unless pids.uniq.length == 2
  2.times { start << true }
  results = Timeout.timeout(30) { threads.map(&:value) }
  raise 'concurrent stale grant overwrote winner' unless results.map(&:first).sort == [:applied, :conflict]
  winning_access = results.find { |row| row.first == :applied }[1]
  persisted = UserGroup.where(user_id: member.user_id, group_id: team.id).pluck(:access).sort
  raise 'grant readback differs from sole successful writer' unless persisted == winning_access.sort
  raise 'grant receipt count not exactly one' unless WasalxAdminOperation.where(operation_id: operations.drop(1)).count == 1
ensure
  # Do not kill threads mid-write. All joins are bounded by native lock_timeout.
  2.times { start << true } if defined?(start) && start
  threads.each(&:join)
  UserInfo.with_user_id(owner.user_id) do
    Transaction.execute do
      UserGroup.where(user_id: member.user_id, group_id: team.id).destroy_all if team
      WasalxAdminOperation.where(operation_id: operations).destroy_all
      team&.reload&.destroy!
    end
  end
end
puts 'Team administration two-connection grant race passed; committed fixture cleaned.'
