import { readMetaNumberRelease, releaseMetaNumber } from "./meta-number-release.js";
import { metaRoutingRuntime } from "@wasalx/core/meta-routing";
import {parseMetaTariffQuery} from '@wasalx/core/meta-billing-policy-contract';
import {can} from './rbac.js';
import {readMetaTemplatePreparationPage,readMetaTemplatePreparation,requestMetaTemplatePreparation,requestMetaTemplateAction,cancelMetaTemplatePreparation} from './meta-template-preparation.js';
import {readMetaLegacyMigrationPage,readMetaLegacyMigration,requestMetaLegacyMigration,requestMetaLegacyMigrationAction,cancelMetaLegacyMigration} from './meta-legacy-migration.js';
import {parseMetaLifecycleState,metaLifecycleBlockingReasons,recoverMetaLifecycleReasons,assertMetaLifecycleAccess} from "@wasalx/core/meta-account-relation";
import {metaBillingDiagnosticBinding,metaBillingDiagnosticProofCurrent,publicMetaBillingDiagnostic,unavailableMetaBillingDiagnostic} from "@wasalx/core/meta-billing-diagnostic";
import {metaLifecyclePayloadSha256} from "@wasalx/core/meta-account-relation";
import {
  BadRequestException,
  Body,
  ConflictException,
  ForbiddenException,
  Controller,
  Get,
  Headers,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { PoolClient } from "pg";
import { sameMetaConnectionBinding, type MetaAccountRelation, type MetaAccountProof, type MetaConnectionBinding } from "@wasalx/core/meta-account-relation";
import { appendAudit } from "./audit.js";
import {
  isMetaCredentialSecretReference,
  metaCredentialRotationReference,
  metaCredentialSecretReference,
  wahaWebhookSecretReference,
} from "./connection-secret-reference.js";
import { metaActivationView, queueMetaActivation } from "./meta-add-access-activation.js";
import { DatabaseService } from "./database.service.js";
import {
  MetaGraphClientError,
  MetaGroupsClientFactory,
} from "./meta-groups.client.js";
import { Requires } from "./permission.guard.js";
import { requirePrivilegedAuthentication } from "./privileged-auth.js";
import { SecretProvisioningService } from "./secret-provisioning.service.js";
import { TenantDrainService } from "./tenant-drain.service.js";
import { WebhookSecretService } from "./webhook-secret.service.js";
import { MetaCredentialService } from "./meta-credential.service.js";
import { MetaSignupService, hasCoexistenceTarget, type SignupSelection } from "./meta-signup.service.js";
import { loadMetaBinding, assertMetaAddAccessActivationAllowed } from "./meta-connection-binding.js";
import type { MetaSignupExchangeRequest, MetaSignupSelectRequest, MetaSignupStartRequest } from "./meta-signup.types.js";
import {assertMetaTransitionWriter,requestMetaTransitionPreview,refreshMetaTransitionPreview,cancelMetaTransitionPreview,readMetaTransitionPreview,readMetaTransitionPage,requestMetaTransitionExecution} from './meta-account-transition.js';
import {requestMetaCustomerPolicy,metaPolicyBody} from "./meta-account-policy.js";
import type { AuthenticatedRequest } from "./types.js";
import { listCursor, listLimit, takeListPage, withListCursor, type ListPageQuery } from "./list-pagination.js";

type Provider = "WAHA" | "META";
type WahaEngine = "GOWS" | "NOWEB";
type ConnectionState =
  | "PROVISIONING"
  | "AWAITING_AUTH"
  | "CONNECTING"
  | "WORKING"
  | "DEGRADED"
  | "ACTION_REQUIRED"
  | "FAILED"
  | "PAUSED"
  | "REVOKED";
type OperationType = "PROVISION" | "START" | "RESTART" | "PAUSE" | "DISCONNECT" | "SYNC_GROUPS" | "ROTATE_META_CREDENTIAL" | "VERIFY_META_BILLING" | "PREVIEW_META_ACCOUNT_TRANSITION" | "EXECUTE_META_ACCOUNT_TRANSITION";
type LifecycleOperationType = Exclude<OperationType, "PROVISION" | "ROTATE_META_CREDENTIAL" | "VERIFY_META_BILLING" | "PREVIEW_META_ACCOUNT_TRANSITION" | "EXECUTE_META_ACCOUNT_TRANSITION">;
type OperationState = "STAGED" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "CANCELLED";

type OperationRow = {
  id: string;
  tenant_id: string;
  connection_id: string;
  operation_type: OperationType;
  idempotency_key: string;
  state: OperationState;
  attempts: number;
  payload: Record<string, unknown>;
  created_at: string | Date;
  connection_name?: string;
  provider?: Provider;
  connection_state?: ConnectionState;
};

type CreateBody = {
  name?: string;
  provider?: string;
  engine?: unknown;
  disclosureAccepted?: boolean;
  disclosureVersion?: string;
  accessToken?: string;
  phoneNumberId?: string;
  wabaId?: string;
  eligibilityAccepted?: boolean;
  eligibilityVersion?: string;
};

type RotateMetaCredentialBody = { accessToken?: string };

const WAHA_RUNTIME_READY_SQL = `EXISTS (
  SELECT 1 FROM app.current_waha_session_runtime(ps.id) runtime
  WHERE runtime.health_state='HEALTHY' AND runtime.lifecycle_state IN ('ACTIVE','DRAINING')
    AND runtime.last_heartbeat_at>=now()-make_interval(secs=>runtime.heartbeat_ttl_seconds)
    AND runtime.assignment_lease_expires_at>=now()
    AND ps.last_provider_status_at>=runtime.last_started_at
)`;

const META_PROCESSED_MESSAGE_SQL = `(SELECT max(source.received_at) FROM event_inbox source
  WHERE source.tenant_id=c.tenant_id AND source.connection_id=c.id AND source.provider='META'
    AND source.event_type='messages' AND source.status='PROCESSED' AND source.meta_routing_epoch IS NOT NULL
    AND source.meta_direct_asset->>'providerSessionId'=ps.id::text)`;
const META_READINESS_JOIN_SQL = `LEFT JOIN LATERAL (
  SELECT allowed,reason FROM app.meta_direct_routing_guard(c.id,ps.id,ps.opaque_session_id,
    ps.provider_state_data->>'wabaId',NULL,__BINDING__::jsonb->>'appId',__BINDING__::jsonb->'runtime',NULL,NULL,NULL,false)
  WHERE c.provider='META' AND ps.id IS NOT NULL AND jsonb_typeof(__BINDING__::jsonb->'runtime')='object'
) meta_readiness ON true`;

function metaReadinessBinding() {
  let runtime;
  try { runtime=metaRoutingRuntime(process.env); } catch { runtime=null; }
  return JSON.stringify({appId:process.env.META_APP_ID??"",runtime});
}

const TRANSITIONS: Record<LifecycleOperationType, ReadonlySet<ConnectionState>> = {
  START: new Set(["PAUSED", "FAILED", "ACTION_REQUIRED"]),
  RESTART: new Set(["AWAITING_AUTH", "CONNECTING", "WORKING", "DEGRADED", "ACTION_REQUIRED", "FAILED", "PAUSED"]),
  PAUSE: new Set(["AWAITING_AUTH", "CONNECTING", "WORKING", "DEGRADED", "ACTION_REQUIRED", "FAILED"]),
  DISCONNECT: new Set(["PROVISIONING", "AWAITING_AUTH", "CONNECTING", "WORKING", "DEGRADED", "ACTION_REQUIRED", "FAILED", "PAUSED"]),
  SYNC_GROUPS: new Set(["WORKING", "DEGRADED"]),
};

const OPTIMISTIC_STATES: Partial<Record<OperationType, ConnectionState>> = {
  START: "CONNECTING",
  RESTART: "CONNECTING",
};

@Controller("v1/connections")
export class ConnectionsController {
  constructor(
    private readonly database: DatabaseService,
    private readonly secrets: SecretProvisioningService,
    private readonly drains: TenantDrainService,
    private readonly metaGroups: MetaGroupsClientFactory,
    private readonly webhookSecrets: WebhookSecretService,
    private readonly metaCredentials: MetaCredentialService,
    private readonly metaSignup: MetaSignupService,
  ) {}

  @Get("meta/signup/capabilities")
  @Requires("connection:write")
  @Header("Cache-Control", "no-store")
  signupCapabilities(@Req() request: AuthenticatedRequest) { return this.metaSignup.capabilities(request); }

  @Get("meta/signup/attempts")
  @Requires("connection:write")
  @Header("Cache-Control", "no-store")
  signupLatest(@Req() request: AuthenticatedRequest, @Query() query: Record<string, unknown> = {}) {
    if (Object.keys(query).some(key => !["targetConnectionId", "purpose", "targetTransitionId", "targetLegacyMigrationId"].includes(key))
      || (query.targetConnectionId !== undefined && typeof query.targetConnectionId !== "string")
      || (query.purpose !== undefined && typeof query.purpose !== "string")
      || (query.targetTransitionId !== undefined && typeof query.targetTransitionId !== "string")
      || (query.targetLegacyMigrationId !== undefined && typeof query.targetLegacyMigrationId !== "string")) throw new BadRequestException("Invalid account setup query");
    return this.metaSignup.latest(request, query.targetConnectionId as string | undefined, query.purpose as string | undefined, query.targetTransitionId as string | undefined, query.targetLegacyMigrationId as string | undefined);
  }

  @Post("meta/signup/attempts")
  @Requires("connection:write")
  @Header("Cache-Control", "no-store")
  signupStart(@Req() request: AuthenticatedRequest, @Body() body: MetaSignupStartRequest) { return this.metaSignup.start(request, body); }

  @Get("meta/signup/attempts/:attemptId")
  @Requires("connection:write")
  @Header("Cache-Control", "no-store")
  signupGet(@Req() request: AuthenticatedRequest, @Param("attemptId") id: string) { return this.metaSignup.get(request, id); }

  @Post("meta/signup/attempts/:attemptId/exchange")
  @Requires("connection:write")
  @Header("Cache-Control", "no-store")
  signupExchange(@Req() request: AuthenticatedRequest, @Param("attemptId") id: string, @Body() body: MetaSignupExchangeRequest) { return this.metaSignup.exchange(request, id, body); }

  @Post("meta/signup/attempts/:attemptId/session-log")
  @Requires("connection:write")
  @Header("Cache-Control", "no-store")
  signupSessionLog(@Req() request: AuthenticatedRequest, @Param("attemptId") id: string,
    @Body() body: import("@wasalx/core/meta-coexistence-contract").MetaSignupSessionLogRequest) { return this.metaSignup.sessionLog(request, id, body); }

  @Post("meta/signup/attempts/:attemptId/discover")
  @Requires("connection:write")
  @Header("Cache-Control", "no-store")
  signupDiscover(@Req() request: AuthenticatedRequest, @Param("attemptId") id: string, @Body() body: { expectedRevision: number }) { return this.metaSignup.discover(request, id, body); }

  @Post("meta/signup/attempts/:attemptId/cancel")
  @Requires("connection:write")
  @Header("Cache-Control", "no-store")
  signupCancel(@Req() request: AuthenticatedRequest, @Param("attemptId") id: string, @Body() body: { expectedRevision: number }) { return this.metaSignup.cancel(request, id, body); }

  @Post("meta/signup/attempts/:attemptId/select")
  @Requires("connection:write")
  @Header("Cache-Control", "no-store")
  async signupSelect(@Req() request: AuthenticatedRequest, @Param("attemptId") id: string, @Body() body: MetaSignupSelectRequest) {
    const selection = await this.metaSignup.prepareSelection(request, id, body);
    try {
      if (selection.attempt.purpose === "TRANSITION_READBACK" || selection.attempt.purpose === "LEGACY_MIGRATION") {
        await this.metaSignup.selectTransitionObserver(request, selection);
      } else if (selection.attempt.purpose === "RECONNECT") {
        await this.rotateMeta(request, selection.attempt.target_connection_id!, `meta-signup-${id}`, selection.accessToken, selection);
      } else {
        await this.createMeta(request, `meta-signup-${id}`, selection.attempt.name, {
          accessToken: selection.accessToken, phoneNumberId: selection.choice.phoneId, wabaId: selection.choice.wabaId,
        }, selection);
      }
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) throw error;
      // Refresh a durable stage. ADD_ACCESS reads an uncertain write without repeating it.
      const current = await this.metaSignup.get(request, id);
      if (!current.operationId) throw error;
      return current;
    }
    return this.metaSignup.get(request, id);
  }

  @Get(":id/meta/legacy-migrations")
  @Requires("connection:read")
  @Header("Cache-Control", "no-store")
  async legacyMigrationPage(@Req() request:AuthenticatedRequest,@Param("id") id:string){
    assertMetaTransitionId(id);
    return this.database.withTenant(request.principal.tenantId,client=>readMetaLegacyMigrationPage(client,this.templateActor(request,id)));
  }

  @Get(":id/meta/legacy-migrations/:planId")
  @Requires("connection:read")
  @Header("Cache-Control", "no-store")
  async legacyMigrationView(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string){
    assertMetaTransitionId(id);assertMetaTransitionId(planId);
    return this.database.withTenant(request.principal.tenantId,client=>readMetaLegacyMigration(client,this.templateActor(request,id),planId));
  }

  @Post(":id/meta/legacy-migrations")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async createLegacyMigration(@Req() request:AuthenticatedRequest,@Param("id") id:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateLegacyMigration(request,id,undefined,'create',key,body,false);
  }

  @Post(":id/meta/legacy-migrations/resolve")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async resolveLegacyMigration(@Req() request:AuthenticatedRequest,@Param("id") id:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateLegacyMigration(request,id,undefined,'create',key,body,true);
  }

  @Post(":id/meta/legacy-migrations/:planId/cancel")
  @Requires("connection:write")
  async cancelLegacyMigration(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,@Body() body:unknown){
    return this.mutateLegacyMigration(request,id,planId,'cancel',undefined,body,false);
  }

  @Post(":id/meta/legacy-migrations/:planId/:action/resolve")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async resolveLegacyMigrationAction(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,
    @Param("action") action:string,@Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    if(!['observe','register','reconcile'].includes(action))throw new BadRequestException('Invalid migration action.');
    return this.mutateLegacyMigration(request,id,planId,action as 'observe'|'register'|'reconcile',key,body,true);
  }

  @Post(":id/meta/legacy-migrations/:planId/:action")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async legacyMigrationAction(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,
    @Param("action") action:string,@Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    if(!['observe','register','reconcile'].includes(action))throw new BadRequestException('Invalid migration action.');
    return this.mutateLegacyMigration(request,id,planId,action as 'observe'|'register'|'reconcile',key,body,false);
  }

  private async mutateLegacyMigration(request:AuthenticatedRequest,id:string,planId:string|undefined,
    action:'create'|'cancel'|'observe'|'register'|'reconcile',key:string|undefined,body:unknown,resolve:boolean){
    assertMetaTransitionId(id);if(planId)assertMetaTransitionId(planId);
    const requestKey=action==='cancel'?undefined:requireIdempotencyKey(key);
    if(requestKey)assertMetaTransitionId(requestKey);
    const tenantId=request.principal.tenantId,actor=this.templateActor(request,id);
    const result=await this.database.withTenant(tenantId,async client=>{
      await requirePrivilegedAuthentication(client,request.principal,"reviewing a Meta number migration");
      const value=action==='create'?await requestMetaLegacyMigration(client,actor,requestKey!,body,resolve)
        :action==='cancel'?await cancelMetaLegacyMigration(client,actor,planId!,body)
          :await requestMetaLegacyMigrationAction(client,actor,planId!,requestKey!,action.toUpperCase() as 'OBSERVE'|'REGISTER'|'RECONCILE',body,resolve);
      if(!value.duplicate)await appendAudit(client,request.principal,{action:'connection.meta_legacy_'+action+(resolve?'_resolution':''),
        targetType:'connection',targetId:id,requestId:String(request.id),newValue:{migration_id:value.id}});
      return value;
    });
    if(!resolve&&!result.duplicate&&'operationId' in result){
      const operation=await this.database.withTenant(tenantId,async client=>(await client.query<OperationRow>(
        "SELECT * FROM connection_operations WHERE tenant_id=$1 AND id=$2 AND state='QUEUED'",[tenantId,result.operationId])).rows[0]);
      if(operation)await this.wake(operation);
    }
    return result;
  }

  @Get(":id/meta/template-preparations")
  @Requires("connection:read")
  async templatePreparationPage(@Req() request:AuthenticatedRequest,@Param("id") id:string){
    assertMetaTransitionId(id);
    return this.database.withTenant(request.principal.tenantId,client=>readMetaTemplatePreparationPage(client,this.templateActor(request,id)));
  }

  @Get(":id/meta/template-preparations/:planId")
  @Requires("connection:read")
  async templatePreparationView(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string){
    assertMetaTransitionId(id);assertMetaTransitionId(planId);
    return this.database.withTenant(request.principal.tenantId,client=>readMetaTemplatePreparation(client,this.templateActor(request,id),planId));
  }

  @Post(":id/meta/template-preparations")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async createTemplatePreparation(@Req() request:AuthenticatedRequest,@Param("id") id:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateTemplatePreparation(request,id,undefined,'create',key,body,false);
  }

  @Post(":id/meta/template-preparations/resolve")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async resolveTemplatePreparation(@Req() request:AuthenticatedRequest,@Param("id") id:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateTemplatePreparation(request,id,undefined,'create',key,body,true);
  }

  @Post(":id/meta/template-preparations/:planId/cancel")
  @Requires("connection:write")
  async cancelTemplatePreparation(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,@Body() body:unknown){
    return this.mutateTemplatePreparation(request,id,planId,'cancel',undefined,body,false);
  }

  @Post(":id/meta/template-preparations/:planId/:action/resolve")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async resolveTemplateAction(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,
    @Param("action") action:string,@Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    if(!['observe','copy','reconcile'].includes(action))throw new BadRequestException('Invalid template action.');
    return this.mutateTemplatePreparation(request,id,planId,action as 'observe'|'copy'|'reconcile',key,body,true);
  }

  @Post(":id/meta/template-preparations/:planId/:action")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async templateAction(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,
    @Param("action") action:string,@Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    if(!['observe','copy','reconcile'].includes(action))throw new BadRequestException('Invalid template action.');
    return this.mutateTemplatePreparation(request,id,planId,action as 'observe'|'copy'|'reconcile',key,body,false);
  }

  private templateActor(request:AuthenticatedRequest,id:string){return {tenantId:request.principal.tenantId,connectionId:id,
    userId:request.principal.userId,appId:process.env.META_APP_ID??'',requestId:String(request.id)};}

  private async mutateTemplatePreparation(request:AuthenticatedRequest,id:string,planId:string|undefined,
    action:'create'|'cancel'|'observe'|'copy'|'reconcile',key:string|undefined,body:unknown,resolve:boolean){
    assertMetaTransitionId(id);if(planId)assertMetaTransitionId(planId);
    const tenantId=request.principal.tenantId,actor=this.templateActor(request,id);
    const result=await this.database.withTenant(tenantId,async client=>{
      await requirePrivilegedAuthentication(client,request.principal,"preparing Meta templates");
      const value=action==='create'?await requestMetaTemplatePreparation(client,actor,requireIdempotencyKey(key),body,resolve)
        :action==='cancel'?await cancelMetaTemplatePreparation(client,actor,planId!,body)
          :await requestMetaTemplateAction(client,actor,planId!,requireIdempotencyKey(key),action.toUpperCase() as 'OBSERVE'|'COPY'|'RECONCILE',body,resolve);
      if(!value.duplicate)await appendAudit(client,request.principal,{action:'connection.meta_template_'+action+(resolve?'_resolution':''),
        targetType:'connection',targetId:id,requestId:String(request.id),newValue:{preparation_id:value.id}});
      return value;
    });
    if(!resolve&&!result.duplicate&&'operationId' in result){
      const operation=await this.database.withTenant(tenantId,async client=>(await client.query<OperationRow>(
        "SELECT * FROM connection_operations WHERE tenant_id=$1 AND id=$2 AND state='QUEUED'",[tenantId,result.operationId])).rows[0]);
      if(operation)await this.wake(operation);
    }
    return result;
  }

  @Get(":id/meta/account-transitions")
  @Requires("connection:read")
  async metaTransitionPage(@Req() request:AuthenticatedRequest,@Param("id") id:string){
    assertMetaTransitionId(id);
    return this.database.withTenant(request.principal.tenantId,client=>readMetaTransitionPage(client,{tenantId:request.principal.tenantId,connectionId:id,userId:request.principal.userId}));
  }

  @Get(":id/meta/account-transitions/:planId")
  @Requires("connection:read")
  async metaTransitionView(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string){
    assertMetaTransitionId(id);assertMetaTransitionId(planId);
    return this.database.withTenant(request.principal.tenantId,client=>readMetaTransitionPreview(client,{tenantId:request.principal.tenantId,connectionId:id,userId:request.principal.userId},planId));
  }

  @Post(":id/meta/account-transitions")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async createMetaTransitionPreview(@Req() request:AuthenticatedRequest,@Param("id") id:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateMetaTransition(request,id,undefined,'create',key,body);
  }

  @Post(":id/meta/account-transitions/:planId/refresh")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async refreshMetaTransition(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateMetaTransition(request,id,planId,'refresh',key,body);
  }

  @Post(":id/meta/account-transitions/:planId/cancel")
  @Requires("connection:write")
  async cancelMetaTransition(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,@Body() body:unknown){
    return this.mutateMetaTransition(request,id,planId,'cancel',undefined,body);
  }

  @Post(":id/meta/account-transitions/:planId/initiate")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async initiateMetaTransition(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateMetaTransitionExecution(request,id,planId,'INITIATE',key,body,false);
  }

  @Post(":id/meta/account-transitions/:planId/initiate/resolve")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async initiateMetaTransitionResolution(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateMetaTransitionExecution(request,id,planId,'INITIATE',key,body,true);
  }

  @Post(":id/meta/account-transitions/:planId/complete")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async completeMetaTransition(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateMetaTransitionExecution(request,id,planId,'COMPLETE',key,body,false);
  }

  @Post(":id/meta/account-transitions/:planId/complete/resolve")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async completeMetaTransitionResolution(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateMetaTransitionExecution(request,id,planId,'COMPLETE',key,body,true);
  }

  @Post(":id/meta/account-transitions/:planId/observe")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async observeMetaTransition(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateMetaTransitionExecution(request,id,planId,'OBSERVE',key,body,false);
  }

  @Post(":id/meta/account-transitions/:planId/observe/resolve")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async observeMetaTransitionResolution(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateMetaTransitionExecution(request,id,planId,'OBSERVE',key,body,true);
  }

  @Post(":id/meta/account-transitions/:planId/reconcile")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async reconcileMetaTransition(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateMetaTransitionExecution(request,id,planId,'RECONCILE',key,body,false);
  }

  @Post(":id/meta/account-transitions/:planId/reconcile/resolve")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async reconcileMetaTransitionResolution(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Param("planId") planId:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    return this.mutateMetaTransitionExecution(request,id,planId,'RECONCILE',key,body,true);
  }

  private async mutateMetaTransitionExecution(request:AuthenticatedRequest,id:string,planId:string,
    action:'INITIATE'|'COMPLETE'|'OBSERVE'|'RECONCILE',key:string|undefined,body:unknown,resolve:boolean){
    assertMetaTransitionId(id);assertMetaTransitionId(planId);
    const tenantId=request.principal.tenantId;
    const result=await this.database.withTenant(tenantId,async client=>{
      await requirePrivilegedAuthentication(client,request.principal,"changing Meta account payment settings");
      await assertMetaTransitionWriter(client,request.principal);
      const actor={tenantId,connectionId:id,userId:request.principal.userId,appId:process.env.META_APP_ID??'',requestId:String(request.id)};
      return requestMetaTransitionExecution(client,actor,planId,requireIdempotencyKey(key),action,body,resolve);
    });
    // Local resolution never publishes a new job; an already admitted job is
    // recovered through incumbent queue/lease semantics, never re-dispatched here.
    if(!resolve&&!result.duplicate){
      const operation=await this.database.withTenant(tenantId,async client=>(await client.query<OperationRow>(
        "SELECT * FROM connection_operations WHERE tenant_id=$1 AND id=$2 AND state='QUEUED'",[tenantId,result.operationId])).rows[0]);
      if(operation)await this.wake(operation);
    }
    return result;
  }

  private async mutateMetaTransition(request:AuthenticatedRequest,id:string,planId:string|undefined,
    action:'create'|'refresh'|'cancel',key:string|undefined,body:unknown){
    assertMetaTransitionId(id);if(planId)assertMetaTransitionId(planId);
    const tenantId=request.principal.tenantId;
    const result=await this.database.withTenant(tenantId,async client=>{
      await requirePrivilegedAuthentication(client,request.principal,"reviewing Meta account changes");
      await assertMetaTransitionWriter(client,request.principal);
      const actor={tenantId,connectionId:id,userId:request.principal.userId,appId:process.env.META_APP_ID??'',requestId:String(request.id)};
      const result=action==='create'?await requestMetaTransitionPreview(client,actor,requireIdempotencyKey(key),body)
        :action==='refresh'?await refreshMetaTransitionPreview(client,actor,planId!,requireIdempotencyKey(key),body)
          :await cancelMetaTransitionPreview(client,actor,planId!,body);
      if(!result.duplicate)await appendAudit(client,request.principal,{action:`connection.meta_account_preview_${action}`,
        targetType:'connection',targetId:id,requestId:String(request.id),newValue:{preview_id:result.id}});
      return result;
    });
    if('operationId' in result){const operation=await this.database.withTenant(tenantId,async client=>(await client.query<OperationRow>(
      'SELECT * FROM connection_operations WHERE tenant_id=$1 AND id=$2',[tenantId,result.operationId])).rows[0]);
      if(operation)await this.wake(operation);}
    return{id:result.id,duplicate:result.duplicate};
  }

  @Post(":id/meta/billing-policy")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async requestMetaBillingPolicy(@Req() request:AuthenticatedRequest,@Param("id") id:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown) {
    const input=metaPolicyBody(body),tenantId=request.principal.tenantId;
    const result=await this.database.withTenant(tenantId,async client=>{
      await requirePrivilegedAuthentication(client,request.principal,"selecting Meta payment responsibility");
      if((await client.query<{active:boolean}>("SELECT app.lock_current_active_tenant_for_event_admission() AS active")).rows[0]?.active!==true)
        throw new ConflictException("The workspace is unavailable.");
      const connection=(await client.query<{provider:Provider;state:string;secret_reference:string}>("SELECT provider,state,secret_reference FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,id])).rows[0];
      if(!connection)throw new NotFoundException("Connection not found");
      if(connection.provider!=='META'||!['WORKING','PAUSED'].includes(connection.state))throw new ConflictException("Verify the Meta connection first.");
      const session=await diagnosticSession(client,tenantId,id);
      const binding=metaBillingDiagnosticBinding(connection.secret_reference,session,process.env.META_APP_ID??'');
      if('tariffVersionId' in input){
        if(!metaBillingDiagnosticProofCurrent(binding,session?.providerStateData.metaAccountProof,{tenantId,connectionId:id}))
          throw new ConflictException("Verify the current Meta account before accepting rates.");
        let selected:{policyVersionId:string;replay:boolean}|undefined;
        try{selected=(await client.query<{result:{policyVersionId:string;replay:boolean}}>(
          "SELECT app.select_meta_tariff_policy($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
          [id,input.mode,input.mode==='MANAGED'?input.choiceId:null,input.tariffVersionId,input.tariffDefinitionSha256,
            input.documentSha256,input.expectedRevision,request.principal.userId,requireIdempotencyKey(key)])).rows[0]?.result;
        }catch(error){
          // These query errors abort this transaction; withTenant rolls it back.
          // Audit, transport and COMMIT errors remain uncertain outside this catch.
          const code=error&&typeof error==='object'&&'code' in error?error.code:null;
          if(code==='55000'||code==='40001'||code==='23514'||code==='55P03')
            throw new ConflictException("Refresh the available rates and review your selection.");
          throw error;
        }
        if(!selected)throw new ConflictException("The selected rates are unavailable.");
        if(!selected.replay)await appendAudit(client,request.principal,{action:'connection.meta_tariff_policy_requested',targetType:'connection',targetId:id,
          requestId:String(request.id),newValue:{mode:input.mode,tariff_version_id:input.tariffVersionId,send_ready:false}});
        return {tariff:true as const,mode:input.mode,selected};
      }
      if(input.mode==='MANAGED'){
        if(!metaBillingDiagnosticProofCurrent(binding,session?.providerStateData.metaAccountProof,{tenantId,connectionId:id}))
          throw new ConflictException("Verify the current Meta account before selecting managed payment.");
        const selected=(await client.query<{result:{policyVersionId:string;replay:boolean}}>(
          "SELECT app.select_meta_managed_policy($1,$2,$3,$4,$5,$6) AS result",
          [id,input.choiceId,input.documentSha256,input.expectedRevision,request.principal.userId,requireIdempotencyKey(key)])).rows[0]?.result;
        if(!selected)throw new ConflictException("The managed option is unavailable.");
        if(!selected.replay)await appendAudit(client,request.principal,{action:'connection.meta_managed_policy_requested',targetType:'connection',targetId:id,requestId:String(request.id),newValue:{mode:'MANAGED',send_ready:false}});
        return {managed:true as const,selected};
      }
      const result=await requestMetaCustomerPolicy(client,{tenantId,connectionId:id,userId:request.principal.userId,
        idempotencyKey:requireIdempotencyKey(key),expectedRevision:input.expectedRevision,requestId:String(request.id),binding,proof:session?.providerStateData.metaAccountProof});
      if(!result.duplicate)await appendAudit(client,request.principal,{action:'connection.meta_customer_policy_requested',targetType:'connection',targetId:id,requestId:String(request.id),newValue:{operation_id:result.operation.id,mode:'CUSTOMER'}});
      return result;
    });
    if('tariff' in result)return {requestedMode:result.mode,state:'HELD',sendReady:false,replay:result.selected.replay};
    if('managed' in result)return {requestedMode:'MANAGED',state:'HELD',sendReady:false,replay:result.selected.replay};
    await this.wake(result.operation as OperationRow);return operationResponse(result.operation as OperationRow,result.duplicate);
  }

  @Get(":id/meta/billing-policy")
  @Requires("connection:read")
  async metaBillingPolicy(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Query() query:Record<string,unknown>={}) {
    let tariffQuery;try{tariffQuery=parseMetaTariffQuery(query);}catch{throw new BadRequestException("Refresh the available rates.");}
    if(tariffQuery&&!can(request.principal.role,'connection:write'))throw new ForbiddenException("Payment configuration permission is required.");
    return this.database.withTenant(request.principal.tenantId,async client=>{
      const diagnostic=await this.readMetaBillingDiagnostic(client,request.principal.tenantId,id);
      const row=(await client.query<{authority_revision:string;funding_status:string;funding_observed_at:Date|null;state:string;binding_revision:string;active_policy_version_id:string|null;requested_policy_version_id:string|null;mode:'CUSTOMER'|'MANAGED'}>(`SELECT policy.mode,a.authority_revision,a.funding_status,a.funding_observed_at,a.state,b.revision AS binding_revision,a.active_policy_version_id,a.requested_policy_version_id
        FROM meta_connection_account_bindings b JOIN meta_messaging_accounts a ON a.tenant_id=b.tenant_id AND a.id=b.account_id LEFT JOIN meta_billing_policy_versions policy ON policy.tenant_id=a.tenant_id AND policy.id=a.requested_policy_version_id WHERE b.tenant_id=$1 AND b.connection_id=$2 AND b.state<>'RETIRED'`,[request.principal.tenantId,id])).rows[0];
      let revision=row?Number(row.authority_revision):0;
      if(!row){
        const tenantId=request.principal.tenantId;
        const connection=(await client.query<{secret_reference:string}>("SELECT secret_reference FROM connections WHERE tenant_id=$1 AND id=$2 AND provider='META' FOR SHARE",[tenantId,id])).rows[0];
        const session=await diagnosticSession(client,tenantId,id);
        const binding=metaBillingDiagnosticBinding(connection?.secret_reference??'',session,process.env.META_APP_ID??'');
        if(metaBillingDiagnosticProofCurrent(binding,session?.providerStateData.metaAccountProof,{tenantId,connectionId:id})){
          const account=(await client.query<{authority_revision:string}>(`SELECT authority_revision FROM meta_messaging_accounts account
            WHERE tenant_id=$1 AND provider_account_id=$2 AND state<>'RETIRED'
              AND EXISTS(SELECT 1 FROM meta_billing_policy_versions policy WHERE policy.tenant_id=account.tenant_id AND policy.account_id=account.id)`,[tenantId,binding.wabaId])).rows[0];
          revision=account?Number(account.authority_revision):0;
        }
      }
      const current=(await client.query<{ready:boolean}>(`SELECT EXISTS(SELECT 1 FROM provider_sessions ps CROSS JOIN LATERAL app.meta_billing_send_guard($1,ps.id,ps.opaque_session_id,ps.provider_state_data->>'wabaId',$3,$4) guard
        WHERE ps.tenant_id=$2 AND ps.connection_id=$1 AND ps.ownership_state='ACTIVE' AND guard.enrolled AND guard.allowed IS TRUE) AS ready`,[id,request.principal.tenantId,row?.authority_revision??null,row?.binding_revision??null])).rows[0]?.ready===true;
      const managedChoices=(await client.query<{choices:unknown[]}>("SELECT app.meta_managed_policy_choices($1) AS choices",[id])).rows[0]?.choices??[];
      const tariffOffers=tariffQuery?(await client.query<{page:unknown}>("SELECT app.meta_billing_tariff_offers($1,$2,$3,$4) AS page",
        [id,tariffQuery.tariffMode,tariffQuery.choiceId??null,tariffQuery.tariffAfter??null])).rows[0]?.page:null;
      return {...(tariffQuery?{tariffOffers}:{}),enrolled:!!row,mode:row?.mode??null,revision,
        paymentMethod:row?.funding_status??'UNAVAILABLE',checkedAt:row?.funding_observed_at?.toISOString()??null,
        sendReady:current&&diagnostic.current,state:diagnostic.state,actualPayer:row?.mode==='MANAGED'&&current&&diagnostic.current?'APPROVED_SOLUTION_PARTNER':'UNVERIFIED',customerOwnership:'UNVERIFIED',managedAvailable:managedChoices.length>0,managedChoices};
    });
  }

  @Post(":id/meta/billing-diagnostic")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async requestMetaBillingDiagnostic(@Req() request: AuthenticatedRequest, @Param("id") id: string,
    @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
      throw new BadRequestException("Payment diagnostics do not accept account or payment settings.");
    }
    const tenantId = request.principal.tenantId, idempotencyKey = requireIdempotencyKey(key);
    const result = await this.database.withTenant(tenantId, async client => {
      await requirePrivilegedAuthentication(client, request.principal, "checking Meta payment setup");
      const connection = (await client.query<{id:string;name:string;provider:Provider;state:ConnectionState;secret_reference:string}>(
        "SELECT id,name,provider,state,secret_reference FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId,id])).rows[0];
      if (!connection) throw new NotFoundException("Connection not found");
      if (connection.provider !== "META") throw new BadRequestException("Payment diagnostics require a Meta connection.");
      const replay = await selectOperation(client, tenantId, idempotencyKey);
      if (replay) {
        if (replay.connection_id !== id || replay.operation_type !== "VERIFY_META_BILLING") throw new ConflictException("Idempotency key was used for another operation.");
        return {operation:replay,duplicate:true};
      }
      const pending = (await client.query("SELECT id FROM connection_operations WHERE tenant_id=$1 AND connection_id=$2 AND state IN ('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE') LIMIT 1", [tenantId,id])).rows[0];
      if (pending) throw new ConflictException("A connection operation is already pending.");
      const session = await diagnosticSession(client, tenantId, id);
      const binding = metaBillingDiagnosticBinding(connection.secret_reference, session, process.env.META_APP_ID ?? "");
      if(metaBillingDiagnosticProofCurrent(binding,session?.providerStateData.metaAccountProof,{tenantId,connectionId:id})) {
        const proof=session!.providerStateData.metaAccountProof as {credentialFingerprint:string};
        // Same-account re-verification refreshes only this connection's credential generation.
        await client.query(`UPDATE meta_connection_account_bindings b SET provider_session_id=$3,phone_number_id=$4,app_id=$5,
          secret_reference=$6,credential_fingerprint=$7,proof_sha256=encode(public.digest((s.provider_state_data->'metaAccountProof')::text,'sha256'),'hex'),revision=revision+1,updated_at=now()
          FROM meta_messaging_accounts a,provider_sessions s WHERE b.tenant_id=$1 AND b.connection_id=$2 AND b.state='ACTIVE'
            AND s.tenant_id=$1 AND s.connection_id=$2 AND s.id=$3 AND s.opaque_session_id=$4
            AND s.ownership_state='ACTIVE' AND s.state IN('WORKING','PAUSED')
            AND app.meta_account_proof_sha256(s.provider_state_data->'metaAccountProof')=$8
            AND a.tenant_id=b.tenant_id AND a.id=b.account_id AND a.provider_account_id=$9 AND a.state<>'RETIRED'
            AND (b.provider_session_id,b.phone_number_id,b.app_id,b.secret_reference,b.credential_fingerprint,b.proof_sha256)
              IS DISTINCT FROM ($3::uuid,$4::text,$5::text,$6::text,$7::text,encode(public.digest((s.provider_state_data->'metaAccountProof')::text,'sha256'),'hex'))`,
          [tenantId,id,binding.providerSessionId,binding.phoneNumberId,binding.appId,binding.secretReference,proof.credentialFingerprint,binding.proofSha256,binding.wabaId]);
      }
      const policy=(await client.query<{account_id:string;id:string;revision:string;authority_revision:string;requested_policy_version_id:string;last_observation_operation_id:string|null}>(`SELECT b.account_id,b.id,b.revision,a.authority_revision,a.requested_policy_version_id,a.last_observation_operation_id
        FROM meta_connection_account_bindings b JOIN meta_messaging_accounts a ON a.tenant_id=b.tenant_id AND a.id=b.account_id
        WHERE b.tenant_id=$1 AND b.connection_id=$2 AND b.state='ACTIVE' AND a.state<>'RETIRED' FOR SHARE OF b,a`,[tenantId,id])).rows[0];
      const operation = (await client.query<OperationRow>(`INSERT INTO connection_operations
        (tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,requested_by_id,request_id)
        VALUES($1,$2,'VERIFY_META_BILLING',$3,$4,'USER',$5,$6) RETURNING *`,
        [tenantId,id,idempotencyKey,{metaBillingDiagnostic:binding,...(policy?{metaAccountPolicy:{accountId:policy.account_id,bindingId:policy.id,bindingRevision:Number(policy.revision),authorityRevision:Number(policy.authority_revision),policyVersionId:policy.requested_policy_version_id,observationOperationId:policy.last_observation_operation_id}}:{})},request.principal.userId,String(request.id)])).rows[0]!;
      await appendAudit(client, request.principal, {action:"connection.meta_billing_diagnostic_requested",targetType:"connection",targetId:id,
        requestId:String(request.id),newValue:{operation_id:operation.id}});
      return {operation:{...operation,provider:connection.provider,connection_name:connection.name,connection_state:connection.state},duplicate:false};
    });
    await this.wake(result.operation);
    return operationResponse(result.operation,result.duplicate);
  }

  @Get(":id/meta/billing-diagnostic")
  @Requires("connection:read")
  async metaBillingDiagnostic(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    return this.database.withTenant(request.principal.tenantId, client=>this.readMetaBillingDiagnostic(client,request.principal.tenantId,id));
  }

  private async readMetaBillingDiagnostic(client:PoolClient,tenantId:string,id:string) {
      const connection = (await client.query<{provider:Provider;state:string;secret_reference:string;tenant_state:string}>("SELECT c.provider,c.state,c.secret_reference,t.state AS tenant_state FROM connections c JOIN tenants t ON t.id=c.tenant_id WHERE c.tenant_id=$1 AND c.id=$2 FOR SHARE OF c", [tenantId,id])).rows[0];
      if (!connection) throw new NotFoundException("Connection not found");
      if (connection.provider !== "META") throw new BadRequestException("Payment diagnostics require a Meta connection.");
      const operation = (await client.query<OperationRow & {result:Record<string,unknown>}>(`SELECT * FROM connection_operations
        WHERE tenant_id=$1 AND connection_id=$2 AND operation_type='VERIFY_META_BILLING' ORDER BY created_at DESC,id DESC LIMIT 1`, [tenantId,id])).rows[0];
      if (!operation) return {operationId:null,state:null,diagnostic:null,current:false};
      const session = await diagnosticSession(client,tenantId,id);
      const binding = metaBillingDiagnosticBinding(connection.secret_reference,session,process.env.META_APP_ID ?? "");
      const current = metaLifecyclePayloadSha256(binding) === metaLifecyclePayloadSha256(operation.payload.metaBillingDiagnostic ?? null);
      const route = (await client.query<{state:string}>("SELECT state FROM webhook_routes WHERE tenant_id=$1 AND connection_id=$2 AND provider='META' FOR SHARE", [tenantId,id])).rows;
      let held = !["WORKING","PAUSED"].includes(connection.state) || !session || !["WORKING","PAUSED"].includes(session.state)
        || connection.tenant_state !== "ACTIVE"
        || route.length !== 1 || !["ACTIVE","PAUSED"].includes(route[0]!.state) || binding.lifecycleRevision === null
        || !metaBillingDiagnosticProofCurrent(binding,session?.providerStateData.metaAccountProof,{tenantId,connectionId:id});
      const privacy = (await client.query<{clear:boolean}>("SELECT NOT EXISTS(SELECT 1 FROM privacy_jobs WHERE tenant_id=$1 AND job_type='DELETE' AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')) AS clear",[tenantId])).rows[0];
      held ||= privacy?.clear !== true;
      if (!held) {
        const guard = (await client.query<{revision_matches:boolean;blocked:boolean;unresolved_hold:boolean}>("SELECT * FROM app.meta_lifecycle_guard($1,$2,$3,$4,$5,$6)",
          [id,session!.id,session!.opaqueSessionId,binding.wabaId,binding.appId,binding.lifecycleRevision])).rows;
        held = guard.length !== 1 || !guard[0]!.revision_matches || guard[0]!.blocked || guard[0]!.unresolved_hold;
      }
      const stored = publicMetaBillingDiagnostic(operation.result?.metaBillingDiagnostic);
      return {operationId:operation.id,state:operation.state,current:current && !held,
        diagnostic:stored ? publicMetaBillingDiagnostic(!current || held ? {...unavailableMetaBillingDiagnostic(!current ? "BINDING_CHANGED" : "ACCESS_HELD"),checkedAt:stored.checkedAt} : stored) : null};

  }

  @Get()
  @Requires("connection:read")
  async list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListPageQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const limit = listLimit(query.limit);
    const cursor = listCursor(query.cursor);
    const tenantId = request.principal.tenantId;
    const rows = await this.database.rows<Record<string, unknown> & { id: string }>(
      tenantId,
      `WITH cursor_position AS (
        SELECT created_at,id FROM connections WHERE tenant_id=$1 AND id=$3::uuid
      ), page_ids AS (
        SELECT id FROM connections
         WHERE tenant_id=$1 AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM cursor_position))
         ORDER BY created_at DESC,id DESC LIMIT $4
      )
      SELECT c.id,c.name,c.provider,c.engine,c.phone_e164,c.state,c.last_heartbeat_at,c.last_provider_event_at,
              c.action_reason,c.created_at,ps.state AS provider_session_state,ps.provider_state,
              ${WAHA_RUNTIME_READY_SQL} AS worker_ready,
              ps.onboarding_working_at,wr.state AS webhook_state,wr.admission_opened_at AS webhook_admission_opened_at,
              ${META_PROCESSED_MESSAGE_SQL} AS last_processed_provider_message_at,
              coalesce(meta_readiness.allowed,false) AS meta_routing_configuration_ready,meta_readiness.reason AS meta_routing_reason,
              count(DISTINCT g.id)::int AS group_count
         FROM connections c
         LEFT JOIN whatsapp_groups g ON g.connection_id=c.id AND g.tenant_id=c.tenant_id
         LEFT JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id AND ps.ownership_state='ACTIVE'
         LEFT JOIN webhook_routes wr ON wr.tenant_id=c.tenant_id AND wr.connection_id=c.id
         ${META_READINESS_JOIN_SQL.replaceAll("__BINDING__","$2")}
        WHERE c.tenant_id=$1 AND c.id IN (SELECT id FROM page_ids)
        GROUP BY c.id,ps.id,wr.id,meta_readiness.allowed,meta_readiness.reason
        ORDER BY c.created_at DESC,c.id DESC`,
      [tenantId,metaReadinessBinding(),cursor,limit+1],
    );
    return withListCursor(reply, takeListPage(rows, limit, row => row.id));
  }

  @Get(":id")
  @Requires("connection:read")
  async detail(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const row = (
      await this.database.rows<Record<string, unknown> & { id: string }>(
        request.principal.tenantId,
        `SELECT c.id,c.name,c.provider,c.engine,c.phone_e164,c.state,c.last_heartbeat_at,
                c.last_provider_event_at,c.action_reason,c.disclosure_version,c.created_at,c.updated_at,
                ps.state AS provider_session_state,ps.provider_state,ww.worker_key AS worker_id,
                ${WAHA_RUNTIME_READY_SQL} AS worker_ready,
                ps.onboarding_qr_ready_at,ps.onboarding_authorization_method,
                ps.onboarding_scan_acknowledged_at,
                ps.onboarding_scan_completed_at,ps.onboarding_working_at,
                (ps.onboarding_authorization_method='QR' AND ps.onboarding_scan_completed_at IS NOT NULL)
                  AS onboarding_timing_eligible,
                (ps.onboarding_authorization_method='QR' AND ps.onboarding_working_at IS NOT NULL
                  AND ps.onboarding_scan_acknowledged_at>ps.onboarding_working_at)
                  AS onboarding_late_acknowledgement,
                CASE WHEN ps.onboarding_authorization_method='QR'
                  AND ps.onboarding_scan_completed_at IS NOT NULL AND ps.onboarding_qr_ready_at IS NOT NULL
                  THEN extract(epoch FROM ps.onboarding_scan_completed_at-ps.onboarding_qr_ready_at) END AS onboarding_human_seconds,
                CASE WHEN ps.onboarding_authorization_method='QR'
                  AND ps.onboarding_working_at IS NOT NULL AND ps.onboarding_scan_completed_at IS NOT NULL
                  THEN extract(epoch FROM ps.onboarding_working_at-ps.onboarding_scan_completed_at) END AS onboarding_provider_seconds,
                wr.state AS webhook_state,wr.admission_opened_at AS webhook_admission_opened_at,
                ${META_PROCESSED_MESSAGE_SQL} AS last_processed_provider_message_at,
                coalesce(meta_readiness.allowed,false) AS meta_routing_configuration_ready,meta_readiness.reason AS meta_routing_reason,
                (SELECT count(*)::int FROM whatsapp_groups g WHERE g.tenant_id=c.tenant_id AND g.connection_id=c.id) AS group_count,
                op.id AS latest_operation_id,op.operation_type AS latest_operation_type,
                op.state AS latest_operation_state,op.attempts AS latest_operation_attempts,
                op.error_code AS latest_operation_error_code,op.safe_error AS latest_operation_safe_error,
                op.created_at AS latest_operation_created_at
           FROM connections c
           LEFT JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id AND ps.ownership_state='ACTIVE'
           LEFT JOIN LATERAL app.current_waha_session_runtime(ps.id) ww ON true
           LEFT JOIN webhook_routes wr ON wr.tenant_id=c.tenant_id AND wr.connection_id=c.id
           ${META_READINESS_JOIN_SQL.replaceAll("__BINDING__","$3")}
           LEFT JOIN LATERAL (
             SELECT id,operation_type,state,attempts,error_code,safe_error,created_at
               FROM connection_operations
              WHERE tenant_id=c.tenant_id AND connection_id=c.id
              ORDER BY created_at DESC,id DESC LIMIT 1
           ) op ON true
          WHERE c.tenant_id=$1 AND c.id=$2`,
        [request.principal.tenantId, id,metaReadinessBinding()],
      )
    )[0];
    if (!row) throw new NotFoundException("Connection not found");
    return row;
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Requires("connection:write")
  async create(
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyHeader: string | undefined,
    @Body() body: CreateBody,
  ) {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const name = body.name?.trim();
    const provider = body.provider?.toUpperCase() as Provider | undefined;
    if (!name || name.length > 160 || (provider !== "WAHA" && provider !== "META")) {
      throw new BadRequestException("A valid name and provider are required");
    }
    if (provider === "META") {
      if (body.engine !== undefined) {
        throw new BadRequestException("WAHA engine selection is not valid for a Meta connection");
      }
      return this.createMeta(request, idempotencyKey, name, body);
    }
    const engine = validatedWahaEngine(body.engine);
    const disclosureVersion = body.disclosureVersion?.trim();
    if (!body.disclosureAccepted || !disclosureVersion || disclosureVersion.length > 100) {
      throw new BadRequestException("The linked-device risk disclosure must be accepted");
    }

    const tenantId = request.principal.tenantId;
    const replay = await this.findOperation(tenantId, idempotencyKey);
    if (replay) {
      assertCreateReplay(replay, { name, provider, engine, disclosureVersion });
      return this.finishWahaProvision(replay, randomToken(36), randomToken(48), true);
    }

    const config = provisioningConfig();
    const connectionId = randomUUID();
    const providerSessionId = randomUUID();
    const opaqueSessionId = `wx_${randomToken(24)}`;
    const routeToken = randomToken(36);
    const hmacKey = randomToken(48);
    const webhookSecretReference = wahaWebhookSecretReference(tenantId, connectionId);
    const routeTokenSha256 = createHash("sha256").update(routeToken).digest("hex");
    const sessionStorageReference = `waha-session://${providerSessionId}`;

    let staged: OperationRow;
    try {
      staged = await this.database.withTenant(tenantId, async (client) => {
        await client.query(
          `INSERT INTO connections
             (id,tenant_id,name,provider,engine,state,secret_reference,disclosure_version)
           VALUES ($1,$2,$3,'WAHA',$4,'PROVISIONING',$5,$6)`,
          [connectionId, tenantId, name, engine, config.wahaAdminSecretReference, disclosureVersion],
        );
        await client.query(
          `INSERT INTO provider_sessions
             (id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state)
           VALUES ($1,$2,$3,$4,'PROVISIONING',$5,'ACTIVE')`,
          [providerSessionId, tenantId, connectionId, opaqueSessionId, sessionStorageReference],
        );
        await client.query(
          `INSERT INTO webhook_routes
             (tenant_id,connection_id,provider,route_token_sha256,hmac_secret_reference,state)
           VALUES ($1,$2,'WAHA',$3,$4,'PAUSED')`,
          [tenantId, connectionId, routeTokenSha256, webhookSecretReference],
        );
        await client.query(
          "INSERT INTO consent_records (tenant_id,actor_id,policy_type,policy_version) VALUES ($1,$2,'WAHA_LINKED_DEVICE',$3) ON CONFLICT DO NOTHING",
          [tenantId, request.principal.userId, disclosureVersion],
        );
        const operation = (
          await client.query<OperationRow>(
            `INSERT INTO connection_operations
               (tenant_id,connection_id,operation_type,idempotency_key,payload,state,requested_by_type,requested_by_id,request_id)
             VALUES ($1,$2,'PROVISION',$3,$4,'STAGED','USER',$5,$6)
             ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
             RETURNING *`,
            [
              tenantId,
              connectionId,
              idempotencyKey,
              {
                providerSessionId,
                webhookSecretReference,
                publicWebhookBaseUrl: config.publicWebhookBaseUrl,
                request: { name, provider, engine, disclosureVersion },
              },
              request.principal.userId,
              String(request.id),
            ],
          )
        ).rows[0];
        if (!operation) {
          const raced = await selectOperation(client, tenantId, idempotencyKey);
          if (!raced) throw new Error("Idempotency conflict could not be resolved");
          assertCreateReplay(raced, { name, provider, engine, disclosureVersion });
          throw new IdempotencyReplay(raced);
        }
        await client.query(
          `INSERT INTO secret_cleanup_outbox
             (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
           VALUES ($1,$2,$3,'WEBHOOK_SECRET',$4)
           ON CONFLICT DO NOTHING`,
          [tenantId, connectionId, operation.id, webhookSecretReference],
        );
        await appendAudit(client, request.principal, {
          action: "connection.created",
          targetType: "connection",
          targetId: connectionId,
          requestId: String(request.id),
          newValue: {
            name,
            provider,
            engine,
            state: "PROVISIONING",
            operation_id: operation.id,
            disclosure_version: disclosureVersion,
          },
        });
        return { ...operation, connection_name: name, provider, connection_state: "PROVISIONING" };
      });
    } catch (error) {
      if (error instanceof IdempotencyReplay) {
        return this.finishWahaProvision(error.operation, routeToken, hmacKey, true);
      }
      throw error;
    }
    return this.finishWahaProvision(staged, routeToken, hmacKey, false);
  }

  @Post(":id/start")
  @HttpCode(HttpStatus.ACCEPTED)
  @Requires("connection:write")
  start(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Headers("idempotency-key") key?: string) {
    return this.queueLifecycle(request, id, key, "START");
  }

  @Post(":id/restart")
  @HttpCode(HttpStatus.ACCEPTED)
  @Requires("connection:write")
  restart(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Headers("idempotency-key") key?: string) {
    return this.queueLifecycle(request, id, key, "RESTART");
  }

  @Post(":id/pause")
  @HttpCode(HttpStatus.ACCEPTED)
  @Requires("connection:write")
  pause(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Headers("idempotency-key") key?: string) {
    return this.queueLifecycle(request, id, key, "PAUSE");
  }

  @Post(":id/disconnect")
  @HttpCode(HttpStatus.ACCEPTED)
  @Requires("connection:disconnect")
  disconnect(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: { confirmation?: string },
  ) {
    if (body.confirmation !== "DISCONNECT") {
      throw new BadRequestException('Type "DISCONNECT" to confirm permanent disconnection');
    }
    return this.queueLifecycle(request, id, key, "DISCONNECT");
  }

  @Post(":id/groups/sync")
  @HttpCode(HttpStatus.ACCEPTED)
  @Requires("connection:write")
  syncGroups(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Headers("idempotency-key") key?: string, @Body() body: { eligibilityAccepted?: boolean; eligibilityVersion?: string } = {}) {
    return this.queueLifecycle(request, id, key, "SYNC_GROUPS", optionalMetaGroupsConsent(body));
  }

  @Post(":id/meta/credentials")
  @HttpCode(HttpStatus.OK)
  @Requires("connection:write")
  async rotateMetaCredential(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyHeader: string | undefined,
    @Body() body: RotateMetaCredentialBody,
  ) {
    return this.rotateMeta(request, id, requireIdempotencyKey(idempotencyHeader), validatedMetaAccessToken(body.accessToken));
  }

  /** Both HTTP paths share the existing rotation transaction; signup adds its one-use authority. */
  private async rotateMeta(request: AuthenticatedRequest, id: string, idempotencyKey: string, accessToken: string, signup?: SignupSelection) {
    const fingerprint = createHash("sha256").update(accessToken).digest("hex");
    const tenantId = request.principal.tenantId;
    const existing = await this.findOperation(tenantId, idempotencyKey);
    if (!hasCoexistenceTarget(signup?.attempt.target_binding) && (await this.database.rows(tenantId,
      "SELECT id FROM meta_coexistence_contexts WHERE tenant_id=$1 AND connection_id=$2", [tenantId, id])).length) {
      throw new ConflictException("Use the paused connection's Renew access action to preserve Business app capture history.");
    }
    if (signup) await this.metaSignup.guardSelection(request, signup);
    if (existing) {
      assertMetaRotationReplay(existing, id, fingerprint, signup);
      if (existing.state === "SUCCEEDED") return this.finishMetaRotation(request, existing, accessToken, true, undefined, signup);
      if (existing.state !== "STAGED") throw new ConflictException("Meta credential rotation is no longer available");
      const binding = await this.database.withTenant(tenantId, async (client) => {
        await requirePrivilegedAuthentication(client, request.principal, "replacing a Meta access token");
        return loadMetaBinding(client, tenantId, id);
      });
      assertMetaBinding(existing.payload.metaBinding, binding);
      assertLifecycleRevision(existing.payload.metaLifecycleExpectedRevision??0,binding.lifecycle);
      const relation = await this.verifyMetaCredential(accessToken, binding.phoneNumberId, binding.wabaId, async () => { await this.assertMetaDiagnosticCurrent(tenantId, id, binding); if (signup) await this.metaSignup.guardSelection(request, signup); });
      return this.finishMetaRotation(request, existing, accessToken, true, relation, signup);
    }

    const connection = await this.database.withTenant(tenantId, async (client) => {
      await requirePrivilegedAuthentication(client, request.principal, "replacing a Meta access token");
      return loadMetaBinding(client, tenantId, id);
    });
    const relation = await this.verifyMetaCredential(accessToken, connection.phoneNumberId, connection.wabaId, async () => { await this.assertMetaDiagnosticCurrent(tenantId, id, connection); if (signup) await this.metaSignup.guardSelection(request, signup); });

    const newReference = metaCredentialRotationReference(tenantId, id, idempotencyKey);
    let staged: OperationRow;
    try {
      staged = await this.database.withTenant(tenantId, async (client) => {
        const locked = await loadMetaBinding(client, tenantId, id);
        if (!sameMetaConnectionBinding(locked, connection)) {
          const raced = await selectOperation(client, tenantId, idempotencyKey);
          if (raced) {
            assertMetaRotationReplay(raced, id, fingerprint, signup);
            throw new IdempotencyReplay(raced);
          }
          throw new ConflictException("Meta credentials changed; refresh before replacing them");
        }
        await assertMetaLifecycleCurrent(client,id,locked,parseMetaLifecycleState(connection.lifecycle)?.revision??0,true);
        const operation = (
          await client.query<OperationRow>(
            `INSERT INTO connection_operations
               (tenant_id,connection_id,operation_type,idempotency_key,payload,state,
                requested_by_type,requested_by_id,request_id)
             VALUES ($1,$2,'ROTATE_META_CREDENTIAL',$3,$4,'STAGED','USER',$5,$6)
             ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING *`,
            [tenantId, id, idempotencyKey, {
              request: { credentialFingerprint: fingerprint },
              oldSecretReference: connection.secretReference,
              newSecretReference: newReference,
              metaBinding: connection,
              metaLifecycleExpectedRevision:parseMetaLifecycleState(connection.lifecycle)?.revision??0,
              accountRelation: relation,
              ...(signup ? { metaSignupAttemptId: signup.attempt.id, metaSignupPurpose: "RECONNECT" } : {}),
            }, request.principal.userId, String(request.id)],
          )
        ).rows[0];
        if (!operation) {
          const raced = await selectOperation(client, tenantId, idempotencyKey);
          if (!raced) throw new Error("Idempotency conflict could not be resolved");
          assertMetaRotationReplay(raced, id, fingerprint, signup);
          throw new IdempotencyReplay(raced);
        }
        if (signup) await this.metaSignup.bindRotation(client, request, signup, operation);
        await client.query(
          `INSERT INTO secret_cleanup_outbox
             (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
           VALUES ($1,$2,$3,'CONNECTION_CREDENTIAL',$4) ON CONFLICT DO NOTHING`,
          [tenantId, id, operation.id, newReference],
        );
        return { ...operation, provider: "META", connection_state: connection.state };
      });
    } catch (error) {
      if (error instanceof IdempotencyReplay) return this.finishMetaRotation(request, error.operation, accessToken, true, relation, signup);
      throw error;
    }
    return this.finishMetaRotation(request, staged, accessToken, false, relation, signup);
  }

  @Get(":id/meta/number-release")
  @Header("Cache-Control", "no-store")
  @Requires("connection:read")
  async metaNumberRelease(@Req() request:AuthenticatedRequest,@Param("id") id:string){
    return this.database.withTenant(request.principal.tenantId,client=>readMetaNumberRelease(client,request.principal.tenantId,id));
  }

  @Post(":id/meta/number-release")
  @HttpCode(HttpStatus.OK)
  @Header("Cache-Control", "no-store")
  @Requires("connection:disconnect")
  async releaseMetaNumber(@Req() request:AuthenticatedRequest,@Param("id") id:string,
    @Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    const requestKey=requireIdempotencyKey(key);
    return this.database.withTenant(request.principal.tenantId,client=>releaseMetaNumber(client,request,id,requestKey,body));
  }

  @Get(":id/meta/activation")
  @Requires("connection:read")
  async metaSavedAccessActivation(@Req() request:AuthenticatedRequest,@Param("id") id:string){
    return this.database.withTenant(request.principal.tenantId,client=>metaActivationView(client,id));
  }
  @Post(":id/meta/activation")
  @Requires("connection:write")
  @HttpCode(HttpStatus.ACCEPTED)
  async activateMetaSavedAccess(@Req() request:AuthenticatedRequest,@Param("id") id:string,@Headers("idempotency-key") key:string|undefined,@Body() body:unknown){
    const result=await this.database.withTenant(request.principal.tenantId,client=>queueMetaActivation(client,request,id,key,body));
    await this.wake(result.operation);return operationResponse(result.operation,result.duplicate);
  }

  private async queueLifecycle(
    request: AuthenticatedRequest,
    connectionId: string,
    idempotencyHeader: string | undefined,
    operationType: LifecycleOperationType,
    eligibilityVersion: string | null = null,
  ) {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const tenantId = request.principal.tenantId;
    const activation = operationType === "START" || operationType === "RESTART"
      ? await this.prepareMetaActivation(tenantId, connectionId, idempotencyKey, operationType) : undefined;
    const result = await this.database.withTenant(tenantId, async (client) => {
      const replay = await selectOperation(client, tenantId, idempotencyKey);
      if (replay) {
        assertLifecycleReplay(replay, connectionId, operationType, eligibilityVersion);
        return { operation: replay, duplicate: true };
      }

      const connection = (
        await client.query<{ id: string; name: string; provider: Provider; state: ConnectionState; action_reason: string | null; disclosure_version: string | null }>(
          "SELECT id,name,provider,state,action_reason,disclosure_version FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [tenantId, connectionId],
        )
      ).rows[0];
      if (!connection) throw new NotFoundException("Connection not found");
      if (connection.provider === "META" && ["START", "RESTART", "SYNC_GROUPS"].includes(operationType)) {
        await assertMetaAddAccessActivationAllowed(client, tenantId, connectionId);
      }
      // A concurrent request using the same key may have committed while this
      // transaction waited for the connection lock. Recheck before treating
      // its operation as a conflicting pending command.
      const replayAfterLock = await selectOperation(client, tenantId, idempotencyKey);
      if (replayAfterLock) {
        assertLifecycleReplay(replayAfterLock, connectionId, operationType, eligibilityVersion);
        return { operation: replayAfterLock, duplicate: true };
      }
      if (operationType === "DISCONNECT") {
        await requirePrivilegedAuthentication(
          client,
          request.principal,
          "permanently disconnecting a WhatsApp connection",
        );
      }
      if (!TRANSITIONS[operationType].has(connection.state)) {
        throw new ConflictException(`${operationType} is not allowed while the connection is ${connection.state}`);
      }
      const pending = (
        await client.query<{ id: string; operation_type: OperationType }>(
          "SELECT id,operation_type FROM connection_operations WHERE tenant_id=$1 AND connection_id=$2 AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE') ORDER BY created_at LIMIT 1",
          [tenantId, connectionId],
        )
      ).rows[0];
      if (pending) {
        throw new ConflictException(`Connection lifecycle operation ${pending.operation_type} is already pending`);
      }

      if (eligibilityVersion && connection.provider !== "META") {
        throw new BadRequestException("Official Groups acceptance requires a Meta connection.");
      }
      if (operationType === "SYNC_GROUPS" && connection.provider === "META") {
        if (!connection.disclosure_version && !eligibilityVersion) {
          throw new ConflictException("Accept the official Groups constraints before synchronizing groups.");
        }
        if (eligibilityVersion && connection.disclosure_version && connection.disclosure_version !== eligibilityVersion) {
          throw new ConflictException("Official Groups acceptance has already been recorded for this connection.");
        }
      }

      const metaBinding = connection.provider === "META" && !["PAUSE", "DISCONNECT"].includes(operationType)
        ? await loadMetaBinding(client, tenantId, connectionId) : undefined;
      if (metaBinding && (operationType === "START" || operationType === "RESTART")) {
        if (!activation) throw new ConflictException("Meta activation must verify the current credential first");
        assertMetaBinding(activation.binding, metaBinding);
      }
      const lifecycleRevision=metaBinding?parseMetaLifecycleState(metaBinding.lifecycle)?.revision??0:undefined;
      if(metaBinding){
        if(activation)assertLifecycleRevision(activation.lifecycleRevision,metaBinding.lifecycle);
        await assertMetaLifecycleCurrent(client,connectionId,metaBinding,lifecycleRevision!,!!activation?.recovery);
      }
      const admissionClosedAt = ["START", "RESTART", "PAUSE", "DISCONNECT"].includes(operationType)
        ? (await client.query<{ value: string }>("SELECT clock_timestamp()::text AS value")).rows[0]!.value
        : undefined;

      const operation = (
        await client.query<OperationRow>(
          `INSERT INTO connection_operations
             (tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,requested_by_id,request_id,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,'USER',$6,$7,COALESCE($8::timestamptz,clock_timestamp()),COALESCE($8::timestamptz,clock_timestamp()))
           ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
           RETURNING *`,
          [
            tenantId,
            connectionId,
            operationType,
            idempotencyKey,
            {
              requestedFromState: connection.state,
              ...(metaBinding ? { metaBinding,metaLifecycleExpectedRevision:lifecycleRevision } : {}),
              ...(activation?.recovery ? {metaLifecycleRecovery:activation.recovery} : {}),
              ...(eligibilityVersion ? { eligibilityVersion } : {}),
              ...(admissionClosedAt ? { admissionClosedAt } : {}),
            },
            request.principal.userId,
            String(request.id),
            admissionClosedAt ?? null,
          ],
        )
      ).rows[0];
      if (!operation) {
        const raced = await selectOperation(client, tenantId, idempotencyKey);
        if (!raced) throw new Error("Idempotency conflict could not be resolved");
        assertLifecycleReplay(raced, connectionId, operationType, eligibilityVersion);
        return { operation: raced, duplicate: true };
      }

      if (activation && metaBinding) {
        await storeMetaProof(client, operation, accountProof(operation, metaBinding, activation.relation, activation.accessToken));
      }

      if (eligibilityVersion && !connection.disclosure_version) {
        const accepted = await client.query(
          "UPDATE connections SET disclosure_version=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND disclosure_version IS NULL",
          [tenantId, connectionId, eligibilityVersion],
        );
        if (accepted.rowCount !== 1) throw new ConflictException("Official Groups acceptance changed; refresh this connection.");
        await client.query(
          `INSERT INTO consent_records (tenant_id,actor_id,policy_type,policy_version)
           VALUES ($1,$2,'META_OFFICIAL_GROUPS',$3) ON CONFLICT DO NOTHING`,
          [tenantId, request.principal.userId, eligibilityVersion],
        );
        await appendAudit(client, request.principal, {
          action: "connection.meta_groups_consent_accepted",
          targetType: "connection",
          targetId: connectionId,
          requestId: String(request.id),
          newValue: { eligibility_version: eligibilityVersion, operation_id: operation.id },
        });
      }

      const optimisticState = operationType === "RESTART" && ["WORKING", "DEGRADED"].includes(connection.state)
        ? undefined
        : OPTIMISTIC_STATES[operationType];
      if (optimisticState) {
        await client.query(
          "UPDATE connections SET state=$1,action_reason=NULL,updated_at=now() WHERE tenant_id=$2 AND id=$3",
          [optimisticState, tenantId, connectionId],
        );
      }
      if (["START", "RESTART", "PAUSE", "DISCONNECT"].includes(operationType)) {
        const pausedRoute = await client.query(
          `UPDATE webhook_routes
              SET state='PAUSED',updated_at=$3::timestamptz
            WHERE tenant_id=$1 AND connection_id=$2 AND state <> 'REVOKED'`,
          [tenantId, connectionId, admissionClosedAt],
        );
        if (pausedRoute.rowCount !== 1) {
          throw new ConflictException("The connection webhook route is unavailable");
        }
      }
      await appendAudit(client, request.principal, {
        action: `connection.${operationType.toLowerCase()}_requested`,
        targetType: "connection",
        targetId: connectionId,
        requestId: String(request.id),
        previousValue: { state: connection.state, action_reason: connection.action_reason },
        newValue: { state: optimisticState ?? connection.state, operation_id: operation.id },
      });
      return {
        operation: { ...operation, connection_name: connection.name, provider: connection.provider, connection_state: optimisticState ?? connection.state },
        duplicate: false,
      };
    });
    await this.wake(result.operation);
    return operationResponse(result.operation, result.duplicate);
  }

  private async findOperation(tenantId: string, idempotencyKey: string) {
    return (
      await this.database.rows<OperationRow>(
        tenantId,
        `SELECT o.*,c.name AS connection_name,c.provider,c.state AS connection_state
           FROM connection_operations o
           JOIN connections c ON c.tenant_id=o.tenant_id AND c.id=o.connection_id
          WHERE o.tenant_id=$1 AND o.idempotency_key=$2`,
        [tenantId, idempotencyKey],
      )
    )[0];
  }

  private async finishWahaProvision(
    operation: OperationRow,
    routeToken: string,
    hmacKey: string,
    duplicate: boolean,
  ) {
    if (operation.state !== "STAGED") {
      await this.wake(operation);
      return operationResponse(operation, true);
    }
    const routeHash = createHash("sha256").update(routeToken).digest("hex");
    const accepted = await this.database.withTenant(operation.tenant_id, async (client) => {
      const current = (
        await client.query<OperationRow>(
          "SELECT * FROM connection_operations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [operation.tenant_id, operation.id],
        )
      ).rows[0];
      if (!current) throw new ConflictException("Connection provisioning stage is no longer available");
      if (current.state !== "STAGED") {
        const replay = await selectOperation(client, operation.tenant_id, operation.idempotency_key);
        if (!replay || !["QUEUED", "RUNNING", "SUCCEEDED", "FAILED_RETRYABLE"].includes(replay.state)) {
          throw new ConflictException("Connection provisioning stage is no longer available");
        }
        return replay;
      }
      const reference = current.payload.webhookSecretReference;
      if (reference !== wahaWebhookSecretReference(current.tenant_id, current.connection_id)) {
        throw new ConflictException("Connection credential stage is invalid");
      }
      try {
        await this.secrets.storeWebhookSecret(reference, { routeToken, hmacKey });
      } catch (error) {
        throw new ServiceUnavailableException(
          "The secret manager is temporarily unavailable; retry with the same Idempotency-Key",
          { cause: error },
        );
      }
      const route = await client.query(
        `UPDATE webhook_routes SET route_token_sha256=$1,state='ACTIVE',
             admission_opened_at=date_trunc('second',clock_timestamp())+interval '1 second',updated_at=now()
          WHERE tenant_id=$2 AND connection_id=$3 AND provider='WAHA'
            AND hmac_secret_reference=$4 AND state='PAUSED'`,
        [routeHash, operation.tenant_id, operation.connection_id, reference],
      );
      if (route.rowCount !== 1) throw new ConflictException("Connection webhook stage is no longer available");
      const row = (
        await client.query<OperationRow>(
          `UPDATE connection_operations SET state='QUEUED',updated_at=now()
            WHERE tenant_id=$1 AND id=$2 AND state='STAGED'
            RETURNING *`,
          [operation.tenant_id, operation.id],
        )
      ).rows[0];
      if (row) return { ...row, connection_name: operation.connection_name, provider: "WAHA" as const, connection_state: "PROVISIONING" as const };
      const replay = await selectOperation(client, operation.tenant_id, operation.idempotency_key);
      if (!replay || !["QUEUED", "RUNNING", "SUCCEEDED", "FAILED_RETRYABLE"].includes(replay.state)) {
        throw new ConflictException("Connection provisioning stage is no longer available");
      }
      return replay;
    });
    await this.wake(accepted);
    return operationResponse(accepted, duplicate);
  }

  private async finishMetaProvision(operation: OperationRow, accessToken: string, duplicate: boolean, relation?: MetaAccountRelation, signupContext?: { request: AuthenticatedRequest; selection: SignupSelection }) {
    if (operation.payload.metaSignupAttemptId && (!signupContext || signupContext.selection.attempt.id !== operation.payload.metaSignupAttemptId
      || (operation.payload.metaSignupPurpose ?? "NEW_NUMBER") !== signupContext.selection.attempt.purpose)) throw new ConflictException("Account setup requires its original authorization context");
    if (signupContext?.selection.attempt.purpose === "ADD_ACCESS") return this.finishMetaAddAccess(operation, accessToken, duplicate, relation, signupContext);
    if (operation.state !== "STAGED") {
      await this.wake(operation);
      return operationResponse(operation, true);
    }
    const accepted = await this.database.withTenant(operation.tenant_id, async (client) => {
      await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [operation.tenant_id, operation.connection_id]);
      const current = (
        await client.query<OperationRow>(
          "SELECT * FROM connection_operations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [operation.tenant_id, operation.id],
        )
      ).rows[0];
      if (!current) throw new ConflictException("Connection provisioning stage is no longer available");
      if (current.state !== "STAGED") {
        const replay = await selectOperation(client, operation.tenant_id, operation.idempotency_key);
        if (!replay || !["QUEUED", "RUNNING", "SUCCEEDED", "FAILED_RETRYABLE"].includes(replay.state)) {
          throw new ConflictException("Connection provisioning stage is no longer available");
        }
        return replay;
      }
      if (current.payload.metaSignupAttemptId) {
        if (!signupContext) throw new ConflictException("Account setup requires its original authorization context");
        await this.metaSignup.guardPromotion(client, signupContext.request, signupContext.selection, current);
      }
      const reference = current.payload.credentialReference;
      if (reference !== metaCredentialSecretReference(current.tenant_id, current.connection_id)) {
        throw new ConflictException("Connection credential stage is invalid");
      }
      const binding = await loadMetaBinding(client, current.tenant_id, current.connection_id);
      const selected = current.payload.request as Record<string, unknown>;
      if (!relation || binding.secretReference !== reference || binding.providerSessionId !== current.payload.providerSessionId
        || binding.phoneNumberId !== selected.phoneNumberId || binding.wabaId !== selected.wabaId
        || selected.credentialFingerprint !== createHash("sha256").update(accessToken).digest("hex")) {
        throw new ConflictException("The Meta connection stage changed; refresh before continuing");
      }
      await assertMetaLifecycleCurrent(client,current.connection_id,binding,0,false);
      const proof = accountProof(current, binding, relation, accessToken);
      await storeMetaProof(client, current, proof);
      try {
        await this.secrets.storeMetaCredential(reference, { accessToken, ...(signupContext?.selection.registrationPin ? { registrationPin: signupContext.selection.registrationPin } : {}) });
      } catch (error) {
        throw new ServiceUnavailableException(
          "The secret manager is temporarily unavailable; retry with the same Idempotency-Key",
          { cause: error },
        );
      }
      const row = (
        await client.query<OperationRow>(
          `UPDATE connection_operations SET state='QUEUED',payload=payload || $3::jsonb,updated_at=now()
            WHERE tenant_id=$1 AND id=$2 AND state='STAGED'
            RETURNING *`,
          [operation.tenant_id, operation.id, JSON.stringify({ metaBinding: binding, metaAccountProof: proof,metaLifecycleExpectedRevision:0 })],
        )
      ).rows[0];
      if (!row) throw new ConflictException("Connection provisioning stage is no longer available");
      return { ...row, connection_name: operation.connection_name, provider: "META" as const, connection_state: "PROVISIONING" as const };
    });
    await this.wake(accepted);
    return operationResponse(accepted, duplicate);
  }

  private async finishMetaAddAccess(operation: OperationRow, accessToken: string, duplicate: boolean, relation: MetaAccountRelation | undefined,
    context: { request: AuthenticatedRequest; selection: SignupSelection }) {
    if (operation.state === "SUCCEEDED") return operationResponse(operation, true);
    const stage = async (client: PoolClient) => {
      await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [operation.tenant_id, operation.connection_id]);
      const current = (await client.query<OperationRow>("SELECT * FROM connection_operations WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [operation.tenant_id, operation.id])).rows[0];
      if (!current || current.state !== "STAGED" || current.operation_type !== "PROVISION") throw new ConflictException("The saved access stage changed");
      await this.metaSignup.guardPromotion(client, context.request, context.selection, current);
      const reference = metaCredentialSecretReference(current.tenant_id, current.connection_id);
      const binding = await loadMetaBinding(client, current.tenant_id, current.connection_id);
      const selected = current.payload.request as Record<string, unknown>;
      if (!relation || current.payload.credentialReference !== reference || binding.secretReference !== reference
        || binding.providerSessionId !== current.payload.providerSessionId || binding.phoneNumberId !== selected.phoneNumberId
        || binding.wabaId !== selected.wabaId || selected.credentialFingerprint !== createHash("sha256").update(accessToken).digest("hex")) {
        throw new ConflictException("The saved access account or credential changed");
      }
      await assertMetaLifecycleCurrent(client, current.connection_id, binding, 0, false);
      return { current, reference, binding, proof: accountProof(current, binding, relation, accessToken) };
    };
    const inspect = async (reference: string) => {
      let value;
      try { value = await this.metaCredentials.inspectSignupConnection(reference, { tenantId: operation.tenant_id, connectionId: operation.connection_id }); }
      catch { throw new ServiceUnavailableException("The saved credential needs a confirmed read before continuing."); }
      if (value && (value.accessToken !== accessToken || value.registrationPin !== undefined)) throw new ConflictException("The saved credential differs from this authorization");
      return value;
    };
    const prepared = await this.database.withTenant(operation.tenant_id, async client => {
      const current = await stage(client);
      if (await inspect(current.reference)) return { reference: current.reference, write: false };
      if (context.selection.attempt.connection_credential_write_claimed_at) throw new ServiceUnavailableException("A previous credential write is unresolved. It was not repeated.");
      await this.metaSignup.claimConnectionCredentialWrite(client, context.selection);
      return { reference: current.reference, write: true };
    });
    const accepted = await this.database.withTenant(operation.tenant_id, async client => {
      const { current, reference, binding, proof } = await stage(client);
      // Reacquire actor, tenant, connection and attempt locks after the durable
      // claim. Cancellation or revocation between transactions prevents the write.
      if (prepared.write) {
        try { await this.secrets.storeMetaCredential(prepared.reference, { accessToken }); }
        catch { throw new ServiceUnavailableException("The credential write outcome needs a confirmed read. It will not be repeated."); }
      }
      if (!await inspect(reference)) throw new ServiceUnavailableException("The credential write is not confirmed. It will not be repeated.");
      await storeMetaProof(client, current, proof);
      await client.query("UPDATE connections SET state='PAUSED',action_reason=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [current.tenant_id, current.connection_id]);
      await client.query("UPDATE provider_sessions SET state='PAUSED',provider_state='UNVERIFIED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND ownership_state='ACTIVE'", [current.tenant_id, binding.providerSessionId]);
      await client.query("UPDATE webhook_routes SET state='PAUSED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND connection_id=$2", [current.tenant_id, current.connection_id]);
      const result = (await client.query<OperationRow>(`UPDATE connection_operations SET state='SUCCEEDED',payload=payload || $3::jsonb,
        result=jsonb_build_object('accessAdded',true,'pausePreserved',true),completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND state='STAGED' RETURNING *`,
        [current.tenant_id, current.id, { metaBinding: binding, metaAccountProof: proof, metaLifecycleExpectedRevision: 0 }])).rows[0];
      if (!result) throw new ConflictException("The saved access stage changed");
      await this.metaSignup.completeAddAccess(client, context.request, context.selection);
      return { ...result, connection_name: operation.connection_name, provider: "META" as const, connection_state: "PAUSED" as const };
    });
    return operationResponse(accepted, duplicate);
  }

  private async finishMetaRotation(
    request: AuthenticatedRequest,
    operation: OperationRow,
    accessToken: string,
    duplicate: boolean,
    relation?: MetaAccountRelation,
    signup?: SignupSelection,
  ) {
    assertMetaRotationReplay(operation, operation.connection_id, createHash("sha256").update(accessToken).digest("hex"), signup);
    const coexRenewal = hasCoexistenceTarget(signup?.attempt.target_binding);
    const firstCoexWrite = coexRenewal && operation.state !== "SUCCEEDED" ? await this.database.withTenant(operation.tenant_id, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`privacy:${operation.tenant_id}`]);
      await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [operation.tenant_id, operation.connection_id]);
      const current = (await client.query<OperationRow>("SELECT * FROM connection_operations WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [operation.tenant_id, operation.id])).rows[0];
      if (!current) throw new ConflictException("Meta credential rotation is no longer available");
      await this.metaSignup.guardRotation(client, request, signup!, current);
      if (current.state === "SUCCEEDED" || signup!.attempt.connection_credential_write_claimed_at) return false;
      if (current.state !== "STAGED") throw new ConflictException("Meta credential rotation is no longer available");
      await this.metaSignup.claimConnectionCredentialWrite(client, signup!);
      return true;
    }) : false;
    const result = await this.database.withTenant(operation.tenant_id, async (client) => {
      if (coexRenewal) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`privacy:${operation.tenant_id}`]);
      // Staging, lifecycle and reconnect cancellation all serialize on connection
      // before operation/attempt. Do not validate current state for historical replay.
      await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [operation.tenant_id, operation.connection_id]);
      const current = (
        await client.query<OperationRow>(
          "SELECT * FROM connection_operations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [operation.tenant_id, operation.id],
        )
      ).rows[0];
      if (!current) throw new ConflictException("Meta credential rotation is no longer available");
      assertMetaRotationReplay(current, current.connection_id, createHash("sha256").update(accessToken).digest("hex"), signup);
      if (signup) await this.metaSignup.guardRotation(client, request, signup, current);
      // Replaying a completed rotation returns history, never queues a new activation.
      if (current.state === "SUCCEEDED") return { response: { rotated: true, duplicate: true }, validation: undefined };
      if (current.state !== "STAGED") throw new ConflictException("Meta credential rotation is no longer available");
      const oldReference = current.payload.oldSecretReference;
      const newReference = current.payload.newSecretReference;
      const fingerprint = (current.payload.request as Record<string, unknown> | undefined)?.credentialFingerprint;
      if (
        typeof oldReference !== "string" ||
        !isMetaCredentialSecretReference(oldReference, current.tenant_id, current.connection_id) ||
        newReference !== metaCredentialRotationReference(
          current.tenant_id,
          current.connection_id,
          current.idempotency_key,
        ) ||
        fingerprint !== createHash("sha256").update(accessToken).digest("hex")
      ) {
        throw new ConflictException("Connection credential stage is invalid");
      }
      const connection = await loadMetaBinding(client, operation.tenant_id, operation.connection_id);
      assertMetaBinding(current.payload.metaBinding, connection);
      await assertMetaLifecycleCurrent(client,current.connection_id,connection,current.payload.metaLifecycleExpectedRevision??0,true);
      if (connection.secretReference !== oldReference || !relation
        || relation.phoneNumberId !== connection.phoneNumberId || relation.wabaId !== connection.wabaId) {
        throw new ConflictException("Meta credentials changed; refresh before replacing them");
      }
      const proof = accountProof(current, { ...connection, secretReference: newReference }, relation, accessToken);
      try {
        const staged = signup ? await this.metaCredentials.inspectSignupConnection(newReference, { tenantId: current.tenant_id, connectionId: current.connection_id }) : undefined;
        if (staged && (staged.accessToken !== accessToken || staged.registrationPin !== undefined)) throw new ConflictException("Connection credential stage is invalid");
        if (!staged) {
          if (coexRenewal && !firstCoexWrite) throw new ServiceUnavailableException("The credential write outcome is unknown. Refresh the same authorization to reconcile it.");
          await this.secrets.storeMetaCredential(newReference, { accessToken });
        }
        if (coexRenewal) {
          const confirmed = await this.metaCredentials.inspectSignupConnection(newReference, { tenantId: current.tenant_id, connectionId: current.connection_id });
          if (!confirmed || confirmed.accessToken !== accessToken || confirmed.registrationPin !== undefined) throw new ServiceUnavailableException("The credential write needs a confirmed matching read before promotion.");
        }
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        throw new ServiceUnavailableException(
          "The secret manager is temporarily unavailable; retry with the same Idempotency-Key",
          { cause: error },
        );
      }
      const switched = await client.query(
        `UPDATE connections SET secret_reference=$1,updated_at=now()
          WHERE tenant_id=$2 AND id=$3 AND secret_reference=$4 AND state<>'REVOKED'`,
        [newReference, operation.tenant_id, operation.connection_id, oldReference],
      );
      if (switched.rowCount !== 1) throw new ConflictException("Meta credentials changed; refresh before replacing them");
      await storeMetaProof(client, current, proof);
      await client.query(
        `INSERT INTO secret_cleanup_outbox
           (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
         VALUES ($1,$2,$3,'CONNECTION_CREDENTIAL',$4) ON CONFLICT DO NOTHING`,
        [operation.tenant_id, operation.connection_id, operation.id, oldReference],
      );
      await appendAudit(client, request.principal, {
        action: "connection.meta_credential_rotated",
        targetType: "connection",
        targetId: operation.connection_id,
        requestId: String(request.id),
        newValue: { credential_fingerprint_sha256: fingerprint, operation_id: operation.id },
      });
      const completed = await client.query(
        `UPDATE connection_operations SET state='SUCCEEDED',result=$1::jsonb,
             completed_at=now(),updated_at=now()
          WHERE tenant_id=$2 AND id=$3 AND state='STAGED'`,
        [JSON.stringify({ rotated: true, metaAccountProof: proof, ...(signup ? { pausePreserved: true } : {}) }), operation.tenant_id, operation.id],
      );
      if (completed.rowCount !== 1) throw new ConflictException("Meta credential rotation is no longer available");
      if (signup) await this.metaSignup.completeRotation(client, signup);
      return {
        response: { rotated: true, duplicate },
        validation: connection.state === "PAUSED" ? undefined : await ensureMetaRotationValidation(client, request, current, proof,parseMetaLifecycleState(connection.lifecycle)?.revision??0),
      };
    });
    if(result.validation)await this.wake(result.validation);
    return result.response;
  }

  private async createMeta(
    request: AuthenticatedRequest,
    idempotencyKey: string,
    name: string,
    body: CreateBody,
    signup?: SignupSelection,
  ) {
    const phoneNumberId = validatedMetaNumericId(body.phoneNumberId, "phone-number ID");
    const wabaId = validatedMetaNumericId(body.wabaId, "WhatsApp Business Account ID");
    const accessToken = validatedMetaAccessToken(body.accessToken);
    const eligibilityVersion = optionalMetaGroupsConsent(body);
    const tenantId = request.principal.tenantId;
    const credentialFingerprint = createHash("sha256").update(accessToken).digest("hex");
    const replay = await this.findOperation(tenantId, idempotencyKey);
    if (replay) {
      if ((replay.payload.metaSignupAttemptId || signup) && (replay.payload.metaSignupAttemptId !== signup?.attempt.id
        || (replay.payload.metaSignupPurpose ?? "NEW_NUMBER") !== signup?.attempt.purpose)) throw new ConflictException("Account setup operation changed");
      assertMetaCreateReplay(replay, {
        name,
        phoneNumberId,
        wabaId,
        eligibilityVersion,
        credentialFingerprint,
      });
      let relation:MetaAccountRelation|undefined;
      if(replay.state==="STAGED"){
        if(replay.payload.credentialReference!==metaCredentialSecretReference(tenantId,replay.connection_id))throw new ConflictException("Connection credential stage is invalid");
        const binding=await this.database.withTenant(tenantId,client=>loadMetaBinding(client,tenantId,replay.connection_id));
        if(binding.phoneNumberId!==phoneNumberId||binding.wabaId!==wabaId)throw new ConflictException("The Meta connection stage changed");
        assertLifecycleRevision(0,binding.lifecycle);
        relation=await this.verifyMetaCredential(accessToken,phoneNumberId,wabaId,async()=>{ await this.assertMetaDiagnosticCurrent(tenantId,replay.connection_id,binding); if(signup) await this.metaSignup.guardSelection(request,signup); });
      }
      return this.finishMetaProvision(replay, accessToken, true, relation, signup ? { request, selection: signup } : undefined);
    }

    const relation = await this.verifyMetaCredential(accessToken, phoneNumberId, wabaId, signup ? () => this.metaSignup.guardSelection(request, signup) : undefined);

    const config = metaProvisioningConfig();
    const connectionId = randomUUID();
    const providerSessionId = randomUUID();
    const credentialReference = metaCredentialSecretReference(tenantId, connectionId);
    let staged: OperationRow;
    try {
      staged = await this.database.withTenant(tenantId, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('meta-signup-phone:'||$1,0))", [phoneNumberId]);
        if (signup) {
          const availability = (await client.query<{ available: boolean }>("SELECT app.meta_signup_phone_available($1) AS available", [phoneNumberId])).rows[0];
          if (availability?.available !== true) throw new ConflictException({ code: "META_SIGNUP_ASSET_CONFLICT", message: "This number is already connected." });
        }
        await client.query(
          `INSERT INTO connections
             (id,tenant_id,name,provider,engine,state,secret_reference,disclosure_version)
           VALUES ($1,$2,$3,'META','CLOUD_API','PROVISIONING',$4,$5)`,
          [connectionId, tenantId, name, credentialReference, eligibilityVersion],
        );
        await client.query(
          `INSERT INTO provider_sessions
             (id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,
              ownership_state,provider_state,provider_state_data)
           VALUES ($1,$2,$3,$4,'PROVISIONING',$5,'ACTIVE','UNVERIFIED',$6::jsonb)`,
          [
            providerSessionId,
            tenantId,
            connectionId,
            phoneNumberId,
            `meta-cloud://${wabaId}/${phoneNumberId}`,
            JSON.stringify({ wabaId, eligibility: "UNVERIFIED", ...(signup ? { metaSignup: { attemptId: signup.attempt.id, purpose: signup.attempt.purpose, businessId: signup.choice.businessId, wabaId, phoneId: phoneNumberId, graphVersion: signup.attempt.config.graphVersion, ...(signup.attempt.config.variant ? { variant: signup.attempt.config.variant } : {}) } } : {}) }),
          ],
        );
        await client.query(
          `INSERT INTO webhook_routes
             (tenant_id,connection_id,provider,external_key,hmac_secret_reference,state)
           VALUES ($1,$2,'META',$3,$4,'PAUSED')`,
          [tenantId, connectionId, phoneNumberId, config.metaAppSecretReference],
        );
        if (eligibilityVersion) {
          await client.query(
            `INSERT INTO consent_records (tenant_id,actor_id,policy_type,policy_version)
             VALUES ($1,$2,'META_OFFICIAL_GROUPS',$3)
             ON CONFLICT DO NOTHING`,
            [tenantId, request.principal.userId, eligibilityVersion],
          );
        }
        const operation = (
          await client.query<OperationRow>(
            `INSERT INTO connection_operations
               (tenant_id,connection_id,operation_type,idempotency_key,payload,state,
                requested_by_type,requested_by_id,request_id)
             VALUES ($1,$2,'PROVISION',$3,$4,'STAGED','USER',$5,$6)
             ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
             RETURNING *`,
            [
              tenantId,
              connectionId,
              idempotencyKey,
              {
                providerSessionId,
                credentialReference,
                ...(signup ? { metaSignupAttemptId: signup.attempt.id, metaSignupPurpose: signup.attempt.purpose } : {}),
                request: {
                  name,
                  provider: "META",
                  phoneNumberId,
                  wabaId,
                  eligibilityVersion,
                  credentialFingerprint,
                },
              },
              request.principal.userId,
              String(request.id),
            ],
          )
        ).rows[0];
        if (!operation) {
          const raced = await selectOperation(client, tenantId, idempotencyKey);
          if (!raced) throw new Error("Idempotency conflict could not be resolved");
          assertMetaCreateReplay(raced, {
            name,
            phoneNumberId,
            wabaId,
            eligibilityVersion,
            credentialFingerprint,
          });
          throw new IdempotencyReplay(raced);
        }
        if (signup) await this.metaSignup.bindProvision(client, request, signup, connectionId, operation.id);
        await client.query(
          `INSERT INTO secret_cleanup_outbox
             (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
           VALUES ($1,$2,$3,'CONNECTION_CREDENTIAL',$4)
           ON CONFLICT DO NOTHING`,
          [tenantId, connectionId, operation.id, credentialReference],
        );
        await appendAudit(client, request.principal, {
          action: "connection.created",
          targetType: "connection",
          targetId: connectionId,
          requestId: String(request.id),
          newValue: {
            name,
            provider: "META",
            state: "PROVISIONING",
            operation_id: operation.id,
            phone_number_id: phoneNumberId,
            eligibility_version: eligibilityVersion,
            eligibility: "UNVERIFIED",
          },
        });
        return {
          ...operation,
          connection_name: name,
          provider: "META",
          connection_state: "PROVISIONING",
        };
      });
    } catch (error) {
      if (error instanceof IdempotencyReplay) {
        return this.finishMetaProvision(error.operation, accessToken, true, relation, signup ? { request, selection: signup } : undefined);
      }
      // The global reservation also protects manual setup and concurrent signup attempts.
      if (typeof error === "object" && error !== null
        && "code" in error && error.code === "23505"
        && "constraint" in error && error.constraint === "webhook_routes_provider_external_key_key") {
        throw new ConflictException({ code: "META_SIGNUP_ASSET_CONFLICT", message: "This number is already connected." });
      }
      throw error;
    }
    return this.finishMetaProvision(staged, accessToken, false, relation, signup ? { request, selection: signup } : undefined);
  }

  private async verifyMetaCredential(accessToken: string, phoneNumberId: string, wabaId: string, beforeRequest?:()=>Promise<void>) {
    const config = metaProvisioningConfig();
    try {
      const appSecret = await this.webhookSecrets.resolveHmac(config.metaAppSecretReference,
        { kind: "exact", expectedReference: config.metaAppSecretReference });
      const client = this.metaGroups.create(accessToken, phoneNumberId, beforeRequest);
      const credentialMetadata = await client.verifyCredentialMetadata(config.metaAppId, appSecret);
      const relation = await client.verifyPhoneAccountRelationship(wabaId);
      return { ...relation, credentialMetadata };
    } catch (error) {
      if(error instanceof ConflictException||error instanceof NotFoundException)throw error;
      if (error instanceof MetaGraphClientError && !error.retryable) {
        throw new BadRequestException(error.safeError);
      }
      throw new ServiceUnavailableException("Meta credential verification is temporarily unavailable", {
        cause: error,
      });
    }
  }

  private async prepareMetaActivation(tenantId: string, connectionId: string, key: string, type: "START" | "RESTART") {
    const binding = await this.database.withTenant(tenantId, async client => {
      const replay = await selectOperation(client, tenantId, key);
      if (replay) { assertLifecycleReplay(replay, connectionId, type, null); return undefined; }
      const connection = (await client.query<{ provider: Provider; state: ConnectionState }>(
        "SELECT provider,state FROM connections WHERE tenant_id=$1 AND id=$2", [tenantId, connectionId],
      )).rows[0];
      if (!connection) throw new NotFoundException("Connection not found");
      if (connection.provider !== "META") return undefined;
      await assertMetaAddAccessActivationAllowed(client, tenantId, connectionId);
      if (!TRANSITIONS[type].has(connection.state)) throw new ConflictException(`${type} is not allowed while the connection is ${connection.state}`);
      const pending = (await client.query("SELECT id FROM connection_operations WHERE tenant_id=$1 AND connection_id=$2 AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE') LIMIT 1", [tenantId, connectionId])).rows[0];
      if (pending) throw new ConflictException("A connection lifecycle operation is already pending");
      return loadMetaBinding(client, tenantId, connectionId);
    });
    if (!binding) return undefined;
    // No database lock is held while resolving or verifying an external credential.
    const accessToken = await this.metaCredentials.resolveAccessToken(binding.secretReference, { tenantId, connectionId });
    const lifecycleRevision=parseMetaLifecycleState(binding.lifecycle)?.revision??0;
    const reasons=metaLifecycleBlockingReasons(binding.lifecycle);
    const recovery=reasons.length?{expectedRevision:lifecycleRevision,reasons}:undefined;
    if(recovery){
      try{assertMetaLifecycleAccess(recoverMetaLifecycleReasons(binding.lifecycle,lifecycleRevision,reasons));}
      catch{throw new ConflictException("Meta account access requires authoritative lifecycle recovery");}
    }
    const beforeRequest=()=>this.assertMetaDiagnosticCurrent(tenantId,connectionId,binding);
    const relation = await this.verifyMetaCredential(accessToken, binding.phoneNumberId, binding.wabaId,beforeRequest);
    return { binding, relation, accessToken,lifecycleRevision,recovery };
  }

  private async assertMetaDiagnosticCurrent(tenantId:string,connectionId:string,binding:MetaConnectionBinding&{lifecycle?:unknown}){
    await this.database.withTenant(tenantId,async client=>{
      const current=await loadMetaBinding(client,tenantId,connectionId);
      assertMetaBinding(binding,current);
      await assertMetaLifecycleCurrent(client,connectionId,current,parseMetaLifecycleState(binding.lifecycle)?.revision??0,true);
    });
  }

  private async wake(operation: OperationRow) {
    if (!["QUEUED", "RUNNING", "FAILED_RETRYABLE"].includes(operation.state)) return;
    try {
      await this.drains.wakeConnection(operation.tenant_id);
    } catch (error) {
      throw new ServiceUnavailableException("The operation was accepted but the worker wake failed; retry with the same Idempotency-Key", {
        cause: error,
      });
    }
  }
}

