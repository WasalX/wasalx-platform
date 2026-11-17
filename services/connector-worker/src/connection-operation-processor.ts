import {prepareMetaTemplates} from './meta-template-preparation.js';
import {executeMetaLegacyMigration} from './meta-legacy-migration.js';
import {executeMetaAccountTransition} from './meta-account-transition-execution.js';
import {processMetaAccountTransitionPreview} from './meta-account-transition-processor.js';
import {executeMetaManagedFunding} from "./meta-managed-funding.js";
import { readMetaAddAccessActivation } from "./meta-add-access-activation.js";
import { MetaGroupsAdapter, type MetaGroupsCapability } from "../../../packages/connectors/src/meta.js";
import type { MessagingProviderAdapter, ProviderGroup } from "../../../packages/connectors/src/types.js";
import { ProviderError } from "../../../packages/connectors/src/types.js";
import {
  WahaAdapter,
  normalizeWahaPhone,
  type WahaSessionSnapshot,
  type WahaSessionStatus,
} from "../../../packages/connectors/src/waha.js";
import { backoffMs } from "../../../packages/core/src/delivery.js";
import {
  ConnectionOperationLeaseLostError,
  ProviderSessionLeaseUnavailableError,
  WahaWorkerAssignmentUnavailableError,
  type ConnectionOperationJob,
  type ConnectionOperationStore,
  type ConnectionRuntimeState,
  type OperationCompletion,
  type ProviderSessionLease,
} from "./connection-operation-repository.js";
import { SecretResolutionError, type SecretResolver } from "./secrets.js";
import { createHash } from "node:crypto";
import { assertMetaCredentialProof, MetaCredentialMetadataError, sameMetaConnectionBinding, type MetaAccountProof, type MetaConnectionBinding } from "../../../packages/core/src/meta-account-relation.js";
import { observeDuration, recordMetric } from "@wasalx/observability";
import { unavailableMetaBillingDiagnostic } from "../../../packages/core/src/meta-billing-diagnostic.js";

export type ConnectionOperationProcessorConfig = {
  /** @deprecated WAHA endpoints are resolved from the durable worker assignment. */
  wahaBaseUrl?: string;
  metaGraphVersion?: string;
  metaAppId?: string;
  publicWebhookBaseUrl: string;
  workerIdentity?: string;
  claimLimit?: number;
  leaseForSeconds?: number;
  maxGroupPages?: number;
  maxGroups?: number;
  allowInsecureWebhookUrl?: boolean;
};

export type ConnectionOperationDrainResult = {
  claimed: number;
  succeeded: number;
  failedRetryable: number;
  failedTerminal: number;
  leaseLost: number;
};

export type ConnectionOperationErrorClassification = {
  retryable: boolean;
  code: string;
  safeError: string;
  connectionState: ConnectionRuntimeState;
};

type ResolvedLifecycleSecrets = {
  apiKey: string;
  hmacKey?: string;
  routeToken?: string;
};

type ProviderOutcome = {
  connectionState: ConnectionRuntimeState;
  providerState: string;
  providerStateData: Record<string, unknown>;
  actionReason: string | null;
  engine?: string;
};

type ProcessResult = "succeeded" | "failed-retryable" | "failed-terminal" | "lease-lost";
class MetaBillingAccessHeldError extends Error {}

// `message.ack.group` is WAHA's dedicated group receipt event. The general
// `message.ack` event is contact-oriented and is intentionally not subscribed.
const WAHA_EVENTS = [
  "message",
  "message.any",
  "message.edited",
  "message.revoked",
  "message.reaction",
  "poll.vote",
  "message.ack.group",
  "session.status",
] as const;
const ROUTE_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

export class ConnectionOperationProcessor {
  private readonly workerIdentity: string;
  private readonly claimLimit: number;
  private readonly leaseForSeconds: number;
  private readonly maxGroupPages: number;
  private readonly maxGroups: number;
  private readonly publicWebhookBaseUrl: URL;

  constructor(
    private readonly repository: ConnectionOperationStore,
    private readonly secrets: SecretResolver,
    private readonly config: ConnectionOperationProcessorConfig,
  ) {
    this.workerIdentity = boundedWorkerIdentity(config.workerIdentity ?? `connection-worker:${crypto.randomUUID()}`);
    // Each operation can make several provider calls and synchronize many
    // group pages. Claiming one row at a time prevents later rows from losing
    // their database lease before this worker can begin executing them.
    this.claimLimit = boundedInteger(config.claimLimit ?? 1, 1, 1, "claimLimit");
    this.leaseForSeconds = boundedInteger(config.leaseForSeconds ?? 120, 30, 300, "leaseForSeconds");
    this.maxGroupPages = boundedInteger(config.maxGroupPages ?? 1_000, 1, 10_000, "maxGroupPages");
    this.maxGroups = boundedInteger(config.maxGroups ?? 100_000, 1, 1_000_000, "maxGroups");
    this.publicWebhookBaseUrl = validatedPublicWebhookBase(
      config.publicWebhookBaseUrl,
      config.allowInsecureWebhookUrl ?? false,
    );
  }

  async drainTenant(tenantId: string): Promise<ConnectionOperationDrainResult> {
    const operationLeaseId = crypto.randomUUID();
    const jobs = await this.repository.claim(tenantId, operationLeaseId, this.claimLimit);
    const result: ConnectionOperationDrainResult = {
      claimed: jobs.length,
      succeeded: 0,
      failedRetryable: 0,
      failedTerminal: 0,
      leaseLost: 0,
    };

    // Processing in claim order avoids racing two lifecycle commands for the
    // same connection while still allowing BullMQ to parallelize tenants.
    for (const job of jobs) {
      const state = await this.process(job, operationLeaseId);
      if (state === "succeeded") result.succeeded++;
      else if (state === "failed-retryable") result.failedRetryable++;
      else if (state === "failed-terminal") result.failedTerminal++;
      else result.leaseLost++;
    }
    return result;
  }

