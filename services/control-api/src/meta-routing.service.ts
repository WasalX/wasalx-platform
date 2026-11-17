import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { metaLifecyclePayloadSha256 } from '@wasalx/core/meta-account-relation';
import type { PoolClient } from 'pg';
import type { MetaRoutingConfigurationDto } from '@wasalx/core/meta-routing-contract';
import { metaRoutingRuntime, parseMetaRoutingDeclaration, parseMetaRoutingReview } from '@wasalx/core/meta-routing';
import { DatabaseService } from './database.service.js';
import { PlatformOperationsRepository } from './platform-operations.repository.js';
import { requirePrivilegedAuthentication } from './privileged-auth.js';
import { appendAudit } from './audit.js';
import type { AuthenticatedRequest } from './types.js';
import type { PlatformOperatorRequest } from './tenant-provisioning.types.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type Session = {id:string;opaque_session_id:string;provider_state_data:Record<string,unknown>};
export function routingId(value:string){if(!uuid.test(value))throw new BadRequestException('Routing resource is invalid');return value}
export function routingKey(value:unknown){if(typeof value!=='string'||value.length<1||value.length>255||[...value].some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))throw new BadRequestException('Idempotency key is required');return value}
export function routingHash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex')}
export function routingOrigin(request:AuthenticatedRequest){
  if(!process.env.PORTAL_PUBLIC_ORIGIN||request.headers.origin!==process.env.PORTAL_PUBLIC_ORIGIN)throw new ForbiddenException('Routing request origin is invalid');
}
export async function routingWriterCurrent(client:PoolClient,request:AuthenticatedRequest){
  const tenant=(await client.query<{active:boolean}>("SELECT app.lock_current_active_tenant_for_event_admission() AS active")).rows[0];
  if(tenant?.active!==true)throw new ForbiddenException('Routing administration requires current connection authority');
  const member=await client.query(`SELECT 1 FROM tenant_memberships member JOIN tenants tenant ON tenant.id=member.tenant_id
    WHERE member.tenant_id=$1 AND member.user_id=$2 AND member.state='ACTIVE' AND member.role IN('tenant_owner','tenant_admin') AND tenant.state='ACTIVE' FOR SHARE OF member`,[request.principal.tenantId,request.principal.userId]);
  if(member.rowCount!==1)throw new ForbiddenException('Routing administration requires current connection authority');
}

@Injectable()
export class MetaRoutingService {
  constructor(private readonly database:DatabaseService,private readonly platform:PlatformOperationsRepository){}

  async configuration(request:AuthenticatedRequest,connectionId:string){
    return this.database.withTenant(request.principal.tenantId,async client=>{
      const session=await currentSession(client,request.principal.tenantId,routingId(connectionId));
      return configurationView(client,request.principal.tenantId,connectionId,session);
    });
  }
  async declare(request:AuthenticatedRequest,connectionId:string,key:unknown,body:unknown){
    routingOrigin(request);routingId(connectionId);const idempotencyKey=routingKey(key);
    let input;try{input=parseMetaRoutingDeclaration(body)}catch{throw new BadRequestException('Routing declaration is invalid')}
    return this.database.withTenant(request.principal.tenantId,async client=>{
      await requirePrivilegedAuthentication(client,request.principal,'changing Meta routing declaration');
      await routingWriterCurrent(client,request);
      const session=await currentSession(client,request.principal.tenantId,connectionId,true);
      const previous=session.provider_state_data.metaRouting as {version?:number;idempotencyKey?:string;requestHash?:string}|undefined;
      const hash=routingHash({connectionId,userId:request.principal.userId,input});
      if(previous?.idempotencyKey===idempotencyKey){if(previous.requestHash!==hash)throw new ConflictException('Idempotency key was reused');return configurationView(client,request.principal.tenantId,connectionId,session)}
      if(session.id!==input.expectedSessionId||Number(previous?.version??0)!==input.expectedVersion)throw new ConflictException('Routing configuration changed');
      const declaration={version:input.expectedVersion+1,declaredAt:new Date().toISOString(),declaredBy:request.principal.userId,
        fallback:input.fallback,idempotencyKey,requestHash:hash};
      await client.query("UPDATE provider_sessions SET provider_state_data=jsonb_set(provider_state_data,'{metaRouting}',$1::jsonb,true),updated_at=now() WHERE tenant_id=$2 AND id=$3",[declaration,request.principal.tenantId,session.id]);
      await appendAudit(client,request.principal,{action:'meta.routing.declared',targetType:'connection',targetId:connectionId,requestId:String(request.id),newValue:{version:declaration.version,fallback:declaration.fallback}});
      return configurationView(client,request.principal.tenantId,connectionId,{...session,provider_state_data:{...session.provider_state_data,metaRouting:declaration}});
    });
  }
  async operatorView(request:PlatformOperatorRequest,tenantId:string,connectionId:string){
    if(!this.platform.isConfigured())throw new ServiceUnavailableException('Platform routing review is unavailable');
    return this.platform.metaRoutingReview({tenantId:routingId(tenantId),connectionId:routingId(connectionId),operator:request.platformOperator,requestId:String(request.id)});
  }
  async operatorReview(request:PlatformOperatorRequest,tenantId:string,connectionId:string,key:unknown,body:unknown){
    if(!this.platform.isConfigured())throw new ServiceUnavailableException('Platform routing review is unavailable');
    let input;try{input=parseMetaRoutingReview(body)}catch{throw new BadRequestException('Routing observation is invalid')}
    const appId=process.env.META_APP_ID??'';if(!/^[0-9]{1,32}$/u.test(appId))throw new ServiceUnavailableException('Meta routing review is unavailable');
    const runtime=metaRoutingRuntime(process.env);
    try{return await this.platform.recordMetaRoutingReview({tenantId:routingId(tenantId),connectionId:routingId(connectionId),body:input,appId,runtime,key:routingKey(key),
      hash:routingHash({tenantId,connectionId,input,appId,runtime}),operator:request.platformOperator,requestId:String(request.id)})}
    catch(error){const code=(error as {code?:string})?.code;if(['40001','23505'].includes(code??''))throw new ConflictException('Routing observation changed');if(code==='P0002')throw new NotFoundException('Routing connection was not found');throw error}
  }
}