function assertMetaTransitionId(value:string){if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value))throw new BadRequestException('Invalid account preview request.');}

async function selectOperation(client: PoolClient, tenantId: string, idempotencyKey: string) {
  return (
    await client.query<OperationRow>(
      `SELECT o.*,c.name AS connection_name,c.provider,c.state AS connection_state
         FROM connection_operations o
         JOIN connections c ON c.tenant_id=o.tenant_id AND c.id=o.connection_id
        WHERE o.tenant_id=$1 AND o.idempotency_key=$2`,
      [tenantId, idempotencyKey],
    )
  ).rows[0];
}

async function diagnosticSession(client: PoolClient, tenantId: string, connectionId: string) {
  const sessions = (await client.query<{id:string;state:string;opaque_session_id:string;provider_state_data:Record<string,unknown>}>(`SELECT id,state,opaque_session_id,provider_state_data
    FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE' FOR SHARE`, [tenantId,connectionId])).rows;
  return sessions.length === 1 ? {id:sessions[0]!.id,state:sessions[0]!.state,opaqueSessionId:sessions[0]!.opaque_session_id,providerStateData:sessions[0]!.provider_state_data} : undefined;
}


function assertMetaBinding(value: unknown, current: MetaConnectionBinding) {
  if (!value || typeof value !== "object" || !sameMetaConnectionBinding(value as MetaConnectionBinding, current)) {
    throw new ConflictException("The Meta connection changed; refresh before continuing");
  }
}

