# Finite READ ONLY mail observer; no cache, NotificationFactory call, authentication or job execution.
require 'digest'
require 'psych'
require 'time'
def email_canonical(value)
  case value
  when Hash then value.keys.map(&:to_s).sort.to_h{|k|[k,email_canonical(value.key?(k) ? value[k] : value[k.to_sym])]}
  when Array then value.map{|v|email_canonical(v)}
  else value
  end
end
def email_sha(value); Digest::SHA256.hexdigest(JSON.generate(email_canonical(value))); end
def email_job_metadata(raw)
  prefix="--- !ruby/object:ActiveJob::QueueAdapters::DelayedJobAdapter::JobWrapper"
  raise 'wrapper' unless raw.is_a?(String)&&raw.bytesize<=1_000_000&&raw.start_with?(prefix+"\n")
  yaml=raw.sub(/\A#{Regexp.escape(prefix)}(?=\n)/,'---');tree=Psych.parse_stream(yaml);raise 'documents' unless tree.children.size==1
  visit=lambda do |n|
    raise 'tag' if n.is_a?(Psych::Nodes::Alias)||(n.respond_to?(:tag)&&n.tag)||(n.respond_to?(:anchor)&&n.anchor)
    if n.is_a?(Psych::Nodes::Mapping)
      keys=n.children.each_slice(2).map{|k,_|raise('key') unless k.is_a?(Psych::Nodes::Scalar);k.value};raise 'duplicate' unless keys.uniq.size==keys.size
    end
    (n.children||[]).each{|c|visit.call(c)} if n.respond_to?(:children)
  end
  visit.call(tree);data=Psych.safe_load(yaml,permitted_classes:[],permitted_symbols:[],aliases:false)
  raise 'shape' unless data.is_a?(Hash)&&data.keys==['job_data']&&data['job_data'].is_a?(Hash)
  job=data['job_data'];raise 'arguments' unless job['arguments'].is_a?(Array);raise 'class' unless job['job_class'].is_a?(String)&&job['job_class'].match?(/\A[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*\z/)
  {parsed:true,jobClass:job['job_class'],argumentsSha256:email_sha(job['arguments'])}
rescue StandardError
  {parsed:false,jobClass:'UNKNOWN'}
end
# Same installed remaining-days value without User's expiry reset/save! side effect.
def email_mail_blocked_days(preferences, today:)
  return 0 if !preferences[:mail_delivery_failed] || preferences[:mail_delivery_failed_data].blank?
  remaining = (preferences[:mail_delivery_failed_data].to_date - today).to_i + 61
  [remaining, 0].max
end
def email_plain_owned_sink?(channel, domain:)
  raise 'owned_domain' unless domain.is_a?(String) && domain.match?(/\A[A-Za-z0-9.-]+\z/)
  base={'host'=>'alpha-smtp','port'=>2525,'enable_starttls_auto'=>false}
  channel.active && channel.options.dig(:outbound,:adapter)=='smtp' &&
    [base,base.merge('domain'=>domain)].include?(email_canonical(channel.options.dig(:outbound,:options)))
end
def observe_email_effects(input)
  raise 'mode' unless input['isolated']==true&&input['evidenceMode']=='simulated'
  namespace=input.fetch('namespace');raise 'namespace' unless namespace.match?(/\A[A-Za-z0-9-]{1,50}\z/)
  owner_namespace=input['ownerRunId'] || namespace;raise 'owner namespace' unless owner_namespace.match?(/\A[A-Za-z0-9-]{1,50}\z/)
  gid=Integer(input.fetch('groupId'));raise 'group' unless [1,2].include?(gid)
  result=nil
  ActiveRecord::Base.transaction do
    ActiveRecord::Base.connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    channel=input['channelId'] ? Channel.find(input['channelId']) : nil;group=Group.find(gid)
    raise 'channel' if channel && !(channel.area=='Email::Account'&&channel.group_id==gid&&channel.preferences[:alpha_simulation]=="alpha-mail-#{owner_namespace}")
    raise 'address' if channel && group.email_address&.channel_id!=channel.id
    plain=lambda do |c|
      sender=c.area=='Email::Notification' ? Setting.get('notification_sender') : c.group.email_address.email
      domain=Channel::Driver::Smtp.new.prepare_options_get_fqdn(from:sender)
      email_plain_owned_sink?(c,domain:domain)
    end
    candidates=Ticket.where(group_id:gid).order(:id);raise 'ticket_bound' if candidates.count>100
    tickets=channel ? candidates.select{|t|t.preferences[:channel_id].to_i==channel.id} : [];raise 'owned_ticket_bound' if tickets.size>20
    ids=tickets.map(&:id);articles=Ticket::Article.where(ticket_id:ids).order(:id);raise 'article_bound' if articles.count>200
    agents=User.order(:id).select{|u|u.roles.any?{|r|r.name=='Agent'}};raise 'user_bound' if agents.size>20
    users=agents.map{|u|{id:u.id,roles:u.roles.pluck(:id).sort,active:u.active?,agent:true,emailSha256:Digest::SHA256.hexdigest(u.email.to_s),groupFull:u.group_access?(gid,'full'),preferencesSha256:email_sha(u.preferences[:notification_config]),notificationConfig:email_canonical(u.preferences[:notification_config]),outOfOffice:u.out_of_office,replacementId:u.out_of_office_replacement_id,mailDeliveryBlockedDays:email_mail_blocked_days(u.preferences,today:Time.zone.now.to_date)}}
    devices=UserDevice.order(:id);raise 'device_bound' if devices.count>100
    auth_devices=devices.map{|d|{id:d.id,userId:d.user_id,createdAt:d.created_at.utc.iso8601(6),fingerprintPresent:d.fingerprint.present?,userAgentSha256:Digest::SHA256.hexdigest(d.user_agent.to_s),locationSha256:Digest::SHA256.hexdigest(d.location.to_s)}}
    ht=History::Type.find_by(name:'notification');ho=History::Object.find_by(name:'Ticket')
    histories=ht&&ho ? History.where(history_type_id:ht.id,history_object_id:ho.id,o_id:ids).order(:id) : []
    raise 'history_bound' if histories.size>200
    rows=histories.map do |h|
      match=h.value_to.to_s.match(/\A(.+)\(([^:()]+):([a-z,]+)\)\z/);raise 'history_shape' unless match
      recipient_sha=Digest::SHA256.hexdigest(match[1]);u=users.find{|u|u[:emailSha256]==recipient_sha};raise 'history_recipient' unless u
      {id:h.id,ticketId:h.o_id,userId:u[:id],type:match[2],channels:match[3].split(','),recipientSha256:recipient_sha,createdById:h.created_by_id}
    end
    jobs=Delayed::Job.order(:id);raise 'queue_bound' if jobs.count>1000
    queue=jobs.map{|j|{id:j.id,futureDue:!!(j.run_at&&j.run_at>Time.now),failed:!j.failed_at.nil?,locked:!j.locked_at.nil?,attempts:j.attempts,handlerSha256:Digest::SHA256.hexdigest(j.handler.to_s),handler:email_job_metadata(j.handler.to_s)}}
    notifications=Channel.where(area:'Email::Notification').order(:id).to_a;active=notifications.select(&:active)
    triggers=Trigger.where(active:true).order(:id).map{|t|t.attributes.except('created_at','updated_at').symbolize_keys}
    sources=%w[app/models/transaction/notification.rb app/jobs/ticket_article_communicate_email_job.rb app/models/channel/email_parser.rb app/models/channel/driver/base_email_outbound.rb lib/notification_factory/mailer.rb app/models/history.rb lib/transaction_dispatcher.rb app/models/ticket/article/enqueue_communicate_wasalx_job.rb app/jobs/wasalx_ticket_routing_job.rb app/controllers/application_controller/handles_devices.rb app/jobs/user_device_log_job.rb app/models/user_device.rb app/models/channel/driver/smtp.rb].to_h{|p|[p,Digest::SHA256.file(Rails.root.join(p)).hexdigest]}
    if input['includeNotificationConfigurationSources'] == true
      %w[app/services/service/system/set_email_notification_configuration.rb app/models/channel.rb app/controllers/application_controller/authenticates.rb app/controllers/user_devices_controller.rb].each { |p| sources[p] = Digest::SHA256.file(Rails.root.join(p)).hexdigest }
    end
    if input['includeTokenDevicePolicySources'] == true
      %w[app/policies/user_device_policy.rb app/policies/application_policy.rb app/policies/pundit_policy.rb lib/user_context.rb app/controllers/application_controller/authorizes.rb app/controllers/application_controller/has_user.rb app/models/token.rb app/models/token/permissions.rb app/models/user/permissions.rb lib/auth/permissions.rb].each { |path| sources[path] = Digest::SHA256.file(Rails.root.join(path)).hexdigest }
    end
    config={productName:Setting.get('product_name'),accountChannel:channel ? {id:channel.id,active:channel.active,groupId:channel.group_id,options:channel.options,namespace:channel.preferences[:alpha_simulation],address:group.email_address&.email} : nil,activeCoreWorkflowSha256:email_sha(CoreWorkflow.where(active:true).order(:id).map{|w|w.attributes.except('created_at','updated_at')}),defaultNotifications:Setting.get('ticket_agent_default_notifications'),triggers:triggers,users:users,groupFullIds:User.group_access(gid,'full').map(&:id).sort,groupReadIds:User.group_access(gid,'read').map(&:id).sort,notificationChannels:notifications.map{|c|{id:c.id,active:c.active,options:c.options,preferences:c.preferences}},notificationSender:Setting.get('notification_sender'),systemBcc:Setting.get('system_bcc'),fqdn:Setting.get('fqdn'),smime:Setting.get('smime_integration'),pgp:Setting.get('pgp_integration')}
    result={evidenceMode:'simulated',productName:Setting.get('product_name'),authDevices:auth_devices,namespace:namespace,groupId:gid,channelId:channel&.id,configSha256:email_sha(config),scheduledSlaCount:Sla.count,otherActiveAccountChannels:Channel.where(area:'Email::Account',active:true).where.not(id:channel&.id).count,defaultTriggerOnly:triggers.size==1&&triggers[0][:id]==1&&email_canonical(triggers[0][:condition])=={'ticket.action'=>{'operator'=>'is','value'=>'create'},'ticket.state_id'=>{'operator'=>'is not','value'=>4},'article.type_id'=>{'operator'=>'is','value'=>[1,5,11]},'article.sender_id'=>{'operator'=>'is','value'=>2}}&&triggers[0][:perform].keys.map(&:to_s)==['notification.email']&&triggers[0][:perform]['notification.email']['recipient']=='article_last_sender'&&!triggers[0][:perform]['notification.email']['internal'],sourceHashes:sources,fqdn:Setting.get('fqdn'),systemBccBlank:Setting.get('system_bcc').blank?,accountPlainOwnedSink:!!(channel&&plain.call(channel)),notificationPlainOwnedSink:active.size==1&&plain.call(active.first),accountFromSha256:Digest::SHA256.hexdigest(group.email_address&.email.to_s),notificationFromSha256:Digest::SHA256.hexdigest(Mail::AddressList.new(Setting.get('notification_sender').to_s).addresses.tap{|v|raise('notification_sender_shape') unless v.size==1}.first.address),notificationUsers:users,notificationHistory:rows,tickets:tickets.map{|t|{id:t.id,ownerId:t.owner_id,groupId:t.group_id,clientRouteStatus:t.wasalx_client_route_status,mentions:Mention.where(mentionable_type:'Ticket',mentionable_id:t.id).order(:user_id).pluck(:user_id)}},
      queue:{total:queue.size,futureDue:queue.count{|r|r[:futureDue]},failed:queue.count{|r|r[:failed]},locked:queue.count{|r|r[:locked]},unparsed:queue.count{|r|!r[:handler][:parsed]},records:queue},
      articles:articles.map{|a|{articleId:a.id,ticketId:a.ticket_id,createdById:a.created_by_id,messageId:a.message_id,sender:a.sender.name,type:a.type.name,internal:a.internal,performOrigin:a.preferences[:perform_origin],deliveryStatus:a.preferences['delivery_status'],deliveryRetry:a.preferences['delivery_retry'],deliveryChannelId:a.preferences['delivery_channel_id'],ccBlank:a.cc.blank?,relatedDeliveryArticleId:a.preferences['delivery_article_id_related'].to_i,autoResponse:a.preferences['is-auto-response']==true,routingPayloadPresent:a.preferences['wasalx_email_routing_payload'].is_a?(Hash),routingState:a.preferences['wasalx_email_routing_state'],routingAckState:a.preferences['wasalx_email_routing_ack_state']}}}
    raise ActiveRecord::Rollback
  end
  result
end
# Read-only Rails runner. Synthetic message ID or marker only; no content output.
require 'json'
input = JSON.parse(STDIN.read)
raise 'simulation admission required' unless input['isolated'] == true
if input['action']=='effects'
  puts JSON.generate(observe_email_effects(input));exit
end
scope = Ticket::Article.all
if input['messageId']
  raise 'synthetic id required' unless input['messageId'].match?(/\A<?[\w.-]+@alpha\.invalid>?\z/)
  scope = scope.where(message_id: input['messageId'])
elsif input['marker']
  raise 'synthetic marker required' unless input['marker'].match?(/\AWasalX [\w -]{1,120}\z/)
  scope = scope.where('body LIKE ?', "%#{input['marker']}%")
else
  raise 'identity required'
end
rows = scope.limit(20).map do |a|
  {articleId:a.id,ticketId:a.ticket_id,messageId:a.message_id,inReplyTo:a.in_reply_to,
   groupId:a.ticket.group_id,ownerId:a.ticket.owner_id,internal:a.internal,
   sender:a.sender.name,type:a.type.name,deliveryStatus:a.preferences['delivery_status'],
   deliveryRetry:a.preferences['delivery_retry'],deliveryChannelId:a.preferences['delivery_channel_id'],
   attachmentIds:a.attachments.map(&:id),createdAt:a.created_at.utc.iso8601,
   routingState:a.preferences['wasalx_email_routing_state'],routingAckState:a.preferences['wasalx_email_routing_ack_state']}
end
puts JSON.generate({at:Time.now.utc.iso8601,articles:rows})
