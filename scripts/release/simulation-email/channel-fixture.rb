# bundle exec rails runner /run/wasalx-simulation/channel-fixture.rb < input.json
require 'json'
require 'digest'
require 'time'
def assert_retired_owned_channels!(retired, addresses, before, source, run_id, group_for)
  raise 'retired account census drift' unless retired.any? && retired.map(&:id) == before.fetch('accountChannelIds') && addresses.map(&:id) == before.fetch('emailAddressIds') && retired.size == addresses.size
  raise 'retired source binding drift' unless retired.any? { |channel| channel.id == source.fetch('channelId') && channel.group_id == source.fetch('groupId') && channel.preferences[:alpha_simulation] == "alpha-mail-#{source.fetch('ownerNamespace')}" && channel.preferences[:previous_email_address_id] == source.fetch('previousEmailAddressId') } && addresses.any? { |address| address.id == source.fetch('emailAddressId') && address.channel_id == source.fetch('channelId') && address.email == source.fetch('email') }
  owners = []
  retired.each do |channel|
    marker = channel.preferences[:alpha_simulation]
    owner = marker.to_s.delete_prefix('alpha-mail-')
    raise 'retired account owner drift' unless marker == "alpha-mail-#{owner}" && owner.match?(/\A[a-zA-Z0-9-]{1,60}\z/) && owner != run_id && !owners.include?(owner)
    owners << owner
    address = addresses.find { |row| row.channel_id == channel.id }
    group = group_for.call(channel.group_id)
    raise 'retired account restoration drift' unless !channel.active && address && address.email == "support-#{owner.downcase}@alpha.invalid" && group.email_address_id == channel.preferences[:previous_email_address_id] && !addresses.any? { |row| row.id == group.email_address_id }
    raise 'retired account transport drift' unless channel.options.keys.map(&:to_s).sort == %w[inbound outbound] && channel.options.dig(:inbound, :adapter) == 'null' && channel.options.dig(:inbound, :options) == {} && channel.options.dig(:outbound, :adapter) == 'smtp' && address.name == 'Alpha Mail' && group.active? && channel.options.dig(:outbound, :options, :host) == 'alpha-smtp' && channel.options.dig(:outbound, :options, :port) == 2525 && channel.options.dig(:outbound, :options, :enable_starttls_auto) == false && channel.options.dig(:outbound, :options).to_h.keys.map(&:to_s).sort == %w[domain enable_starttls_auto host port]
  end
  raise 'retired account address drift' unless addresses.map(&:channel_id).sort == retired.map(&:id).sort
end
def assert_retained_account_activation!(channel, address, group, source, run_id)
  owner = source.fetch('ownerNamespace')
  raise 'retained account owner invalid' unless owner.match?(/\A[a-zA-Z0-9-]{1,60}\z/) && owner != run_id
  raise 'retained account identity drift' unless channel.id == source.fetch('channelId') && channel.group_id == source.fetch('groupId') && address.id == source.fetch('emailAddressId') && address.channel_id == channel.id
  raise 'retained account ownership drift' unless channel.preferences[:alpha_simulation] == "alpha-mail-#{owner}" && channel.preferences[:previous_email_address_id] == source.fetch('previousEmailAddressId')
  raise 'retained account address drift' unless address.email == source.fetch('email') && address.name == 'Alpha Mail' && address.email == "support-#{owner.downcase}@alpha.invalid"
  raise 'retained account group drift' unless group.id == channel.group_id && group.active? && group.email_address_id == source.fetch('previousEmailAddressId')
  outbound = channel.options.dig(:outbound)
  raise 'retained account transport drift' unless channel.area == 'Email::Account' && !channel.active && channel.options.keys.map(&:to_s).sort == %w[inbound outbound] && channel.options.dig(:inbound, :adapter) == 'null' && channel.options.dig(:inbound, :options) == {} && outbound&.dig(:adapter) == 'smtp' && outbound.dig(:options, :host) == 'alpha-smtp' && outbound.dig(:options, :port) == 2525 && outbound.dig(:options, :enable_starttls_auto) == false && outbound.dig(:options).to_h.keys.map(&:to_s).sort == %w[domain enable_starttls_auto host port]
  true
