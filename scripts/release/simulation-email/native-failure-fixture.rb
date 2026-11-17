require 'json'
require 'digest'
require 'time'
i=JSON.parse(STDIN.read);raise 'isolated only' unless i['isolated']==true
MAIL_FAILURE_KEYS = %w[mail_delivery_failed mail_delivery_failed_data].freeze
def canonical_preferences(value)
  case value
  when Hash
    value.each_with_object({}) { |(key, item), result| result[key.to_s] = canonical_preferences(item) }.sort.to_h
  when Array then value.map { |item| canonical_preferences(item) }
  else value
  end
end
def recipient_mail_state(user)
  preferences = canonical_preferences(user.preferences || {})
  other = preferences.reject { |key, _| MAIL_FAILURE_KEYS.include?(key) }
  keys = MAIL_FAILURE_KEYS.to_h { |key| [key, {'present'=>preferences.key?(key), 'value'=>preferences[key]}] }
  keys = JSON.parse(JSON.generate(keys))
  {'keys'=>keys, 'preferencesSha256'=>Digest::SHA256.hexdigest(JSON.generate(preferences)),
   'otherPreferencesSha256'=>Digest::SHA256.hexdigest(JSON.generate(other))}
end
def recipient_state(user, recipient)
  state = user && recipient_mail_state(user)
  {exists: !user.nil?, userId: user&.id, recipientFailureFlag: state&.dig('keys','mail_delivery_failed','value'),
   originalRecipient: recipient, recipientMailState: state}
end
if i['action']=='preflight'
 pending=Delayed::Job.where("handler LIKE ?",'%TicketArticleCommunicateEmailJob%').where(failed_at:nil).count
 puts JSON.generate({pendingEmailJobs:pending});exit
end
if i['action']=='recipient-state'
 recipient=i.fetch('originalRecipient');raise 'recipient scope' unless recipient.match?(/\A[^\s<>@]+@alpha\.invalid\z/)
 u=User.find_by(email:recipient)
 puts JSON.generate(recipient_state(u, recipient));exit
end
if i['action']=='recipient-mail-restore'
 recipient=i.fetch('originalRecipient');raise 'recipient scope' unless recipient=='customer@alpha.invalid'
 before=i.fetch('preBounce');after=i.fetch('postBounce')
 proof=i.fetch('bounceProofSha256');raise 'bounce proof sha' unless proof.match?(/\A[0-9a-f]{64}\z/)
 raise 'restore intent sha' unless i.fetch('restoreIntentSha256').match?(/\A[0-9a-f]{64}\z/)
 raise 'unsettled mail effects' unless i['ownedJobsDrained']==true && i['uncertainOutcomesReconciled']==true
 u=User.find_by(email:recipient);raise 'recipient missing' unless u
 restored=nil
 u.with_lock do
   raise 'recipient identity drift' unless before['exists']==true && after['exists']==true &&
     before['originalRecipient']==recipient && after['originalRecipient']==recipient &&
     before['userId']==u.id && after['userId']==u.id
   prior=before.fetch('recipientMailState');post=after.fetch('recipientMailState')
   raise 'other preferences drift' unless prior.fetch('otherPreferencesSha256')==post.fetch('otherPreferencesSha256')
   raise 'pre-bounce recipient already blocked' unless prior.fetch('keys').fetch('mail_delivery_failed').fetch('value')!=true &&
     prior.fetch('keys').fetch('mail_delivery_failed_data').fetch('present')==false
   raise 'post-bounce flag absent' unless post.fetch('keys').fetch('mail_delivery_failed')=={'present'=>true,'value'=>true}
   data=post.fetch('keys').fetch('mail_delivery_failed_data')
   raise 'post-bounce failure data absent' unless data.fetch('present')==true && !data.fetch('value').nil?
   raise 'recipient preference drift' unless recipient_mail_state(u)==post
   pending=Delayed::Job.where("handler LIKE ?",'%TicketArticleCommunicateEmailJob%').where(failed_at:nil).count
   raise 'pending native mail jobs' unless pending==0
   preferences=u.preferences.dup
   MAIL_FAILURE_KEYS.each { |key| preferences.delete(key);preferences.delete(key.to_sym) }
   MAIL_FAILURE_KEYS.each do |key|
     saved=prior.fetch('keys').fetch(key)
     preferences[key.to_sym]=saved.fetch('value') if saved.fetch('present')==true
   end
   u.preferences=preferences;u.save!
   restored=recipient_state(u,recipient)
   raise 'recipient restoration drift' unless restored.fetch(:recipientMailState)==prior
 end
 puts JSON.generate({restored:true,recipient:restored,bounceProofSha256:proof});exit