  private async process(job: ConnectionOperationJob, operationLeaseId: string): Promise<ProcessResult> {
    if(job.operationType==='EXECUTE_META_ACCOUNT_TRANSITION'&&Object.hasOwn(job.payload,'metaLegacyMigration')){
      const store=this.repository.legacyMigrationStore();
      try{
        if(job.provider!=='META')throw new Error('Migration provider mismatch');
        await executeMetaLegacyMigration(job,operationLeaseId,this.config.metaAppId??process.env.META_APP_ID??'',store,this.secrets);
        return 'succeeded';
      }catch(error){
        if(error instanceof ConnectionOperationLeaseLostError)return 'lease-lost';
        try{await store.failOperation(job,operationLeaseId);}catch{return 'lease-lost';}
        return 'failed-terminal';
      }
    }
    if((job.operationType==='PREVIEW_META_ACCOUNT_TRANSITION'||job.operationType==='EXECUTE_META_ACCOUNT_TRANSITION')
      &&Object.hasOwn(job.payload,'metaTemplatePreparation')){
      const store=this.repository.templatePreparationStore();
      try{
        if(job.provider!=='META')throw new Error('Template provider mismatch');
        await prepareMetaTemplates(job,operationLeaseId,this.config.metaAppId??process.env.META_APP_ID??'',store,this.secrets);
        return 'succeeded';
      }catch{
        try{await store.failTemplateOperation(job,operationLeaseId);}catch{return 'lease-lost';}
        return 'failed-terminal';
      }
    }
    if(job.operationType==='EXECUTE_META_ACCOUNT_TRANSITION'){
      const store=this.repository.transitionExecutionStore();
      try{
        if(job.provider!=='META')throw new Error('Transition provider mismatch');
        await executeMetaAccountTransition(job,operationLeaseId,this.config.metaAppId??process.env.META_APP_ID??'',store,this.secrets);
        await store.finishTransition(job,operationLeaseId,true);
        return 'succeeded';
      }catch(error){
        if(error instanceof ConnectionOperationLeaseLostError)return 'lease-lost';
        try{await store.finishTransition(job,operationLeaseId,false);}catch{return 'lease-lost';}
        return 'failed-terminal';
      }
    }
    if (job.operationType === "PREVIEW_META_ACCOUNT_TRANSITION") return processMetaAccountTransitionPreview(job,operationLeaseId,this.repository,
      ()=>this.resolveMetaAccessToken(job),this.config.metaAppId??process.env.META_APP_ID??'',this.config.metaGraphVersion??process.env.META_GRAPH_VERSION);
    if (job.operationType === "VERIFY_META_BILLING") {
      return job.payload.metaManagedFunding ? this.processManagedFunding(job,operationLeaseId) : this.processMetaBillingDiagnostic(job, operationLeaseId);
    }
    const startedAt = Date.now();
    let sessionLease: ProviderSessionLease | undefined;
    try {
      this.validateJobContext(job);
      if (job.provider === "WAHA") {
        const assignment = await this.repository.acquireWahaWorkerAssignment(job, this.leaseForSeconds);
        if (assignment.engine !== job.engine) {
          throw new LifecycleOperationError(
            "WAHA_ENGINE_ASSIGNMENT_MISMATCH",
            "The selected WAHA engine did not match the assigned worker.",
            false,
            "ACTION_REQUIRED",
          );
        }
      }
      sessionLease = await this.repository.acquireProviderSessionLease(
        job,
        operationLeaseId,
        `${this.workerIdentity}:${operationLeaseId}`,
        this.leaseForSeconds,
      );
      let completion: OperationCompletion;
      if (job.provider === "META") {
        const wabaId = this.metaWabaId(job);
        if (job.operationType === "PAUSE" || job.operationType === "DISCONNECT") {
          completion = localMetaCompletion(job, wabaId);
        } else {
          const binding: MetaConnectionBinding = { secretReference: job.connectionSecretReference,
            providerSessionId: job.providerSession!.id, phoneNumberId: job.providerSession!.opaqueSessionId, wabaId };
          if ((job.payload.metaBinding && !sameMetaConnectionBinding(job.payload.metaBinding as MetaConnectionBinding, binding))
            || (job.payload.credentialReference && job.payload.credentialReference !== binding.secretReference)) {
            throw new LifecycleOperationError("META_BINDING_SUPERSEDED", "The Meta credential or account selection was superseded.", false);
          }
          if(job.payload.metaAddAccessActivation){
            // Revalidate the current initiator and exact admission before resolving
            // the private token, as well as before every subsequent provider GET.
            sessionLease=await this.repository.renewLeases(job,operationLeaseId,sessionLease,this.leaseForSeconds);
          }
          const accessToken = await this.resolveMetaAccessToken(job);
          const credentialFingerprint = createHash("sha256").update(accessToken).digest("hex");
          const currentProof = job.providerSession?.providerStateData.metaAccountProof as MetaAccountProof | undefined;
          if (currentProof && (currentProof.claim !== "PHONE_ACCOUNT_RELATION_VERIFIED" || currentProof.schemaVersion !== 1
            || currentProof.tenantId !== job.tenantId || currentProof.connectionId !== job.connectionId
            || !sameMetaConnectionBinding(currentProof, binding) || currentProof.credentialFingerprint !== credentialFingerprint)) {
            throw new LifecycleOperationError("META_CREDENTIAL_PROOF_MISMATCH", "The Meta credential changed outside its verified connection stage.", false);
          }
          const adapter = new MetaGroupsAdapter({
            accessToken,
            graphVersion: validatedMetaGraphVersion(this.config.metaGraphVersion ?? process.env.META_GRAPH_VERSION),
            phoneNumberIdFor: () => job.providerSession!.opaqueSessionId,
            wabaIdFor: () => wabaId,
            beforeRequest: async () => {
              const metadata = assertMetaCredentialProof(currentProof, { appId: this.config.metaAppId ?? process.env.META_APP_ID ?? "", accessToken });
              if (job.operationType !== "SYNC_GROUPS" && !metadata) throw new MetaCredentialMetadataError();
              // Renew also verifies admission-time lifecycle revision and pending signed BLOCK rows.
              sessionLease = await this.repository.renewLeases(job, operationLeaseId, sessionLease!, this.leaseForSeconds);
              if (job.operationType === "PROVISION" && job.providerSession?.providerStateData.metaSignup) {
                if (!this.repository.assertMetaSignupCurrent) throw new LifecycleOperationError("META_SIGNUP_STATE_INVALID", "Account setup authorization is unavailable.", false);
                await this.repository.assertMetaSignupCurrent(job, operationLeaseId, sessionLease);
              }
            },
          });
          sessionLease = await this.repository.renewLeases(
            job,
            operationLeaseId,
            sessionLease,
            this.leaseForSeconds,
          );
          if (job.operationType === "SYNC_META_APP") {
            await this.executeMetaSync(job, operationLeaseId, sessionLease, adapter);
            return "succeeded";
          }
          completion = await this.executeMeta(job, operationLeaseId, sessionLease, adapter, wabaId, credentialFingerprint);
        }
      } else {
        const lifecycleSecrets = await this.resolveLifecycleSecrets(job);
        const assignment = job.providerSession?.wahaAssignment;
        if (!assignment) {
          throw new LifecycleOperationError(
            "WAHA_WORKER_ASSIGNMENT_UNAVAILABLE",
            "No healthy WAHA worker has capacity for this session.",
            true,
          );
        }
        const adapter = new WahaAdapter({
          baseUrl: assignment.baseUrl,
          apiKey: lifecycleSecrets.apiKey,
          sessionFor: () => job.providerSession!.opaqueSessionId,
        });
        sessionLease = await this.repository.renewLeases(
          job,
          operationLeaseId,
          sessionLease,
          this.leaseForSeconds,
        );
        completion = await this.execute(job, operationLeaseId, sessionLease, adapter, lifecycleSecrets);
      }
      const persistedCompletion = await this.repository.complete(job, operationLeaseId, sessionLease, completion);
      recordConnectionOutcome(job, persistedCompletion?.connectionState ?? completion.connectionState, "succeeded", startedAt);
      return "succeeded";
    } catch (error) {
      if (error instanceof ConnectionOperationLeaseLostError) {
        recordConnectionOutcome(job, job.connectionState, "lease_lost", startedAt);
        return "lease-lost";
      }

      const classified = classifyConnectionOperationError(error, job.connectionState);
      if(job.payload.metaAddAccessActivation){classified.retryable=false;classified.connectionState="PAUSED";}
      const retryable = job.operationType !== "SYNC_META_APP" && classified.retryable && job.attempts < job.maxAttempts;
      const failureConnectionState = job.operationType === "SYNC_META_APP" ? job.connectionState : job.payload.metaAddAccessActivation ? "PAUSED" : job.operationType === "SYNC_GROUPS"
        && !(job.provider === "META" && !classified.retryable && requiresReauthentication(classified.code))
        ? job.connectionState
        : retryable
          ? classified.connectionState
          : terminalConnectionState(classified.connectionState, job.operationType);
      try {
        await this.repository.fail(job, operationLeaseId, sessionLease, {
          retryable,
          code: retryable ? classified.code : exhaustedCode(classified.code, job),
          safeError: retryable ? classified.safeError : exhaustedMessage(classified.safeError, classified.retryable, job),
          retryAt: retryable ? new Date(Date.now() + backoffMs(job.attempts)).toISOString() : undefined,
          connectionState: failureConnectionState,
        });
        const resultingState = failureConnectionState;
        recordConnectionOutcome(job, resultingState, retryable ? "retryable_failure" : "terminal_failure", startedAt, classified.code);
        if (!retryable && resultingState === "ACTION_REQUIRED" && requiresReauthentication(classified.code)) {
          recordMetric("wasalx_connection_reauthentication_total", 1, {
            provider: job.provider.toLowerCase(),
            reason: classified.code,
          });
        }
        return retryable ? "failed-retryable" : "failed-terminal";
      } catch (finalizationError) {
        if (finalizationError instanceof ConnectionOperationLeaseLostError) {
          recordConnectionOutcome(job, job.connectionState, "lease_lost", startedAt);
          return "lease-lost";
        }
        throw finalizationError;
      }
    }
  }

