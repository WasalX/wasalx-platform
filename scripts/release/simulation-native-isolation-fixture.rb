# Fixed supporting fixture only, never operator acceptance or an arbitrary native console.
require 'json'
require 'base64'
require 'digest'
p=JSON.parse(Base64.urlsafe_decode64(ENV.fetch('WASALX_NATIVE_ISOLATION_INPUT')))
raise 'Isolated fixture required' unless p.fetch('project').match?(/\Awasalx-simulation-[a-zA-Z0-9_-]+\z/) && p.fetch('namespace').match?(/\A[a-zA-Z0-9-]{1,40}\z/)
raise 'Foreign native environment' unless p.fetch('tenantId')==ENV.fetch('WASALX_TENANT_ID') && p.fetch('instanceId')==ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID')
source=Wasalx::InstalledPackage.verify!
%w[candidate_commit_sha candidate_tree_sha native_package_sha256].each{|key|raise 'Native source differs from admitted immutable image' unless source.fetch(key)==p.fetch('source').fetch(key)}
if p.fetch('mode')=='READ'
 raise 'Unexpected health input' unless p.keys.sort==%w[instanceId mode namespace project source tenantId].sort
 puts JSON.generate('nativeIsolation'=>{'source'=>source,'tenantId'=>p['tenantId'],'instanceId'=>p['instanceId']})
else
 raise 'Unsupported fixed fixture operation' unless p.fetch('mode')=='CREATE' && p.keys.sort==%w[groupId instanceId marker mode namespace number project side source tenantId ticketId].sort
 raise 'Invalid fixed fixture side' unless %w[primary secondary].include?(p.fetch('side'))
 raise 'Invalid fixed fixture IDs' unless %w[ticketId number].all?{|key|p[key].is_a?(String)&&p[key].match?(/\A[1-9][0-9]{0,15}\z/)}
 raise 'Invalid fixed group' unless p['groupId'].nil? || (p['groupId'].is_a?(String) && p['groupId'].match?(/\A[1-9][0-9]{0,15}\z/))
 raise 'Invalid fixed marker' unless p.fetch('marker').match?(/\Awasalx-isolation-[a-z0-9-]{8,100}\z/)
 raise 'Fixture already consumed; reconcile original intent' if Ticket.exists?(id:p['ticketId'])||Ticket.exists?(number:p['number'])||Ticket.where('title LIKE ?',"%#{Ticket.sanitize_sql_like(p['marker'])}%").exists?
 receipt=Wasalx::ServiceIdentity.receipt
 raise 'Fresh service identity required' unless receipt && receipt['schema_version']==2 && receipt['origin']=='FRESH' && receipt['phase']=='BOUND' && receipt['tenant_id']==p['tenantId'] && receipt['instance_id']==p['instanceId']
 owner=Wasalx::ServiceIdentity.native_owner!(receipt)
 group=p['groupId'] ? Group.find(p['groupId']) : Group.where(active:true).order(:id).first!
 raise 'Inactive fixture group' unless group.active
 bytes="WasalX isolation attachment #{p['namespace']} #{p['side']}\n"
 result=nil
 UserInfo.with_user_id(owner.id) do
  Transaction.execute do
   customer=User.create!(login:p['marker'],email:'',firstname:'Synthetic',lastname:'Isolation customer',active:true,roles:[Role.find_by!(name:'Customer')],created_by_id:owner.id,updated_by_id:owner.id)
   ticket=Ticket.create!(id:Integer(p['ticketId']),title:p['marker'],group:group,customer:customer,owner:owner,state:Ticket::State.find_by!(name:'open'),created_by_id:owner.id,updated_by_id:owner.id)
   # Deliberately disjoint friendly references are fixture data, never aliases for a foreign case.
   ticket.update_columns(number:p['number'])
   article=Ticket::Article.create!(ticket:ticket,sender:Ticket::Article::Sender.find_by!(name:'Agent'),type:Ticket::Article::Type.find_by!(name:'note'),internal:true,content_type:'text/plain',body:p['marker'],created_by_id:owner.id,updated_by_id:owner.id)
   file=Store.create!(object:'Ticket::Article',o_id:article.id,filename:"wasalx-isolation-#{p['side']}.txt",data:bytes,preferences:{'Content-Type'=>'text/plain'},created_by_id:owner.id)
   result={'tenantId'=>p['tenantId'],'instanceId'=>p['instanceId'],'nativeGroupId'=>group.id.to_s,'ticketId'=>ticket.id.to_s,'ticketNumber'=>ticket.reload.number.to_s,'articleId'=>article.id.to_s,'marker'=>p['marker'],'attachment'=>{'id'=>file.id.to_s,'filename'=>file.filename,'bytes'=>bytes.bytesize,'sha256'=>Digest::SHA256.hexdigest(bytes)},'source'=>source}
  end
 end
 puts JSON.generate('nativeIsolation'=>result)
end
