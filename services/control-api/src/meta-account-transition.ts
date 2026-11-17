import {BadRequestException,ConflictException,ForbiddenException,NotFoundException} from '@nestjs/common';
import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {metaTransitionContext,type MetaTransitionContext} from '@wasalx/core/meta-account-transition-context';
import {parseMetaTransitionPreviewRequest,parseMetaTransitionPreviewAction,parseMetaTransitionExecutionActionRequest,type MetaTransitionExecutionAction,type MetaTransitionExecutionView,type MetaTransitionExecutionActionResult,type MetaTransitionExecutionResolutionResult,type MetaTransitionPreviewView,type MetaTransitionPreviewPage} from '@wasalx/core/meta-account-transition-contract';
import {publicMetaTransitionObservation} from '@wasalx/core/meta-account-transition-observation';

type Actor={tenantId:string;connectionId:string;userId:string;appId:string;requestId:string};
type Plan={execution_state:string;id:string;revision:string;state:string;source_account_id:string;initiating_connection_id:string;requested_mode:'CUSTOMER'|'WASALX_MANAGED';
  target_currency:string;request_sha256:string;current_observation_operation_id:string;observed_at:Date|null;expires_at:Date|null;result:Record<string,unknown>|null;operation_state:string;observation_payload:Record<string,unknown>;};
const safeHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict=()=>new ConflictException({code:'META_TRANSITION_CONTEXT_CHANGED',message:'Refresh the connected account before continuing.'});
function parse<T>(parser:(body:unknown)=>T,body:unknown):T{try{return parser(body);}catch{throw new BadRequestException({code:'META_TRANSITION_REQUEST_INVALID',message:'Review the requested payment mode and currency.'});}}
/** Shared local authority for create, refresh and cancel; no provider proof is required. */
export async function assertMetaTransitionWriter(client:PoolClient,actor:Pick<Actor,'tenantId'|'userId'>){
  const active=(await client.query<{active:boolean}>('SELECT app.lock_current_active_tenant_for_event_admission() AS active')).rows[0]?.active;
  if(active!==true)throw new ForbiddenException('The workspace is unavailable.');
  const member=await client.query(`SELECT 1 FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2
    AND state='ACTIVE' AND role IN('tenant_owner','tenant_admin') FOR SHARE`,[actor.tenantId,actor.userId]);
  if(member.rowCount!==1)throw new ForbiddenException('Current connection administration permission is required.');
}
async function context(client:PoolClient,actor:Actor):Promise<MetaTransitionContext>{
  const raw=(await client.query<{value:unknown}>('SELECT app.meta_account_transition_context($1,$2,$3) AS value',[actor.connectionId,actor.userId,actor.appId])).rows[0]?.value;
  try{return metaTransitionContext(raw,{tenantId:actor.tenantId,connectionId:actor.connectionId,actorId:actor.userId,appId:actor.appId});}catch{throw conflict();}}
function payload(id:string,revision:number,ctx:MetaTransitionContext){return{metaAccountTransition:{id,revision,accountId:ctx.accountId,
  bindingId:ctx.bindingId,accountRevision:ctx.accountRevision,bindingRevision:ctx.bindingRevision,scopeSha256:ctx.scopeSha256,
  appId:ctx.appId,impactConnectionIds:ctx.connectionIds}};}
async function queue(client:PoolClient,actor:Actor,key:string,id:string,revision:number,ctx:MetaTransitionContext,requestRevision?:number){
  if((await client.query("SELECT 1 FROM connection_operations WHERE tenant_id=$1 AND connection_id=$2 AND state IN ('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE') LIMIT 1",[actor.tenantId,actor.connectionId])).rowCount)
    throw new ConflictException('A connection operation is already pending.');
  const requestPayload=payload(id,revision,ctx);
  if(requestRevision!==undefined)Object.assign(requestPayload.metaAccountTransition,{requestRevision});
  return (await client.query(`INSERT INTO connection_operations(tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,requested_by_id,request_id,max_attempts)
    VALUES($1,$2,'PREVIEW_META_ACCOUNT_TRANSITION',$3,$4,'USER',$5,$6,1) RETURNING *`,
    [actor.tenantId,actor.connectionId,key,requestPayload,actor.userId,actor.requestId])).rows[0];}