  private async processManagedFunding(job:ConnectionOperationJob,leaseId:string):Promise<ProcessResult>{
    const appId=this.config.metaAppId??process.env.META_APP_ID??"";
    try{
      const observed=await executeMetaManagedFunding(job,leaseId,appId,this.repository,this.secrets);
      await this.repository.completeMetaBillingDiagnostic(job,leaseId,appId,observed.diagnostic,observed.funding);
      return "succeeded";
    }catch(error){
      if(error instanceof ConnectionOperationLeaseLostError)return "lease-lost";
      const failure=classifyConnectionOperationError(error,job.connectionState);
      try{
        // Financial stage owns one durable slot; no automatic POST retry.
        await this.repository.failMetaBillingDiagnostic(job,leaseId,{...failure,retryable:false,connectionState:job.connectionState},appId);
        return "failed-terminal";
      }catch(finalizationError){if(finalizationError instanceof ConnectionOperationLeaseLostError)return "lease-lost";throw finalizationError;}
    }
  }

  private async processMetaBillingDiagnostic(job: ConnectionOperationJob, leaseId: string): Promise<ProcessResult> {
    const appId = this.config.metaAppId ?? process.env.META_APP_ID ?? "";
    try {
      const guard = await this.repository.guardMetaBillingDiagnostic(job, leaseId, appId);
      if (guard !== "CURRENT") {
        await this.repository.completeMetaBillingDiagnostic(job, leaseId, appId,
          unavailableMetaBillingDiagnostic(guard === "CHANGED" ? "BINDING_CHANGED" : "ACCESS_HELD"));
        return "succeeded";
      }
      const accessToken = await this.resolveMetaAccessToken(job);
      const proof = job.providerSession?.providerStateData.metaAccountProof;
      const adapter = new MetaGroupsAdapter({ accessToken,
        graphVersion: validatedMetaGraphVersion((proof as {graphVersion?:string})?.graphVersion),
        phoneNumberIdFor: () => job.providerSession!.opaqueSessionId,
        wabaIdFor: () => this.metaWabaId(job),
        beforeRequest: async () => {
          if (!assertMetaCredentialProof(proof, {appId, accessToken})) throw new MetaBillingAccessHeldError();
          if (await this.repository.guardMetaBillingDiagnostic(job, leaseId, appId) !== "CURRENT") throw new MetaBillingAccessHeldError();
        } });
      const observed = await adapter.billingAccountProof(this.metaWabaId(job));
      await this.repository.completeMetaBillingDiagnostic(job, leaseId, appId, observed.diagnostic,
        job.payload.metaAccountPolicy ? observed.funding : undefined);
      return "succeeded";
    } catch (error) {
      if (error instanceof ConnectionOperationLeaseLostError) return "lease-lost";
      try {
        if (error instanceof MetaBillingAccessHeldError || error instanceof MetaCredentialMetadataError) {
          await this.repository.completeMetaBillingDiagnostic(job, leaseId, appId, unavailableMetaBillingDiagnostic("ACCESS_HELD"));
          return "succeeded";
        }
        const failure = classifyConnectionOperationError(error, job.connectionState);
        const retryable = failure.retryable && job.attempts < job.maxAttempts;
        await this.repository.failMetaBillingDiagnostic(job, leaseId, { ...failure, retryable,
          connectionState: job.connectionState,
          retryAt: retryable ? new Date(Date.now() + backoffMs(job.attempts)).toISOString() : undefined },appId);
        return retryable&&!job.payload.metaAccountPolicy ? "failed-retryable" : "failed-terminal";
      } catch (finalizationError) {
        if (finalizationError instanceof ConnectionOperationLeaseLostError) return "lease-lost";
        throw finalizationError;
      }
    }
  }

  private validateJobContext(job: ConnectionOperationJob) {
    if (job.provider !== "WAHA" && job.provider !== "META") {
      throw new LifecycleOperationError("UNSUPPORTED_PROVIDER", "This lifecycle worker does not support the connection provider.", false);
    }
    if (job.provider === "WAHA" && job.engine !== "GOWS" && job.engine !== "NOWEB") {
      throw new LifecycleOperationError(
        "WAHA_ENGINE_INVALID",
        "The WAHA connection does not have a valid selected engine.",
        false,
        "ACTION_REQUIRED",
      );
    }
    if (!job.providerSession) {
      throw new LifecycleOperationError(
        "ACTIVE_PROVIDER_SESSION_MISSING",
        "The connection does not have an active provider session.",
        false,
      );
    }
    if (!job.webhookRoute && ["PROVISION", "START", "RESTART"].includes(job.operationType)) {
      throw new LifecycleOperationError("WEBHOOK_ROUTE_MISSING", "The connection does not have a webhook route.", false);
    }
    if (job.webhookRoute?.state === "REVOKED" && job.operationType !== "DISCONNECT") {
      throw new LifecycleOperationError("WEBHOOK_ROUTE_REVOKED", "The connection webhook route has been revoked.", false);
    }
    if (job.operationType === "SYNC_GROUPS" && (
      !["WORKING", "DEGRADED"].includes(job.connectionState)
      || job.providerSession.state !== "WORKING"
      || job.webhookRoute?.state !== "ACTIVE"
    )) {
      throw new LifecycleOperationError(
        "SYNC_GROUPS_SUPERSEDED",
        "Group synchronization was superseded by a connection lifecycle change.",
        false,
        job.connectionState,
      );
    }
    const requestedSession = stringValue(job.payload.providerSessionId);
    if (requestedSession && requestedSession !== job.providerSession.id) {
      throw new LifecycleOperationError(
        "STALE_PROVIDER_SESSION",
        "The operation targets an inactive provider session and must be requested again.",
        false,
      );
    }
  }

  private async resolveLifecycleSecrets(job: ConnectionOperationJob): Promise<ResolvedLifecycleSecrets> {
    const secretReference = job.providerSession?.wahaAssignment?.secretReference;
    if (!secretReference) {
      throw new LifecycleOperationError(
        "WAHA_WORKER_ASSIGNMENT_UNAVAILABLE",
        "No healthy WAHA worker has capacity for this session.",
        true,
      );
    }
    const adminSecret = await this.secrets.resolve(secretReference,{kind:"exact",expectedReference:secretReference});
    const apiKey = stringValue(adminSecret.apiKey);
    if (!apiKey || apiKey.length > 4_096) {
      throw new LifecycleOperationError("WAHA_ADMIN_SECRET_INVALID", "WAHA administrative credentials are unavailable.", false);
    }

    if (!["PROVISION", "START", "RESTART"].includes(job.operationType)) return { apiKey };
    return this.resolveProvisioningSecrets(job, apiKey);
  }

