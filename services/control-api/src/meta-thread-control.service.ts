import { BadRequestException,ConflictException,ForbiddenException,Injectable,NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { MetaThreadActionDto,MetaThreadRoutingDto,MetaRoutingAction,MetaThreadControlCommand } from '@wasalx/core/meta-routing-contract';
import { assertMetaDirectEffectCurrent } from '@wasalx/core/meta-direct-identity';
import { assertMetaCredentialProof } from '@wasalx/core/meta-account-relation';
import { META_ROUTING_ROLES,metaRoutingRuntime,type MetaRoutingRole } from '@wasalx/core/meta-routing';
import { DatabaseService } from './database.service.js';
import { MetaCredentialService } from './meta-credential.service.js';
import { MetaGraphClientError,MetaGroupsClientFactory } from './meta-groups.client.js';
import { routingHash,routingId,routingKey,routingOrigin,routingWriterCurrent } from './meta-routing.service.js';
import { requirePrivilegedAuthentication } from './privileged-auth.js';
import { appendAudit } from './audit.js';
import { can,type TenantRole } from './rbac.js';
import type { AuthenticatedRequest } from './types.js';

type ActionInput=MetaThreadControlCommand;
type Action={id:string;tenant_id:string;connection_id:string;conversation_id:string;participant_identity_id:string;provider_session_id:string;phone_number_id:string;account_id:string;app_id:string;
 action:ActionInput['action'];target_role:MetaRoutingRole|null;routing_epoch:string;configuration_version:string;review_version:string;recipient_snapshot:{kind:'PHONE'|'BSUID';value:string};
 request_sha256:string;actor_id:string;state:'RUNNING'|'SUCCEEDED'|'FAILED'|'OUTCOME_UNKNOWN';dispatched_at:Date|null;completed_at:Date|null;provider_request_id:string|null;error_code:string|null};
type Context={connection_id:string;provider_session_id:string;phone_number_id:string;account_id:string;secret_reference:string;proof:unknown;participant_identity_id:string;configuration_version:string;review_version:string};
const view=(action:Action):MetaThreadActionDto=>({id:action.id,action:action.action,targetRole:action.target_role,state:action.state,requestId:action.provider_request_id,reason:action.error_code,retryable:false});
function input(value:unknown):ActionInput{
 const v=value as Partial<ActionInput>|null;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['action','targetRole','expectedRoutingEpoch','expectedConfigurationVersion','expectedReviewVersion'].includes(k))
  ||typeof v.action!=='string'||!['take','pass','release'].includes(v.action)
  ||(v.targetRole!==undefined&&(v.action!=='pass'||!META_ROUTING_ROLES.includes(v.targetRole)))
  ||!['expectedRoutingEpoch','expectedConfigurationVersion','expectedReviewVersion'].every(k=>typeof v[k as keyof ActionInput]==='number'&&Number.isSafeInteger(v[k as keyof ActionInput])&&Number(v[k as keyof ActionInput])>=0))throw new BadRequestException('Thread control request is invalid');
 return{action:v.action as ActionInput['action'],...(v.targetRole===undefined?{}:{targetRole:v.targetRole}),
  expectedRoutingEpoch:v.expectedRoutingEpoch!,expectedConfigurationVersion:v.expectedConfigurationVersion!,expectedReviewVersion:v.expectedReviewVersion!};
}

@Injectable()
export class MetaThreadControlService {
 constructor(private readonly database:DatabaseService,private readonly credentials:MetaCredentialService,private readonly clients:MetaGroupsClientFactory){}