end
input = JSON.parse(STDIN.read)
raise 'isolated admission required' unless input['isolated'] == true && input['evidenceMode'] == 'simulated'
run_id = input.fetch('runId')
raise 'invalid run' unless run_id.match?(/\A[a-zA-Z0-9-]{1,60}\z/)
owner_run_id = input['ownerRunId'] || run_id
raise 'invalid owner run' unless owner_run_id.match?(/\A[a-zA-Z0-9-]{1,60}\z/)
marker = "alpha-mail-#{owner_run_id}"
device_snapshot = lambda do
  raise 'authentication device bound' if UserDevice.count > 100
  UserDevice.order(:id).map { |d| {id: d.id, userId: d.user_id, createdAt: d.created_at.utc.iso8601(6), fingerprintPresent: d.fingerprint.present?, userAgentSha256: Digest::SHA256.hexdigest(d.user_agent.to_s), locationSha256: Digest::SHA256.hexdigest(d.location.to_s)} }
end
action = input.fetch('action')
if %w[notification-readback notification-setup notification-activate notification-contain].include?(action)
  snapshot = lambda do
    channels = Channel.where(area: 'Email::Notification').order(:id).to_a
    raise 'notification channel shape' unless channels.size == 2 && channels.map { |c| c.options.dig(:outbound, :adapter) }.sort == %w[sendmail smtp]
    raise 'notification credentials require separate admission' if channels.any? { |c| c.options.dig(:outbound, :options).to_h.any? { |key, value| %w[user password].include?(key.to_s) && value.present? } || c.last_log_out.present? }
    JSON.parse(JSON.generate({channels: channels.map { |c| {id: c.id, active: c.active, options: c.options, preferences: c.preferences, statusOut: c.status_out, lastLogOut: c.last_log_out == '' ? nil : c.last_log_out} }, notificationSender: Setting.get('notification_sender'), systemBcc: Setting.get('system_bcc'), accountChannelIds: Channel.where(area: 'Email::Account').order(:id).pluck(:id), emailAddressIds: EmailAddress.order(:id).pluck(:id), emailAddressRows: EmailAddress.order(:id).map(&:attributes)}))
  end
  if action == 'notification-readback'
    puts JSON.generate(snapshot.call)
  else
    raise 'sink hostname required' unless input.fetch('smtpHost') == 'alpha-smtp'
    Channel.transaction do
      Channel.where(area: 'Email::Notification').order(:id).lock.load
      before = snapshot.call
      raise 'notification configuration drift; reconcile before retry' unless before == input.fetch('expected')
      unless action == 'notification-contain'
        if input['retainedChannel']
          raise 'retained activation only' unless action == 'notification-activate'
          owned = input.fetch('retainedChannel'); owner = owned.fetch('ownerRunId')
          raise 'invalid retained owner' unless owner.match?(/\A[a-zA-Z0-9-]{1,60}\z/) && owner != run_id
          raise 'retained channel census drift' unless before.fetch('accountChannelIds') == [owned.fetch('channelId')] && before.fetch('emailAddressIds') == [owned.fetch('emailAddressId')]
          channel = Channel.lock.find(owned.fetch('channelId')); group = Group.lock.find(owned.fetch('groupId')); address = EmailAddress.find(owned.fetch('emailAddressId'))
          raise 'retained account ownership drift' unless channel.area == 'Email::Account' && channel.active && channel.group_id == group.id && channel.preferences[:alpha_simulation] == "alpha-mail-#{owner}" && group.email_address_id == address.id && address.channel_id == channel.id && address.email == owned.fetch('email')
        elsif input['allowRetiredOwnedChannels'] == true
          retired = Channel.where(area: 'Email::Account').order(:id).lock.to_a
          addresses = EmailAddress.order(:id).lock.to_a
          assert_retired_owned_channels!(retired, addresses, before, input.fetch('expectedRetiredChannel'), run_id, ->(id) { Group.lock.find(id) })
        else
          raise 'notification setup requires fresh account channels' unless before.fetch('accountChannelIds').empty?
          raise 'notification setup requires fresh email addresses' unless before.fetch('emailAddressIds').empty?
        end
      end
      raise 'notification setup requires empty native queue' if Delayed::Job.exists?
      if action == 'notification-setup'
        expected_devices = input.fetch('expectedDevices')
        raise 'notification device baseline drift' unless JSON.parse(JSON.generate(device_snapshot.call)) == expected_devices
      end
      domain = Channel::Driver::Smtp.new.prepare_options_get_fqdn(from: Setting.get('notification_sender'))
      options = {host: 'alpha-smtp', port: 2525, enable_starttls_auto: false, domain: domain}
      Service::System::SetEmailNotificationConfiguration.execute(adapter: 'smtp', new_configuration: options)
      Channel.find_by!(area: 'Email::Notification', active: true).update!(active: false) unless action == 'notification-activate'
      after = snapshot.call
      raise 'notification device baseline changed' if action == 'notification-setup' && JSON.parse(JSON.generate(device_snapshot.call)) != expected_devices
      raise 'notification row identity changed' unless after.fetch('channels').map { |c| c.fetch('id') } == before.fetch('channels').map { |c| c.fetch('id') }
      %w[notificationSender systemBcc accountChannelIds emailAddressIds emailAddressRows].each { |key| raise 'unrelated notification configuration changed' unless before.fetch(key) == after.fetch(key) }
      expected_options = JSON.parse(JSON.generate({outbound: {adapter: 'smtp', options: options}}))
      expected_channels = before.fetch('channels').map do |channel|
        channel.fetch('options').dig('outbound', 'adapter') == 'smtp' ? channel.merge('active' => action == 'notification-activate', 'options' => expected_options, 'statusOut' => 'ok', 'lastLogOut' => nil) : channel.merge('active' => false)
      end
      raise 'notification configuration changed outside the supported service contract' unless after.fetch('channels') == expected_channels
      active = after.fetch('channels').select { |c| c.fetch('active') }
      raise 'notification sink not admitted' unless action == 'notification-activate' ? active.size == 1 && active.first.fetch('options') == expected_options && active.first.fetch('statusOut') == 'ok' && active.first.fetch('lastLogOut').nil? : active.empty?
      puts JSON.generate({before: before, after: after, configured: true, noProbe: true})
    end
  end