  private async resolveProvisioningSecrets(job: ConnectionOperationJob, apiKey: string): Promise<ResolvedLifecycleSecrets> {
    if (!job.webhookRoute) {
      throw new LifecycleOperationError("WEBHOOK_ROUTE_MISSING", "The connection does not have a webhook route.", false);
    }
    const webhookSecret = await this.secrets.resolve(job.webhookRoute.hmacSecretReference,{kind:"waha-webhook",tenantId:job.tenantId,connectionId:job.connectionId});
    const hmacKey = stringValue(webhookSecret.hmacKey);
    const routeToken = stringValue((webhookSecret as typeof webhookSecret & { routeToken?: unknown }).routeToken);
    if (!hmacKey || hmacKey.length < 16 || hmacKey.length > 4_096) {
      throw new LifecycleOperationError("WEBHOOK_HMAC_SECRET_INVALID", "The webhook signing secret is unavailable.", false);
    }
    if (!routeToken || !ROUTE_TOKEN.test(routeToken)) {
      throw new LifecycleOperationError("WEBHOOK_ROUTE_TOKEN_INVALID", "The webhook route token is unavailable.", false);
    }
    return { apiKey, hmacKey, routeToken };
  }

  private async resolveMetaAccessToken(job: ConnectionOperationJob) {
    const secret = await this.secrets.resolve(job.connectionSecretReference,{kind:"meta-connection",tenantId:job.tenantId,connectionId:job.connectionId});
    const accessToken = stringValue((secret as typeof secret & { accessToken?: unknown }).accessToken);
    if (!accessToken || accessToken.length < 16 || accessToken.length > 4_096 || hasUnsafeControl(accessToken)) {
      throw new LifecycleOperationError(
        "META_ACCESS_TOKEN_INVALID",
        "Secure Meta credentials are unavailable.",
        false,
      );
    }
    return accessToken;
  }

  private metaWabaId(job: ConnectionOperationJob) {
    const stateValue = stringValue(job.providerSession?.providerStateData.wabaId);
    const request = job.payload.request as Record<string, unknown> | undefined;
    const requestedValue = stringValue(request?.wabaId);
    const value = stateValue ?? requestedValue;
    if (!value || !/^\d{5,32}$/u.test(value)) {
      throw new LifecycleOperationError(
        "META_WABA_ID_MISSING",
        "The Meta connection is missing its WhatsApp Business Account identifier.",
        false,
      );
    }
    return value;
  }

  private async execute(
    job: ConnectionOperationJob,
    operationLeaseId: string,
    sessionLease: ProviderSessionLease,
    adapter: WahaAdapter,
    lifecycleSecrets: ResolvedLifecycleSecrets,
  ): Promise<OperationCompletion> {
    switch (job.operationType) {
      case "SYNC_META_APP":
        throw new LifecycleOperationError("META_COEXISTENCE_UNAVAILABLE", "Business app synchronization requires a Meta connection.", false);
      case "EXECUTE_META_ACCOUNT_TRANSITION":
      case "PREVIEW_META_ACCOUNT_TRANSITION":
      case "VERIFY_META_BILLING": throw new Error("Diagnostics require operation-only processing");
      case "PROVISION": {
        const options=this.provisioningOptions(job,lifecycleSecrets);
        const outcome = await this.sessionAction(job, adapter, "PROVISION", async () =>
          adapter.createSession(job.connectionId,options),
        );
        await adapter.verifySessionContract(job.connectionId,options);
        const identity = await this.identityWhenWorking(job, operationLeaseId, sessionLease, adapter, outcome);
        return { ...lifecycleCompletion(job, outcome, identity, { provisioned: true }), webhookState: "ACTIVE" };
      }
      case "START": {
        const options=this.provisioningOptions(job,lifecycleSecrets);
        let current:WahaSessionSnapshot;
        try{current=await adapter.reconcileSessionContract(job.connectionId,options)}catch(error){
          if(!(error instanceof ProviderError)||error.status!==404||!error.outcomeKnown)throw error;
          current=await adapter.createSession(job.connectionId,options);
        }
        const outcome=current.status==="STOPPED"
          ?await this.sessionAction(job,adapter,"START",()=>adapter.startSession(job.connectionId))
          :current.status==="FAILED"
            ?await this.sessionAction(job,adapter,"RESTART",()=>adapter.restartSession(job.connectionId))
          :snapshotOutcome(current);
        assertSelectedWahaEngine(job,outcome);
        await adapter.verifySessionContract(job.connectionId,options);
        const identity = await this.identityWhenWorking(job, operationLeaseId, sessionLease, adapter, outcome);
        return { ...lifecycleCompletion(job, outcome, identity, { started: true }), webhookState: "ACTIVE" };
      }
      case "RESTART": {
        const options=this.provisioningOptions(job,lifecycleSecrets);
        const current=await adapter.reconcileSessionContract(job.connectionId,options);
        const outcome=current.reconciled&&current.status!=="STOPPED"&&current.status!=="FAILED"
          ?snapshotOutcome(current)
          :await this.sessionAction(job,adapter,"RESTART",()=>current.status==="STOPPED"?adapter.startSession(job.connectionId):adapter.restartSession(job.connectionId));
        assertSelectedWahaEngine(job,outcome);
        await adapter.verifySessionContract(job.connectionId,options);
        const identity = await this.identityWhenWorking(job, operationLeaseId, sessionLease, adapter, outcome);
        return { ...lifecycleCompletion(job, outcome, identity, { restarted: true }), webhookState: "ACTIVE" };
      }
      case "PAUSE": {
        const snapshot = await adapter.stopSession(job.connectionId);
        const mapped = snapshotOutcome(snapshot);
        assertSelectedWahaEngine(job, mapped);
        return {
          connectionState: "PAUSED",
          providerState: mapped.providerState,
          providerStateData: mapped.providerStateData,
          actionReason: "The connection is paused.",
          ...(mapped.engine ? { engine: mapped.engine } : {}),
          webhookState: "PAUSED",
          result: { paused: true, providerState: mapped.providerState },
        };
      }
      case "DISCONNECT": {
        sessionLease = await this.repository.renewLeases(job, operationLeaseId, sessionLease, this.leaseForSeconds);
        await ignoreMissingSession(() => adapter.stopSession(job.connectionId));
        sessionLease = await this.repository.renewLeases(job, operationLeaseId, sessionLease, this.leaseForSeconds);
        await ignoreMissingSession(() => adapter.deleteSession(job.connectionId));
        const duplicateIdentity = job.payload.reason === "DUPLICATE_IDENTITY";
        return {
          connectionState: "REVOKED",
          providerState: "DELETED",
          providerStateData: { status: "DELETED" },
          actionReason: duplicateIdentity
            ? "This WhatsApp account is already connected in this workspace. The duplicate linked session was removed."
            : "The WhatsApp linked device has been disconnected.",
          retireSession: true,
          revokeWebhook: true,
          webhookState: "REVOKED",
          result: duplicateIdentity
            ? { disconnected: true, rejected: "DUPLICATE_IDENTITY" }
            : { disconnected: true },
        };
      }
      case "SYNC_GROUPS": {
        const providerState = await providerStateOutcome(adapter, job.connectionId);
        if (providerState.connectionState !== "WORKING") {
          throw new LifecycleOperationError(
            "WAHA_SESSION_NOT_WORKING",
            "WhatsApp must be connected before groups can be synchronized.",
            true,
            providerState.connectionState,
          );
        }
        const groups = await this.collectGroups(job, operationLeaseId, sessionLease, adapter);
        const identity = await this.identityWhenWorking(job, operationLeaseId, sessionLease, adapter, providerState);
        return {
          connectionState: "WORKING",
          providerState: providerState.providerState,
          providerStateData: providerState.providerStateData,
          actionReason: null,
          phoneE164: identity?.phoneE164,
          ...(providerState.engine ? { engine: providerState.engine } : {}),
          groups,
          result: {
            synchronized: true,
            groupCount: groups.length,
            providerState: providerState.providerState,
          },
        };
      }
    }
  }

