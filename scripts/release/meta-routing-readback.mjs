// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
// Run under the actual app reader before any journey mutation. This proves the
// fixed read plans' prerequisites without granting or reading platform audit data.
export function routingReaderAccessPlan(){return{params:[],sql:`SELECT current_user::text AS current_role,session_user::text AS session_role,
 pg_has_role(current_user,'wasalx_app','MEMBER') AS app_member,
 (SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS restricted,
 NOT has_table_privilege(current_user,'public.platform_operations_audit_events','SELECT') AS platform_audit_denied,
 (SELECT bool_and(has_table_privilege(current_user,'public.'||name,'SELECT')) FROM unnest(ARRAY[
 'provider_sessions','meta_routing_reviews','meta_thread_ownership','meta_thread_control_actions','normalized_messages','audit_events',
 'event_inbox','participant_identities','meta_direct_identity_aliases','message_links','bot_conversations','connections','bot_assignments','bot_handoff_jobs','bot_conversation_events']) name) AS tables_readable,
 (SELECT bool_and(has_function_privilege(current_user,name,'EXECUTE')) FROM unnest(ARRAY[
 'app.meta_direct_native_anchor_valid(uuid,uuid,text,boolean)',
 'app.meta_direct_routing_guard(uuid,uuid,text,text,uuid,text,jsonb,bigint,uuid[],uuid,boolean)',
 'app.webhook_event_id_sha256(uuid,uuid,text,text)']) name) AS functions_executable`};}
