# frozen_string_literal: true
# Real native database/session/event lifecycle in an isolated qualification DB.
# The socket sink and control verdict are synthetic; native event and pool code are real.
require 'json'
require 'securerandom'
raise 'Isolated native qualification is required' unless ENV['WASALX_TEST_ISOLATED'] == '1'
assertion = ->(condition, message) { raise message unless condition }
pool_missing = lambda do
  ActiveRecord::Base.connection_pool
  false
rescue ActiveRecord::ConnectionNotDefined
  true
end
original_post = Wasalx::Client.method(:post)
original_actor = UserInfo.current_user_id
original_clients = WebsocketServer.instance_variable_get(:@clients)
original_options = WebsocketServer.instance_variable_get(:@options)
users = []
client_id = nil
proof = {}
begin
  UserInfo.current_user_id = 1
  agent = Role.find_by!(name: 'Agent')
  user = User.create!(login: "legacy-proof-#{SecureRandom.hex(12)}", firstname: 'Synthetic', lastname: 'Legacy',
    email: '', active: true, roles: [Role.find_by!(name: 'Admin'), agent], created_by_id: 1, updated_by_id: 1)
  users << user.id
  member = WasalxMembership.create!(tenant_id: ENV.fetch('WASALX_TENANT_ID'), instance_id: ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID'),
    portal_user_id: SecureRandom.uuid, subject: SecureRandom.uuid, email: '', user_id: user.id, revision: 1, member_state: 'ACTIVE', portal_role: 'tenant_owner')
  control_allowed = true
  control_database_failure = false
  Wasalx::Client.define_singleton_method(:post) do |path, input, scope:, **_options|
    raise 'Unexpected control call' unless path == '/internal/v1/zammad/membership/check' && scope == 'zammad:membership'
    ActiveRecord::Base.connection.execute('SELECT wasalx_intentionally_missing_column') if control_database_failure
    { 'allowed' => control_allowed && input[:user_id] == member.portal_user_id && input[:revision] == member.revision }
  end
  deliveries = []
  closes = []
  socket = Object.new
  client_id = socket.object_id.to_s
  assertion.call(Sessions.valid_client_id?(client_id), 'Fixture client ID violates the native session contract')
  socket.define_singleton_method(:send) { |value| deliveries << JSON.parse(value) }
  socket.define_singleton_method(:close_websocket) { closes << true }
  clients = { client_id => { session: { 'id' => user.id }, websocket: socket, error_count: 0, last_ping: Time.now.to_i } }
  WebsocketServer.instance_variable_set(:@clients, clients)
  WebsocketServer.instance_variable_set(:@options, {})
  Sessions.create(client_id, { 'id' => user.id }, { type: 'websocket' })
  payload = { event: 'core_workflow', request_id: 'native-pool-proof', class_name: 'User', screen: 'edit',
    params: { id: user.id, firstname: user.firstname, lastname: user.lastname, email: '', active: true, role_ids: [agent.id] } }
  ActiveRecord::Base.remove_connection
  2.times do
    WebsocketServer.onmessage(socket, JSON.generate(payload))
    assertion.call(deliveries.last&.any? { |event| event['event'] == 'core_workflow' && event.dig('data', 'request_id') == payload[:request_id] }, 'Native CoreWorkflow response was lost')
    assertion.call(pool_missing.call, 'Event/guard leaked its database pool')
  end
  proof[:native_event_init_destroy_and_core_workflow] = true

  Sessions.send(client_id, { event: 'owned-queue-proof' })
  WebsocketServer.send_to_client
  assertion.call(deliveries.last.any? { |event| event['event'] == 'owned-queue-proof' }, 'Native timer delivery failed after pool removal')
  sender = Sessions::Event::Base.allocate
  sender.instance_variable_set(:@clients, clients)
  sender.instance_variable_set(:@options, {})
  sender.websocket_send(client_id, { event: 'owned-direct-proof' })
  assertion.call(deliveries.last.any? { |event| event['event'] == 'owned-direct-proof' }, 'Native event direct delivery failed after pool removal')
  assertion.call(pool_missing.call, 'Timer/direct guard leaked a database pool')
  proof[:native_timer_queue_and_direct_delivery] = true

  borrowed_pool = ActiveRecord::Base.establish_connection
  borrowed_pool.with_connection do |connection|
    assertion.call(Wasalx::MembershipAccess.legacy_allowed?(client_id), 'Existing active connection was denied')
    assertion.call(ActiveRecord::Base.connection_pool.equal?(borrowed_pool) && borrowed_pool.active_connection?.equal?(connection), 'Guard removed or replaced caller-owned active connection')
  end
  borrowed_pool.release_connection
  assertion.call(Wasalx::MembershipAccess.legacy_allowed?(client_id), 'Existing idle pool was denied')
  assertion.call(ActiveRecord::Base.connection_pool.equal?(borrowed_pool), 'Guard removed caller-owned idle pool')
  ActiveRecord::Base.remove_connection
  control_database_failure = true
  assertion.call(!Wasalx::MembershipAccess.legacy_allowed?(client_id), 'Actual database failure did not deny access')
  assertion.call(pool_missing.call, 'Database failure leaked its owned pool')
  control_database_failure = false
  ActiveRecord::Base.establish_connection
  proof[:caller_owned_active_and_idle_pool_preserved] = true

  member.update!(member_state: 'SUSPENDED')
  ActiveRecord::Base.remove_connection
  count = deliveries.length
  WebsocketServer.onmessage(socket, JSON.generate(payload))
  assertion.call(deliveries.length == count && closes.length == 1 && !clients.key?(client_id), 'Suspended event leaked a private response')
  assertion.call(pool_missing.call, 'Denied guard leaked its pool')
  ActiveRecord::Base.establish_connection
  member.update!(member_state: 'ACTIVE', revision: 2)
  Sessions.destroy(client_id)
  ActiveRecord::Base.remove_connection
  assertion.call(!Wasalx::MembershipAccess.legacy_allowed?(client_id, { 'id' => user.id }), 'Removed stored session regained access after re-add')
  assertion.call(pool_missing.call, 'Missing session opened a database pool')
  Sessions.create(client_id, { 'id' => user.id }, { type: 'websocket' })
  control_allowed = false
  assertion.call(!Wasalx::MembershipAccess.legacy_allowed?(client_id), 'Current control denial was ignored')
  assertion.call(pool_missing.call, 'Control denial leaked its pool')
  ActiveRecord::Base.establish_connection
  machine = User.create!(login: "tenant-automation-proof-#{SecureRandom.hex(12)}", firstname: 'Synthetic', lastname: 'Machine',
    email: '', active: true, roles: [agent], created_by_id: 1, updated_by_id: 1)
  users << machine.id
  Sessions.create(client_id, { 'id' => machine.id }, { type: 'websocket' })
  ActiveRecord::Base.remove_connection
  assertion.call(!Wasalx::MembershipAccess.legacy_allowed?(client_id), 'Automation account gained interactive access')
  assertion.call(pool_missing.call, 'Machine denial leaked its pool')
  proof[:revoked_machine_and_current_control_denials] = true
ensure
  ActiveRecord::Base.establish_connection if pool_missing.call
  Wasalx::Client.define_singleton_method(:post, original_post)
  Sessions.destroy(client_id)
  WasalxMembership.where(user_id: users).destroy_all
  User.where(id: users).find_each(&:destroy!)
  WebsocketServer.instance_variable_set(:@clients, original_clients)
  WebsocketServer.instance_variable_set(:@options, original_options)
  UserInfo.current_user_id = original_actor
end
puts JSON.generate(proof)