function accountProof(operation: OperationRow, binding: MetaConnectionBinding, relation: MetaAccountRelation, accessToken: string): MetaAccountProof {
  return { ...relation, tenantId: operation.tenant_id, connectionId: operation.connection_id,
    secretReference: binding.secretReference, providerSessionId: binding.providerSessionId,
    credentialFingerprint: createHash("sha256").update(accessToken).digest("hex"), operationId: operation.id, fencingToken: 0 };
}

async function storeMetaProof(client: PoolClient, operation: OperationRow, proof: MetaAccountProof) {
  const updated = await client.query(
    `UPDATE provider_sessions SET provider_state_data=provider_state_data || jsonb_build_object('metaAccountProof',$4::jsonb),updated_at=now()
      WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND ownership_state='ACTIVE'`,
    [operation.tenant_id, operation.connection_id, proof.providerSessionId, JSON.stringify(proof)],
  );
  if (updated.rowCount !== 1) throw new ConflictException("The Meta session changed; refresh before continuing");
}

async function ensureMetaRotationValidation(client:PoolClient,request:AuthenticatedRequest,rotation:OperationRow,proof:MetaAccountProof,lifecycleRevision:number){
  const key=`meta-credential-validation:${createHash("sha256").update(rotation.idempotency_key).digest("hex")}`;
  const inserted=(await client.query<OperationRow>(`INSERT INTO connection_operations
    (tenant_id,connection_id,operation_type,idempotency_key,payload,state,requested_by_type,requested_by_id,request_id)
    VALUES ($1,$2,'RESTART',$3,$4,'QUEUED','USER',$5,$6)
    ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING *`,[
    rotation.tenant_id,rotation.connection_id,key,{sourceOperationId:rotation.id,metaLifecycleExpectedRevision:lifecycleRevision,metaBinding:{secretReference:proof.secretReference,providerSessionId:proof.providerSessionId,phoneNumberId:proof.phoneNumberId,wabaId:proof.wabaId}},request.principal.userId,String(request.id),
  ])).rows[0];
  if(inserted)return inserted;
  const replay=await selectOperation(client,rotation.tenant_id,key);
  if(!replay||replay.operation_type!=="RESTART"||replay.connection_id!==rotation.connection_id)throw new ConflictException("Meta credential validation operation is unavailable");
  return replay;
}