export function assertRoutingReaderAccess(rows){
 assert.equal(rows.length,1);const r=rows[0];assert.equal(r.current_role,'wasalx_runtime');assert.equal(r.session_role,'wasalx_runtime');
 for(const key of ['app_member','restricted','platform_audit_denied','tables_readable','functions_executable'])assert.equal(r[key],true,'Routing reader prerequisite: '+key);
 return true;
}
// Fixed SELECTs reused by the isolated stack and the existing admitted DEV guest.
// The caller supplies values only; the browser/relay never supplies SQL.
export function routingReadPlan(kind,x){
 for(const id of [x.tenantId,x.connectionId,x.sessionId])assert(uuid(id));
 const params=[x.tenantId,x.connectionId,x.sessionId];
 if(kind==='configuration')return{params,sql:`SELECT session.tenant_id,session.connection_id,session.id AS session_id,
  session.opaque_session_id AS phone_id,session.provider_state_data->>'wabaId' AS account_id,
  session.provider_state_data->'metaRouting' AS declaration,
  (SELECT to_jsonb(review)-'request_sha256' FROM meta_routing_reviews review WHERE review.tenant_id=session.tenant_id
   AND review.connection_id=session.connection_id ORDER BY review.review_version DESC LIMIT 1) AS review,
  (SELECT count(*)::integer FROM meta_thread_ownership item WHERE item.tenant_id=session.tenant_id AND item.connection_id=session.connection_id) AS ownership_count,
  (SELECT count(*)::integer FROM meta_thread_control_actions item WHERE item.tenant_id=session.tenant_id AND item.connection_id=session.connection_id) AS action_count,
  (SELECT count(*)::integer FROM normalized_messages item WHERE item.tenant_id=session.tenant_id AND item.connection_id=session.connection_id) AS ordinary_count,
  (SELECT count(*)::integer FROM audit_events audit WHERE audit.tenant_id=session.tenant_id AND audit.target_id=session.connection_id::text
    AND audit.action='meta.routing.declared' AND audit.actor_id::text=session.provider_state_data#>>'{metaRouting,declaredBy}') AS declaration_audit_count
  FROM provider_sessions session WHERE session.tenant_id=$1::uuid AND session.connection_id=$2::uuid AND session.id=$3::uuid AND session.ownership_state='ACTIVE'`};
 if(kind==='primary'){
  assert(typeof x.messageId==='string'&&/^wamid\.synthetic\.[A-Za-z0-9_-]+\.(initial|new)$/u.test(x.messageId));
  assert(typeof x.appId==='string'&&/^[0-9]{1,32}$/u.test(x.appId));params.push(x.messageId,x.appId,JSON.stringify(x.runtime));
  return{params,sql:`SELECT source.tenant_id,source.connection_id,source.id AS source_id,source.status,source.lease_id,
   source.payload_sha256,source.meta_direct_asset,source.meta_routing_evidence,source.meta_routing_epoch,
   message.external_message_id,message.external_participant_id,message.message_text,message.processing_status,message.provider_metadata,
   participant.id AS participant_id,alias.source_event_id AS alias_source_id,alias.source_payload_sha256 AS alias_source_sha256,
   anchor.meta_direct_native_anchor,app.meta_direct_native_anchor_valid(anchor.id,participant.id,conversation.zammad_customer_id::text,true) AS anchor_valid,
   link.zammad_ticket_id,link.zammad_article_id,conversation.id AS conversation_id,conversation.zammad_ticket_number,
   conversation.zammad_customer_id,ownership.source_event_id AS ownership_source_id,ownership.source_hash,
   guard.allowed,guard.claim,guard.epoch,guard.configuration_version,guard.review_version
   FROM event_inbox source JOIN normalized_messages message ON message.tenant_id=source.tenant_id AND message.event_inbox_id=source.id
   JOIN participant_identities participant ON participant.tenant_id=message.tenant_id AND participant.connection_id=message.connection_id
    AND participant.external_participant_id=message.external_participant_id
   JOIN meta_direct_identity_aliases alias ON alias.tenant_id=participant.tenant_id AND alias.connection_id=participant.connection_id AND alias.participant_identity_id=participant.id
    AND alias.provider_session_id=$3::uuid AND alias.kind='PHONE' AND alias.state='ACTIVE'
   JOIN event_inbox anchor ON anchor.tenant_id=alias.tenant_id AND anchor.id=alias.source_event_id
   JOIN message_links link ON link.tenant_id=message.tenant_id AND link.connection_id=message.connection_id AND link.external_message_id=message.external_message_id
   JOIN bot_conversations conversation ON conversation.tenant_id=participant.tenant_id AND conversation.connection_id=participant.connection_id
    AND conversation.external_chat_id=participant.external_participant_id AND conversation.zammad_ticket_id=link.zammad_ticket_id
   JOIN meta_thread_ownership ownership ON ownership.tenant_id=participant.tenant_id AND ownership.connection_id=participant.connection_id
    AND ownership.provider_session_id=$3::uuid AND ownership.participant_identity_id=participant.id
   CROSS JOIN LATERAL app.meta_direct_routing_guard(source.connection_id,$3::uuid,source.meta_direct_asset->>'phoneNumberId',source.meta_direct_asset->>'wabaId',
    participant.id,$5::text,$6::jsonb,NULL,ARRAY[source.id],NULL,true) guard
   WHERE source.tenant_id=$1::uuid AND source.connection_id=$2::uuid AND source.provider='META' AND source.event_type='messages'
    AND source.provider_event_id_sha256=app.webhook_event_id_sha256($1::uuid,$2::uuid,'META',$4::text)
    AND message.external_message_id=$4::text AND message.provider_metadata->'direct'='true' AND source.meta_direct_identity_change IS NULL`};
 }
 assert.equal(kind,'thread');assert(uuid(x.conversationId));params.push(x.conversationId);
 return{params,sql:`SELECT conversation.id AS conversation_id,conversation.tenant_id,conversation.connection_id,
  jsonb_build_object('state',conversation.state,'humanEpoch',conversation.human_ownership_epoch,'humanPauseStartedAt',conversation.human_pause_started_at,
   'customerControl',conversation.customer_control,'connectionState',connection.state,'sessionState',session.state,
   'assignmentId',conversation.assignment_id,'assignmentState',assignment.state,'handoff',(SELECT jsonb_build_object('state',job.state,'ownerId',job.zammad_owner_id,'groupId',job.zammad_group_id)
    FROM bot_handoff_jobs job WHERE job.tenant_id=conversation.tenant_id AND job.conversation_id=conversation.id ORDER BY job.created_at DESC,job.id DESC LIMIT 1)) AS internal,
  conversation.zammad_ticket_id,conversation.fencing_token,
  (SELECT count(*)::integer FROM bot_conversation_events event WHERE event.tenant_id=conversation.tenant_id AND event.conversation_id=conversation.id AND event.event_kind='RESUMED') AS resumed_count,
  ownership.state AS claim,ownership.epoch,
  (SELECT count(*)::integer FROM meta_thread_control_actions action WHERE action.tenant_id=conversation.tenant_id AND action.connection_id=conversation.connection_id
   AND action.state IN('RUNNING','OUTCOME_UNKNOWN')) AS unresolved_actions,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',action.id,'idempotency_key',action.idempotency_key,'action',action.action,'target_role',action.target_role,
   'state',action.state,'provider_request_id',action.provider_request_id,'actor_id',action.actor_id) ORDER BY action.created_at,action.id)
   FROM meta_thread_control_actions action WHERE action.tenant_id=conversation.tenant_id AND action.conversation_id=conversation.id),'[]') AS actions
  FROM bot_conversations conversation JOIN connections connection ON connection.tenant_id=conversation.tenant_id AND connection.id=conversation.connection_id
  JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id AND session.id=$3::uuid
  JOIN bot_assignments assignment ON assignment.tenant_id=conversation.tenant_id AND assignment.id=conversation.assignment_id
  JOIN participant_identities participant ON participant.tenant_id=conversation.tenant_id AND participant.connection_id=conversation.connection_id AND participant.external_participant_id=conversation.external_chat_id
  JOIN meta_thread_ownership ownership ON ownership.tenant_id=participant.tenant_id AND ownership.connection_id=participant.connection_id AND ownership.participant_identity_id=participant.id AND ownership.provider_session_id=session.id
  WHERE conversation.tenant_id=$1::uuid AND conversation.connection_id=$2::uuid AND conversation.id=$4::uuid`};
}

