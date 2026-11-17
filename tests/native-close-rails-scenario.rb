# Actual native Rails/controller regression; Wasalx::Client boundary is simulated.
# Only main may run in an admitted synthetic fixture without background workers.
native_close_proof = lambda do |owner:, customer:, group:, service_token:, namespace:|
  require 'action_dispatch/testing/integration'
  require 'uri'
  raise 'Native queue adapter mismatch' unless ActiveJob::Base.queue_adapter.class.name == 'ActiveJob::QueueAdapters::DelayedJobAdapter'
  raise 'Native actor/group mismatch' unless owner.permissions?('ticket.agent') && owner.group_ids_access('read').map(&:to_i).include?(group.id)
  raise 'Native fixture namespace missing' if namespace.to_s.empty?
  original_get = Wasalx::Client.method(:get)
  original_post = Wasalx::Client.method(:post)
  original_enqueue = WasalxTicketStateJob.method(:perform_later)
  prior_job_ids = Delayed::Job.pluck(:id)
  captured = []
  admissions = []
  callbacks = []
  owned_tickets = []
  owned_articles = []
  callback_state = 'BLOCKED_EFFECTS'
  reject_preflight = false
  closed = Ticket::State.by_category(:closed).first || raise('Native closed state absent')
  agent_sender = Ticket::Article::Sender.find_by!(name: 'Agent')
  wasalx_type = Ticket::Article::Type.find_by!(name: 'wasalx group message')
  session = ActionDispatch::Integration::Session.new(Rails.application)
  session.host!(Setting.get('fqdn'))
  headers = { 'Authorization' => "Token token=#{service_token}", 'User-Agent' => 'WasalX-native-close-regression' }
  hold = lambda do |payload|
    begin
      WasalxTicketStateJob.new.perform(payload)
      raise 'Native close unexpectedly bypassed pending effects'
    rescue Wasalx::Client::TemporaryRequestFailed
      true
    end
  end
  make_ticket = lambda do |suffix|
    UserInfo.with_user_id(owner.id) do
      t = Ticket.create!(title: "#{namespace}-#{suffix}", group: group, customer: customer,
                         created_by: owner, updated_by: owner)
      t.update!(wasalx_connection_id: '00000000-0000-4000-8000-000000000011',
                wasalx_group_id: "#{namespace}@g.us", wasalx_provider: 'WAHA')
      owned_tickets << t.id
      t
    end
  end
  make_article = lambda do |t, preferences = {}|
    UserInfo.with_user_id(owner.id) do
      a = Ticket::Article.create!(ticket: t, sender: agent_sender, type: wasalx_type,
           internal: false, content_type: 'text/plain', body: namespace,
           preferences: preferences, created_by: owner, updated_by: owner)
      owned_articles << a.id
      a
    end
  end
  close_payload = lambda do |ticket_id|
    rows = captured.select { |row| row[:payload]['ticket_id'].to_i == ticket_id && row[:payload]['state_id'].to_i == closed.id }
    raise 'Native closed callback count mismatch' unless rows.length == 1
    rows.first[:payload]
  end
  WasalxTicketStateJob.define_singleton_method(:perform_later) do |payload|
    job = original_enqueue.call(payload)
    raise 'Native close job not durable' if job.provider_job_id.to_s.empty?
    captured << { payload: payload.deep_dup, native_job_id: job.provider_job_id.to_i }
    job
  end
  Wasalx::Client.define_singleton_method(:get) do |path, scope:, actor: nil|
    raise Wasalx::Client::PermanentRequestFailed, 'Controlled preflight rejection' if reject_preflight
    uri = URI.parse(path)
    query = URI.decode_www_form(uri.query.to_s).to_h
    raise 'Unexpected native GET' unless uri.path == '/internal/v1/zammad/outbound/preflight' && scope == 'zammad:outbound'
    raise 'Native GET actor mismatch' unless actor && actor[:user_id].to_i == owner.id
    raise 'Native GET ticket mismatch' unless owned_tickets.include?(query['ticket_id'].to_i)
    raise 'Native GET connection/group mismatch' unless query['connection_id'] == '00000000-0000-4000-8000-000000000011' && query['group_id'] == "#{namespace}@g.us"
    { 'available' => true }
  end
  Wasalx::Client.define_singleton_method(:post) do |path, payload, scope:, actor: nil|
    raise 'Native POST ticket mismatch' unless owned_tickets.include?(payload[:ticket_id].to_i)
    if path == '/internal/v1/zammad/outbound'
      raise 'Native outbound actor/scope mismatch' unless scope == 'zammad:outbound' && actor && actor[:user_id].to_i == owner.id
      raise 'Native outbound tenant mismatch' unless payload[:tenant_id] == ENV.fetch('WASALX_TENANT_ID')
      admissions << payload.deep_dup
      { 'id' => "71000000-0000-4000-8000-#{format('%012d', payload.fetch(:article_id))}", 'state' => 'QUEUED' }
    elsif path == '/internal/v1/zammad/ticket-state'
      raise 'Native callback scope mismatch' unless scope == 'zammad:ticket-state'
      raise 'Native barrier leaked to API' if payload.key?(:pending_article_ids) || payload.key?('pending_article_ids')
      callbacks << payload.deep_dup
      { 'state' => callback_state }
    else
      raise 'Unexpected native POST'
    end
  end
  begin
    orders = %w[close-first reply-first].map do |order|
      t = make_ticket.call(order)
      before_articles = Ticket::Article.where(ticket_id: t.id).pluck(:id)
      session.put("/api/v1/tickets/#{t.id}", params: { state_id: closed.id,
        article: { body: "#{namespace}-#{order}", type: wasalx_type.name, sender: 'Agent',
                   internal: false, content_type: 'text/plain' } }, headers: headers, as: :json)
      raise 'Native same-save PUT failed; no replay' unless session.response.status == 200
      ids = Ticket::Article.where(ticket_id: t.id).pluck(:id) - before_articles
      raise 'Native same-save article count mismatch' unless ids.length == 1
      a = Ticket::Article.find(ids.first)
      owned_articles << a.id
      payload = close_payload.call(t.id).deep_dup
      raise 'Native same-save article missing from barrier' unless payload.fetch('pending_article_ids') == [a.id]
      communication_jobs = (Delayed::Job.pluck(:id) - prior_job_ids).filter_map do |id|
        data = Delayed::Job.find(id).payload_object.instance_variable_get(:@job_data)
        id if data && data['job_class'] == 'CommunicateWasalxJob' && data.fetch('arguments').first == a.id
      end
      raise 'Native same-save communication not durable' unless communication_jobs.length == 1
      immutable_payload = payload.deep_dup
      admitted_before = admissions.length
      callbacks_before = callbacks.length
      if order == 'close-first'
        hold.call(payload)
        raise 'Native close dispatched before admission' unless callbacks.length == callbacks_before && admissions.length == admitted_before
      end
      CommunicateWasalxJob.new.perform(a.id)
      raise 'Native article admission not persisted' if a.reload.preferences['wasalx_delivery_id'].to_s.empty?
      raise 'Native admission count mismatch' unless admissions.length == admitted_before + 1
      callback_state = 'BLOCKED_EFFECTS'
      2.times { hold.call(payload) }
      raise 'Native unknown/pending hold replayed output' unless admissions.length == admitted_before + 1
      retry_before = Delayed::Job.pluck(:id)
      WasalxTicketStateJob.perform_now(payload)
      retry_ids = Delayed::Job.pluck(:id) - retry_before
      retry_rows = retry_ids.map { |id| Delayed::Job.find(id) }.select do |row|
        data = row.payload_object.instance_variable_get(:@job_data)
        data && data['job_class'] == 'WasalxTicketStateJob'
      end
      raise 'Native held callback retry count mismatch' unless retry_rows.length == 1
      data = retry_rows.first.payload_object.instance_variable_get(:@job_data)
      arguments = data.fetch('arguments').first.except('_aj_symbol_keys', '_aj_ruby2_keywords')
      raise 'Native retry changed original payload' unless arguments == immutable_payload && data.fetch('executions') == 1
      raise 'Native retry is not bounded' unless retry_rows.first.run_at > Time.current && retry_rows.first.run_at <= 16.minutes.from_now
      callback_state = 'APPLIED'
      WasalxTicketStateJob.new.perform(payload)
      WasalxTicketStateJob.new.perform(payload)
      CommunicateWasalxJob.new.perform(a.id)
      raise 'Native duplicate communication replayed output' unless admissions.length == admitted_before + 1
      expected_callback = immutable_payload.transform_keys(&:to_sym).except(:pending_article_ids)
      raise 'Native retry changed captured close timestamp/key' unless callbacks.drop(callbacks_before).all? { |row| row == expected_callback }
      raise 'Native callback mutated its input' unless payload == immutable_payload
      { order: order, ticket_id: t.id, article_id: a.id, original_time: payload['transitioned_at'],
        original_key: payload['idempotency_key'], retry_job_id: retry_rows.first.id, admission_count: 1 }
    end
    nested_ticket = make_ticket.call('nested-rollback')
    nested_before = captured.length
    outer_transition_time = nil
    UserInfo.with_user_id(owner.id) do
      ActiveRecord::Base.transaction do
        ActiveRecord::Base.transaction(requires_new: true) do
          nested_ticket.update!(state: closed)
          raise ActiveRecord::Rollback
        end
        nested_ticket.reload.update!(state: closed)
        outer_transition_time = nested_ticket.updated_at.utc.iso8601(6)
      end
    end
    raise 'Native nested rollback leaked callback' unless captured.length == nested_before + 1 &&
      close_payload.call(nested_ticket.id).fetch('transitioned_at') == outer_transition_time
    reopened_ticket = make_ticket.call('closed-then-reopened')
    open_state = Ticket::State.find_by!(default_follow_up: true)
    UserInfo.with_user_id(owner.id) do
      ActiveRecord::Base.transaction do
        reopened_ticket.update!(state: closed)
        Ticket.find(reopened_ticket.id).update!(state: open_state)
      end
    end
    reopened_payloads = captured.select { |row| row[:payload]['ticket_id'].to_i == reopened_ticket.id }
    raise 'Native superseded close emitted callback' unless reopened_payloads.length == 1 &&
      reopened_payloads.first[:payload]['state_id'].to_i == open_state.id
    cycle_ticket = make_ticket.call('close-reopen-close')
    cycle_close_times = []
    UserInfo.with_user_id(owner.id) do
      ActiveRecord::Base.transaction do
        cycle_ticket.update!(state: closed)
        cycle_close_times << cycle_ticket.updated_at.utc.iso8601(6)
        Ticket.find(cycle_ticket.id).update!(state: open_state)
        final_cycle = Ticket.find(cycle_ticket.id)
        final_cycle.update!(state: closed)
        cycle_close_times << final_cycle.updated_at.utc.iso8601(6)
      end
    end
    cycle_payloads = captured.select { |row| row[:payload]['ticket_id'].to_i == cycle_ticket.id }
    final_cycle_time = cycle_close_times.last
    final_cycle_key = "ticket-state:#{cycle_ticket.id}:#{closed.id}:#{final_cycle_time}"
    raise 'Native final state cycle callback invalid' unless cycle_payloads.length.between?(1, 2) &&
      cycle_payloads.any? { |row| row[:payload]['transitioned_at'] == final_cycle_time && row[:payload]['idempotency_key'] == final_cycle_key } &&
      cycle_payloads.all? { |row|
      row[:payload]['state_id'].to_i == closed.id && cycle_close_times.include?(row[:payload]['transitioned_at'])
    }
    imported_ticket = make_ticket.call('imported')
    old_import = Setting.get('import_mode')
    begin
      Setting.set('import_mode', true)
      imported = make_article.call(imported_ticket)
    ensure
      Setting.set('import_mode', old_import)
    end
    raise 'Native imported marker absent' unless imported.reload.preferences['wasalx_imported'] == true
    imported_jobs = (Delayed::Job.pluck(:id) - prior_job_ids).filter_map do |id|
      data = Delayed::Job.find(id).payload_object.instance_variable_get(:@job_data)
      id if data && data['job_class'] == 'CommunicateWasalxJob' && data.fetch('arguments').first == imported.id
    end
    raise 'Native import enqueued communication' unless imported_jobs.empty?
    UserInfo.with_user_id(owner.id) { imported_ticket.update!(state: closed) }
    raise 'Native imported article held closure' unless close_payload.call(imported_ticket.id).fetch('pending_article_ids').empty?
    forged_ticket = make_ticket.call('forged')
    forged = make_article.call(forged_ticket, 'wasalx_imported' => true)
    raise 'Native article trusted forged import marker' if forged.reload.preferences['wasalx_imported'] == true
    UserInfo.with_user_id(owner.id) { forged_ticket.update!(state: closed) }
    raise 'Native forged article escaped barrier' unless close_payload.call(forged_ticket.id).fetch('pending_article_ids') == [forged.id]
    rollback_ticket = make_ticket.call('rollback')
    rollback_state = rollback_ticket.state_id
    rollback_articles = Ticket::Article.where(ticket_id: rollback_ticket.id).pluck(:id)
    rollback_captured = captured.length
    reject_preflight = true
    session.put("/api/v1/tickets/#{rollback_ticket.id}", params: { state_id: closed.id,
      article: { body: namespace, type: wasalx_type.name, sender: 'Agent', internal: false,
                 content_type: 'text/plain' } }, headers: headers, as: :json)
    raise 'Native rejected same-save unexpectedly succeeded' if session.response.status.between?(200, 299)
    raise 'Native rejected same-save partly committed' unless rollback_ticket.reload.state_id == rollback_state &&
      Ticket::Article.where(ticket_id: rollback_ticket.id).pluck(:id) == rollback_articles && captured.length == rollback_captured
    { mode: 'actual-native-rails-simulated-client', orders: orders, imported_exclusion: true,
      forged_marker_rejected: true, same_save_rollback: true, nested_rollback: true,
      superseded_close_dropped: true, final_state_cycle: true, ticket_ids: owned_tickets,
      article_ids: owned_articles, new_job_ids: Delayed::Job.pluck(:id) - prior_job_ids,
      historical_jobs_preserved: (prior_job_ids - Delayed::Job.pluck(:id)).empty? }
  ensure
    Wasalx::Client.define_singleton_method(:get, original_get)
    Wasalx::Client.define_singleton_method(:post, original_post)
    WasalxTicketStateJob.define_singleton_method(:perform_later, original_enqueue)
  end