  private async sessionAction(
    job: ConnectionOperationJob,
    adapter: WahaAdapter,
    action: "PROVISION" | "START" | "RESTART",
    execute: () => Promise<WahaSessionSnapshot>,
  ): Promise<ProviderOutcome> {
    try {
      const outcome = snapshotOutcome(await execute());
      assertSelectedWahaEngine(job, outcome);
      if (outcome.connectionState === "FAILED") {
        throw new LifecycleOperationError("WAHA_SESSION_RECOVERY_FAILED", "The WhatsApp session is still failed after the connection action.", false, "FAILED");
      }
      return outcome;
    } catch (error) {
      // A provider call may succeed while its database finalization is lost.
      // Reconcile conflict responses against the existing session so replay is
      // safe instead of turning a successful external action into a dead end.
      if (!(error instanceof ProviderError)||action==="PROVISION"||(error.status!==409&&error.outcomeKnown))throw error;
      const recovered = await providerStateOutcome(adapter, job.connectionId);
      const acceptable=["AWAITING_AUTH", "CONNECTING", "WORKING"].includes(recovered.connectionState);
      if (!acceptable) throw error;
      assertSelectedWahaEngine(job,recovered);
      return {
        ...recovered,
        providerStateData: { ...recovered.providerStateData, reconciledAfterConflict: true },
      };
    }
  }

  private async executeMetaSync(job: ConnectionOperationJob, operationLeaseId: string, sessionLease: ProviderSessionLease, adapter: MetaGroupsAdapter) {
    const signup = job.providerSession?.providerStateData.metaSignup as { variant?: string; graphVersion?: string } | undefined;
    if (process.env.META_COEXISTENCE_ENABLED !== "true" || signup?.variant !== "BUSINESS_APP"
      || signup.graphVersion !== (this.config.metaGraphVersion ?? process.env.META_GRAPH_VERSION)
      || !this.repository.coexistenceRequest || !this.repository.finishCoexistence) {
      throw new LifecycleOperationError("META_COEXISTENCE_UNAVAILABLE", "Business app synchronization is unavailable.", false);
    }
    await adapter.verifyPhoneAccountRelationship(job.connectionId);
    const phone = await adapter.signupPhone(job.connectionId);
    if (phone.mode !== "COEXISTENCE" || phone.numberState !== "REGISTERED") {
      throw new LifecycleOperationError("META_COEXISTENCE_MODE_UNKNOWN", "The Business app connection could not be verified.", false);
    }
    for (const kind of ["contacts", "history"] as const) {
      const claimed = await this.repository.coexistenceRequest(job, operationLeaseId, sessionLease, kind, "CLAIMED");
      if (!claimed) continue;
      let requestId: string;
      try { requestId = await adapter.syncBusinessAppData(job.connectionId, kind, async () => {
        if (!await this.repository.coexistenceRequest!(job, operationLeaseId, sessionLease, kind, "DISPATCH")) {
          throw new ProviderError("Business app synchronization authorization changed before dispatch.", false, "META_COEXISTENCE_STOPPED", undefined, false);
        }
      }); }
      catch (error) {
        if (error instanceof ConnectionOperationLeaseLostError) throw error;
        const outcome = error instanceof ProviderError && error.outcomeKnown ? "REJECTED" : "UNKNOWN";
        await this.repository.coexistenceRequest(job, operationLeaseId, sessionLease, kind, outcome);
        if (outcome === "UNKNOWN") break;
        continue;
      }
      if (!await this.repository.coexistenceRequest(job, operationLeaseId, sessionLease, kind, "ACCEPTED", requestId)) {
        throw new ConnectionOperationLeaseLostError();
      }
    }
    await this.repository.finishCoexistence(job, operationLeaseId, sessionLease);
  }