export function assertConfigurationReadback(row,expected){
 assert(row);assert.equal(row.tenant_id,expected.tenantId);assert.equal(row.connection_id,expected.connectionId);assert.equal(row.session_id,expected.sessionId);
 assert.equal(row.phone_id,expected.phoneId);assert.equal(row.account_id,expected.accountId);
 assert.equal(row.declaration.declaredBy,expected.ownerId);assert.equal(row.declaration.idempotencyKey,expected.declarationKey);
 assert.equal(row.declaration.version,expected.configurationVersion);assert.equal(row.declaration.fallback,'HOLD');assert.equal(row.declaration_audit_count,1);
 assert.equal(row.review.id,expected.reviewId);
 if(expected.operatorSubjectSha256){
  assert.equal(row.review.operator_subject_sha256,expected.operatorSubjectSha256);assert.equal(row.review.operator_independent,true);
 }else{assert.equal(row.review.operator_subject,expected.operatorSubject);assert.notEqual(row.review.operator_subject,expected.ownerId);}
 assert.equal(row.review.tenant_id,expected.tenantId);assert.equal(row.review.provider_session_id,expected.sessionId);
 assert.equal(row.review.phone_number_id,expected.phoneId);assert.equal(row.review.account_id,expected.accountId);assert.equal(row.review.app_id,expected.appId);
 assert.equal(Number(row.review.configuration_version),expected.configurationVersion);assert.equal(Number(row.review.review_version),expected.reviewVersion);
 assert.equal(row.review.idempotency_key,expected.reviewKey);assert.equal(row.review.disposition,'REVIEWED');assert.deepEqual(row.review.observation,expected.observation);
 assert.deepEqual(row.review.runtime_binding,expected.expectedRuntime);assert(Date.parse(row.review.observed_at)>=Date.parse(row.declaration.declaredAt));
 if(expected.requireNoOwnership){assert.equal(row.ownership_count,0);assert.equal(row.action_count,0);assert.equal(row.ordinary_count,0);}
 return true;
}

