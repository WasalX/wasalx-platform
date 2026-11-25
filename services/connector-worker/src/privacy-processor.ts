import { createHash, randomUUID } from "node:crypto";
import { observeDuration, recordMetric } from "@wasalx/observability";
import { PrivacyLegalHoldError, PrivacyRepositoryError, type PrivacyJob, type PrivacyRepository, type PrivacyTarget } from "./privacy-repository.js";
import { PrivacyZammadClient, PrivacyZammadError } from "./privacy-zammad.js";
import { SecretResolutionError, type SecretResolver } from "./secrets.js";

export interface PrivacyObjectStorage {
  put(key: string, bytes: Uint8Array, metadata: Record<string, string>): Promise<void>;
  delete(key: string): Promise<void>;
}

export type PrivacyProcessorResult = {
  claimed: number;
  succeeded: number;
  deferred: number;
  failedRetryable: number;
  failedTerminal: number;
  legalHoldBlocked: number;
  leaseLost: number;
};

export class PrivacyProcessor {
  constructor(
    private readonly repository: PrivacyRepository,
    private readonly secrets: SecretResolver,
    private readonly storage: PrivacyObjectStorage,
    private readonly batchSize = 5,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 25) throw new Error("Privacy batch size is invalid");
  }

  async drainTenant(tenantId: string): Promise<PrivacyProcessorResult> {
    await this.repository.expireHolds(tenantId);
    await this.repository.ensureMaintenanceJob(tenantId);
    const leaseId = randomUUID();
    const jobs = await this.repository.claim(tenantId, leaseId, this.batchSize);
    const result: PrivacyProcessorResult = {
      claimed: jobs.length,
      succeeded: 0,
      deferred: 0,
      failedRetryable: 0,
      failedTerminal: 0,
      legalHoldBlocked: 0,
      leaseLost: 0,
    };
    for (const job of jobs) {
      const startedAt = Date.now();
      try {
        const outcome = await this.process(job, leaseId);
        if (outcome === "deferred") {
          result.deferred += 1;
          recordPrivacyOutcome(job, "deferred", startedAt);
        } else if (await this.repository.complete(job, leaseId, outcome)) {
          result.succeeded += 1;
          recordPrivacyOutcome(job, "succeeded", startedAt, outcome);
        } else {
          result.leaseLost += 1;
          recordPrivacyOutcome(job, "lease_lost", startedAt);
        }
      } catch (error) {
        const failure = classifyPrivacyFailure(error, job);
        const persisted = await this.repository.fail(job, leaseId, failure).catch(() => false);
        if (!persisted) {
          result.leaseLost += 1;
          recordPrivacyOutcome(job, "lease_lost", startedAt);
        } else if ("legalHold" in failure && failure.legalHold) {
          result.legalHoldBlocked += 1;
          recordPrivacyOutcome(job, "legal_hold_blocked", startedAt);
        } else if (failure.retryable && job.attempts < job.maxAttempts) {
          result.failedRetryable += 1;
          recordPrivacyOutcome(job, "failed_retryable", startedAt);
        } else {
          result.failedTerminal += 1;
          recordPrivacyOutcome(job, "failed_terminal", startedAt);
        }
      }
    }
    return result;
  }

  private async process(job: PrivacyJob, leaseId: string): Promise<Record<string, unknown> | "deferred"> {
    const discovered = await this.repository.discover(job, leaseId);
    if (job.jobType === "EXPORT") {
      const artifact = await this.export(job, leaseId);
      const local = await this.repository.finalize(job, leaseId);
      return {
        ...local,
        ...discovered,
        participantIdentities: artifact.participantIdentities,
        metaDirectAliases: artifact.metaDirectAliases,
        metaDirectIdentityEvents: artifact.metaDirectIdentityEvents,
        metaDirectRecipients: artifact.metaDirectRecipients,
        metaCoexistenceMessages: artifact.metaCoexistenceMessages,
        metaCoexistenceContacts: artifact.metaCoexistenceContacts,
        metaBillingEvidence: artifact.metaBillingEvidence,
        metaAccountPolicies: artifact.metaAccountPolicies,
        metaAccountTransitions: artifact.metaAccountTransitions,
        metaRoutingEvents: artifact.metaRoutingEvents,
        metaRoutingActions: artifact.metaRoutingActions,
        metaManagedAuthority: artifact.metaManagedAuthority,
        metaFinancialEffects: artifact.metaFinancialEffects,
        metaCostAssessments: artifact.metaCostAssessments,
        metaCostTariffs: artifact.metaCostTariffs,
        metaCostStatements: artifact.metaCostStatements,
        metaCostSourceReviewStatus: artifact.metaCostSourceReviewStatus,
        metaSignupAttempts: artifact.metaSignupAttempts,
        groupWorkspaceParticipants: artifact.groupWorkspaceParticipants,
        exportArtifactId: artifact.id,
        exportExpiresAt: artifact.expiresAt,
      };
    }

    if(await this.repository.hasPendingFinanceReview(job))throw new PrivacyRepositoryError(
      "FINANCE_SOURCE_REVIEW_REQUIRED","A retained financial source requires review before privacy processing can continue",false);
    const targets = await this.repository.targets(job);
    let client: PrivacyZammadClient | undefined;
    for (const target of targets) {
      if (target.state !== "PENDING" || target.type === "NORMALIZED_MESSAGE") continue;
      if (target.type === "ZAMMAD_TICKET") {
        client ??= await this.zammad(job, leaseId);
        const attempts = await this.repository.beginTargetExternal(job, leaseId, target);
        await observeZammad("privacy_delete_ticket", () => client!.deleteTicket(target.targetId, { id: target.id, attempts }));
        await this.repository.markTargetExternal(job, leaseId, target);
        continue;
      }
      if (target.type === "ZAMMAD_USER") {
        client ??= await this.zammad(job, leaseId);
        const deferred = await this.processUserPrivacyTask(job, leaseId, target, client);
        if (deferred) return "deferred";
        continue;
      }
      if (target.type === "MEDIA_OBJECT" || target.type === "EXPORT_ARTIFACT" || target.type === "EXPORT_OBJECT" || target.type === "META_COST_SOURCE") {
        assertPrivacyObjectKey(job, target);
        await this.repository.beginTargetExternal(job, leaseId, target);
        await this.storage.delete(target.objectKey!);
        await this.repository.markTargetExternal(job, leaseId, target);
      }
    }
    if (await this.repository.hasPendingExternalTargets(job)) {
      if (!await this.repository.defer(job, leaseId, new Date(Date.now() + 1_000).toISOString())) throw new Error("Privacy job lease was lost while deferring");
      return "deferred";
    }
    const local = await this.repository.finalize(job, leaseId);
    return { ...local, ...discovered };
  }

  private async export(job: PrivacyJob, leaseId: string) {
    if (!job.requestId) throw new PrivacyRepositoryError("EXPORT_REQUEST_MISSING", "Export request metadata is unavailable", false);
    const local = await this.repository.exportData(job, leaseId);
    const metaCoexistence = local.metaCoexistence ?? { messages: [], contacts: [] };
    const metaRouting = local.metaRouting ?? { events: [], actions: [] };
    const zammad = await this.zammad(job, leaseId);
    const tickets: Array<Record<string, unknown>> = [];
    let zammadBytes = 0;
    for (const ticketId of local.ticketIds) {
      await this.repository.renew(job, leaseId);
      const ticket = await observeZammad("privacy_get_ticket", () => zammad.getTicket(ticketId));
      if (!ticket) {
        tickets.push({ id: ticketId, unavailable: true });
        continue;
      }
      await this.repository.renew(job, leaseId);
      const value = {
        ticket,
        articles: await observeZammad("privacy_get_articles", () => zammad.getTicketArticles(ticketId)),
      };
      zammadBytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (zammadBytes > 40_000_000) {
        throw new PrivacyRepositoryError("EXPORT_SCOPE_TOO_LARGE", "Export is too large; choose a narrower scope", false);
      }
      tickets.push(value);
    }
    const bundle = {
      schemaVersion: 1,
      tenantId: job.tenantId,
      requestId: job.requestId,
      generatedAt: new Date().toISOString(),
      scope: { type: job.scopeType, value: job.scopeValue },
      local: {
        messages: local.messages,
        participantIdentities: local.participantIdentities,
        ...(local.whatsappMarketingPreferences ? { whatsappMarketingPreferences: local.whatsappMarketingPreferences } : {}),
        metaDirectAliases: local.metaDirectAliases,
        metaDirectIdentityEvents: local.metaDirectIdentityEvents,
        metaDirectRecipients: local.metaDirectRecipients,
        metaCoexistence,
        metaBillingEvidence: local.metaBillingEvidence,
        metaAccountPolicies: local.metaAccountPolicies,
        metaAccountTransitions: local.metaAccountTransitions,
        metaRouting,
        metaManagedAuthority: local.metaManagedAuthority,
        metaFinancialEffects: local.metaFinancialEffects,
        metaCostAssessments: local.metaCostAssessments,
        metaCostTariffs: local.metaCostTariffs,
        metaCostStatements: local.metaCostStatements,
        metaCostSourceReviewStatus: local.metaCostSourceReviewStatus,
        metaSignupAttempts: local.metaSignupAttempts,
        groupWorkspaceParticipants: local.groupWorkspaceParticipants,
        correlations: local.correlations,
        botConversations: local.botConversations,
        botEvents: local.botEvents,
        botActions: local.botActions,
      },
      zammad: { tickets },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    if (bytes.byteLength < 2 || bytes.byteLength > 52_428_800) {
      throw new PrivacyRepositoryError("EXPORT_SIZE_INVALID", "Export is too large; choose a narrower scope", false);
    }
    const objectKey = `tenants/${job.tenantId}/privacy-exports/${job.requestId}-${job.fencingToken}.json`;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await this.repository.reserveArtifactUpload(job, leaseId, objectKey);
    await this.repository.renew(job, leaseId);
    await this.storage.put(objectKey, bytes, {
        mime_type: "application/json",
        tenant_id: job.tenantId,
        privacy_request_id: job.requestId,
        sha256,
      });
    const artifact = await this.repository.persistArtifact(job, leaseId, { objectKey, sha256, byteSize: bytes.byteLength });
    return {
      ...artifact,
      participantIdentities: local.participantIdentities.length,
      metaDirectAliases: local.metaDirectAliases.length,
      metaDirectIdentityEvents: local.metaDirectIdentityEvents.length,
      metaDirectRecipients: local.metaDirectRecipients.length,
      metaCoexistenceMessages: metaCoexistence.messages.length,
      metaCoexistenceContacts: metaCoexistence.contacts.length,
      metaBillingEvidence: local.metaBillingEvidence.length,
      metaAccountPolicies: local.metaAccountPolicies.length,
      metaAccountTransitions: local.metaAccountTransitions.length,
      metaRoutingEvents: metaRouting.events.length,
      metaRoutingActions: metaRouting.actions.length,
      metaManagedAuthority: local.metaManagedAuthority.length,
      metaFinancialEffects: local.metaFinancialEffects.length,
      metaCostAssessments: local.metaCostAssessments.length,
      metaCostTariffs: local.metaCostTariffs.length,
      metaCostStatements: local.metaCostStatements.length,
      metaCostSourceReviewStatus: local.metaCostSourceReviewStatus.length,
      metaSignupAttempts: local.metaSignupAttempts.length,
      groupWorkspaceParticipants: local.groupWorkspaceParticipants.length,
    };
  }

  private async processUserPrivacyTask(
    job: PrivacyJob,
    leaseId: string,
    target: PrivacyTarget,
    client: PrivacyZammadClient,
  ) {
    let operationId = target.externalOperationId;
    let state: string;
    if (!operationId) {
      if (target.attempts > 0) {
        throw new PrivacyZammadError(
          "Zammad data-privacy task outcome requires operator reconciliation",
          "ZAMMAD_PRIVACY_OUTCOME_UNKNOWN",
          false,
        );
      }
      const attempts = await this.repository.beginTargetExternal(job, leaseId, target);
      const created = await observeZammad(
        "privacy_create_user_task",
        () => client.createUserDataPrivacyTask(target.targetId, { id: target.id, attempts }),
      );
      operationId = created.id;
      state = created.state;
      await this.repository.setTargetOperation(job, leaseId, target, operationId);
    } else {
      const startedAt = target.externalStartedAt ? new Date(target.externalStartedAt).getTime() : Number.NaN;
      if (!Number.isFinite(startedAt) || Date.now() - startedAt > 24 * 60 * 60 * 1_000) {
        throw new PrivacyZammadError(
          "Zammad data-privacy task requires operator reconciliation",
          "ZAMMAD_PRIVACY_OUTCOME_UNKNOWN",
          false,
        );
      }
      await this.repository.renew(job, leaseId);
      state = (await observeZammad(
        "privacy_get_user_task",
        () => client.getDataPrivacyTask(operationId!, target),
      )).state;
    }
    if (["completed", "complete", "done", "finished", "successful", "succeeded"].includes(state)) {
      await this.repository.markTargetExternal(job, leaseId, target);
      return false;
    }
    if (["failed", "error", "cancelled", "canceled"].includes(state)) {
      throw new PrivacyZammadError("Zammad data-privacy task failed", "ZAMMAD_PRIVACY_TASK_FAILED", false);
    }
    const next = new Date(Date.now() + 30_000).toISOString();
    if (!await this.repository.defer(job, leaseId, next)) throw new Error("Privacy job lease was lost while deferring");
    return true;
  }

  private async zammad(job: PrivacyJob, leaseId: string) {
    let secret;
    try {
      secret = await this.secrets.resolve(job.zammadPrivacySecretReference,{kind:"zammad",tenantId:job.tenantId,purpose:"privacy"});
    } catch (error) {
      if (error instanceof SecretResolutionError) throw error;
      throw new SecretResolutionError("Zammad privacy credential could not be resolved", true);
    }
    if (!secret.token) {
      throw new PrivacyZammadError("Zammad privacy credential is unavailable", "ZAMMAD_PRIVACY_CREDENTIAL_INVALID", false);
    }
    return new PrivacyZammadClient(job.zammadBaseUrl, secret.token, 30_000, { jobId: job.id, leaseId, fencingToken: job.fencingToken });
  }
}