  private async executeMeta(
    job: ConnectionOperationJob,
    operationLeaseId: string,
    sessionLease: ProviderSessionLease,
    adapter: MetaGroupsAdapter,
    wabaId: string,
    credentialFingerprint: string,
  ): Promise<OperationCompletion> {
    const currentStateData = job.providerSession?.providerStateData ?? {};
    if ((currentStateData.metaSignup as { purpose?: string } | undefined)?.purpose === "ADD_ACCESS"
      || (currentStateData.metaAccountTransition as {purpose?:string}|undefined)?.purpose === "ACCOUNT_SUCCESSOR") {
      if(!job.payload.metaAddAccessActivation)throw new LifecycleOperationError("META_SIGNUP_ADD_ACCESS_ACTIVATION_REQUIRED", "Saved account access requires a separate activation review.", false, "PAUSED");
      return readMetaAddAccessActivation(job,adapter,this.config.metaAppId??process.env.META_APP_ID??"",
        this.config.metaGraphVersion??process.env.META_GRAPH_VERSION??"",credentialFingerprint);
    }
    if (job.operationType === "SYNC_GROUPS" && !job.disclosureVersion) {
      throw new LifecycleOperationError("META_GROUPS_CONSENT_REQUIRED", "Accept the official Groups constraints before synchronizing groups.", false);
    }
    const relation = await adapter.verifyPhoneAccountRelationship(job.connectionId);
    const credentialMetadata = (job.providerSession?.providerStateData.metaAccountProof as MetaAccountProof | undefined)?.credentialMetadata;
    const proof: MetaAccountProof = { ...relation, ...(credentialMetadata ? { credentialMetadata } : {}), tenantId: job.tenantId, connectionId: job.connectionId,
      secretReference: job.connectionSecretReference, providerSessionId: job.providerSession!.id,
      credentialFingerprint, operationId: job.id, fencingToken: job.fencingToken };
    switch (job.operationType) {
      case "SYNC_META_APP":
        throw new LifecycleOperationError("META_COEXISTENCE_UNAVAILABLE", "Business app synchronization requires its dedicated finalizer.", false);
      case "EXECUTE_META_ACCOUNT_TRANSITION":
      case "PREVIEW_META_ACCOUNT_TRANSITION":
      case "VERIFY_META_BILLING": throw new Error("Diagnostics require operation-only processing");
      case "PROVISION":
      case "START":
      case "RESTART": {
        const signup = currentStateData.metaSignup as { attemptId?: string; businessId?: string; phoneId?: string; wabaId?: string; graphVersion?: string; variant?: string } | undefined;
        if (signup) {
          if (!signup.attemptId || !signup.businessId || signup.phoneId !== job.providerSession?.opaqueSessionId || signup.wabaId !== wabaId
            || signup.graphVersion !== (this.config.metaGraphVersion ?? process.env.META_GRAPH_VERSION)) {
            throw new LifecycleOperationError("META_SIGNUP_STATE_INVALID", "Account setup binding changed.", false, "ACTION_REQUIRED");
          }
          await adapter.verifySignupOwner(job.connectionId, signup.businessId);
          let phone = await adapter.signupPhone(job.connectionId);
          const expectedMode = signup.variant === "BUSINESS_APP" ? "COEXISTENCE" : "STANDARD";
          if (phone.mode !== expectedMode || (expectedMode === "COEXISTENCE" && phone.numberState !== "REGISTERED")) throw new LifecycleOperationError("META_SIGNUP_MODE_UNKNOWN", "The number requires a separate connection review.", false, "ACTION_REQUIRED");
          if (phone.numberState !== "REGISTERED") {
            if (expectedMode !== "STANDARD" || phone.numberState !== "REGISTRATION_REQUIRED" || !this.repository.claimMetaSignupRegistration) {
              throw new LifecycleOperationError("META_SIGNUP_PHONE_UNVERIFIED", "Meta number registration requires attention.", false, "ACTION_REQUIRED");
            }
            const secret = await this.secrets.resolve(job.connectionSecretReference, { kind: "meta-connection", tenantId: job.tenantId, connectionId: job.connectionId });
            if (!secret.registrationPin || !/^\d{6}$/u.test(secret.registrationPin)) throw new LifecycleOperationError("META_SIGNUP_REGISTRATION_REJECTED", "Secure registration details are unavailable.", false, "ACTION_REQUIRED");
            const claimed = await this.repository.claimMetaSignupRegistration(job, operationLeaseId, sessionLease, signup.attemptId);
            if (!claimed) throw new LifecycleOperationError("META_SIGNUP_REGISTRATION_UNKNOWN", "A previous registration requires provider reconciliation. It was not repeated.", false, "ACTION_REQUIRED");
            try { await adapter.registerSignupPhone(job.connectionId, secret.registrationPin); }
            catch (error) {
              if (error instanceof ConnectionOperationLeaseLostError) throw error;
              const known = error instanceof ProviderError && error.outcomeKnown;
              throw new LifecycleOperationError(known ? "META_SIGNUP_REGISTRATION_REJECTED" : "META_SIGNUP_REGISTRATION_UNKNOWN",
                known ? "Meta rejected number registration. Review the number in Meta." : "Meta registration outcome is unknown. It was not repeated.", false, "ACTION_REQUIRED");
            }
            phone = await adapter.signupPhone(job.connectionId);
            if (phone.numberState !== "REGISTERED" || phone.mode !== "STANDARD") throw new LifecycleOperationError("META_SIGNUP_REGISTRATION_UNKNOWN", "Meta has not confirmed the registered number state.", false, "ACTION_REQUIRED");
          }
        }
        const capability = job.disclosureVersion ? await adapter.checkGroupsCapability(job.connectionId) : undefined;
        await this.repository.renewLeases(
          job,
          operationLeaseId,
          sessionLease,
          this.leaseForSeconds,
        );
        // WABA app subscription is idempotent. Repeating it after an ambiguous
        // transport result cannot create a duplicate external resource.
        await adapter.subscribeWaba(job.connectionId);
        const signupReadiness = signup ? await adapter.signupReadiness(job.connectionId, this.config.metaAppId ?? process.env.META_APP_ID ?? "") : undefined;
        if (signupReadiness && (!signupReadiness.subscribed || !["AVAILABLE", "LIMITED"].includes(signupReadiness.messaging))) {
          throw new LifecycleOperationError("META_SIGNUP_PROVIDER_UNAVAILABLE", "Meta messaging readiness requires attention.", false, "ACTION_REQUIRED");
        }
        const identity = await this.metaIdentity(job, operationLeaseId, sessionLease, adapter);
        const groups = capability?.eligible
          ? await this.collectGroups(job, operationLeaseId, sessionLease, adapter)
          : undefined;
        return {
          connectionState: "WORKING",
          providerState: "AVAILABLE",
          providerStateData: {
            ...currentStateData,
            metaAccountProof: proof,
            wabaId,
            eligibility: capability ? metaGroupsEligibility(capability) : "CONSENT_REQUIRED",
            capability: capability ? sanitizedMetaCapability(capability) : { eligible: false, state: "CONSENT_REQUIRED", evidence: "local_policy" },
          },
          actionReason: null,
          phoneE164: identity.phoneE164,
          engine: "CLOUD_API",
          groups,
          webhookState: "ACTIVE",
          result: {
            ...(signupReadiness ? { metaSignupReady: true, metaSignupMessaging: signupReadiness.messaging } : {}),
            metaAccountProof: proof,
            eligible: capability?.eligible ?? false,
            subscribed: true,
            synchronized: groups !== undefined,
            ...(groups ? { groupCount: groups.length } : {}),
            identity,
          },
        };
      }
      case "PAUSE":
      case "DISCONNECT":
        return localMetaCompletion(job, wabaId);
      case "SYNC_GROUPS": {
        if (!job.disclosureVersion) {
          throw new LifecycleOperationError("META_GROUPS_CONSENT_REQUIRED", "Accept the official Groups constraints before synchronizing groups.", false);
        }
        const capability = await adapter.checkGroupsCapability(job.connectionId);
        const groups = capability.eligible
          ? await this.collectGroups(job, operationLeaseId, sessionLease, adapter)
          : undefined;
        const identity = await this.metaIdentity(job, operationLeaseId, sessionLease, adapter);
        return {
          connectionState: "WORKING",
          providerState: "AVAILABLE",
          providerStateData: {
            ...currentStateData,
            metaAccountProof: proof,
            wabaId,
            eligibility: metaGroupsEligibility(capability),
            capability: sanitizedMetaCapability(capability),
          },
          actionReason: null,
          phoneE164: identity.phoneE164,
          engine: "CLOUD_API",
          groups,
          webhookState: "ACTIVE",
          result: {
            metaAccountProof: proof,
            eligible: capability.eligible,
            synchronized: groups !== undefined,
            ...(groups ? { groupCount: groups.length } : {}),
            identity,
          },
        };
      }
    }
  }

  private async metaIdentity(
    job: ConnectionOperationJob,
    operationLeaseId: string,
    sessionLease: ProviderSessionLease,
    adapter: MetaGroupsAdapter,
  ) {
    await this.repository.renewLeases(
      job,
      operationLeaseId,
      sessionLease,
      this.leaseForSeconds,
    );
    const identity = await adapter.getIdentity(job.connectionId);
    const phoneE164 = normalizeWahaPhone(identity.phone);
    if (!phoneE164) {
      throw new LifecycleOperationError(
        "META_IDENTITY_INVALID",
        "Meta did not return a valid business phone number.",
        false,
      );
    }
    return {
      phoneE164,
      ...(identity.displayName ? { displayName: identity.displayName.slice(0, 256) } : {}),
    };
  }