elsif action == 'authentication-readback'
  ActiveRecord::Base.transaction do
    ActiveRecord::Base.connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    token = Token.find_by!(action: 'api', persistent: true, name: 'WasalX Service', token: input.fetch('serviceToken'))
    actor = token.user
    context = UserContext.new(actor, token)
    sources = %w[app/policies/user_device_policy.rb app/policies/application_policy.rb app/policies/pundit_policy.rb lib/user_context.rb app/controllers/application_controller/authorizes.rb app/controllers/application_controller/has_user.rb app/models/token.rb app/models/token/permissions.rb app/models/user/permissions.rb lib/auth/permissions.rb].to_h { |path| [path, Digest::SHA256.file(Rails.root.join(path)).hexdigest] }
    policy = {actorHasDevicePermission: actor.permissions?('user_preferences.device'), tokenContextHasDevicePermission: context.permissions?('user_preferences.device'), logs: UserDevicePolicy.new(context, UserDevice).log?, tokenPermissions: token.preferences.fetch(:permission).sort, sourceHashes: sources}
    devices = device_snapshot.call
    puts JSON.generate({serviceActorId: token.user_id, tokenLastUsedAt: token.last_used_at&.utc&.iso8601(6), devicePolicy: policy, devices: devices})
  end
elsif action == 'cross-connection-setup'
  agent_id = Integer(input.fetch('agentId'))
  agent_email = input.fetch('agentEmail')
  service_token_value = input.fetch('serviceToken')
  raise 'invalid service token admission' unless service_token_value.is_a?(String) && service_token_value.length >= 16
  group_name = "WasalX cross connection #{run_id}"
  group_note = "WasalX simulated cross connection owner #{run_id}"
  result = nil
  Group.transaction do
    agent = User.lock.find(agent_id)
    service_token = Token.lock.find_by!(action: 'api', persistent: true, name: 'WasalX Service', token: service_token_value)
    service_actor = User.lock.find(service_token.user_id)
    raise 'cross connection actor mismatch' unless agent.active? && agent.email == agent_email && agent.permissions?('ticket.agent') && !agent.permissions?('admin')
    raise 'cross connection service identity mismatch' unless service_actor.active? && service_actor.permissions?('ticket.agent') && service_actor.permissions?('admin') && service_actor.id != agent.id
    raise 'cross connection fixture exists; reconcile saved intent before retry' if Group.lock.find_by(name: group_name)
    original = agent.group_ids_access_map.transform_keys(&:to_i)
    service_original = service_actor.group_ids_access_map.transform_keys(&:to_i)
    group = UserInfo.with_user_id(1) { Group.create!(name: group_name, note: group_note, active: true, created_by_id: 1, updated_by_id: 1) }
    agent.group_ids_access_map = original.merge(group.id => 'full')
    service_actor.group_ids_access_map = service_original.merge(group.id => 'full')
    agent.save!
    service_actor.save!
    agent.reload
    service_actor.reload
    expected = original.merge(group.id => ['full'])
    service_expected = service_original.merge(group.id => ['full'])
    raise 'cross connection access not persisted' unless agent.group_ids_access_map.transform_keys(&:to_i) == expected
    raise 'cross connection service access not persisted' unless service_actor.group_ids_access_map.transform_keys(&:to_i) == service_expected
    raise 'cross connection group is not isolated' unless group.email_address_id.nil? && group.signature_id.nil? && group.parent_id.nil? && group.all_children.empty? && Ticket.where(group_id: group.id).none? && Channel.where(group_id: group.id).none?
    result = {ownerRunId: run_id, agentId: agent.id, serviceActorId: service_actor.id, groupId: group.id, groupName: group.name, originalAccessMap: original, currentAccessMap: expected, originalServiceAccessMap: service_original, currentServiceAccessMap: service_expected}
  end
  puts JSON.generate(result)