function recordPrivacyOutcome(
  job: Pick<PrivacyJob, "jobType">,
  outcome: string,
  startedAt: number,
  summary?: Record<string, unknown>,
) {
  const jobType = job.jobType.toLowerCase();
  const attributes = { job_type: jobType, result: outcome };
  recordMetric("wasalx_privacy_job_total", 1, attributes);
  observeDuration("wasalx_privacy_job_duration_seconds", startedAt, attributes);
  if (job.jobType === "DELETE") recordMetric("wasalx_privacy_deletion_total", 1, { result: outcome });
  if (job.jobType === "EXPORT") recordMetric("wasalx_privacy_export_total", 1, { result: outcome });
  if (outcome === "legal_hold_blocked") {
    recordMetric("wasalx_privacy_legal_hold_block_total", 1, { job_type: jobType });
  }
  const unmatched = summary?.unmatchedDiagnostics;
  if (outcome === "succeeded" && typeof unmatched === "number" && Number.isSafeInteger(unmatched) && unmatched > 0) {
    recordMetric("wasalx_unmatched_diagnostic_purged_total", unmatched, { source: "retention_sweep" });
  }
}

async function observeZammad<T>(operation: string, task: () => Promise<T>) {
  const startedAt = Date.now();
  try {
    const value = await task();
    recordMetric("wasalx_ticket_operation_total", 1, { operation, component: "privacy", result: "succeeded" });
    observeDuration("wasalx_ticket_operation_seconds", startedAt, { operation, component: "privacy", result: "succeeded" });
    return value;
  } catch (error) {
    recordMetric("wasalx_ticket_operation_total", 1, { operation, component: "privacy", result: "failed" });
    observeDuration("wasalx_ticket_operation_seconds", startedAt, { operation, component: "privacy", result: "failed" });
    throw error;
  }
}

