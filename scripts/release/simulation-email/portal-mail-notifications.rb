# Explicit isolated platform fixture setup/restore. This is never operator UI evidence.
require 'json'
require 'digest'
i=JSON.parse(STDIN.read)
raise 'isolated portal mail setup required' unless i['isolated']==true && i['evidenceMode']=='simulated' && i['operatorSurface']=='portal'
namespace=i.fetch('namespace');raise 'namespace' unless namespace.match?(/\A[A-Za-z0-9-]{1,50}\z/)
path=i.fetch('receiptPath');raise 'owned private receipt required' unless path=="/run/wasalx-simulation/email-stage-#{namespace}/notification-receipt.json"
snapshot=lambda do
 rows=Channel.where(area:'Email::Notification').order(:id).to_a
 raise 'exact native notification rows required' unless rows.size==2 && rows.map{|row|row.options.dig(:outbound,:adapter)}.sort==%w[sendmail smtp]
 raise 'native queue must be drained' unless Delayed::Job.count==0
 {rows:rows.map{|row|{id:row.id,active:row.active,options:row.options,preferences:row.preferences,status_out:row.status_out,last_log_out:row.last_log_out.presence}},sender:Setting.get('notification_sender'),system_bcc:Setting.get('system_bcc')}
end
canonical=lambda{|value|JSON.parse(JSON.generate(value))}
if i['action']=='setup'
 raise 'fresh receipt required' if File.exist?(path)
 before=canonical.call(snapshot.call)
 raise 'existing notification credentials/log require separate ownership admission' if before.fetch('rows').any?{|row|row.dig('options','outbound','options').to_h.any?{|key,value|%w[user password].include?(key)&&value.present?} || row['last_log_out'].present?}
 spec=i.fetch('syntheticMailbox');auth=i.fetch('credentials')
 raise 'frozen synthetic transport required' unless spec['schemaVersion']==1 && spec['namespace']==namespace && spec['host']=='alpha-smtp' && spec['smtpPort']==465 && spec['security']=='TLS' && spec['mailbox']=="support-#{namespace.downcase}@alpha.invalid" && auth['username']==spec['mailbox'] && auth['password'].is_a?(String) && auth['password'].bytesize.between?(16,256)
 from=Mail::AddressList.new(before.fetch('sender')).addresses
 raise 'exact allowed notification sender required' unless from.size==1 && spec.fetch('allowedSenders').include?(from.first.address) && before['system_bcc'].blank?
 File.open(path,File::WRONLY|File::CREAT|File::EXCL,0600){|file|file.write(JSON.generate({state:'OUTCOME_UNKNOWN',namespace:namespace,before:before}));file.flush;file.fsync}
 Channel.transaction do
  Channel.where(area:'Email::Notification').lock.load
  raise 'notification preimage changed' unless canonical.call(snapshot.call)==before
  options={host:'alpha-smtp',port:465,ssl:true,ssl_verify:true,openssl_verify_mode:'peer',enable_starttls_auto:false,user:auth.fetch('username'),password:auth.fetch('password'),domain:Channel::Driver::Smtp.new.prepare_options_get_fqdn(from:before.fetch('sender'))}
  Service::System::SetEmailNotificationConfiguration.execute(adapter:'smtp',new_configuration:options)
 end
 after=canonical.call(snapshot.call)
 File.open(path+'.completed',File::WRONLY|File::CREAT|File::EXCL,0600){|file|file.write(JSON.generate({namespace:namespace,before:before,afterSha256:Digest::SHA256.hexdigest(JSON.generate(after))}));file.flush;file.fsync}
 puts JSON.generate({configured:true,operatorProof:false,namespace:namespace,beforeSha256:Digest::SHA256.hexdigest(JSON.generate(before)),afterSha256:Digest::SHA256.hexdigest(JSON.generate(after)),receiptPath:path+'.completed'})
elsif i['action']=='restore'
 receipt=JSON.parse(File.binread(path+'.completed'));raise 'receipt namespace mismatch' unless receipt['namespace']==namespace
 current=canonical.call(snapshot.call);raise 'notification configuration drift' unless Digest::SHA256.hexdigest(JSON.generate(current))==receipt.fetch('afterSha256')
 Channel.transaction do
  Channel.where(area:'Email::Notification').lock.load
  raise 'notification configuration drift under lock' unless Digest::SHA256.hexdigest(JSON.generate(canonical.call(snapshot.call)))==receipt.fetch('afterSha256')
  receipt.fetch('before').fetch('rows').each{|attributes|row=Channel.find(attributes.fetch('id'));raise 'notification row identity changed' unless row.area=='Email::Notification';restored=attributes.except('id');restored['options']=restored.fetch('options').deep_symbolize_keys;row.update!(restored)}
 end
 raise 'notification restoration mismatch' unless canonical.call(snapshot.call)==receipt.fetch('before')
 puts JSON.generate({restored:true,operatorProof:false,namespace:namespace,sourceReceiptSha256:Digest::SHA256.file(path+'.completed').hexdigest})
else
 raise 'explicit platform setup/restore action required'
end