function requireIdempotencyKey(value: string | undefined) {
  if (!value || value.length > 255 || value.trim() !== value || hasControlCharacters(value)) {
    throw new BadRequestException("A valid Idempotency-Key header is required");
  }
  return value;
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function assertCreateReplay(
  operation: OperationRow,
  expected: { name: string; provider: "WAHA"; engine: WahaEngine; disclosureVersion: string },
) {
  const request = operation.payload?.request as Record<string, unknown> | undefined;
  // Operations accepted before selectable engines were introduced used GOWS.
  // Treat an absent historical value as GOWS while fingerprinting every new
  // request explicitly; a NOWEB request can never replay a legacy operation.
  const requestedEngine = request?.engine ?? "GOWS";
  if (
    operation.operation_type !== "PROVISION" ||
    operation.connection_name !== expected.name ||
    operation.provider !== expected.provider ||
    requestedEngine !== expected.engine ||
    request?.disclosureVersion !== expected.disclosureVersion
  ) {
    throw new ConflictException("Idempotency-Key was already used for a different request");
  }
}

function validatedWahaEngine(value: unknown): WahaEngine {
  if (value === undefined) return "GOWS";
  if (typeof value !== "string") {
    throw new BadRequestException("Only the qualified GOWS engine is available for new connections");
  }
  const engine = value.toUpperCase();
  if (engine !== "GOWS") {
    throw new BadRequestException("Only the qualified GOWS engine is available for new connections");
  }
  return engine;
}

function assertMetaCreateReplay(
  operation: OperationRow,
  expected: {
    name: string;
    phoneNumberId: string;
    wabaId: string;
    eligibilityVersion: string | null;
    credentialFingerprint: string;
  },
) {
  const request = operation.payload?.request as Record<string, unknown> | undefined;
  if (
    operation.operation_type !== "PROVISION" ||
    operation.connection_name !== expected.name ||
    operation.provider !== "META" ||
    request?.provider !== "META" ||
    request?.phoneNumberId !== expected.phoneNumberId ||
    request?.wabaId !== expected.wabaId ||
    (request?.eligibilityVersion ?? null) !== expected.eligibilityVersion ||
    request?.credentialFingerprint !== expected.credentialFingerprint
  ) {
    throw new ConflictException("Idempotency-Key was already used for a different request");
  }
}

function assertMetaRotationReplay(operation: OperationRow, connectionId: string, fingerprint: string, signup?: SignupSelection) {
  if ((operation.payload.metaSignupAttemptId || signup) && (operation.payload.metaSignupAttemptId !== signup?.attempt.id || operation.payload.metaSignupPurpose !== "RECONNECT" || signup?.attempt.purpose !== "RECONNECT")) {
    throw new ConflictException("Account setup requires its original authorization context");
  }
  const request = operation.payload?.request as Record<string, unknown> | undefined;
  if (
    operation.operation_type !== "ROTATE_META_CREDENTIAL" ||
    operation.connection_id !== connectionId ||
    request?.credentialFingerprint !== fingerprint
  ) {
    throw new ConflictException("Idempotency-Key was already used for a different request");
  }
}

function assertLifecycleReplay(operation: OperationRow, connectionId: string, operationType: LifecycleOperationType, eligibilityVersion: string | null = null) {
  if (operation.connection_id !== connectionId || operation.operation_type !== operationType ||
      (operation.payload?.eligibilityVersion ?? null) !== eligibilityVersion) {
    throw new ConflictException("Idempotency-Key was already used for a different request");
  }
}

function optionalMetaGroupsConsent(body: { eligibilityAccepted?: unknown; eligibilityVersion?: unknown }): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestException("A valid official Groups acceptance request is required.");
  }
  if ((body.eligibilityAccepted === undefined || body.eligibilityAccepted === false) && body.eligibilityVersion === undefined) return null;
  const version = typeof body.eligibilityVersion === "string" ? body.eligibilityVersion.trim() : "";
  if (body.eligibilityAccepted !== true || !version || version.length > 100 || hasControlCharacters(version)) {
    throw new BadRequestException("Official Groups acceptance requires explicit agreement and a valid policy version.");
  }
  return version;
}

