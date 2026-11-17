import test from 'node:test';
import assert from 'node:assert/strict';
import {primaryReadback,routingReadPlan,routingReaderAccessPlan,assertRoutingReaderAccess,redactRoutingOperator,assertConfigurationReadback} from '../scripts/release/meta-routing-readback.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sha='a'.repeat(64);
const expected={tenantId:id(1),connectionId:id(2),sessionId:id(3),participantId:id(4),messageId:'wamid.synthetic.routing.initial',appId:'100003',phoneId:'100001',accountId:'100002',
 configurationVersion:1,reviewVersion:1,payloadSha256:sha,rawSha256:'b'.repeat(64),text:'Synthetic lineage'};
function fixture(){
 const row={tenant_id:id(1),connection_id:id(2),source_id:id(5),status:'PROCESSED',lease_id:null,processing_status:'COMPLETE',external_message_id:expected.messageId,
  payload_sha256:sha,meta_direct_asset:{providerSessionId:id(3),phoneNumberId:'100001',wabaId:'100002'},
  meta_routing_evidence:{appId:'100003',providerSessionId:id(3),accountId:'100002',phoneNumberId:'100001',category:'PRIMARY_MESSAGE',payloadSha256:sha},
  meta_routing_epoch:'1',message_text:expected.text,provider_metadata:{direct:true,zammad_customer_id:'41'},participant_id:id(4),
  alias_source_id:id(5),alias_source_sha256:sha,meta_direct_native_anchor:{participantId:id(4),payloadSha256:sha,nativeCustomerId:'41'},anchor_valid:true,
  zammad_ticket_id:'51',zammad_article_id:'61',zammad_customer_id:41,conversation_id:id(6),zammad_ticket_number:'101',ownership_source_id:id(5),source_hash:sha,
  allowed:true,claim:'OWN',epoch:'1',configuration_version:'1',review_version:'1'};
 return{row,native:{article:{id:61,ticket_id:51,body:expected.text},ticket:{id:51,customer_id:41}}};
}
test('actual-source reader cannot accept another tenant/message/hash or incomplete native lineage',()=>{
 const good=fixture();const result=primaryReadback(good.row,expected,good.native);assert.equal(result.nativeCompleted,true);assert.equal(result.sourceEventId,id(5));
 for(const mutate of [x=>x.row.tenant_id=id(9),x=>x.row.external_message_id='wamid.synthetic.stale.initial',x=>x.row.payload_sha256='f'.repeat(64),
  x=>x.row.meta_direct_asset.providerSessionId=id(9),x=>x.row.meta_routing_evidence.appId='99999',x=>x.row.meta_routing_evidence.payloadSha256='f'.repeat(64),
  x=>x.row.meta_routing_evidence.category='STANDBY_MESSAGE',x=>x.row.processing_status='PROCESSING',x=>x.row.lease_id=id(9),x=>x.row.anchor_valid=false,
  x=>x.row.meta_direct_native_anchor.nativeCustomerId='99',x=>x.native.article.ticket_id=99,x=>x.native.article.body='Different',x=>x.native.ticket.customer_id=99,
  x=>x.row.ownership_source_id=id(9),x=>x.row.allowed=false,x=>x.row.meta_routing_epoch='0',x=>x.row.review_version='2']){
  const bad=fixture();mutate(bad);assert.throws(()=>primaryReadback(bad.row,expected,bad.native));
 }
 // A later real message can retain the original ordinary alias anchor; importing
 // that message is never allowed to create or rewrite the anchor.
 const next=fixture();next.row.source_id=id(7);next.row.ownership_source_id=id(7);
 assert.equal(primaryReadback(next.row,expected,next.native).aliasSourceEventId,id(5));
});
test('finite SQL plans reject arbitrary read modes and bind exact tenant/source values',()=>{
 for(const kind of ['configuration','primary','thread']){const plan=routingReadPlan(kind,{...expected,conversationId:id(6),runtime:{mode:'SIMULATED'}});
  assert.deepEqual(plan.params.slice(0,3),[id(1),id(2),id(3)]);assert(plan.sql.includes('$1::uuid'));assert(!/\b(?:INSERT|UPDATE|DELETE)\b/u.test(plan.sql));}
 assert.throws(()=>routingReadPlan('arbitrary-sql',expected));assert.throws(()=>routingReadPlan('primary',{...expected,messageId:"'; SELECT secret"}));
 assert.throws(()=>routingReadPlan('configuration',{...expected,tenantId:'invalid'}));
});
test('operator projection keeps independent subject hash and omits raw subject from DEV relay',()=>{
 const rows=redactRoutingOperator([{review:{id:id(1),operator_subject:'platform-actor'}}],id(9));
 assert.equal(rows[0].review.operator_subject,undefined);assert.match(rows[0].review.operator_subject_sha256,/^[a-f0-9]{64}$/u);assert.equal(rows[0].review.operator_independent,true);
 assert.equal(redactRoutingOperator([{review:{operator_subject:id(9)}}],id(9))[0].review.operator_independent,false);
});
test('configuration reader requires current exact owner/operator/session/CAS evidence before OWN',()=>{
 const observation={observedAt:'2026-10-08T08:11:00.000Z'},runtime={mode:'SIMULATED'},ownerId=id(8);
 const want={...expected,ownerId,operatorSubject:'platform-actor',declarationKey:id(9),reviewKey:id(10),reviewId:id(11),observation,expectedRuntime:runtime,requireNoOwnership:true};
 const row={tenant_id:id(1),connection_id:id(2),session_id:id(3),phone_id:'100001',account_id:'100002',
  declaration:{declaredBy:ownerId,idempotencyKey:id(9),version:1,fallback:'HOLD',declaredAt:'2026-10-08T08:10:00.123Z'},declaration_audit_count:1,
  review:{id:id(11),operator_subject:'platform-actor',tenant_id:id(1),provider_session_id:id(3),phone_number_id:'100001',account_id:'100002',app_id:'100003',
   configuration_version:1,review_version:1,idempotency_key:id(10),disposition:'REVIEWED',observation,runtime_binding:runtime,observed_at:observation.observedAt},
  ownership_count:0,action_count:0,ordinary_count:0};
 assert.equal(assertConfigurationReadback(row,want),true);
 for(const mutate of [x=>x.declaration.declaredBy=id(9),x=>x.review.operator_subject=ownerId,x=>x.review.provider_session_id=id(9),x=>x.review.configuration_version=2,
  x=>x.review.runtime_binding.mode='LIVE',x=>x.review.observed_at='2026-10-08T08:10:00.000Z',x=>x.ownership_count=1,x=>x.declaration_audit_count=0]){
  const bad=structuredClone(row);mutate(bad);assert.throws(()=>assertConfigurationReadback(bad,want));
 }
});

test('actual app reader preflight requires existing read grants and keeps platform audit denied',()=>{
 const plan=routingReaderAccessPlan();assert.deepEqual(plan.params,[]);
 assert(!/\b(?:INSERT|UPDATE|DELETE|GRANT)\b/u.test(plan.sql));
 assert(plan.sql.includes("NOT has_table_privilege(current_user,'public.platform_operations_audit_events','SELECT')"));
 const row={current_role:'wasalx_runtime',session_role:'wasalx_runtime',app_member:true,restricted:true,platform_audit_denied:true,tables_readable:true,functions_executable:true};
 assert.equal(assertRoutingReaderAccess([row]),true);
 for(const key of Object.keys(row)){const bad={...row,[key]:typeof row[key]==='boolean'?false:'wasalx_platform_operator'};assert.throws(()=>assertRoutingReaderAccess([bad]));}
 assert.throws(()=>assertRoutingReaderAccess([]));assert.throws(()=>assertRoutingReaderAccess([row,row]));
});