end
if i['action']=='bounce-readback'
 original=Ticket::Article.find(i.fetch('originalArticleId'));bounce=Ticket::Article.find(i.fetch('articleId'));u=User.find_by(email:i.fetch('originalRecipient'))
 puts JSON.generate({recipientUserId:u&.id,originalArticle:original.id,originalMessageId:original.message_id,originalStatus:original.preferences['delivery_status'],bounceArticle:bounce.id,bounceTicket:bounce.ticket_id,body:bounce.body,recipientFailureFlag:u&.preferences&.dig(:mail_delivery_failed)});exit
end
if i['action']=='readback'
 a=Ticket::Article.find(i.fetch('articleId'));t=Ticket.find(a.ticket_id)
 related=Ticket::Article.where(ticket_id:t.id).select{|x| x.preferences['delivery_article_id_related'].to_i==a.id}.map{|x|{id:x.id,body:x.body,internal:x.internal}}
 puts JSON.generate({articleId:a.id,ticketId:t.id,state:t.state.name,reopened:t.state.default_follow_up,preferences:a.preferences,related:related});exit
end
raise 'create action only' unless i['action']=='create'
recipient=i.fetch('recipient');raise 'recipient scope' unless recipient.match?(/\Afailure-[a-z0-9_-]+@alpha\.invalid\z/)
t=Ticket.find(i.fetch('ticketId'));raise 'fixture ticket mismatch' unless t.id==Integer(i.fetch('ticketId'))
channel=t.group.email_address.channel;raise 'sink channel mismatch' unless channel.id==Integer(i.fetch('channelId')) && channel.active && channel.options[:outbound][:options][:host]=='alpha-smtp'
raise 'import mode' if Setting.get('import_mode')
raise 'existing failure marker; readback, never recreate' if Ticket::Article.where(ticket_id:t.id,body:i.fetch('marker')).exists?
receipt=i.fetch('receiptPath');raise 'private path required' unless receipt.start_with?('/run/wasalx-simulation/')&&!receipt.split('/').include?('..')
File.open(receipt,File::WRONLY|File::CREAT|File::EXCL,0600){|f|f.write(JSON.generate({state:'OUTCOME_UNKNOWN',at:Time.now.utc.iso8601,marker:i['marker']}));f.flush;f.fsync}
u=User.find(i.fetch('actorId'));raise 'actor not agent' unless u.active && u.roles.any?{|r|r.name=='Agent'}
UserInfo.current_user_id=u.id
begin
 a=Ticket::Article.create!(ticket_id:t.id,type:Ticket::Article::Type.find_by!(name:'email'),sender:Ticket::Article::Sender.find_by!(name:'Agent'),from:t.group.email_address.email,to:recipient,subject:'Alpha isolated failure',body:i.fetch('marker'),content_type:'text/plain',internal:false,created_by_id:u.id,updated_by_id:u.id)
 # Existing after_create_commit hook enqueues real TicketArticleCommunicateEmailJob exactly once.
 puts JSON.generate({articleId:a.id,ticketId:t.id,messageId:a.message_id,actorId:u.id,interfaceHandle:ApplicationHandleInfo.current,at:Time.now.utc.iso8601})
ensure
 UserInfo.current_user_id=nil
end