elsif action == 'cross-connection-restore'
  raise 'cross connection observation settlement required' unless input['observationSettled'] == true
  agent_id = Integer(input.fetch('agentId'))
  service_actor_id = Integer(input.fetch('serviceActorId'))
  service_token_value = input.fetch('serviceToken')
  raise 'invalid service token admission' unless service_token_value.is_a?(String) && service_token_value.length >= 16
  group_id = Integer(input.fetch('groupId'))
  ticket_proof = input.fetch('ticketProof')
  ticket_id = Integer(ticket_proof.fetch('ticketId'))
  article_id = Integer(ticket_proof.fetch('articleId'))
  external_message_id = ticket_proof.fetch('externalMessageId')
  routed_group_id = Integer(ticket_proof.fetch('routedGroupId'))
  raise 'WASALX_FIXTURE_ERROR:CROSS_CONNECTION_MESSAGE_ID_INVALID' unless external_message_id.is_a?(String) && external_message_id.length.between?(1, 512)
  original = input.fetch('originalAccessMap').to_h { |key, value| [Integer(key), Array(value).map(&:to_s).sort] }
  service_original = input.fetch('originalServiceAccessMap').to_h { |key, value| [Integer(key), Array(value).map(&:to_s).sort] }
  group_name = "WasalX cross connection #{owner_run_id}"
  group_note = "WasalX simulated cross connection owner #{owner_run_id}"
  result = nil
  Group.transaction do
    agent = User.lock.find(agent_id)
    service_actor = User.lock.find(service_actor_id)
    service_token = Token.lock.find_by!(action: 'api', persistent: true, name: 'WasalX Service', token: service_token_value)
    group = Group.lock.find(group_id)
    raise 'cross connection ownership mismatch' unless group.name == group_name && group.note == group_note && group.active? && group.created_by_id == 1
    raise 'cross connection service identity drift' unless service_token.user_id == service_actor.id && service_actor.id != agent.id
    expected = original.merge(group.id => ['full'])
    service_expected = service_original.merge(group.id => ['full'])
    raise 'cross connection access drift; preserve fixture' unless agent.group_ids_access_map.transform_keys(&:to_i) == expected
    raise 'cross connection service access drift; preserve fixture' unless service_actor.group_ids_access_map.transform_keys(&:to_i) == service_expected
    ticket = Ticket.lock.find(ticket_id)
    article = Ticket::Article.lock.find(article_id)
    raise 'WASALX_FIXTURE_ERROR:CROSS_CONNECTION_TICKET_ROUTE_DRIFT' unless ticket.group_id == routed_group_id
    raise 'WASALX_FIXTURE_ERROR:CROSS_CONNECTION_ARTICLE_DRIFT' unless article.ticket_id == ticket.id && article.preferences['wasalx_external_message_id'] == external_message_id
    expected_fixture_tickets = routed_group_id == group.id ? [ticket.id] : []
    raise 'WASALX_FIXTURE_ERROR:CROSS_CONNECTION_FIXTURE_TICKET_DRIFT' unless Ticket.where(group_id: group.id).pluck(:id).sort == expected_fixture_tickets
    raise 'cross connection group gained a channel' if Channel.where(group_id: group.id).exists?
    raise 'cross connection group gained an email linkage' unless group.email_address_id.nil?
    raise 'cross connection group gained a signature linkage' unless group.signature_id.nil?
    raise 'cross connection group gained hierarchy' unless group.parent_id.nil? && group.all_children.empty?
    foreign_access = User.where.not(id: [agent.id, service_actor.id]).find { |user| user.saved_group_ids_access_map.transform_keys(&:to_i).key?(group.id) }
    raise 'cross connection group gained foreign access' if foreign_access
    agent.group_ids_access_map = original.transform_values { |value| value.length == 1 ? value.first : value }
    service_actor.group_ids_access_map = service_original.transform_values { |value| value.length == 1 ? value.first : value }
    agent.save!
    service_actor.save!
    group.update!(active: false, updated_by_id: 1)
    agent.reload
    service_actor.reload
    group.reload
    raise 'cross connection access restoration failed' unless agent.group_ids_access_map.transform_keys(&:to_i) == original
    raise 'cross connection service access restoration failed' unless service_actor.group_ids_access_map.transform_keys(&:to_i) == service_original
    raise 'cross connection group retirement failed' if group.active?
    result = {restored: true, retainedEvidence: true, ownerRunId: owner_run_id, agentId: agent.id, serviceActorId: service_actor.id, groupId: group.id, ticketProof: {ticketId: ticket.id, articleId: article.id, externalMessageId: external_message_id, routedGroupId: routed_group_id}, accessMap: original, serviceAccessMap: service_original}
  end
  puts JSON.generate(result)