end

# Actual installed Rails/article transaction and package services. Only the
# signed Wasalx::Client admission boundary is simulated; no provider is called.
native_direct_keep_open_proof = lambda do |owner:, customer:, group:, namespace:|
  require 'securerandom'
  require 'time'
  raise 'Native direct actor permission missing' unless owner.active && owner.permissions?('ticket.agent') && owner.group_ids_access('full').map(&:to_i).include?(group.id)
  original_get, original_post = Wasalx::Client.method(:get), Wasalx::Client.method(:post)
  prior_job_ids = Delayed::Job.pluck(:id)
  owned_tickets, owned_articles, intents, callbacks = [], [], [], []
  snapshot = nil
  ticket = UserInfo.with_user_id(owner.id) do
    row = Ticket.create!(title: "#{namespace}-direct-keep-open", group: group, customer: customer, created_by: owner, updated_by: owner)
    owned_tickets << row.id
    row.update!(wasalx_connection_id: '00000000-0000-4000-8000-000000000011', wasalx_group_id: "#{namespace}@c.us", wasalx_provider: 'WAHA', wasalx_bot_conversation: 'true', wasalx_bot_state: 'HUMAN')
    raise 'Native direct marker did not persist' unless row.reload.wasalx_bot_conversation == 'true'
    row
  end
  Wasalx::Client.define_singleton_method(:get) do |path, scope:, actor: nil|
    if path.start_with?('/internal/v1/zammad/outbound/preflight?')
      { 'keep_open' => true }
    elsif path.start_with?('/internal/v1/zammad/direct-customer-closes/')
      raise 'Missing direct close test snapshot' unless snapshot
      snapshot.deep_dup
    else
      raise 'Unexpected native direct qualification GET'
    end
  end
  Wasalx::Client.define_singleton_method(:post) do |path, payload, scope:, actor: nil|
    if path == '/internal/v1/zammad/outbound/native-intent'
      raise 'Reply intent outside actual article transaction' unless Ticket.current_transaction.open?
      # On a second connection NOWAIT must observe the actual same ticket row
      # lock, including a standalone article-create transaction.
      result = Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do |connection|
          begin
            connection.transaction(requires_new: true) { connection.exec_query("SELECT id FROM tickets WHERE id=#{Integer(ticket.id)} FOR UPDATE NOWAIT") }
            :unlocked
          rescue ActiveRecord::StatementInvalid => error
            raise unless error.cause.is_a?(PG::LockNotAvailable)
            :locked
          end
        end
      end.value
      raise 'Standalone article did not retain native ticket lock' unless result == :locked
      intents << payload.deep_dup
      { 'id' => payload.fetch(:operation_id), 'human_ownership_epoch' => 3 }
    elsif path == '/internal/v1/zammad/ticket-state'
      # Capture the actual HTTP JSON shape, including nested receipt keys.
      callbacks << JSON.parse(payload.to_json)
      { 'state' => 'APPLIED' }
    else
      raise 'Unexpected native direct qualification POST'
    end
  end
  make_reply = lambda do
    UserInfo.with_user_id(owner.id) do
      row = Ticket::Article.create!(ticket: ticket, sender: Ticket::Article::Sender.find_by!(name: 'Agent'),
        type: Ticket::Article::Type.find_by!(name: 'wasalx group message'), internal: false,
        content_type: 'text/plain', body: "#{namespace}-reply", created_by: owner, updated_by: owner,
        preferences: { 'wasalx_native_reply_intent_id' => 'untrusted' })
      owned_articles << row.id
      row
    end
  end
  committed = make_reply.call
  raise 'Committed reply marker not source-owned' unless committed.preferences['wasalx_native_reply_intent_id'] == intents.last.fetch(:operation_id)
  raise 'Committed communication job absent' unless Delayed::Job.where.not(id: prior_job_ids).any? { |job| job.handler.include?('CommunicateWasalxJob') }
  before_articles = Ticket::Article.where(ticket_id: ticket.id).pluck(:id)
  before_jobs = Delayed::Job.pluck(:id)
  Ticket::Article.transaction do
    make_reply.call
    raise ActiveRecord::Rollback
  end
  raise 'Article rollback leaked row' unless Ticket::Article.where(ticket_id: ticket.id).pluck(:id) == before_articles
  raise 'Article rollback leaked communication job' unless Delayed::Job.pluck(:id) == before_jobs
  raise 'Rollback lost durable app reservation observation' unless intents.length == 2
  # Mark only this owned simulated article admitted; no communicate/provider job
  # is run. Customer close must then commit its exact System receipt and callback.
  committed.reload.update!(preferences: committed.preferences.merge('wasalx_delivery_id' => SecureRandom.uuid, 'wasalx_delivery_state' => 'SENT'))
  ticket.reload
  snapshot = { 'tenant_id' => ENV.fetch('WASALX_TENANT_ID'), 'instance_id' => ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID'),
    'command_id' => SecureRandom.uuid, 'ticket_id' => ticket.id.to_s, 'customer_id' => customer.id.to_s,
    'request_sha256' => 'a' * 64, 'native_action_state' => 'ATTEMPTED', 'effects_clear' => true,
    'connection_id' => ticket.wasalx_connection_id, 'external_chat_id' => ticket.wasalx_group_id, 'native_group_id' => group.id.to_s,
    'human_ownership_epoch' => 3, 'conversation_fencing_token' => 11,
    'expected_native_updated_at' => ticket.updated_at.utc.iso8601(6), 'expected_native_state_id' => ticket.state_id.to_s,
    'expected_native_article_id' => Ticket::Article.where(ticket_id: ticket.id).maximum(:id).to_s }
  close = Service::Ticket::WasalxCustomerClose.new(ticket: ticket, command_id: snapshot.fetch('command_id'), current_user: owner)
  result = close.execute
  raise 'Customer close receipt absent' unless result.fetch('state') == 'SUCCEEDED' && result.fetch('customer_id') == customer.id.to_s
  closed_jobs = Delayed::Job.where.not(id: before_jobs).select { |job| job.handler.include?('WasalxTicketStateJob') }
  raise 'Customer close callback job absent' if closed_jobs.empty?
  # Invoke only exact owned callback jobs; never drain the fixture queue.
  closed_jobs.each { |job| job.payload_object.perform }
  proof = callbacks.find { |payload| payload['customer_close_receipt']&.fetch('command_id') == snapshot.fetch('command_id') }
  raise 'Native callback lacks exact customer confirmation receipt' unless proof && proof.fetch('customer_close_receipt') == result
  snapshot['native_action_state'] = 'OUTCOME_UNKNOWN'
  before_count = Ticket::Article.where(ticket_id: ticket.id).count
  raise 'Customer close duplicate receipt changed' unless close.execute == result && close.reconcile == result
  raise 'Customer close duplicate created article' unless Ticket::Article.where(ticket_id: ticket.id).count == before_count
  { standaloneReplyLock: true, articleRollback: true, durableIntentObservation: true, customerCloseReceipt: true,
    customerCallbackReceipt: true, unknownReceiptNoReplay: true, tickets: owned_tickets, articles: owned_articles,
    ownedJobIds: Delayed::Job.pluck(:id) - prior_job_ids, priorJobIds: prior_job_ids, providerActions: 0 }
