import assert from 'node:assert/strict';
import {parseRailsJson} from './simulation-rails-json.mjs';
const identifier=/^[1-9][0-9]{0,15}$/u;
const isolationKeys=['ticketId','ticketNumber','articleId','attachmentId','marker','foreignTicketId','foreignTicketNumber','foreignMarker'];
const inputs={'handoff-evidence':['ticketId','jobId','connectionId'],'isolation-evidence':isolationKeys,ticket:['ticketId'],articles:['ticketId'],article:['articleId'],user:['userId'],group:['groupId'],states:[],attachment:['ticketId','articleId','attachmentId'],channel:['channelId'],'email-address':['emailAddressId'],'service-identity':['ownerId','agentId','groupId','runtimeSha256','privacySha256']};
const readback=String.raw`require 'json';require 'base64';require 'digest'
input=JSON.parse(Base64.urlsafe_decode64(ENV.fetch('WASALX_FIXTURE_READ_INPUT')))
raise 'Foreign fixture tenant' unless input.fetch('tenantId')==ENV.fetch('WASALX_TENANT_ID')
kind=input.fetch('kind');args=input.fetch('input')
if input['source']
 raise 'Foreign fixture instance' unless input.fetch('instanceId')==ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID')
 installed=Wasalx::InstalledPackage.verify!
 %w[candidate_commit_sha candidate_tree_sha native_package_sha256].each{|key|raise 'Native fixture source changed' unless installed.fetch(key)==input.fetch('source').fetch(key)}
end
article_json=lambda do |article|
 article.attributes.merge('type'=>article.type.name,'sender'=>article.sender.name,'attachments'=>article.attachments.map{|file|{'id'=>file.id,'filename'=>file.filename,'size'=>file.preferences['size'].to_i,'preferences'=>file.preferences.slice('size','Content-Type','Mime-Type')}})
end
value=ActiveRecord::Base.transaction(requires_new:true) do
 ActiveRecord::Base.connection.execute('SET TRANSACTION READ ONLY')
 ActiveRecord::Base.connection.execute("SET LOCAL statement_timeout='5s'")
 case kind
 when 'isolation-evidence'
  ticket=Ticket.find(args.fetch('ticketId'));raise 'Fixture friendly reference changed' unless ticket.number.to_s==args.fetch('ticketNumber') && ticket.title.include?(args.fetch('marker'))
  article=Ticket::Article.find(args.fetch('articleId'));raise 'Foreign fixture article' unless article.ticket_id==ticket.id && article.body.include?(args.fetch('marker'))
  file=article.attachments.find{|row|row.id.to_s==args.fetch('attachmentId')};raise 'Fixture attachment unavailable' unless file
  bytes=file.content;raise 'Fixture media bound exceeded' if bytes.bytesize>50*1024*1024
  absence={'ticketIdAbsent'=>!Ticket.exists?(id:args.fetch('foreignTicketId')),'ticketNumberAbsent'=>!Ticket.exists?(number:args.fetch('foreignTicketNumber')),'markerAbsent'=>!Ticket.where('title LIKE ?',"%#{Ticket.sanitize_sql_like(args.fetch('foreignMarker'))}%").exists?}
  {'ticket'=>ticket.attributes,'article'=>article_json.call(article),'attachment'=>{'filename'=>file.filename,'byteSize'=>bytes.bytesize,'sha256'=>Digest::SHA256.hexdigest(bytes)},'absence'=>absence,'installed'=>installed}
 when 'handoff-evidence'
  ticket=Ticket.find(args.fetch('ticketId'));raise 'Foreign handoff connection' unless ticket.wasalx_connection_id==args.fetch('connectionId')
  correlation=ticket.wasalx_correlation_key;raise 'Missing handoff ticket correlation' unless correlation.is_a?(String) && correlation.match?(/\A[0-9a-f]{64}\z/)
  key='bot-handoff:'+args.fetch('jobId')
  notes=Ticket::Article.where(ticket_id:ticket.id).order(:id).select{|article|article.preferences.to_h.with_indifferent_access[:wasalx_handoff_key]==key}
  raise 'Unsafe handoff note' unless notes.all?{|article|article.internal && article.type.name=='note' && article.sender.name=='System'}
  {'ticketId'=>ticket.id.to_s,'ticketNumber'=>ticket.number.to_s,'ticketCount'=>Ticket.where(wasalx_correlation_key:correlation).count,'noteIds'=>notes.map{|article|article.id.to_s}}
 when 'ticket' then Ticket.find(args.fetch('ticketId')).attributes
 when 'articles' then Ticket::Article.where(ticket_id:args.fetch('ticketId')).order(:created_at,:id).limit(501).map{|row|article_json.call(row)}.tap{|rows|raise 'Fixture article bound exceeded' if rows.length>500}
 when 'article' then article_json.call(Ticket::Article.find(args.fetch('articleId')))
 when 'user' then User.find(args.fetch('userId')).then{|user|user.attributes.slice('id','email','firstname','lastname','mobile','login','active').merge('role_ids'=>user.role_ids,'group_ids_access_map'=>user.group_ids_access_map)}
 when 'group' then Group.find(args.fetch('groupId')).attributes.slice('id','name','active','email_address_id','updated_at')
 when 'states' then Ticket::State.order(:id).map{|row|row.attributes.slice('id','name','state_type_id','active')}
 when 'attachment'
  article=Ticket::Article.find(args.fetch('articleId'));raise 'Foreign fixture article' unless article.ticket_id.to_s==args.fetch('ticketId')
  file=article.attachments.find{|row|row.id.to_s==args.fetch('attachmentId')};raise 'Fixture attachment unavailable' unless file
  bytes=file.content;raise 'Fixture media bound exceeded' if bytes.bytesize>50*1024*1024
  {'filename'=>file.filename,'byteSize'=>bytes.bytesize,'sha256'=>Digest::SHA256.hexdigest(bytes)}
 when 'channel' then Channel.find(args.fetch('channelId')).then{|channel|options=channel.options.to_h.with_indifferent_access;channel.attributes.slice('id','area','active','updated_at').merge('inbound_adapter'=>options.dig(:inbound,:adapter),'outbound_adapter'=>options.dig(:outbound,:adapter))}
 when 'service-identity'
  guard=Wasalx::ServiceIdentity;record=guard.receipt
  raise 'Fresh service identity unavailable' unless record && record['schema_version']==2 && record['origin']=='FRESH' && record['phase']=='BOUND'
  raise 'Foreign service instance' unless record.fetch('instance_id')==ENV.fetch('WASALX_ZAMMAD_INSTANCE_ID')
  machine=User.find(record.fetch('automation_native_user_id'));owner=guard.native_owner!(record);agent=User.find(args.fetch('agentId'))
  raise 'Human and machine identities are not distinct' unless [machine.id,owner.id,agent.id].uniq.length==3 && owner.id.to_s==args.fetch('ownerId')
  raise 'Invalid machine identity' unless guard.machine_valid?(machine,record) && !guard.automation?(owner) && !guard.automation?(agent)
  human=lambda do |user,role|
   rows=WasalxMembership.where(user_id:user.id).to_a;raise 'Ambiguous human projection' unless rows.length==1
   row=rows.first;raise 'Foreign human projection' unless row.tenant_id==input.fetch('tenantId') && row.instance_id==record.fetch('instance_id') && row.member_state=='ACTIVE' && row.portal_role==role && user.active && user.email==row.email
   raise 'Human native permissions changed' unless Wasalx::MembershipProjection.native_access_matches?(user,role,'ACTIVE')
   raise 'Human OIDC binding changed' unless Authorization.where(user_id:user.id,provider:'openid_connect',uid:row.subject).count==1
   {'portalRef'=>'sha256:'+Digest::SHA256.hexdigest(row.portal_user_id),'nativeRef'=>'sha256:'+Digest::SHA256.hexdigest(user.id.to_s),'subjectRef'=>'sha256:'+Digest::SHA256.hexdigest(row.subject),'emailRef'=>'sha256:'+Digest::SHA256.hexdigest(row.email),'revision'=>row.revision,'role'=>row.portal_role,'state'=>row.member_state,'fingerprint'=>guard.digest([row.attributes,user.active,user.role_ids.sort])}
  end
  owner_proof=human.call(owner,'tenant_owner');agent_proof=human.call(agent,'agent')
  runtime=Token.find(record.fetch('runtime_token_id'));privacy=Token.find(record.fetch('privacy_token_id'))
  raise 'Configured service token ownership changed' unless runtime.user_id==machine.id && privacy.user_id==machine.id && runtime.id!=privacy.id && runtime.token!=privacy.token
  raise 'Configured service token values changed' unless Digest::SHA256.hexdigest(runtime.token)==args.fetch('runtimeSha256') && Digest::SHA256.hexdigest(privacy.token)==args.fetch('privacySha256')
  raise 'Service token purpose boundary changed' unless guard.token_allowed?(machine,runtime,'runtime') && guard.token_allowed?(machine,privacy,'privacy') && !guard.token_allowed?(machine,runtime,'privacy') && !guard.token_allowed?(machine,privacy,'runtime')
  raise 'Machine acquired human projection' if WasalxMembership.exists?(user_id:machine.id)
  raise 'Native session scan exceeded bound' if Session.count>1000
  token_security=lambda do |token|
   token.reload
   token.attributes.slice('id','action','name','user_id','persistent','expires_at','created_at').merge('permissions'=>Array(token.preferences.to_h.with_indifferent_access[:permission]).sort,'expired'=>token.expired?,'valueSha256'=>Digest::SHA256.hexdigest(token.token))
  end
  snapshot=lambda do
   current=User.find(machine.id)
   database_sessions=Session.find_each.filter_map{|row|row.id.to_s if row.data&.dig('user_id').to_s==machine.id.to_s}.sort
   socket_sessions=Sessions.list.filter_map{|key,data|key.to_s if data.dig(:user,'id').to_s==machine.id.to_s}.sort
   {'identity'=>guard.digest([current.id,current.active,current.login,current.email,current.preferences,current.role_ids.sort,current.permissions.pluck(:name).sort,current.password.present?]),'tokens'=>guard.digest([token_security.call(runtime),token_security.call(privacy)]),'credentials'=>guard.digest([Authorization.where(user_id:machine.id).pluck(:id).sort,current.two_factor_preferences.pluck(:id).sort]),'databaseSessions'=>database_sessions,'socketSessions'=>socket_sessions}
  end
  # Installed 7.1.3 Auth::User.new(username) resolves the user without password validation.
  before=snapshot.call
  raise 'Native password eligibility guard unavailable' unless Auth::User.instance_method(:can_login?).owner==Wasalx::ServiceIdentity::PasswordAuthentication
  password_denied = Auth::User.new(machine.login).can_login? == false
  raise 'Native password eligibility admitted the machine' unless password_denied
  interactive_denied=Wasalx::MembershipAccess.allowed?(machine,interactive:true,auth_type:'session')==false
  raise 'Machine interactive policy admitted access' unless interactive_denied
  raise 'Native session authentication guard unavailable' unless ApplicationController.instance_method(:authentication_check_prerequesits).owner==Wasalx::MembershipAccess::Authentication
  session_denied=false
  begin
   ApplicationController.new.send(:authentication_check_prerequesits,machine,'session')
  rescue Exceptions::NotAuthorized => error
   raise 'Unexpected native session denial' unless error.message=='Workspace access is not available'
   session_denied=true
  end
  raise 'Native session authentication admitted the machine' unless session_denied
  raise 'Machine acquired interactive credentials' if machine.password.present? || Authorization.exists?(user_id:machine.id) || machine.two_factor_preferences.exists?
  raise 'Machine already has an interactive session' unless before['databaseSessions'].empty? && before['socketSessions'].empty?
  after=snapshot.call;raise 'Eligibility check mutated credentials or sessions' unless before==after
  raise 'Eligibility check changed human administration' unless owner_proof==human.call(owner.reload,'tenant_owner') && agent_proof==human.call(agent.reload,'agent')
  group=Group.find(args.fetch('groupId'));raise 'Fixture service group inactive' unless group.active
  full=UserGroup.where(user_id:machine.id,group_id:group.id,access:'full').exists?
  raise 'Fixture machine grant was not explicitly enabled' unless full
  {'installed'=>Wasalx::InstalledPackage.verify!,'mode'=>'FRESH','phase'=>'BOUND','receiptRef'=>'sha256:'+guard.digest(record),'machineRef'=>'sha256:'+Digest::SHA256.hexdigest(machine.id.to_s),'owner'=>owner_proof,'agent'=>agent_proof,'groupRef'=>'sha256:'+Digest::SHA256.hexdigest(group.id.to_s),'separateHumanAndMachine'=>true,'noHumanAdministration'=>true,'noInteractiveCredentials'=>true,'noInteractiveSession'=>true,'interactiveDenied'=>interactive_denied,'sessionAuthenticationDenied'=>session_denied,'passwordLoginDenied'=>password_denied,'eligibilityReadOnly'=>true,'configuredTokenOwnership'=>true,'independentTokenValues'=>true,'purposeSeparated'=>true,'fullFixtureGrant'=>full,'snapshotRef'=>'sha256:'+guard.digest(after)}
 when 'email-address' then EmailAddress.find(args.fetch('emailAddressId')).attributes.slice('id','email','realname','active','channel_id')
 else raise 'Unsupported fixture read'
 end
end
puts JSON.generate({'readback'=>value})`;
// Backend corroboration only. It cannot produce an operator/browser PASS.
export async function privateNativeRead(s,kind,input={}){
 assert(s.model?.name?.startsWith('wasalx-simulation-'));assert.match(s.tenantId,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu);
 assert(Object.hasOwn(inputs,kind),'Unsupported fixed native read');const keys=inputs[kind];assert(keys&&input&&Object.getPrototypeOf(input)===Object.prototype,'Unsupported fixed native read');assert.deepEqual(Object.keys(input).sort(),[...keys].sort());
 for(const key of keys){if(kind==='handoff-evidence'&&['jobId','connectionId'].includes(key)){assert.match(input[key],/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu,'Invalid handoff fixture identifier');}else if(kind==='isolation-evidence'&&['marker','foreignMarker'].includes(key)){assert(typeof input[key]==='string'&&/^wasalx-isolation-[a-z0-9-]{8,100}$/u.test(input[key]),'Invalid fixed isolation marker');}else if(kind==='service-identity'&&key.endsWith('Sha256')){assert(typeof input[key]==='string');assert.match(input[key],/^[a-f0-9]{64}$/u,'Invalid configured service digest');}else{assert(typeof input[key]==='string'||Number.isSafeInteger(input[key]),'Invalid native fixture identifier');assert.match(String(input[key]),identifier,'Invalid native fixture identifier');}}
 if(kind==='service-identity'){assert.notEqual(String(input.ownerId),String(input.agentId));assert.notEqual(input.runtimeSha256,input.privacySha256,'Independent configured service values required');}
 const service=s.nativeReadService??'zammad-railsserver';assert(['zammad-railsserver','zammad-isolation-railsserver'].includes(service),'Unsupported fixed native service');if(kind==='service-identity')assert.equal(service,'zammad-railsserver','Main service identity proof only');
 const container=s.containers?.[service];assert.match(container?.Id??'',/^[a-f0-9]{64}$/u);
 const [current]=JSON.parse(await s.run('docker',['inspect',container.Id]));assert.equal(current?.Id,container.Id);assert.equal(current.Image,container.Image);assert.equal(current.State?.Status,'running');assert.equal(current.Config?.Labels?.['com.docker.compose.project'],s.model.name);assert.equal(current.Config?.Labels?.['com.docker.compose.service'],service);
 let source,instanceId;
 if(service==='zammad-isolation-railsserver'||kind==='isolation-evidence'){
  const configured=s.model.services?.[service];assert.equal(configured?.image,current.Image,'Native isolation requires the prepared immutable image ID');assert.equal(configured.environment.WASALX_TENANT_ID,s.tenantId);instanceId=configured.environment.WASALX_ZAMMAD_INSTANCE_ID;assert.match(instanceId,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu);
  const [image]=JSON.parse(await s.run('docker',['image','inspect',current.Image]));assert.equal(image.Id,current.Image);const labels=image.Config?.Labels??{};source={candidate_commit_sha:labels['org.opencontainers.image.revision'],candidate_tree_sha:labels['io.wasalx.source.tree'],native_package_sha256:labels['com.wasalx.zammad.package.sha256']};assert.match(source.candidate_commit_sha??'',/^[a-f0-9]{40}$/u);assert.match(source.candidate_tree_sha??'',/^[a-f0-9]{40}$/u);assert.match(source.native_package_sha256??'',/^[a-f0-9]{64}$/u);
 }
 const payload=Buffer.from(JSON.stringify({tenantId:s.tenantId,kind,...(source?{source,instanceId}:{}),input:Object.fromEntries(keys.map(key=>[key,String(input[key])]))})).toString('base64url');
 const result=parseRailsJson(await s.run('docker',['exec','-e','WASALX_FIXTURE_READ_INPUT='+payload,container.Id,'/usr/bin/timeout','--kill-after=2s','20s','bundle','exec','rails','runner',readback]));
 assert(Object.hasOwn(result,'readback'),'Missing fixed native readback');return result.readback;
}