elsif action == 'routing-visibility-setup'
  agent_id = Integer(input.fetch('agentId'))
  target_group_id = Integer(input.fetch('targetGroupId'))
  agent_email = input.fetch('agentEmail')
  target_group_name = input.fetch('targetGroupName')
  visibility_name = "WasalX routing visibility #{run_id}"
  visibility_note = "WasalX simulated routing visibility owner #{run_id}"
  result = nil
  User.transaction do
    agent = User.lock.find(agent_id)
    raise 'routing visibility actor mismatch' unless agent.active? && agent.email == agent_email && agent.permissions?('ticket.agent') && !agent.permissions?('admin')
    target = Group.lock.find(target_group_id)
    raise 'routing visibility target mismatch' unless target.active? && target.name == target_group_name
    current = agent.group_ids_access_map.transform_keys(&:to_i)
    control = Group.lock.find_by(name: visibility_name)
    raise 'routing visibility fixture exists; reconcile saved intent before retry' if control
    original = current
    control = UserInfo.with_user_id(1) { Group.create!(name: visibility_name, note: visibility_note, active: true, created_by_id: 1, updated_by_id: 1) }
    agent.group_ids_access_map = original.merge(control.id => 'full')
    agent.save!
    agent.reload
    raise 'routing visibility target access missing' unless original[target.id] == ['full']
    expected = original.merge(control.id => ['full'])
    raise 'routing visibility grant not persisted' unless agent.group_ids_access_map.transform_keys(&:to_i) == expected
    raise 'routing visibility control group is not isolated' unless control.email_address_id.nil? && control.signature_id.nil? && control.parent_id.nil? && control.all_children.empty? && Ticket.where(group_id: control.id).none? && Channel.where(group_id: control.id).none?
    result = {ownerRunId: run_id, agentId: agent.id, targetGroupId: target.id, controlGroupId: control.id, controlGroupName: control.name, originalAccessMap: original, currentAccessMap: expected}
  end
  puts JSON.generate(result)
