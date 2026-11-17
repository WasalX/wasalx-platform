# Current simulated-provider readback; never authenticates a human or mutates native records.
require 'json'
require 'digest'
require 'time'
input=JSON.parse(STDIN.read)
raise 'isolated current portal fixture required' unless input['isolated']==true && input['evidenceMode']=='simulated' && input['operatorSurface']=='portal'
namespace=input.fetch('namespace');raise 'namespace' unless namespace.match?(/\A[A-Za-z0-9-]{1,50}\z/)
group_id=Integer(input.fetch('groupId'));channel_id=Integer(input.fetch('channelId'));actor_ids=input.fetch('nativeUserIds').map{|id|Integer(id)}.sort
raise 'exact owner and agent required' unless actor_ids.size==2 && actor_ids.uniq.size==2
result=nil
ActiveRecord::Base.transaction do
  ActiveRecord::Base.connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
  actors=User.where(id:actor_ids).order(:id).to_a
  raise 'active managed actors required' unless actors.size==2 && actors.all?{|actor|actor.active && !Wasalx::ServiceIdentity.automation?(actor) && actor.group_access?(group_id,'full') && WasalxMembership.where(user_id:actor.id,tenant_id:ENV.fetch('WASALX_TENANT_ID'),instance_id:ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID'),member_state:'ACTIVE').exists?}
  channel=Channel.find(channel_id);group=Group.find(group_id)
  address=group.email_address
  raise 'exact saved mailbox binding required' unless channel.area=='Email::Account' && channel.group_id==group.id && address&.channel_id==channel.id
  receipt=WasalxAdminOperation.find_by!(operation_id:input.fetch('mailboxCreateOperationId'),kind:'MAILBOX_CREATE',portal_user_id:input.fetch('ownerPortalUserId'),native_user_id:Integer(input.fetch('ownerNativeUserId')))
  raise 'exact portal mailbox creation receipt required' unless actor_ids.include?(receipt.native_user_id) && receipt.target_id.nil? && receipt.result['state']=='APPLIED' && receipt.result['mailbox_id']==channel.id.to_s
  spec=input.fetch('syntheticMailbox')
  raise 'frozen owned mailbox required' unless spec['schemaVersion']==1 && spec['namespace']==namespace && spec['host']=='alpha-smtp' && address.email==spec['mailbox']
  transport=lambda do |row|
    outbound=row.options.dig(:outbound,:options).to_h
    row.options.dig(:outbound,:adapter)=='smtp' && outbound[:host]=='alpha-smtp' && outbound[:port].to_i==465 && outbound[:ssl]==true && outbound[:ssl_verify]==true && outbound[:openssl_verify_mode].to_s=='peer' && outbound[:user]==spec['mailbox'] && outbound[:password].present?
  end
  inbound=channel.options.dig(:inbound,:options).to_h
  account_tls=transport.call(channel) && channel.options.dig(:inbound,:adapter)=='imap' && inbound[:host]=='alpha-smtp' && inbound[:port].to_i==993 && inbound[:ssl]!='off' && inbound[:ssl]!='starttls' && inbound[:ssl_verify]==true && inbound[:user]==spec['mailbox'] && inbound[:password].present?
  notifications=Channel.where(area:'Email::Notification',active:true).order(:id).to_a
  notification_tls=notifications.size==1 && transport.call(notifications.first)
  sources=input.fetch('sourceHashes').to_h
  raise 'bounded installed sources required' unless sources.size.between?(6,40) && sources.keys.all?{|path|path.match?(/\A(?:app|lib)\/[a-zA-Z0-9_\/.]+\z/) && !path.split('/').include?('..')}
  actual=sources.to_h{|path,_|[path,Digest::SHA256.file(Rails.root.join(path)).hexdigest]}
  raise 'installed source drift' unless actual==sources
  tickets=Ticket.where(group_id:group.id).order(:id).to_a;raise 'bounded group fixture required' if tickets.size>100
  ticket_ids=tickets.map(&:id)
  articles=Ticket::Article.where(ticket_id:ticket_ids).order(:id).to_a;raise 'bounded article fixture required' if articles.size>500
  history_type=History::Type.find_by(name:'notification');history_object=History::Object.find_by(name:'Ticket')
  histories=history_type&&history_object ? History.where(history_type_id:history_type.id,history_object_id:history_object.id,o_id:ticket_ids).order(:id).to_a : []
  raise 'bounded notification history required' if histories.size>500
  rows=histories.map do |history|
    match=history.value_to.to_s.match(/\A(.+)\(([^:()]+):([a-z,]+)\)\z/);raise 'notification history shape' unless match
    user=actors.find{|actor|actor.email==match[1]};raise 'unowned notification recipient' unless user
    {id:history.id,ticketId:history.o_id,userId:user.id,type:match[2],channels:match[3].split(','),recipientSha256:Digest::SHA256.hexdigest(match[1]),createdById:history.created_by_id,createdAt:history.created_at.utc.iso8601(6)}
  end
  pending=Delayed::Job.where(failed_at:nil).where('handler LIKE ? OR handler LIKE ?', '%TicketArticleCommunicateEmailJob%','%Wasalx::MailboxVerification%').count
  configuration={account:channel.options,groupSender:address.attributes.except('created_at','updated_at'),notification:notifications.map{|row|[row.id,row.options]},triggers:Trigger.where(active:true).order(:id).map{|row|row.attributes.except('created_at','updated_at')},nativeUsers:actors.map{|actor|[actor.id,actor.roles.pluck(:id).sort,actor.group_ids_access_map,actor.preferences[:notification_config]]},systemBcc:Setting.get('system_bcc'),notificationSender:Setting.get('notification_sender')}
  result={operatorSurface:'portal',evidenceMode:'simulated',namespace:namespace,sourceHashes:actual,configSha256:Digest::SHA256.hexdigest(JSON.generate(configuration)),accountOwnedTls:account_tls,notificationOwnedTls:notification_tls,accountActive:channel.active,otherActiveAccounts:Channel.where(area:'Email::Account',active:true).where.not(id:channel.id).count,systemBccBlank:Setting.get('system_bcc').blank?,pendingEmailJobs:pending,nativeQueueTotal:Delayed::Job.count,nativeUserIds:actor_ids,
    tickets:tickets.map{|ticket|{id:ticket.id,number:ticket.number,groupId:ticket.group_id,ownerId:ticket.owner_id,state:ticket.state.name,updatedAt:ticket.updated_at.utc.iso8601(6)}},
    articles:articles.map{|article|{articleId:article.id,ticketId:article.ticket_id,messageId:article.message_id,createdById:article.created_by_id,bodySha256:Digest::SHA256.hexdigest(article.body.to_s),sender:article.sender.name,type:article.type.name,internal:article.internal,to:article.to.to_s,ccBlank:article.cc.blank?,deliveryStatus:article.preferences['delivery_status'],deliveryRetry:article.preferences['delivery_retry'],deliveryChannelId:article.preferences['delivery_channel_id'],relatedArticleId:article.preferences['delivery_article_id_related'].to_i,routingState:article.preferences['wasalx_email_routing_state'],routingAckState:article.preferences['wasalx_email_routing_ack_state']}},notificationHistory:rows}
  raise ActiveRecord::Rollback
end
puts JSON.generate(result)
