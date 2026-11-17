import {
  recordMetric,
  recordStructuredLog,
  safeErrorCode,
  safeTenantLogId,
  withSpan,
} from "@wasalx/observability";
import type { InvitationMailerConfig } from "./config.js";
import {
  InvitationDeliveryError,
  buildInvitationAcceptanceUrl,
  decryptInvitationToken,
  type TransactionalEmailProvider,
} from "./provider.js";
import type { InvitationEmailJob, InvitationMailerStore } from "./repository.js";
import { MailerSecretError, type MailerSecretResolver } from "./secrets.js";

export class InvitationMailerProcessor {
  private readonly config: Pick<InvitationMailerConfig,
    "workerId" | "batchSize" | "maxAttempts" | "privateKeyReferences" |
    "portalOrigin" | "sender" | "templateId">;
  private readonly store: InvitationMailerStore;
  private readonly secrets: MailerSecretResolver;
  private readonly provider: TransactionalEmailProvider;
  constructor(
    config: Pick<InvitationMailerConfig,
      "workerId" | "batchSize" | "maxAttempts" | "privateKeyReferences" |
      "portalOrigin" | "sender" | "templateId">,
    store: InvitationMailerStore,
    secrets: MailerSecretResolver,
    provider: TransactionalEmailProvider,
  ) {
    this.config = config;
    this.store = store;
    this.secrets = secrets;
    this.provider = provider;
  }

  async drainOnce() {
    const jobs = await this.store.claim(this.config.workerId, this.config.batchSize);
    const outcomes = await Promise.all(jobs.map((job) => this.process(job)));
    return {
      claimed: jobs.length,
      sent: outcomes.filter((outcome) => outcome === "sent").length,
      retrying: outcomes.filter((outcome) => outcome === "retrying").length,
      terminal: outcomes.filter((outcome) => outcome === "terminal").length,
      stale: outcomes.filter((outcome) => outcome === "stale").length,
    };
  }

  private async process(job: InvitationEmailJob) {
    return withSpan("invitation email delivery", {
      attributes: { "wasalx.component": "invitation_mailer" },
    }, async () => {
      let providerReceipt: string | undefined;
      try {
        const token = await decryptInvitationToken({
          ciphertext: job.token_ciphertext,
          keyVersion: job.token_key_version,
          privateKeyReferences: this.config.privateKeyReferences,
          secrets: this.secrets,
        });
        const acceptanceUrl = buildInvitationAcceptanceUrl(this.config.portalOrigin, token);
        const receipt = await this.provider.send({
          recipient: job.recipient_email,
          sender: this.config.sender,
          templateId: this.config.templateId,
          acceptanceUrl,
          expiresAt: job.expires_at,
          idempotencyKey: job.idempotency_key,
          deliveryId: job.id,
        });
        providerReceipt = receipt.messageId;
        const completed = await this.store.complete(job, this.config.workerId, receipt.messageId);
        const outcome = completed ? "sent" : "stale";
        recordJobMetric(outcome, "none");
        recordStructuredLog(completed ? "info" : "warn", "invitation_mailer.delivery_finished", {
          tenant_id: safeTenantLogId(job.tenant_id),
          job_id: job.id,
          outcome,
        });
        return outcome;
      } catch (error) {
        const failure = providerReceipt
          ? {
              code: "EMAIL_PROVIDER_RECEIPT_PERSISTENCE_UNKNOWN",
              retryable: false,
              safeMessage: "Invitation delivery requires operator verification before any resend.",
            }
          : classifyFailure(error);
        const retryable = failure.retryable && job.attempts < this.config.maxAttempts;
        const outcome = retryable ? "retrying" : "terminal";
        const failed = await this.store.fail(job, this.config.workerId, {
          retryable,
          code: failure.code,
          safeError: retryable
            ? "Invitation delivery will be retried automatically."
            : failure.safeMessage,
          nextAttemptAt: nextAttempt(job.attempts),
        });
        const finalOutcome = failed ? outcome : "stale";
        recordJobMetric(finalOutcome, failure.code);
        recordStructuredLog(retryable ? "warn" : "error", "invitation_mailer.delivery_failed", {
          tenant_id: safeTenantLogId(job.tenant_id),
          job_id: job.id,
          outcome: finalOutcome,
          error_code: failure.code,
        });
        return finalOutcome;
      }
    });
  }
}

function classifyFailure(error: unknown) {
  if (error instanceof InvitationDeliveryError || error instanceof MailerSecretError) {
    return {
      code: error.code,
      retryable: error.retryable,
      safeMessage: error instanceof InvitationDeliveryError
        ? error.safeMessage
        : "A required invitation delivery secret is unavailable.",
    };
  }
  return {
    code: safeErrorCode(error),
    retryable: true,
    safeMessage: "Invitation delivery failed unexpectedly.",
  };
}

export function nextAttempt(attempt: number, random = Math.random) {
  const exponent = Math.max(0, Math.min(attempt - 1, 10));
  const base = Math.min(15 * 60_000, 2_000 * (2 ** exponent));
  const jitter = 0.75 + Math.max(0, Math.min(1, random())) * 0.5;
  return new Date(Date.now() + Math.round(base * jitter));
}

function recordJobMetric(outcome: string, reason: string) {
  recordMetric("wasalx_worker_jobs_total", 1, {
    component: "invitation_mailer",
    outcome,
    reason,
  });
}