elsif action == 'routing-visibility-restore'
  raise 'routing visibility observation settlement required' unless input['observationSettled'] == true
  agent_id = Integer(input.fetch('agentId'))
  target_group_id = Integer(input.fetch('targetGroupId'))
  control_group_id = Integer(input.fetch('controlGroupId'))
  original = input.fetch('originalAccessMap').to_h { |key, value| [Integer(key), Array(value).map(&:to_s).sort] }
  visibility_name = "WasalX routing visibility #{owner_run_id}"
  visibility_note = "WasalX simulated routing visibility owner #{owner_run_id}"
  result = nil
  User.transaction do
    agent = User.lock.find(agent_id)
    target = Group.lock.find(target_group_id)
    control = Group.lock.find(control_group_id)
    raise 'routing visibility target drift' unless target.active? && original[target.id] == ['full']
    raise 'routing visibility ownership mismatch' unless control.name == visibility_name && control.note == visibility_note && control.active? && control.created_by_id == 1
    expected = original.merge(control.id => ['full'])
    raise 'routing visibility access drift; preserve fixture' unless agent.group_ids_access_map.transform_keys(&:to_i) == expected
    raise 'routing visibility control group gained a ticket' if Ticket.where(group_id: control.id).exists?
    raise 'routing visibility control group gained a channel' if Channel.where(group_id: control.id).exists?
    raise 'routing visibility control group gained an email linkage' unless control.email_address_id.nil?
    raise 'routing visibility control group gained a signature linkage' unless control.signature_id.nil?
    raise 'routing visibility control group gained hierarchy' unless control.parent_id.nil? && control.all_children.empty?
    foreign_access = User.where.not(id: agent.id).find { |user| user.saved_group_ids_access_map.transform_keys(&:to_i).key?(control.id) }
    raise 'routing visibility control group gained foreign access' if foreign_access
    agent.group_ids_access_map = original.transform_values { |value| value.length == 1 ? value.first : value }
    agent.save!
    agent.reload
    raise 'routing visibility access restoration failed' unless agent.group_ids_access_map.transform_keys(&:to_i) == original
    control.destroy!
    raise 'routing visibility control group retained' if Group.exists?(control.id)
    result = {restored: true, ownerRunId: owner_run_id, agentId: agent.id, targetGroupId: target.id, controlGroupId: control.id, accessMap: original}
  end
  puts JSON.generate(result)
elsif action == 'retained-account-activate'
  raise 'retained account settlement required' unless input['ownedJobsDrained'] == true && input['uncertainOutcomesReconciled'] == true
  source = input.fetch('retainedChannel')
  result = nil
  Channel.transaction do
    channel = Channel.lock.find(source.fetch('channelId'))
    address = EmailAddress.find(source.fetch('emailAddressId'))
    group = Group.lock.find(source.fetch('groupId'))
    assert_retained_account_activation!(channel, address, group, source, run_id)
    raise 'retained account native queue not empty' unless Delayed::Job.count.zero?
    raise 'another active account channel exists' if Channel.where(area: 'Email::Account', active: true).where.not(id: channel.id).exists?
    group.update!(email_address_id: address.id, updated_by_id: 1)
    channel.update!(active: true, updated_by_id: 1)
    group.reload
    channel.reload
    raise 'retained account activation failed' unless group.email_address_id == address.id && channel.active
    result = source.merge('active' => true, 'adopted' => true)
  end
  puts JSON.generate(result)
elsif action == 'reconcile-create-rollback'
  group_id = Integer(input.fetch('groupId'))
  expected_email_address_id = input['expectedEmailAddressId']
  address_email = "support-#{run_id.downcase}@alpha.invalid"
  ActiveRecord::Base.transaction do
    ActiveRecord::Base.connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    group = Group.find(group_id)
    owned = Channel.where(area: 'Email::Account').to_a.select { |channel| channel.preferences[:alpha_simulation] == marker }
    intended = EmailAddress.where('LOWER(email) = ?', address_email.downcase)
    pending = Delayed::Job.where("handler LIKE ?", '%TicketArticleCommunicateEmailJob%').where(failed_at: nil).count
    total = Delayed::Job.count
    rolled_back = owned.empty? && intended.none? && group.email_address_id == expected_email_address_id && pending.zero? && total.zero?
    puts JSON.generate({rolledBack: rolled_back, ownedChannelCount: owned.size, intendedAddressCount: intended.count, groupEmailAddressId: group.email_address_id, pendingEmailJobs: pending, nativeQueueTotal: total})
  end