 async inspect(request:AuthenticatedRequest,conversationId:string,key?:unknown):Promise<MetaThreadRoutingDto>{
  routingId(conversationId);const selectedKey=key===undefined?undefined:routingKey(key);
  return this.database.withTenant(request.principal.tenantId,async client=>{
   const context=await this.context(client,request.principal.tenantId,conversationId);
   await this.expire(client,request.principal.tenantId,context.connection_id);
   const ownership=(await client.query(`SELECT guard.allowed,guard.epoch,guard.claim,guard.reason,guard.configuration_version,guard.review_version
    FROM app.meta_direct_routing_guard($1,$2,$3,$4,$5,$6,$7::jsonb) guard`,
    [context.connection_id,context.provider_session_id,context.phone_number_id,context.account_id,context.participant_identity_id,process.env.META_APP_ID??'',JSON.stringify(metaRoutingRuntime(process.env))])).rows[0];
   const actions=(await client.query<Action>('SELECT * FROM meta_thread_control_actions WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 20',[request.principal.tenantId,conversationId])).rows;
   let correlation:MetaThreadRoutingDto['correlation']=null;
   if(selectedKey!==undefined){
    const original=(await client.query<Action>('SELECT * FROM meta_thread_control_actions WHERE tenant_id=$1 AND idempotency_key=$2',[request.principal.tenantId,selectedKey])).rows[0];
    correlation={state:'ABSENT'};
    if(original){
     if(original.connection_id!==context.connection_id||original.conversation_id!==conversationId||original.actor_id!==request.principal.userId)throw new ConflictException('Thread control correlation is unavailable');
     const command:MetaThreadControlCommand={action:original.action,...(original.target_role===null?{}:{targetRole:original.target_role}),expectedRoutingEpoch:Number(original.routing_epoch),expectedConfigurationVersion:Number(original.configuration_version),expectedReviewVersion:Number(original.review_version)};
     if(original.request_sha256!==routingHash({actorId:request.principal.userId,conversationId,command}))throw new ConflictException('Thread control correlation is unavailable');
     correlation={state:'MATCHED',action:view(original),command};
    }
   }
   const availability=(await client.query<{allowed:boolean;roles:MetaRoutingRole[];targets:MetaRoutingRole[];enabled:boolean}>(`SELECT guard.allowed,review.observation->'roles' AS roles,
      review.observation->'targets' AS targets,review.observation->'threadControlEnabled'='true'::jsonb AS enabled
     FROM app.meta_direct_routing_guard($1,$2,$3,$4,$5,$6,$7::jsonb,NULL,NULL,NULL,false) guard
     JOIN meta_routing_reviews review ON review.tenant_id=$8 AND review.connection_id=$1 AND review.review_version=guard.review_version
     WHERE guard.claim NOT IN('LEGACY_COMPATIBILITY','PRIMARY_DELIVERY')`,[context.connection_id,context.provider_session_id,context.phone_number_id,context.account_id,context.participant_identity_id,process.env.META_APP_ID??'',JSON.stringify(metaRoutingRuntime(process.env)),request.principal.tenantId])).rows[0];
   const member=(await client.query<{role:TenantRole}>("SELECT member.role FROM tenant_memberships member JOIN tenants tenant ON tenant.id=member.tenant_id WHERE member.tenant_id=$1 AND member.user_id=$2 AND member.state='ACTIVE' AND tenant.state='ACTIVE'",[request.principal.tenantId,request.principal.userId])).rows[0];
   const eligible:MetaRoutingAction[]=[],targets:MetaRoutingRole[]=availability?.targets??[];
   const usable=availability?.allowed===true&&availability.enabled===true&&!!member&&can(member.role,'connection:write')&&can(member.role,'bot:operate');
   const escalation=availability?.roles.includes('escalation')===true;
   if(usable){if(escalation)eligible.push('take');if(ownership.allowed){if(targets.length||!escalation)eligible.push('pass');eligible.push('release')}}
   return{connectionId:context.connection_id,ownership:{allowed:ownership.allowed,epoch:ownership.epoch===null?null:Number(ownership.epoch),claim:ownership.claim,reason:ownership.reason,configurationVersion:Number(ownership.configuration_version),reviewVersion:Number(ownership.review_version)},actions:actions.map(view),
    availability:{actions:eligible,passTargets:eligible.includes('pass')?targets:[],untargetedPass:eligible.includes('pass')&&!escalation,admission:'ROUTING_SNAPSHOT_ONLY',currentnessRecheckedAtExecution:true},correlation,internalOwnershipUnchanged:true,reconciliation:'ORIGINAL_PROVIDER_EVIDENCE_REQUIRED'};
  });
 }
 async execute(request:AuthenticatedRequest,conversationId:string,key:unknown,body:unknown):Promise<MetaThreadActionDto>{
  routingOrigin(request);
  if(!can(request.principal.role,'connection:write')||!can(request.principal.role,'bot:operate'))throw new ForbiddenException('Thread control requires connection and conversation authority');
  routingId(conversationId);const command=input(body),idempotencyKey=routingKey(key);
  const hash=routingHash({actorId:request.principal.userId,conversationId,command});
  const reservation=await this.database.withTenant(request.principal.tenantId,async client=>{
   await requirePrivilegedAuthentication(client,request.principal,'transferring Meta thread control');
   await routingWriterCurrent(client,request);
   const context=await this.context(client,request.principal.tenantId,conversationId);
   await this.expire(client,request.principal.tenantId,context.connection_id);
   const existing=(await client.query<Action>('SELECT * FROM meta_thread_control_actions WHERE tenant_id=$1 AND idempotency_key=$2',[request.principal.tenantId,idempotencyKey])).rows[0];
   if(existing){if(existing.request_sha256!==hash||existing.conversation_id!==conversationId||existing.actor_id!==request.principal.userId)throw new ConflictException('Idempotency key was reused');return{action:existing,replay:true,context}}
   const aliases=(await client.query<{kind:'PHONE'|'BSUID';value:string}>(`SELECT kind,value FROM meta_direct_identity_aliases WHERE tenant_id=$1 AND connection_id=$2
    AND participant_identity_id=$3 AND provider_session_id=$4 AND phone_number_id=$5 AND waba_id=$6 AND state='ACTIVE' ORDER BY CASE kind WHEN 'BSUID' THEN 0 ELSE 1 END FOR SHARE`,
    [request.principal.tenantId,context.connection_id,context.participant_identity_id,context.provider_session_id,context.phone_number_id,context.account_id])).rows;
   if(!aliases.length)throw new ConflictException('Thread control identity requires verification');
   if(Number(context.configuration_version)!==command.expectedConfigurationVersion||Number(context.review_version)!==command.expectedReviewVersion)throw new ConflictException('Routing configuration changed');
   const pending=await client.query("SELECT 1 FROM meta_thread_control_actions WHERE tenant_id=$1 AND connection_id=$2 AND participant_identity_id=$3 AND state IN('RUNNING','OUTCOME_UNKNOWN')",[request.principal.tenantId,context.connection_id,context.participant_identity_id]);
   if(pending.rowCount)throw new ConflictException('A prior thread control outcome requires reconciliation');
   const action=(await client.query<Action>(`INSERT INTO meta_thread_control_actions(id,tenant_id,connection_id,provider_session_id,participant_identity_id,conversation_id,phone_number_id,account_id,app_id,
    routing_epoch,configuration_version,review_version,action,target_role,recipient_snapshot,runtime_binding,actor_id,idempotency_key,request_sha256,credential_context)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [randomUUID(),request.principal.tenantId,context.connection_id,context.provider_session_id,context.participant_identity_id,conversationId,context.phone_number_id,context.account_id,process.env.META_APP_ID??'',
     command.expectedRoutingEpoch,command.expectedConfigurationVersion,command.expectedReviewVersion,command.action,command.targetRole??null,aliases[0],metaRoutingRuntime(process.env),request.principal.userId,idempotencyKey,hash,{secretReference:context.secret_reference,proof:context.proof}])).rows[0]!;
   await assertMetaDirectEffectCurrent(client,{tenantId:request.principal.tenantId,conversationId,connectionId:context.connection_id,appId:process.env.META_APP_ID??'',routingActionId:action.id});
   await appendAudit(client,request.principal,{action:'meta.thread_control.reserved',targetType:'meta_thread_control',targetId:action.id,requestId:String(request.id),newValue:{action:action.action,epoch:command.expectedRoutingEpoch}});
   return{action,replay:false,context};
  });
  if(reservation.replay)return view(reservation.action);
  const {action,context}=reservation;
  let response:{requestId:string}|undefined,error:unknown;
  try{
   const token=await this.credentials.resolveAccessToken(context.secret_reference,{tenantId:request.principal.tenantId,connectionId:context.connection_id});
   if(!assertMetaCredentialProof(context.proof,{appId:process.env.META_APP_ID??'',accessToken:token}))throw new ConflictException('Thread control credential proof is unavailable');
   const client=this.clients.create(token,context.phone_number_id,()=>this.database.withTenant(request.principal.tenantId,async db=>{
    await routingWriterCurrent(db,request);
    await db.query('SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[request.principal.tenantId,context.connection_id]);
    await requirePrivilegedAuthentication(db,request.principal,'transferring Meta thread control');
    await assertMetaDirectEffectCurrent(db,{tenantId:request.principal.tenantId,conversationId,connectionId:context.connection_id,appId:process.env.META_APP_ID??'',routingActionId:action.id});
    const claimed=await db.query("UPDATE meta_thread_control_actions SET dispatched_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND state='RUNNING' AND dispatched_at IS NULL AND expires_at>clock_timestamp()",[request.principal.tenantId,action.id]);
    if(claimed.rowCount!==1)throw new ConflictException('Thread control was already attempted');
   }));
   response=await client.threadControl(action.action,action.target_role??undefined,action.recipient_snapshot,action.id);
  }catch(caught){error=caught}
  try{return await this.database.withTenant(request.principal.tenantId,async client=>{
   // Current authority controls projection only. A known original receipt must
   // remain settleable even when its initiating actor or tenant is now inactive.
   let currentActor=false;
   if(response){
    await client.query('SAVEPOINT routing_receipt_actor');
    try{await routingWriterCurrent(client,request);currentActor=true}
    catch{await client.query('ROLLBACK TO SAVEPOINT routing_receipt_actor')}
    await client.query('RELEASE SAVEPOINT routing_receipt_actor');
   }
   await client.query('SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[request.principal.tenantId,context.connection_id]);
   const current=(await client.query<Action>("SELECT * FROM meta_thread_control_actions WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[request.principal.tenantId,action.id])).rows[0]!;
   if(current.state==='SUCCEEDED'||current.state==='FAILED')return view(current);
   const knownFailure=current.dispatched_at===null||error instanceof MetaGraphClientError&&error.outcomeKnown===true;
   if(current.state==='OUTCOME_UNKNOWN'&&!response&&!knownFailure)return view(current);
   let currentAuthority=false;
   if(response&&currentActor&&current.state==='RUNNING'){
    await client.query('SAVEPOINT routing_receipt_authority');
    try{await assertMetaDirectEffectCurrent(client,{tenantId:request.principal.tenantId,conversationId,connectionId:context.connection_id,appId:process.env.META_APP_ID??'',routingActionId:action.id});currentAuthority=true}
    catch{await client.query('ROLLBACK TO SAVEPOINT routing_receipt_authority')}
    await client.query('RELEASE SAVEPOINT routing_receipt_authority');
   }
   const state=response?'SUCCEEDED':knownFailure?'FAILED':'OUTCOME_UNKNOWN';
   const completed=(await client.query<Action>(`UPDATE meta_thread_control_actions SET state=$1,provider_request_id=$2,error_code=$3,completed_at=clock_timestamp()
    WHERE tenant_id=$4 AND id=$5 AND state IN('RUNNING','OUTCOME_UNKNOWN') RETURNING *`,[state,response?.requestId??null,response?null:knownFailure?'META_THREAD_CONTROL_REJECTED':'META_THREAD_CONTROL_OUTCOME_UNKNOWN',request.principal.tenantId,action.id])).rows[0]!;
   if(response&&currentAuthority)await this.projectSuccess(client,completed);
   // Settling the original attempt is a system action, not new authority for
   // its initiating user. Keep that immutable attribution even after revocation.
   await client.query(`INSERT INTO audit_events
    (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
    VALUES($1,'SYSTEM','control-api','meta.thread_control.completed','meta_thread_control',$2,$3,$4)`,
    [completed.tenant_id,completed.id,{state,requestId:response?.requestId??null,initiatingActorId:completed.actor_id},String(request.id)]);
   return view(completed);
  })}catch{return{id:action.id,action:action.action,targetRole:action.target_role,requestId:null,state:'OUTCOME_UNKNOWN',reason:'META_THREAD_CONTROL_OUTCOME_UNKNOWN',retryable:false}}
 }

 private async context(client:PoolClient,tenantId:string,conversationId:string):Promise<Context>{
  const preliminary=(await client.query<{connection_id:string}>('SELECT connection_id FROM bot_conversations WHERE tenant_id=$1 AND id=$2',[tenantId,conversationId])).rows[0];
  if(!preliminary)throw new NotFoundException('Conversation was not found');
  await client.query('SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,preliminary.connection_id]);
  const rows=(await client.query<Context>(`SELECT conversation.connection_id,session.id AS provider_session_id,session.opaque_session_id AS phone_number_id,
   session.provider_state_data->>'wabaId' AS account_id,connection.secret_reference,session.provider_state_data->'metaAccountProof' AS proof,participant.id AS participant_identity_id,
   COALESCE(session.provider_state_data#>>'{metaRouting,version}','0') AS configuration_version,COALESCE(review.review_version,0) AS review_version
   FROM bot_conversations conversation JOIN connections connection ON connection.tenant_id=conversation.tenant_id AND connection.id=conversation.connection_id AND connection.provider='META'
   JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id AND session.ownership_state='ACTIVE'
   JOIN participant_identities participant ON participant.tenant_id=conversation.tenant_id AND participant.connection_id=conversation.connection_id AND participant.external_participant_id=conversation.external_chat_id
   LEFT JOIN LATERAL(SELECT item.review_version FROM meta_routing_reviews item WHERE item.tenant_id=connection.tenant_id AND item.connection_id=connection.id ORDER BY item.review_version DESC LIMIT 1) review ON true
   WHERE conversation.tenant_id=$1 AND conversation.id=$2`,[tenantId,conversationId])).rows;
  if(rows.length!==1)throw new ConflictException('Conversation routing identity is unavailable');return rows[0]!;
 }
 private async expire(client:PoolClient,tenantId:string,connectionId:string){
  await client.query("UPDATE meta_thread_control_actions SET state='OUTCOME_UNKNOWN',error_code='META_THREAD_CONTROL_OUTCOME_UNKNOWN',completed_at=clock_timestamp() WHERE tenant_id=$1 AND connection_id=$2 AND state='RUNNING' AND expires_at<=clock_timestamp()",[tenantId,connectionId]);
 }
 private async projectSuccess(client:PoolClient,action:Action){
  // A late receipt is historical fact, never permission to overwrite newer input.
  const newer=await client.query(`SELECT 1 FROM event_inbox source WHERE source.tenant_id=$1 AND source.connection_id=$2
   AND source.received_at>=(SELECT dispatched_at FROM meta_thread_control_actions WHERE tenant_id=$1 AND id=$3)
   AND source.meta_routing_evidence->>'providerSessionId'=$4
   AND source.meta_routing_evidence->>'category' IN('PRIMARY_MESSAGE','STANDBY_MESSAGE','CONTROL_PASSED','CONTROL_TAKEN','UNRESOLVED_ROUTING')
   AND(source.meta_routing_participant_id=$5 OR(source.meta_routing_evidence->>'category' IN('CONTROL_TAKEN','UNRESOLVED_ROUTING') AND source.meta_routing_evidence->'peer' IS NULL)
    OR EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id
     AND alias.participant_identity_id=$5 AND alias.kind=source.meta_routing_evidence#>>'{peer,kind}' AND alias.value=source.meta_routing_evidence#>>'{peer,value}')) LIMIT 1`,
   [action.tenant_id,action.connection_id,action.id,action.provider_session_id,action.participant_identity_id]);
  const prior=(await client.query<{epoch:string}>('SELECT epoch FROM meta_thread_ownership WHERE tenant_id=$1 AND connection_id=$2 AND provider_session_id=$3 AND participant_identity_id=$4 FOR UPDATE',
   [action.tenant_id,action.connection_id,action.provider_session_id,action.participant_identity_id])).rows[0];
  const changed=newer.rowCount!==0||Number(prior?.epoch??0)!==Number(action.routing_epoch);
  const state=changed?'UNKNOWN':action.action==='take'?'OWN':action.action==='pass'?'STANDBY':'IDLE';
  // Existing ownership must take the UPDATE trigger path. Preserve its exact
  // customer-message window; a successful action cannot create or refresh it.
  const projected=await client.query(prior?`UPDATE meta_thread_ownership ownership SET state=$7,epoch=$8,configuration_version=$9,review_version=$10,
   observed_at=receipt.completed_at,epoch_started_at=receipt.completed_at,source_hash=$11,source_action_id=$12,source_event_id=NULL
   FROM meta_thread_control_actions receipt WHERE ownership.tenant_id=$1 AND ownership.connection_id=$2 AND ownership.provider_session_id=$3
    AND ownership.participant_identity_id=$4 AND ownership.phone_number_id=$5 AND ownership.account_id=$6 AND receipt.tenant_id=$1 AND receipt.id=$12`
   :`INSERT INTO meta_thread_ownership(tenant_id,connection_id,provider_session_id,participant_identity_id,phone_number_id,account_id,state,epoch,configuration_version,review_version,
    observed_at,epoch_started_at,last_customer_message_at,source_hash,source_action_id)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,receipt.completed_at,receipt.completed_at,NULL,$11,$12
    FROM meta_thread_control_actions receipt WHERE receipt.tenant_id=$1 AND receipt.id=$12`,
    [action.tenant_id,action.connection_id,action.provider_session_id,action.participant_identity_id,action.phone_number_id,action.account_id,state,Number(prior?.epoch??0)+1,
     action.configuration_version,action.review_version,action.request_sha256,action.id]);
  if(projected.rowCount!==1)throw new ConflictException('Thread control projection changed');
 }
}