function operationResponse(operation: OperationRow, duplicate: boolean) {
  return {
    id: operation.connection_id,
    state: operation.connection_state,
    operation: {
      id: operation.id,
      type: operation.operation_type,
      state: operation.state,
      attempts: operation.attempts,
      created_at: operation.created_at,
    },
    duplicate,
  };
}

function randomToken(bytes: number) {
  return Buffer.from(randomBytes(bytes)).toString("base64url");
}

function provisioningConfig() {
  const wahaAdminSecretReference = process.env.WAHA_ADMIN_SECRET_REFERENCE;
  if (
    !wahaAdminSecretReference ||
    Buffer.byteLength(wahaAdminSecretReference, "utf8") > 512 ||
    !/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/.test(wahaAdminSecretReference)
  ) {
    throw new ServiceUnavailableException("WAHA administrative credentials are not configured");
  }
  const rawBaseUrl = process.env.PUBLIC_WEBHOOK_BASE_URL;
  if (!rawBaseUrl) throw new ServiceUnavailableException("The public webhook URL is not configured");
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new ServiceUnavailableException("The public webhook URL is invalid");
  }
  const insecureDevelopmentOverride =
    process.env.ALLOW_INSECURE_WEBHOOK_URL === "true" && process.env.NODE_ENV !== "production";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && insecureDevelopmentOverride)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ServiceUnavailableException("The public webhook URL is invalid");
  }
  return {
    wahaAdminSecretReference,
    publicWebhookBaseUrl: rawBaseUrl.replace(/\/+$/, ""),
  };
}