export async function requestMetaTransitionPreview(client:PoolClient,actor:Actor,key:string,body:unknown){
  const request=parse(parseMetaTransitionPreviewRequest,body),ctx=await context(client,actor);
  const requestSha=safeHash({connectionId:actor.connectionId,...request});
  const replay=(await client.query<{id:string;request_sha256:string;current_observation_operation_id:string}>(
    'SELECT id,request_sha256,current_observation_operation_id FROM meta_account_transitions WHERE tenant_id=$1 AND idempotency_key=$2',[actor.tenantId,key])).rows[0];
  if(replay){if(replay.request_sha256!==requestSha)throw new ConflictException('This request key belongs to another preview.');
    return{id:replay.id,operationId:replay.current_observation_operation_id,duplicate:true};}
  if(request.expectedAccountRevision!==ctx.accountRevision||request.expectedBindingRevision!==ctx.bindingRevision)throw conflict();
  if((await client.query('SELECT 1 FROM meta_account_transitions WHERE tenant_id=$1 AND source_account_id=$2 AND state<>\'CANCELLED\' AND execution_state<>\'RECONCILED_PAUSED\'',[actor.tenantId,ctx.accountId])).rowCount)
    throw new ConflictException({code:'META_TRANSITION_ALREADY_OPEN',message:'Review the existing account preview first.'});
  const id=randomUUID(),operation=await queue(client,actor,key,id,1,ctx);
  await client.query(`INSERT INTO meta_account_transitions(id,tenant_id,source_account_id,initiating_connection_id,initiating_binding_id,requested_by,
    requested_mode,target_currency,request_sha256,idempotency_key,initial_account_revision,initial_binding_revision,current_observation_operation_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,actor.tenantId,ctx.accountId,actor.connectionId,ctx.bindingId,actor.userId,
      request.requestedMode,request.targetCurrency,requestSha,key,ctx.accountRevision,ctx.bindingRevision,operation.id]);
  return{id,operationId:operation.id,operation,duplicate:false};
}

export async function refreshMetaTransitionPreview(client:PoolClient,actor:Actor,id:string,key:string,body:unknown){
  const {expectedRevision}=parse(parseMetaTransitionPreviewAction,body),ctx=await context(client,actor);
  const plan=(await client.query<Plan>(`SELECT * FROM meta_account_transitions WHERE tenant_id=$1 AND id=$2 AND source_account_id=$3 AND transition_kind='CURRENCY' FOR UPDATE`,[actor.tenantId,id,ctx.accountId])).rows[0];
  if(!plan)throw new NotFoundException('Preview not found.');
  const replay=(await client.query<{id:string;connection_id:string;operation_type:string;requested_by_id:string;payload:Record<string,unknown>}>('SELECT id,connection_id,operation_type,requested_by_id,payload FROM connection_operations WHERE tenant_id=$1 AND idempotency_key=$2',[actor.tenantId,key])).rows[0];
  if(replay){const p=replay.payload.metaAccountTransition as {id?:unknown;requestRevision?:unknown}|undefined;
    if(p?.id!==id||p.requestRevision!==expectedRevision||replay.connection_id!==actor.connectionId
      ||replay.requested_by_id!==actor.userId||replay.operation_type!=='PREVIEW_META_ACCOUNT_TRANSITION')throw new ConflictException('This request key belongs to another action.');
    return{id,operationId:replay.id,duplicate:true};}
  if(plan.execution_state!=='UNPREPARED'||plan.state==='CANCELLED'||Number(plan.revision)!==expectedRevision)throw conflict();
  const current=(await client.query<{state:string}>('SELECT state FROM connection_operations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[actor.tenantId,plan.current_observation_operation_id])).rows[0];
  if(current&&['QUEUED','RUNNING','FAILED_RETRYABLE'].includes(current.state))throw new ConflictException('The account preview is still being checked.');
  const revision=expectedRevision+1,operation=await queue(client,actor,key,id,revision,ctx,expectedRevision);
  await client.query("UPDATE meta_account_transitions SET revision=$1,state='PENDING',current_observation_operation_id=$2,observed_at=NULL,expires_at=NULL,updated_at=now() WHERE tenant_id=$3 AND id=$4",[revision,operation.id,actor.tenantId,id]);
  return{id,operationId:operation.id,operation,duplicate:false};
}

export async function cancelMetaTransitionPreview(client:PoolClient,actor:Actor,id:string,body:unknown){
  const {expectedRevision}=parse(parseMetaTransitionPreviewAction,body);
  // Cancellation deliberately needs local role/privacy scope, not fresh provider credentials.
  const plan=(await client.query<Plan>(`SELECT p.* FROM meta_account_transitions p JOIN meta_connection_account_bindings b
    ON b.tenant_id=p.tenant_id AND b.account_id=p.source_account_id WHERE p.tenant_id=$1 AND p.id=$2 AND b.connection_id=$3 AND p.transition_kind='CURRENCY' FOR UPDATE OF p`,[actor.tenantId,id,actor.connectionId])).rows[0];
  if(!plan)throw new NotFoundException('Preview not found.');
  if(plan.state==='CANCELLED'){
    if(Number(plan.revision)!==expectedRevision+1)throw conflict();
    return{id,duplicate:true};
  }
  if(plan.execution_state!=='UNPREPARED'){
    const value=(await client.query<{value:{id:string;duplicate:boolean}}>('SELECT app.cancel_meta_transition_execution($1,$2,$3,$4) AS value',
      [id,actor.connectionId,actor.userId,expectedRevision])).rows[0]?.value;
    if(!value)throw conflict();return value;
  }
  if(Number(plan.revision)!==expectedRevision)throw conflict();
  await client.query(`UPDATE connection_operations SET state='CANCELLED',completed_at=now(),updated_at=now(),lease_id=NULL,lease_expires_at=NULL
    WHERE tenant_id=$1 AND id=$2 AND operation_type='PREVIEW_META_ACCOUNT_TRANSITION' AND state IN ('QUEUED','FAILED_RETRYABLE')`,[actor.tenantId,plan.current_observation_operation_id]);
  await client.query("UPDATE meta_account_transitions SET state='CANCELLED',revision=revision+1,cancelled_at=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2",[actor.tenantId,id]);
  return{id,duplicate:false};
}

export async function readMetaTransitionPage(client:PoolClient,actor:Pick<Actor,'tenantId'|'connectionId'|'userId'>):Promise<MetaTransitionPreviewPage>{
  const connection=(await client.query<{provider:string}>('SELECT provider FROM connections WHERE tenant_id=$1 AND id=$2',[actor.tenantId,actor.connectionId])).rows[0];
  if(!connection)throw new NotFoundException('Connection not found.');
  if(connection.provider!=='META')throw new BadRequestException('Account previews require a Meta connection.');
  const row=(await client.query<{account_revision:string;binding_revision:string}>(`SELECT a.authority_revision AS account_revision,b.revision AS binding_revision
    FROM meta_connection_account_bindings b JOIN meta_messaging_accounts a ON a.tenant_id=b.tenant_id AND a.id=b.account_id
    WHERE b.tenant_id=$1 AND b.connection_id=$2 AND b.state='ACTIVE' AND a.state<>'RETIRED'
      AND NOT EXISTS(SELECT 1 FROM meta_account_transitions p WHERE p.tenant_id=a.tenant_id AND p.source_account_id=a.id
        AND p.transition_kind='TEMPLATE_PREPARATION' AND p.state<>'CANCELLED')`,[actor.tenantId,actor.connectionId])).rows[0];
  return{prepare:row?{accountRevision:Number(row.account_revision),bindingRevision:Number(row.binding_revision)}:null,
    currentPlan:await readMetaTransitionPreview(client,actor)};
}

export async function readMetaTransitionPreview(client:PoolClient,actor:Pick<Actor,'tenantId'|'connectionId'|'userId'>,id?:string):Promise<MetaTransitionPreviewView|null>{
  const plan=(await client.query<Plan>(`SELECT p.*,o.result,o.state AS operation_state,o.payload AS observation_payload FROM meta_account_transitions p
    JOIN meta_connection_account_bindings b ON b.tenant_id=p.tenant_id AND b.account_id=p.source_account_id
    JOIN connection_operations o ON o.tenant_id=p.tenant_id AND o.id=p.current_observation_operation_id
    WHERE p.tenant_id=$1 AND b.connection_id=$2 AND p.transition_kind='CURRENCY' AND ($3::uuid IS NULL AND p.state<>'CANCELLED' OR p.id=$3)
    ORDER BY p.created_at DESC LIMIT 1`,[actor.tenantId,actor.connectionId,id??null])).rows[0];
  if(!plan){if(id)throw new NotFoundException('Preview not found.');return null;}
  const observation=publicMetaTransitionObservation(plan.result?.metaTransitionPreview);
  const expired=plan.expires_at!==null&&plan.expires_at.getTime()<=Date.now();
  const state=plan.state==='CANCELLED'?'CANCELLED':expired?'EXPIRED':plan.state==='PENDING'&&['FAILED_TERMINAL','CANCELLED'].includes(plan.operation_state)?'BLOCKED':plan.state as MetaTransitionPreviewView['state'];
  const captured=(plan.observation_payload.metaAccountTransition as {impactConnectionIds?:unknown}|undefined)?.impactConnectionIds;
  const ids=Array.isArray(captured)&&captured.length<=2000?captured.filter((v):v is string=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(v)):[];
  const names=(await client.query<{id:string;name:string}>('SELECT id,name FROM connections WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[actor.tenantId,ids])).rows;
  const connections=ids.map(id=>({id,name:names.find(row=>row.id===id)?.name??null}));
  const execution=(await client.query<{value:MetaTransitionExecutionView}>('SELECT app.meta_transition_execution_view($1,$2) AS value',[plan.id,actor.userId])).rows[0]?.value;
  return{id:plan.id,revision:Number(plan.revision),state,requestedMode:plan.requested_mode,targetCurrency:plan.target_currency,
    current:observation?.current??{declaredMode:'UNSELECTED',actualPayer:'UNVERIFIED',currency:null},
    impact:{connections,phoneInventory:observation?.impact?.phoneInventory??'UNAVAILABLE',externalPhoneCount:observation?.impact?.externalPhoneCount??null,
      sourceTemplateCount:observation?.impact?.sourceTemplateCount??null,affectedFlowVersionCount:observation?.impact?.affectedFlowVersionCount??null,templateCompatibility:'NOT_ASSESSED'},
    reasons:observation?.reasons??['PROVIDER_READ_UNAVAILABLE'],observedAt:plan.observed_at?.toISOString()??null,expiresAt:plan.expires_at?.toISOString()??null,
    canRefresh:plan.execution_state==='UNPREPARED'&&state!=='CANCELLED'&&!['QUEUED','RUNNING','FAILED_RETRYABLE'].includes(plan.operation_state),
    canCancel:plan.execution_state==='UNPREPARED'&&state!=='CANCELLED',canExecute:false,...(execution?{execution}:{})};
}

export async function requestMetaTransitionExecution(client:PoolClient,actor:Actor,id:string,key:string,action:MetaTransitionExecutionAction,body:unknown,resolve=false){
  const request=parse(parseMetaTransitionExecutionActionRequest,body);
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(key))throw new BadRequestException('Invalid request key.');
  if(!(await client.query(`SELECT 1 FROM meta_account_transitions WHERE tenant_id=$1 AND id=$2
    AND initiating_connection_id=$3 AND transition_kind='CURRENCY'`,[actor.tenantId,id,actor.connectionId])).rowCount)
    throw new NotFoundException('Account transition not found.');
  const fn=resolve?'resolve_meta_transition_request':'queue_meta_transition_action';
  const value=(await client.query<{value:MetaTransitionExecutionActionResult|MetaTransitionExecutionResolutionResult}>(
    'SELECT app.'+fn+'($1,$2,$3,$4,$5,$6,$7,$8) AS value',
    [id,actor.connectionId,actor.userId,request.expectedRevision,request.expectedPreviewSha256,key,action,actor.requestId])).rows[0]?.value;
  if(!value)throw conflict();return value;
}