export function classifyPrivacyFailure(error: unknown, job: Pick<PrivacyJob, "attempts" | "maxAttempts">) {
  if (error instanceof PrivacyLegalHoldError) {
    return {
      retryable: false,
      legalHold: true,
      code: "LEGAL_HOLD_ACTIVE",
      safeError: "An active legal hold blocks this privacy deletion.",
    };
  }
  if (error instanceof PrivacyRepositoryError) {
    return retry(error.code, error.message, error.retryable, job);
  }
  if (error instanceof PrivacyZammadError) {
    return retry(error.code, error.message, error.retryable, job);
  }
  if (error instanceof SecretResolutionError) {
    return retry(
      "PRIVACY_SECRET_UNAVAILABLE",
      error.retryable ? "Privacy service credentials are temporarily unavailable." : "Privacy service credentials are invalid.",
      error.retryable,
      job,
    );
  }
  if (isStorageError(error)) {
    return retry(
      stringField(error, "code") ?? "PRIVACY_STORAGE_FAILURE",
      "Private object storage is unavailable for the privacy operation.",
      Boolean((error as { retryable?: unknown }).retryable),
      job,
    );
  }
  return retry("PRIVACY_UNEXPECTED_FAILURE", "Privacy processing failed temporarily.", true, job);
}