  private async collectGroups(
    job: ConnectionOperationJob,
    operationLeaseId: string,
    initialSessionLease: ProviderSessionLease,
    adapter: MessagingProviderAdapter,
  ): Promise<ProviderGroup[]> {
    let cursor: string | undefined;
    let sessionLease = initialSessionLease;
    const seenCursors = new Set<string>();
    const groups = new Map<string, ProviderGroup>();

    for (let page = 0; page < this.maxGroupPages; page++) {
      sessionLease = await this.repository.renewLeases(
        job,
        operationLeaseId,
        sessionLease,
        this.leaseForSeconds,
      );
      const result = await adapter.listGroups(job.connectionId, cursor);
      for (const rawGroup of result.groups) {
        const group = validatedGroup(rawGroup, job.provider);
        groups.set(group.id, group);
        if (groups.size > this.maxGroups) {
          throw new LifecycleOperationError(
            `${job.provider}_GROUP_LIMIT_EXCEEDED`,
            "The provider returned more groups than this connection can synchronize safely.",
            false,
          );
        }
      }
      if (result.nextCursor === undefined) return [...groups.values()];
      if (!result.nextCursor || result.nextCursor === cursor || seenCursors.has(result.nextCursor)) {
        throw new LifecycleOperationError(
          `${job.provider}_GROUP_CURSOR_INVALID`,
          "The provider returned an invalid group pagination cursor.",
          false,
        );
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }

    throw new LifecycleOperationError(
      `${job.provider}_GROUP_PAGE_LIMIT_EXCEEDED`,
      "Group synchronization exceeded the safe pagination limit.",
      false,
    );
  }

  private async identityWhenWorking(
    job: ConnectionOperationJob,
    operationLeaseId: string,
    sessionLease: ProviderSessionLease,
    adapter: WahaAdapter,
    outcome: ProviderOutcome,
  ) {
    if (outcome.connectionState !== "WORKING") return undefined;
    await this.repository.renewLeases(job, operationLeaseId, sessionLease, this.leaseForSeconds);
    const identity = await adapter.getIdentity(job.connectionId);
    const phoneE164 = normalizeWahaPhone(identity.phone);
    if (!phoneE164) {
      throw new LifecycleOperationError(
        "WAHA_IDENTITY_INVALID",
        "WAHA did not return a valid connected WhatsApp number.",
        false,
      );
    }
    return {
      phoneE164,
      ...(identity.displayName ? { displayName: identity.displayName.slice(0, 256) } : {}),
    };
  }

  private webhookUrl(routeToken: string) {
    const url = new URL(`/webhooks/waha/${routeToken}`, this.publicWebhookBaseUrl);
    return url.toString();
  }

  private provisioningOptions(job: ConnectionOperationJob, lifecycleSecrets: ResolvedLifecycleSecrets) {
    const { hmacKey, routeToken } = requiredProvisioningSecrets(lifecycleSecrets);
    return {
      start: true,
      expectedEngine: job.engine as "GOWS" | "NOWEB",
      config: {
        metadata: { connectionId: job.connectionId },
        webhooks: [{
          url: this.webhookUrl(routeToken),
          events: [...WAHA_EVENTS],
          hmac: { key: hmacKey },
          retries: { policy: "exponential", delaySeconds: 2, attempts: 15 },
        }],
      },
    };
  }
}

function assertSelectedWahaEngine(job: ConnectionOperationJob, outcome: ProviderOutcome) {
  if (outcome.engine && outcome.engine !== job.engine) {
    throw new LifecycleOperationError(
      "WAHA_ENGINE_PROVIDER_MISMATCH",
      "The provider reported a different WAHA engine than the selected connection engine.",
      false,
      "ACTION_REQUIRED",
    );
  }
}

function recordConnectionOutcome(
  job: ConnectionOperationJob,
  state: ConnectionRuntimeState,
  result: "succeeded" | "retryable_failure" | "terminal_failure" | "lease_lost",
  startedAt: number,
  reason = "none",
) {
  const attributes = {
    provider: job.provider.toLowerCase(),
    action: job.operationType.toLowerCase(),
    state: state.toLowerCase(),
    result,
    reason,
  };
  recordMetric("wasalx_connection_transition_total", 1, attributes);
  observeDuration("wasalx_connection_operation_seconds", startedAt, attributes);
}

function requiresReauthentication(code: string) {
  return /(AUTH|TOKEN|CREDENTIAL|SESSION|HMAC|SECRET)/u.test(code.toUpperCase());
}

export function mapWahaSessionState(status: WahaSessionStatus): ProviderOutcome {
  switch (status) {
    case "SCAN_QR_CODE":
      return outcome("AWAITING_AUTH", status, "Scan the current QR code to connect WhatsApp.");
    case "PASSKEY_REQUIRED":
      return outcome("AWAITING_AUTH", status, "Complete the WhatsApp passkey step to continue.");
    case "PASSKEY_CONFIRMATION_REQUIRED":
      return outcome("AWAITING_AUTH", status, "Confirm the displayed WhatsApp passkey code to continue.");
    case "STARTING":
      return outcome("CONNECTING", status, null);
    case "WORKING":
      return outcome("WORKING", status, null);
    case "STOPPED":
      return outcome("PAUSED", status, "The WhatsApp session is stopped.");
    case "FAILED":
      return outcome("FAILED", status, "WAHA reported that the WhatsApp session failed.");
    case "UNKNOWN":
      return outcome("DEGRADED", status, "WAHA returned an unknown session state.");
  }
}

export function classifyConnectionOperationError(
  error: unknown,
  currentState: ConnectionRuntimeState = "DEGRADED",
): ConnectionOperationErrorClassification {
  if (error instanceof MetaCredentialMetadataError) {
    return { retryable: false, code: error.code, safeError: error.message, connectionState: "ACTION_REQUIRED" };
  }
  if (error instanceof LifecycleOperationError) {
    return {
      retryable: error.retryable,
      code: error.code,
      safeError: error.message,
      connectionState: error.connectionState ?? (error.retryable ? retryState(currentState) : "ACTION_REQUIRED"),
    };
  }
  if (
    error instanceof ProviderSessionLeaseUnavailableError ||
    error instanceof WahaWorkerAssignmentUnavailableError
  ) {
    return {
      retryable: true,
      code: error.code,
      safeError: error.message,
      connectionState: currentState,
    };
  }
  if (error instanceof SecretResolutionError) {
    return {
      retryable: error.retryable,
      code: error.retryable ? "SECRET_RESOLVER_UNAVAILABLE" : "SECRET_RESOLUTION_FAILED",
      safeError: error.retryable
        ? "Secure connection credentials are temporarily unavailable."
        : "Secure connection credentials could not be resolved.",
      connectionState: error.retryable ? retryState(currentState) : "ACTION_REQUIRED",
    };
  }
  if (error instanceof ProviderError) {
    const authorizationFailure = error.status === 401 || error.status === 403;
    const missingSession = error.status === 404;
    const metaError = error.code.startsWith("META_");
    return {
      retryable: error.retryable,
      code: boundedCode(error.code || "PROVIDER_ERROR"),
      safeError: metaError
        ? safeError(error)
        : authorizationFailure
        ? "WAHA administrative credentials were rejected."
        : missingSession
          ? "The WAHA session could not be found."
          : safeError(error),
      connectionState: error.retryable ? retryState(currentState) : "ACTION_REQUIRED",
    };
  }
  if (isRetryableDatabaseError(error)) {
    return {
      retryable: true,
      code: "DATABASE_TEMPORARILY_UNAVAILABLE",
      safeError: "The connection operation could not be saved temporarily.",
      connectionState: retryState(currentState),
    };
  }
  return {
    retryable: true,
    code: "UNEXPECTED_WORKER_ERROR",
    safeError: "The connection operation failed unexpectedly and will be retried.",
    connectionState: retryState(currentState),
  };
}

class LifecycleOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly connectionState?: ConnectionRuntimeState,
  ) {
    super(message);
    this.name = "LifecycleOperationError";
  }
}

function snapshotOutcome(snapshot: WahaSessionSnapshot): ProviderOutcome {
  const mapped = mapWahaSessionState(snapshot.status);
  return {
    ...mapped,
    providerStateData: {
      status: snapshot.status,
      ...(snapshot.engine ? { engine: snapshot.engine } : {}),
      ...(snapshot.reconciled ? { provisioningReconciled: true } : {}),
    },
    ...(snapshot.engine ? { engine: snapshot.engine } : {}),
  };
}

async function providerStateOutcome(adapter: WahaAdapter, connectionId: string): Promise<ProviderOutcome> {
  const state = await adapter.getState(connectionId);
  const providerState = normalizedProviderState(state.detail);
  const mapped = mapWahaSessionState(providerState);
  return {
    connectionState: mapped.connectionState,
    providerState,
    providerStateData: { status: providerState,...(state.engine?{engine:state.engine}:{}) },
    actionReason: mapped.actionReason,
    ...(state.engine?{engine:state.engine}:{}),
  };
}

function lifecycleCompletion(
  job: ConnectionOperationJob,
  outcome: ProviderOutcome,
  identity: { phoneE164: string; displayName?: string } | undefined,
  result: Record<string, unknown>,
): OperationCompletion {
  return {
    connectionState: outcome.connectionState,
    providerState: outcome.providerState,
    providerStateData: outcome.providerStateData,
    actionReason: outcome.actionReason,
    ...(identity?.phoneE164 ? { phoneE164: identity.phoneE164 } : {}),
    ...(outcome.engine ? { engine: outcome.engine } : job.engine ? { engine: job.engine } : {}),
    result: {
      ...result,
      providerState: outcome.providerState,
      ...(identity ? { identity } : {}),
    },
  };
}