ensure
  Wasalx::Client.define_singleton_method(:get, original_get) if original_get
  Wasalx::Client.define_singleton_method(:post, original_post) if original_post
end


# Actual native model/controller proof; only the signed application boundary is
# simulated. No queue drain, callback execution or provider request is permitted.
native_denied_command_proof = lambda do |owner:, customer:, group:, service_token:, namespace:|
  require 'action_dispatch/testing/integration'
  require 'securerandom'
  require 'digest'
  raise 'Denied command service actor unavailable' unless owner.active && owner.permissions?('admin.system')
  raise 'Denied command namespace unavailable' if namespace.to_s.empty?
  raise 'Native queue adapter mismatch' unless ActiveJob::Base.queue_adapter.class.name == 'ActiveJob::QueueAdapters::DelayedJobAdapter'
  original_get, original_post = Wasalx::Client.method(:get), Wasalx::Client.method(:post)
  metadata = lambda do |ids|
    Delayed::Job.where(id: ids).order(:id).map do |job|
      job.attributes.slice('id', 'priority', 'attempts', 'run_at', 'locked_at', 'locked_by', 'failed_at', 'queue').merge(
        'handler_sha256' => Digest::SHA256.hexdigest(job.handler),
        'last_error_sha256' => job.last_error.nil? ? nil : Digest::SHA256.hexdigest(job.last_error))
    end
  end
  prior_ids = Delayed::Job.order(:id).pluck(:id)
  prior_metadata = metadata.call(prior_ids)
  snapshots, tickets, receipts = {}, [], []
  state_fields = %w[state_id owner_id group_id wasalx_correlation_status]
  session = ActionDispatch::Integration::Session.new(Rails.application)
  session.host!(Setting.get('fqdn'))
  headers = { 'Authorization' => "Token token=#{service_token}", 'User-Agent' => 'WasalX-denied-command-regression' }
  Wasalx::Client.define_singleton_method(:get) do |path, scope:, actor: nil|
    execution = path.match(%r{\A/internal/v1/zammad/quoted-commands/([0-9a-f-]+)\?denied_transcript=v1\z})&.captures&.first
    raise 'Unexpected denied transcript GET' unless execution && snapshots.key?(execution) && scope == 'zammad:ticket-state'
    JSON.parse(snapshots.fetch(execution).to_json)
  end
  Wasalx::Client.define_singleton_method(:post) { |*_args, **_kwargs| raise 'Denied transcript dispatched a callback or provider effect' }
  %w[new open closed].each do |state_name|
    title = "#{namespace}-denied-#{state_name}"
    raise 'Consumed denied fixture namespace' if Ticket.exists?(title: title)
    ticket = UserInfo.with_user_id(owner.id) do
      row = Ticket.create!(title: title, group: group, customer: customer,
        state: Ticket::State.find_by!(name: state_name), created_by: owner, updated_by: owner)
      row.update!(wasalx_connection_id: '00000000-0000-4000-8000-000000000011',
        wasalx_group_id: "#{namespace}@g.us", wasalx_provider: 'WAHA')
      row.reload
    end
    tickets << ticket.id
    baseline = ticket.attributes.slice(*state_fields)
    articles = Ticket::Article.where(ticket_id: ticket.id).order(:id).pluck(:id)
    jobs = Delayed::Job.pluck(:id)
    execution = SecureRandom.uuid
    snapshots[execution] = {
      'tenant_id' => ENV.fetch('WASALX_TENANT_ID'), 'instance_id' => ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID'),
      'execution_id' => execution, 'ticket_id' => ticket.id.to_s, 'request_sha256' => Digest::SHA256.hexdigest(execution),
      'native_action_state' => 'ATTEMPTED', 'effects_clear' => true,
      'disposition' => 'TRANSCRIPT_ONLY_DENIED', 'denied_transcript' => 'v1', 'command_authorized' => false,
      'permission' => 'AGENTS', 'plan' => { 'effects' => [] }, 'command_text' => '/close',
      'connection_id' => ticket.wasalx_connection_id, 'external_group_id' => ticket.wasalx_group_id,
      'native_group_id' => group.id.to_s, 'message_id' => "#{namespace}-#{state_name}-command",
      'quoted_message_id' => "#{namespace}-#{state_name}-quote", 'participant_id' => '000000000000@lid',
      'expected_native_updated_at' => ticket.updated_at.utc.iso8601(6), 'expected_native_state_id' => ticket.state_id.to_s,
      'expected_native_article_id' => Ticket::Article.where(ticket_id: ticket.id).maximum(:id).to_s
    }
    path = "/api/v1/wasalx/tickets/#{ticket.id}/quoted-commands/#{execution}"
    session.post(path, headers: headers, as: :json)
    raise "Denied #{state_name} controller failed: #{session.response.status}" unless session.response.status == 200
    result = JSON.parse(session.response.body)
    raise 'Denied receipt disposition changed' unless result.slice('state', 'disposition', 'outcome') ==
      { 'state' => 'SUCCEEDED', 'disposition' => 'TRANSCRIPT_ONLY_DENIED', 'outcome' => 'REJECTED' }
    raise 'Denied receipt binding changed' unless result['execution_id'] == execution && result['ticket_id'] == ticket.id.to_s &&
      result['request_sha256'] == snapshots.fetch(execution).fetch('request_sha256') && result['recorded_at'] && !result.key?('closed_at')
    new_ids = Ticket::Article.where(ticket_id: ticket.id).order(:id).pluck(:id) - articles
    raise 'Denied transcript article cardinality changed' unless new_ids == [result.fetch('article_id').to_i]
    article = Ticket::Article.find(new_ids.first)
    expected_body = "/close\n\nRejected: only tenant agents may close this ticket.\nتم الرفض: يمكن لموظفي المستأجر فقط إغلاق هذه التذكرة."
    raise 'Denied transcript body/type changed' unless article.internal && article.sender.name == 'System' && article.type.name == 'note' && article.body == expected_body
    raise 'Denied receipt key changed' unless article.wasalx_operation_key == "ticket-command:#{execution}"
    preferences = article.preferences
    { 'wasalx_command_execution_id' => execution, 'wasalx_command_disposition' => 'TRANSCRIPT_ONLY_DENIED',
      'wasalx_external_message_id' => snapshots[execution]['message_id'], 'wasalx_quoted_external_message_id' => snapshots[execution]['quoted_message_id'],
      'wasalx_participant_id' => snapshots[execution]['participant_id'], 'wasalx_command_request_sha256' => snapshots[execution]['request_sha256'] }.each do |key, value|
      raise 'Denied source preference changed' unless preferences[key] == value
    end
    raise 'Denied note masquerades as successful close' if preferences.key?('wasalx_command_closed_at')
    raise 'Denied note changed ticket state/ownership' unless ticket.reload.attributes.slice(*state_fields) == baseline
    new_jobs = Delayed::Job.where.not(id: jobs).to_a
    raise 'Denied note queued communication or state callback' if new_jobs.any? { |job| job.handler.include?('CommunicateWasalxJob') || job.handler.include?('WasalxTicketStateJob') }
    if state_name == 'closed'
      count, job_ids = Ticket::Article.where(ticket_id: ticket.id).count, Delayed::Job.order(:id).pluck(:id)
      session.post(path, headers: headers, as: :json)
      raise 'Denied duplicate POST changed receipt' unless session.response.status == 200 && JSON.parse(session.response.body) == result
      snapshots[execution]['native_action_state'] = 'OUTCOME_UNKNOWN'
      session.get(path, headers: headers)
      raise 'Denied UNKNOWN GET changed receipt' unless session.response.status == 200 && JSON.parse(session.response.body) == result
      raise 'Denied recovery created article/job' unless Ticket::Article.where(ticket_id: ticket.id).count == count && Delayed::Job.order(:id).pluck(:id) == job_ids
      missing = SecureRandom.uuid
      snapshots[missing] = snapshots[execution].merge('execution_id' => missing, 'request_sha256' => Digest::SHA256.hexdigest(missing))
      session.get("/api/v1/wasalx/tickets/#{ticket.id}/quoted-commands/#{missing}", headers: headers)
      raise 'UNKNOWN absent receipt was fabricated' unless session.response.status == 200 && JSON.parse(session.response.body) == { 'state' => 'NO_RECEIPT', 'execution_id' => missing }
      raise 'UNKNOWN absent receipt mutated native state' unless ticket.reload.attributes.slice(*state_fields) == baseline &&
        Ticket::Article.where(ticket_id: ticket.id).count == count && Delayed::Job.order(:id).pluck(:id) == job_ids
      invalid = SecureRandom.uuid
      snapshots[invalid] = snapshots[execution].merge('execution_id' => invalid, 'disposition' => 'UNKNOWN')
      rejected = false
      begin
        Service::Ticket::WasalxQuotedCommand.new(ticket: ticket, execution_id: invalid, current_user: owner).reconcile
      rescue ArgumentError
        rejected = true
      end
      raise 'Unknown disposition was admitted' unless rejected
      raise 'Unknown disposition mutated native state' unless ticket.reload.attributes.slice(*state_fields) == baseline &&
        Ticket::Article.where(ticket_id: ticket.id).count == count && Delayed::Job.order(:id).pluck(:id) == job_ids
    end
    receipts << { state: state_name, ticketId: ticket.id.to_s, articleId: result.fetch('article_id') }
  end
  raise 'Denied proof changed retained job metadata' unless metadata.call(prior_ids) == prior_metadata
  { mode: 'actual-native-rails-simulated-client', states: receipts.map { |row| row[:state] }, receipts: receipts,
    stateOwnershipPreserved: true, duplicateReceipt: true, unknownReadOnly: true,
    noCommunicationOrStateCallbacks: true, historicalJobsPreserved: true, providerActions: 0 }
ensure
  Wasalx::Client.define_singleton_method(:get, original_get) if original_get
  Wasalx::Client.define_singleton_method(:post, original_post) if original_post
end