function retry(code: string, safeError: string, retryable: boolean, job: Pick<PrivacyJob, "attempts" | "maxAttempts">) {
  const canRetry = retryable && job.attempts < job.maxAttempts;
  const exhausted = retryable && !canRetry;
  return {
    retryable: canRetry,
    code: exhausted ? `${code}_EXHAUSTED`.slice(0, 100) : code,
    safeError: safeError.slice(0, 500),
    ...(canRetry ? { retryAt: new Date(Date.now() + retryDelay(job.attempts)).toISOString() } : {}),
  };
}

function assertPrivacyObjectKey(job: PrivacyJob, target: PrivacyTarget) {
  const key = target.objectKey;
  if (!key || key.length > 512 || /[\p{Cc}\p{Cf}]/u.test(key)) {
    throw new PrivacyRepositoryError("PRIVACY_OBJECT_KEY_MISSING", "Private object cleanup metadata is unavailable.", false);
  }
  if (target.type === "MEDIA_OBJECT") {
    const match = new RegExp(`^${escapeRegex(job.tenantId)}/sha256/([0-9a-f]{2})/([0-9a-f]{64})$`, "u").exec(key);
    if (!match || match[1] !== match[2]!.slice(0, 2)) throw invalidObjectKey();
    return;
  }
  if(target.type==="META_COST_SOURCE"){
    if(!/^[0-9a-f-]{36}$/u.test(target.targetId))throw invalidObjectKey();
    const prefix="tenants/"+job.tenantId+"/meta-cost-sources/"+target.targetId+"/";
    if(!key.startsWith(prefix)||!/^[0-9a-f]{64}\.bin$/u.test(key.slice(prefix.length)))throw invalidObjectKey();
    return;
  }
  const exportPrefix = `tenants/${job.tenantId}/privacy-exports/`;
  if (!key.startsWith(exportPrefix) || !/^[0-9a-f-]{36}(?:-[0-9]+)?\.json$/u.test(key.slice(exportPrefix.length))) throw invalidObjectKey();
  if (target.type === "EXPORT_OBJECT" && target.targetId !== key) throw invalidObjectKey();
}

function invalidObjectKey() {
  return new PrivacyRepositoryError("PRIVACY_OBJECT_KEY_INVALID", "Private object cleanup metadata is invalid.", false);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function retryDelay(attempts: number) {
  return Math.min(3_600_000, 5_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 10)) + Math.floor(Math.random() * 1_000);
}

function isStorageError(value: unknown): value is { code?: string; retryable?: boolean } {
  if (value === null || typeof value !== "object") return false;
  const code = stringField(value, "code");
  return typeof (value as { retryable?: unknown }).retryable === "boolean"
    && Boolean(code?.startsWith("MEDIA_STORAGE_") || code?.startsWith("PRIVACY_STORAGE_"));
}

function stringField(value: object, field: string) {
  const entry = (value as Record<string, unknown>)[field];
  return typeof entry === "string" ? entry : undefined;
}