export function redactRoutingOperator(rows,ownerId){
 return rows.map(row=>{if(!row.review)return row;const subject=row.review.operator_subject;assert(typeof subject==='string'&&subject.length>0);
  const {operator_subject,...review}=row.review;void operator_subject;
  return{...row,review:{...review,operator_subject_sha256:createHash('sha256').update(subject).digest('hex'),operator_independent:subject!==ownerId}};});
}

export function primaryReadback(row,expected,native){
 assert.equal(row.tenant_id,expected.tenantId);assert.equal(row.connection_id,expected.connectionId);
 assert.equal(row.external_message_id,expected.messageId);assert.equal(row.payload_sha256,expected.payloadSha256);
 assert.deepEqual(row.meta_direct_asset,{providerSessionId:expected.sessionId,phoneNumberId:expected.phoneId,wabaId:expected.accountId});
 const e=row.meta_routing_evidence;assert.equal(e.appId,expected.appId);assert.equal(e.providerSessionId,expected.sessionId);
 assert.equal(e.accountId,expected.accountId);assert.equal(e.phoneNumberId,expected.phoneId);assert.equal(e.category,'PRIMARY_MESSAGE');
 assert.equal(e.payloadSha256,expected.payloadSha256);assert.equal(row.source_hash,expected.payloadSha256);
 assert.equal(row.message_text,expected.text);assert.equal(row.processing_status,'COMPLETE');assert.equal(row.status,'PROCESSED');assert.equal(row.lease_id,null);
 assert.equal(row.anchor_valid,true);assert.equal(row.meta_direct_native_anchor.participantId,row.participant_id);
 assert.equal(row.meta_direct_native_anchor.payloadSha256,row.alias_source_sha256);
 assert.equal(row.meta_direct_native_anchor.nativeCustomerId,String(row.zammad_customer_id));
 assert.equal(String(row.provider_metadata.zammad_customer_id),String(row.zammad_customer_id));
 assert.equal(String(native.article.id),String(row.zammad_article_id));assert.equal(String(native.article.ticket_id),String(row.zammad_ticket_id));
 assert.equal(String(native.article.body).replace(/<[^>]*>/gu,'').trim(),expected.text);
 assert.equal(String(native.ticket.id),String(row.zammad_ticket_id));assert.equal(String(native.ticket.customer_id),String(row.zammad_customer_id));
 assert.equal(row.ownership_source_id,row.source_id);assert.equal(row.allowed,true);assert.equal(row.claim,'OWN');
 assert.equal(Number(row.configuration_version),expected.configurationVersion);assert.equal(Number(row.review_version),expected.reviewVersion);
 assert.equal(Number(row.meta_routing_epoch),Number(row.epoch));
 return{ordinarySourceProcessed:true,tenantId:row.tenant_id,messageId:row.external_message_id,payloadSha256:row.payload_sha256,rawSha256:expected.rawSha256,
  nativeCompleted:true,connectionId:row.connection_id,sessionId:expected.sessionId,configurationVersion:Number(row.configuration_version),reviewVersion:Number(row.review_version),
  category:e.category,claim:row.claim,allowed:row.allowed,epoch:Number(row.epoch),participantId:row.participant_id,sourceEventId:row.source_id,
  aliasSourceEventId:row.alias_source_id,ownershipSourceEventId:row.ownership_source_id,ordinaryNormalizedCount:1,nativeSourceLinkCount:1,
  importAuthorityUsed:false,internalControlMutatedByRouting:false,conversationId:row.conversation_id,ticketNumber:row.zammad_ticket_number};
}