function localMetaCompletion(job: ConnectionOperationJob, wabaId: string): OperationCompletion {
  const currentStateData = job.providerSession?.providerStateData ?? {};
  if (job.operationType === "PAUSE") {
    return {
      connectionState: "PAUSED",
      providerState: "PAUSED_LOCAL",
      providerStateData: { ...currentStateData, wabaId, localState: "PAUSED" },
      actionReason: "The official Meta connection is paused in WasalX.",
      engine: "CLOUD_API",
      webhookState: "PAUSED",
      result: { paused: true },
    };
  }
  if (job.operationType !== "DISCONNECT") {
    throw new LifecycleOperationError(
      "META_LOCAL_OPERATION_INVALID",
      "The local Meta lifecycle operation is invalid.",
      false,
    );
  }
  return {
    connectionState: "REVOKED",
    providerState: "REVOKED_LOCAL",
    providerStateData: { ...currentStateData, wabaId, localState: "REVOKED" },
    actionReason: "The official Meta connection has been disconnected from WasalX.",
    engine: "CLOUD_API",
    retireSession: true,
    revokeWebhook: true,
    webhookState: "REVOKED",
    result: {
      disconnected: true,
      // WABA app subscription is shared at account scope and is deliberately
      // retained when only one phone-number connection is disconnected.
      providerSubscriptionRetained: true,
    },
  };
}

function outcome(connectionState: ConnectionRuntimeState, providerState: string, actionReason: string | null): ProviderOutcome {
  return { connectionState, providerState, providerStateData: { status: providerState }, actionReason };
}

async function ignoreMissingSession(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return;
    throw error;
  }
}

function validatedGroup(group: ProviderGroup, provider: "WAHA" | "META"): ProviderGroup {
  const id = group.id.trim();
  const name = group.name.trim();
  const validId = provider === "WAHA"
    ? id.endsWith("@g.us") && id.length <= 512 && !hasUnsafeControl(id)
    : /^[A-Za-z0-9_-]{1,510}={0,2}$/u.test(id);
  if (!validId) {
    throw new LifecycleOperationError(
      `${provider}_GROUP_INVALID`,
      "The provider returned an invalid group identifier.",
      false,
    );
  }
  const maximumNameLength = provider === "META" ? 128 : 256;
  if (!name || [...name].length > maximumNameLength || hasUnsafeControl(name)) {
    throw new LifecycleOperationError(
      `${provider}_GROUP_INVALID`,
      "The provider returned an invalid group name.",
      false,
    );
  }
  const maximumParticipants = provider === "META" ? 8 : 100_000;
  if (!Number.isSafeInteger(group.participants) || group.participants < 0 || group.participants > maximumParticipants) {
    throw new LifecycleOperationError(
      `${provider}_GROUP_INVALID`,
      "The provider returned an invalid participant count.",
      false,
    );
  }
  if (group.pictureUrl) {
    let picture: URL;
    try {
      picture = new URL(group.pictureUrl);
    } catch {
      throw new LifecycleOperationError("WAHA_GROUP_INVALID", "WAHA returned an invalid group picture URL.", false);
    }
    if (picture.protocol !== "https:" || group.pictureUrl.length > 2_048) {
      throw new LifecycleOperationError("WAHA_GROUP_INVALID", "WAHA returned an unsafe group picture URL.", false);
    }
  }
  const participantRoster = provider === "WAHA" && group.participantRoster
    ? group.participantRoster.filter((participant) => /^[1-9][0-9]{5,19}@(c\.us|s\.whatsapp\.net|lid)$/u.test(participant.id))
    : undefined;
  return { id, name, participants: group.participants, ...(group.pictureUrl ? { pictureUrl: group.pictureUrl } : {}), ...(participantRoster ? { participantRoster } : {}) };
}

function metaGroupsEligibility(value: MetaGroupsCapability) {
  if (value.eligible) return "VERIFIED";
  return value.state === "TEMPORARILY_UNAVAILABLE" ? "UNVERIFIED" : "NOT_ELIGIBLE";
}

function sanitizedMetaCapability(value: MetaGroupsCapability) {
  return {
    eligible: value.eligible,
    state: value.state,
    checkedAt: value.checkedAt,
    evidence: value.evidence,
    constraints: value.constraints,
    documentationUrl: value.documentationUrl,
  };
}

function validatedMetaGraphVersion(value: string | undefined) {
  if (!value || !/^v\d{1,3}\.\d{1,3}$/u.test(value)) {
    throw new LifecycleOperationError(
      "META_GRAPH_VERSION_INVALID",
      "The Meta Graph API version is not configured.",
      false,
    );
  }
  return value;
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "Unknown connection worker error")
    .replace(/(token|secret|authorization|api[-_ ]?key|hmac)\s*[=:]\s*\S+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

function retryState(current: ConnectionRuntimeState): ConnectionRuntimeState {
  return current === "PROVISIONING" || current === "AWAITING_AUTH" || current === "CONNECTING"
    ? current
    : "DEGRADED";
}

function terminalConnectionState(state: ConnectionRuntimeState, operationType: ConnectionOperationJob["operationType"]): ConnectionRuntimeState {
  if (operationType === "DISCONNECT") return "ACTION_REQUIRED";
  if (state === "ACTION_REQUIRED") return state;
  // Exhausting a discovery retry does not mean the linked WhatsApp session
  // itself failed. Keep the connection recoverable and truthfully degraded so
  // an operator can synchronize again after correcting a provider/schema
  // compatibility issue without restarting or re-pairing the number.
  if (operationType === "SYNC_GROUPS") return "DEGRADED";
  return "FAILED";
}

function exhaustedCode(code: string, job: ConnectionOperationJob) {
  return job.attempts >= job.maxAttempts && code !== "MAX_ATTEMPTS_EXHAUSTED"
    ? `${boundedCode(code)}_EXHAUSTED`.slice(0, 100)
    : boundedCode(code);
}

function exhaustedMessage(message: string, wasRetryable: boolean, job: ConnectionOperationJob) {
  if (!wasRetryable || job.attempts < job.maxAttempts) return message;
  return `${message} The retry limit was reached.`.slice(0, 500);
}

function boundedCode(value: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 100);
  return normalized || "CONNECTION_OPERATION_FAILED";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredProvisioningSecrets(secrets: ResolvedLifecycleSecrets) {
  if (!secrets.hmacKey || !secrets.routeToken) {
    throw new LifecycleOperationError(
      "WEBHOOK_PROVISIONING_SECRET_MISSING",
      "Webhook provisioning credentials are unavailable.",
      false,
    );
  }
  return { hmacKey: secrets.hmacKey, routeToken: secrets.routeToken };
}

function hasUnsafeControl(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedWorkerIdentity(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || hasUnsafeControl(normalized)) throw new Error("workerIdentity is invalid");
  return normalized;
}

function validatedPublicWebhookBase(value: string, allowInsecure: boolean) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("publicWebhookBaseUrl must be a credential-free HTTPS URL");
  }
  return url;
}

function isRetryableDatabaseError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = stringValue((error as { code?: unknown }).code);
  if (!code) return false;
  return code.startsWith("08") || code.startsWith("40") || ["53", "55P03", "57P01", "57P02", "57P03"].some((prefix) => code.startsWith(prefix));
}

function normalizedProviderState(value: unknown): WahaSessionStatus {
  return value === "STOPPED" ||
    value === "STARTING" ||
    value === "SCAN_QR_CODE" ||
    value === "PASSKEY_REQUIRED" ||
    value === "PASSKEY_CONFIRMATION_REQUIRED" ||
    value === "WORKING" ||
    value === "FAILED"
    ? value
    : "UNKNOWN";
}