async function currentSession(client:PoolClient,tenantId:string,connectionId:string,lock=false):Promise<Session>{
  const connection=await client.query(`SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 AND provider='META' ${lock?'FOR UPDATE':''}`,[tenantId,connectionId]);
  if(connection.rowCount!==1)throw new NotFoundException('Routing connection was not found');
  const sessions=(await client.query<Session>(`SELECT id,opaque_session_id,provider_state_data FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE' ${lock?'FOR UPDATE':''}`,[tenantId,connectionId])).rows;
  if(sessions.length!==1)throw new ConflictException('Routing session is unavailable');return sessions[0]!;
}
async function configurationView(client:PoolClient,tenantId:string,connectionId:string,session:Session):Promise<MetaRoutingConfigurationDto>{
  const declaration=session.provider_state_data.metaRouting as {version:number;fallback:string}|undefined;
  const review=(await client.query<{provider_session_id:string;phone_number_id:string;account_id:string;app_id:string;configuration_version:string;review_version:string;disposition:string;observed_at:Date;runtime_binding:unknown;observation:Record<string,unknown>}>(
    'SELECT provider_session_id,phone_number_id,account_id,app_id,configuration_version,review_version,disposition,observed_at,runtime_binding,observation FROM meta_routing_reviews WHERE tenant_id=$1 AND connection_id=$2 ORDER BY review_version DESC LIMIT 1',[tenantId,connectionId])).rows[0];
  const compatible=(await client.query(`SELECT 1 FROM meta_routing_legacy_admissions WHERE tenant_id=$1 AND connection_id=$2 AND provider_session_id=$3 AND disabled_at IS NULL
    AND phone_number_id=$4 AND account_id IS NOT DISTINCT FROM $5`,[tenantId,connectionId,session.id,session.opaque_session_id,session.provider_state_data.wabaId??null])).rowCount===1;
  const primary=(await client.query<{eligible:boolean}>(`SELECT app.meta_primary_delivery_eligible($1,$2,$3,$4,$5,$6::jsonb) AS eligible`,
    [connectionId,session.id,session.opaque_session_id,session.provider_state_data.wabaId??null,process.env.META_APP_ID??'',JSON.stringify(metaRoutingRuntime(process.env))])).rows[0]?.eligible===true;
  const observed=review?.disposition==='REVIEWED'&&review.provider_session_id===session.id&&Number(review.configuration_version)===Number(declaration?.version??0)
    &&review.phone_number_id===session.opaque_session_id&&review.account_id===session.provider_state_data.wabaId&&review.app_id===process.env.META_APP_ID
    &&metaLifecyclePayloadSha256(review.runtime_binding)===metaLifecyclePayloadSha256(metaRoutingRuntime(process.env));
  return{sessionId:session.id,configurationVersion:Number(declaration?.version??0),reviewVersion:Number(review?.review_version??0),
    readiness:observed?'OBSERVED_AWAITING_THREAD':compatible?'LEGACY_COMPATIBILITY':primary?'PRIMARY_DELIVERY':'REVIEW_REQUIRED',
    declared:declaration?{fallback:'HOLD'}:null,
    observed:review?{current:observed,disposition:review.disposition,observedAt:review.observed_at.toISOString(),mode:(review.runtime_binding as {mode:string}).mode,scope:review.observation.scope,roles:review.observation.roles,targets:review.observation.targets,threadControlEnabled:review.observation.threadControlEnabled} as MetaRoutingConfigurationDto['observed']:null,
    providerConfigurationReadback:false,accountFundingProof:'SEPARATE_REQUIRED'};
}