elsif action == 'create'
  raise 'create owner mismatch' unless owner_run_id == run_id
  # Main validates this exact Docker DNS name resolves only on the internal network.
  raise 'sink hostname required' unless input.fetch('smtpHost') == 'alpha-smtp'
  raise 'owned fixture exists; read back instead' if Channel.where(area: 'Email::Account').any? { |c| c.preferences[:alpha_simulation] == marker }
  result = nil
  Channel.transaction do
    group = Group.lock.find(input.fetch('groupId'))
    raise 'group configuration drift' unless group.email_address_id == input['expectedEmailAddressId']
    previous = group.email_address_id
    address_email = "support-#{run_id.downcase}@alpha.invalid"
    domain = Channel::Driver::Smtp.new.prepare_options_get_fqdn(from: address_email)
    channel = Channel.create!(area: 'Email::Account', group_id: group.id, active: true,
      options: { inbound: { adapter: 'null', options: {} }, outbound: { adapter: 'smtp', options: {host: 'alpha-smtp', port: 2525, enable_starttls_auto: false, domain: domain} } },
      preferences: {alpha_simulation: marker, previous_email_address_id: previous}, created_by_id: 1, updated_by_id: 1)
    address = EmailAddress.create!(name: 'Alpha Mail', email: address_email, channel_id: channel.id, created_by_id: 1, updated_by_id: 1)
    group.update!(email_address_id: address.id, updated_by_id: 1)
    result = {channelId: channel.id, emailAddressId: address.id, email: address.email, groupId: group.id, previousEmailAddressId: previous, ownerNamespace: run_id}
  end
  puts JSON.generate(result)
elsif action == 'command-agent-email-setup' || action == 'command-agent-email-restore'
  agent_id = Integer(input.fetch('agentId'))
  group_id = Integer(input.fetch('targetGroupId'))
  original_email = input.fetch('originalEmail')
  target_email = input.fetch('targetEmail')
  raise 'command identity email shape' unless [original_email, target_email].all? { |email| email.is_a?(String) && email.match?(/\A[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+\z/) } && original_email != target_email
  result = nil
  User.transaction do
    agent = User.lock.find(agent_id)
    group = Group.lock.find(group_id)
    raise 'command identity actor or group changed' unless agent.active? && agent.permissions?('ticket.agent') && !agent.permissions?('admin') && group.active? && agent.group_ids_access('full').map(&:to_i).include?(group.id)
    expected = action == 'command-agent-email-setup' ? original_email : target_email
    raise 'command identity preimage changed' unless agent.email == expected || (action == 'command-agent-email-restore' && agent.email == original_email)
    destination = action == 'command-agent-email-setup' ? target_email : original_email
    raise 'command identity email collision' if User.where('LOWER(email) = ?', destination.downcase).where.not(id: agent.id).exists?
    UserInfo.with_user_id(1) { agent.update!(email: destination) } unless agent.email == destination
    agent.reload
    raise 'command identity restoration or permission drift' unless agent.email == destination && agent.active? && agent.permissions?('ticket.agent') && !agent.permissions?('admin') && agent.group_ids_access('full').map(&:to_i).include?(group.id)
    result = {agentId: agent.id, groupId: group.id, originalSha256: Digest::SHA256.hexdigest(original_email), targetSha256: Digest::SHA256.hexdigest(target_email), adjusted: action == 'command-agent-email-setup', restored: action == 'command-agent-email-restore'}
  end
  puts JSON.generate(result)
elsif action == 'readback'
  channel = Channel.find(input.fetch('channelId'))
  raise 'ownership mismatch' unless channel.preferences[:alpha_simulation] == marker
  puts JSON.generate({channelId: channel.id, groupId: channel.group_id, active: channel.active, inboundAdapter: channel.options.dig(:inbound,:adapter), outbound: channel.options.dig(:outbound), emailAddressId: channel.group.email_address_id, statusOut: channel.status_out})
elsif action == 'restore'
  raise 'drain receipt required' unless input['ownedJobsDrained'] == true && input['uncertainOutcomesReconciled'] == true
  Channel.transaction do
    channel = Channel.lock.find(input.fetch('channelId'))
    raise 'ownership mismatch' unless channel.preferences[:alpha_simulation] == marker
    address = EmailAddress.find(input.fetch('emailAddressId'))
    raise 'address mismatch' unless address.channel_id == channel.id
    group = Group.lock.find(channel.group_id)
    raise 'group changed since fixture' unless group.email_address_id == address.id
    group.update!(email_address_id: channel.preferences[:previous_email_address_id], updated_by_id: 1)
    channel.update!(active: false, updated_by_id: 1)
    # Retain channel/address to preserve native ticket provenance. No deletion.
    puts JSON.generate({restored: true, channelId: channel.id, active: channel.active, groupId: group.id, emailAddressId: group.email_address_id})
  end
else
  raise 'unsupported action'
end