function metaProvisioningConfig() {
  const metaAppId = process.env.META_APP_ID;
  if (!metaAppId || !/^\d{5,32}$/u.test(metaAppId)) {
    throw new ServiceUnavailableException("The Meta app identity is not configured");
  }
  const metaAppSecretReference = process.env.META_APP_SECRET_REFERENCE;
  if (
    !metaAppSecretReference ||
    Buffer.byteLength(metaAppSecretReference, "utf8") > 512 ||
    !/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u.test(metaAppSecretReference)
  ) {
    throw new ServiceUnavailableException("Meta webhook credentials are not configured");
  }
  const graphVersion = process.env.META_GRAPH_VERSION;
  if (!graphVersion || !/^v\d{1,3}\.\d{1,3}$/u.test(graphVersion)) {
    throw new ServiceUnavailableException("The Meta Graph API version is not configured");
  }
  return { metaAppSecretReference, metaAppId };
}

function validatedMetaNumericId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^\d{5,32}$/u.test(value)) {
    throw new BadRequestException(`A valid Meta ${label} is required`);
  }
  return value;
}

function validatedMetaAccessToken(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 4_096 ||
    hasControlCharacters(value)
  ) {
    throw new BadRequestException("A valid Meta System User access token is required");
  }
  return value;
}

class IdempotencyReplay extends Error {
  constructor(readonly operation: OperationRow) {
    super("Idempotent provisioning replay");
  }
}

function assertLifecycleRevision(expected:unknown,lifecycle:unknown){
  if(typeof expected!=="number"||!Number.isSafeInteger(expected)||expected<0||(parseMetaLifecycleState(lifecycle)?.revision??0)!==expected){
    throw new ConflictException("The Meta account lifecycle changed; refresh before continuing");
  }
}
async function assertMetaLifecycleCurrent(client:PoolClient,connectionId:string,binding:MetaConnectionBinding&{lifecycle?:unknown},revision:unknown,diagnostic:boolean){
  assertLifecycleRevision(revision,binding.lifecycle);
  const guard=(await client.query<{revision_matches:boolean;blocked:boolean;unresolved_hold:boolean}>(
    "SELECT * FROM app.meta_lifecycle_guard($1,$2,$3,$4,$5,$6)",
    [connectionId,binding.providerSessionId,binding.phoneNumberId,binding.wabaId,process.env.META_APP_ID??"",revision])).rows;
  if(guard.length!==1||guard[0].revision_matches!==true||guard[0].unresolved_hold!==false||(!diagnostic&&guard[0].blocked!==false)){
    throw new ConflictException("Meta account access requires lifecycle reconciliation");
  }
  if(!diagnostic)assertMetaLifecycleAccess(binding.lifecycle);
}
