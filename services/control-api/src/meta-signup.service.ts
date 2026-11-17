import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { metaId, metaSignupChoiceAdmission } from "@wasalx/core/meta-signup";
import type { MetaCoexistenceConsent, MetaSignupSessionLogRequest } from "@wasalx/core/meta-coexistence-contract";
import type { MetaCredentialMetadata } from "@wasalx/core/meta-account-relation";
import { DatabaseService } from "./database.service.js";
import { MetaCredentialService } from "./meta-credential.service.js";
import { MetaGraphClientError } from "./meta-groups.client.js";
import { MetaSignupClient, type SignupConfig, type VerifiedSignupChoice } from "./meta-signup.client.js";
import { SecretProvisioningService } from "./secret-provisioning.service.js";
import { WebhookSecretService } from "./webhook-secret.service.js";
import { requirePrivilegedAuthentication } from "./privileged-auth.js";
import { appendAudit } from "./audit.js";
import { loadMetaReconnectTarget, assertMetaReconnectTarget, reconnectConflict, type MetaReconnectTarget } from "./meta-connection-binding.js";
import { metaCredentialRotationReference } from "./connection-secret-reference.js";
import type { AuthenticatedRequest } from "./types.js";
import type { MetaSignupAttemptView, MetaSignupCapabilities, MetaSignupExchangeRequest, MetaSignupReadiness, MetaSignupReason, MetaSignupSelectRequest, MetaSignupStartRequest, MetaSignupStartResponse, MetaSignupStatus } from "./meta-signup.types.js";

type ObserverTarget = { state: "PAUSED" | "WORKING"; connectionId: string; providerSessionId: string; phoneNumberId: string; wabaId: string; appId: string; secretReference: string; contextSha256: string; transitionId: string; sourceBindingId: string; scopeSha256: string };
type Attempt = {
  purpose: "NEW_NUMBER" | "RECONNECT" | "ADD_ACCESS" | "TRANSITION_READBACK" | "LEGACY_MIGRATION"; target_transition_id?: string; target_connection_id?: string; target_binding?: MetaReconnectTarget | ObserverTarget; target_name?: string;
  connection_credential_write_claimed_at?: string;
  id: string; tenant_id: string; requested_by: string; name: string; idempotency_key: string;
  challenge_sha256: string; config: SignupConfig & { payerMode: "CUSTOMER" }; secret_reference: string;
  status: MetaSignupStatus; revision: number; selection_revision: number; reason_code?: MetaSignupReason;
  readiness: MetaSignupReadiness; choices: VerifiedSignupChoice[]; selected_choice?: VerifiedSignupChoice;
  credential_fingerprint?: string; credential_metadata?: MetaCredentialMetadata;
  registration_pin_fingerprint?: string; credential_stored_at?: string; connection_id?: string; operation_id?: string; expires_at: string | Date;
  coexistence_consent?: MetaCoexistenceConsent;
};
export type SignupSelection = { attempt: Attempt; choice: VerifiedSignupChoice; accessToken: string; registrationPin?: string; credentialMetadata?: MetaCredentialMetadata };

@Injectable()
export class MetaSignupService {
  constructor(private readonly database: DatabaseService, private readonly secrets: SecretProvisioningService,
    private readonly credentials: MetaCredentialService, private readonly webhookSecrets: WebhookSecretService) {}

  async capabilities(request: AuthenticatedRequest): Promise<MetaSignupCapabilities> {
    await this.authorize(request);
    try { const { config } = await this.preflight(); return { enabled: true, payerModes: ["CUSTOMER"], sdk: sdk(config), businessAppEnabled: businessAppConfigured() }; }
    catch { return { enabled: false, unavailableReason: "META_SIGNUP_NOT_CONFIGURED", payerModes: ["CUSTOMER"] }; }
  }

  async start(request: AuthenticatedRequest, body: MetaSignupStartRequest): Promise<MetaSignupStartResponse> {
    only(body, ["name", "payerMode", "idempotencyKey", "targetConnectionId", "targetTransitionId", "targetLegacyMigrationId", "purpose", "variant", "coexistenceConsent"]);
    if (body.variant !== undefined && !["STANDARD", "BUSINESS_APP"].includes(body.variant)) throw invalid();
    const businessApp = body.variant === "BUSINESS_APP";
    if (businessApp) {
      if (Object.hasOwn(body, "targetConnectionId")) throw invalid();
      only(body.coexistenceConsent, ["version", "history", "contacts", "echoes"]);
      if (body.coexistenceConsent?.version !== "2026-10-07" || typeof body.coexistenceConsent.history !== "boolean"
        || typeof body.coexistenceConsent.contacts !== "boolean" || body.coexistenceConsent.echoes !== true) throw invalid();
    } else if (body.coexistenceConsent !== undefined) throw invalid();
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 100 || /\p{Cc}/u.test(body.name)
      || body.payerMode !== "CUSTOMER" || typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(body.idempotencyKey)
      || (Object.hasOwn(body, "targetConnectionId") && !uuid(body.targetConnectionId))
      || (Object.hasOwn(body, "purpose") && (body.purpose !== "NEW_NUMBER" && body.purpose !== "ADD_ACCESS"))
      || (Object.hasOwn(body, "purpose") && Object.hasOwn(body, "targetConnectionId"))
      || (Object.hasOwn(body, "targetTransitionId") && (!uuid(body.targetTransitionId) || !uuid(body.targetConnectionId) || Object.hasOwn(body, "purpose") || Object.hasOwn(body,"targetLegacyMigrationId")))
      || (Object.hasOwn(body,"targetLegacyMigrationId") && (!uuid(body.targetLegacyMigrationId) || !uuid(body.targetConnectionId) || Object.hasOwn(body,"purpose")))) throw invalid();
    const transitionId = body.targetLegacyMigrationId ?? body.targetTransitionId;
    const purpose = body.targetLegacyMigrationId ? "LEGACY_MIGRATION" : body.targetTransitionId ? "TRANSITION_READBACK" : body.targetConnectionId ? "RECONNECT" : body.purpose ?? "NEW_NUMBER";
    if (businessApp && purpose !== "NEW_NUMBER") throw invalid();
    await this.authorize(request); this.origin(request);
    const { config } = await this.preflight(businessApp ? "BUSINESS_APP" : "STANDARD");
    const id = randomUUID(); const challenge = Buffer.from(randomBytes(32)).toString("base64url");
    const result = await this.database.withTenant(request.principal.tenantId, async client => {
      await this.authorize(request, client);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`meta-signup-start:${request.principal.tenantId}:${request.principal.userId}`]);
      const previous = (await client.query<Attempt>("SELECT * FROM meta_signup_attempts WHERE tenant_id=$1 AND requested_by=$2 AND idempotency_key=$3 FOR UPDATE",
        [request.principal.tenantId, request.principal.userId, body.idempotencyKey])).rows[0];
      if (previous) {
        if (previous.name !== body.name.trim() || !sameConfig(previous.config, config)
          || previous.coexistence_consent?.history !== body.coexistenceConsent?.history
          || previous.coexistence_consent?.contacts !== body.coexistenceConsent?.contacts
          || previous.coexistence_consent?.echoes !== body.coexistenceConsent?.echoes
          || previous.coexistence_consent?.version !== body.coexistenceConsent?.version
          || (previous.target_connection_id ?? undefined) !== body.targetConnectionId
          || (previous.target_transition_id ?? undefined) !== transitionId || previous.purpose !== purpose) throw conflict();
        return { row: previous, created: false };
      }
      const target = transitionId ? await this.observerTarget(client, transitionId, body.targetConnectionId!, request.principal.userId, purpose === "LEGACY_MIGRATION")
        : body.targetConnectionId ? await loadMetaReconnectTarget(client, request.principal.tenantId, body.targetConnectionId) : null;
      const row = (await client.query<Attempt>(`INSERT INTO meta_signup_attempts
        (id,tenant_id,requested_by,name,idempotency_key,challenge_sha256,config,secret_reference,readiness,expires_at,purpose,target_connection_id,target_binding,coexistence_consent,target_transition_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '10 minutes',$10,$11,$12,$13,$14) RETURNING *`,
      [id, request.principal.tenantId, request.principal.userId, body.name.trim(), body.idempotencyKey, hash(challenge),
        { ...config, payerMode: "CUSTOMER" }, `secret://${request.principal.tenantId}/meta-signup/${id}`, initialReadiness(),
        purpose, body.targetConnectionId ?? null, target, body.coexistenceConsent ?? null, transitionId ?? null])).rows[0]!;
      await client.query(`INSERT INTO secret_cleanup_outbox (tenant_id,meta_signup_attempt_id,cleanup_kind,secret_reference)
        VALUES ($1,$2,'META_SIGNUP_CREDENTIAL',$3)`, [row.tenant_id, row.id, row.secret_reference]);
      await this.audit(client, request, row.id, "meta_signup.started");
      return { row, created: true };
    });
    return { ...await this.get(request, result.row.id), ...(result.created ? { challenge } : {}), sdk: sdk(config) };
  }

  async latest(request: AuthenticatedRequest, targetConnectionId?: string, purpose?: string, targetTransitionId?: string, targetLegacyMigrationId?: string) {
    if ((targetConnectionId !== undefined && !uuid(targetConnectionId))
      || (purpose !== undefined && purpose !== "NEW_NUMBER" && purpose !== "ADD_ACCESS")
      || (purpose !== undefined && targetConnectionId !== undefined)
      || (targetTransitionId !== undefined && (!uuid(targetTransitionId) || !uuid(targetConnectionId) || purpose !== undefined || targetLegacyMigrationId !== undefined))
      || (targetLegacyMigrationId !== undefined && (!uuid(targetLegacyMigrationId) || !uuid(targetConnectionId) || purpose !== undefined))) throw invalid();
    await this.authorize(request);
    const row = (await this.database.rows<Attempt>(request.principal.tenantId, `SELECT * FROM meta_signup_attempts
      WHERE tenant_id=$1 AND requested_by=$2 AND status NOT IN ('CANCELLED','EXPIRED','FAILED')
      AND purpose=$3 AND target_connection_id IS NOT DISTINCT FROM $4::uuid AND target_transition_id IS NOT DISTINCT FROM $5::uuid
      AND (expires_at>clock_timestamp() OR status IN ('PROVISIONING','OUTCOME_UNKNOWN','COMPLETED')) ORDER BY created_at DESC LIMIT 1`,
    [request.principal.tenantId, request.principal.userId, targetLegacyMigrationId ? "LEGACY_MIGRATION" : targetTransitionId ? "TRANSITION_READBACK" : targetConnectionId ? "RECONNECT" : purpose ?? "NEW_NUMBER", targetConnectionId ?? null, targetLegacyMigrationId ?? targetTransitionId ?? null]))[0];
    return { attempt: row ? await this.get(request, row.id) : null };
  }

  async get(request: AuthenticatedRequest, id: string): Promise<MetaSignupAttemptView> {
    return this.database.withTenant(request.principal.tenantId, async client => {
      await this.authorize(request, client);
      let row = await this.row(client, request, id, true);
      // A vanished exchange process is never permission to replay its code.
      await client.query(`UPDATE meta_signup_attempts SET status='OUTCOME_UNKNOWN',reason_code='META_SIGNUP_EXCHANGE_UNKNOWN',revision=revision+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND status='EXCHANGING' AND exchange_claimed_at<clock_timestamp()-interval '60 seconds'`, [row.tenant_id, id]);
      await client.query(`UPDATE meta_signup_attempts SET status='EXPIRED',reason_code='META_SIGNUP_EXPIRED',revision=revision+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND expires_at<=clock_timestamp() AND status IN ('AWAITING_AUTHORIZATION','SELECTION_REQUIRED','NUMBER_REQUIRED','ACTION_REQUIRED') AND connection_id IS NULL`, [row.tenant_id, id]);
      if (row.status === "PROVISIONING" && row.operation_id) {
        const operation = (await client.query<{ state: string; result: Record<string, unknown>; error_code?: string }>(
          "SELECT state,result,error_code FROM connection_operations WHERE tenant_id=$1 AND id=$2 AND connection_id=$3", [row.tenant_id, row.operation_id, row.connection_id])).rows[0];
        if (row.purpose === "RECONNECT" && operation?.state === "SUCCEEDED" && operation.result?.rotated === true && operation.result?.pausePreserved === true) {
          await client.query(`UPDATE meta_signup_attempts SET status='COMPLETED',reason_code=NULL,readiness=$3,revision=revision+1,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND id=$2 AND status='PROVISIONING'`, [row.tenant_id, id, reconnectReadiness()]);
        } else if (row.purpose === "NEW_NUMBER" && operation?.state === "SUCCEEDED" && operation.result?.metaSignupReady === true) {
          await client.query(`UPDATE meta_signup_attempts SET status='COMPLETED',readiness=$3,revision=revision+1,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND id=$2 AND status='PROVISIONING'`, [row.tenant_id, id, { ...row.readiness, number: "REGISTERED", subscription: "CONFIRMED", messaging: operation.result.metaSignupMessaging ?? "UNKNOWN" }]);
        } else if (operation && ["FAILED_TERMINAL", "CANCELLED"].includes(operation.state)) {
          const unknown = operation.error_code === "META_SIGNUP_REGISTRATION_UNKNOWN";
          await client.query(`UPDATE meta_signup_attempts SET status=$3,reason_code=$4,revision=revision+1,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND id=$2 AND status='PROVISIONING'`, [row.tenant_id, id, unknown ? "OUTCOME_UNKNOWN" : "ACTION_REQUIRED",
            unknown ? "META_SIGNUP_REGISTRATION_UNKNOWN" : "META_SIGNUP_PROVIDER_UNAVAILABLE"]);
        }
      }
      row = await this.row(client, request, id);
      if (row.purpose === "NEW_NUMBER" && row.status === "OUTCOME_UNKNOWN" && row.reason_code === "META_SIGNUP_REGISTRATION_UNKNOWN" && row.connection_id) {
        // The existing explicit Start action may read back registration and complete
        // without repeating POST /register. Preserve the failed original operation.
        const recovered = (await client.query<{ id: string; result: Record<string, unknown> }>(`SELECT operation.id,operation.result
          FROM connection_operations operation JOIN connections connection ON connection.tenant_id=operation.tenant_id AND connection.id=operation.connection_id
          JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
          WHERE operation.tenant_id=$1 AND operation.connection_id=$2 AND operation.state='SUCCEEDED' AND operation.operation_type IN ('START','RESTART')
            AND operation.result->>'metaSignupReady'='true' AND connection.state='WORKING' AND session.ownership_state='ACTIVE'
            AND session.provider_state_data->'metaSignup'->>'attemptId'=$3
            AND session.provider_state_data->'metaAccountProof'->>'operationId'=operation.id::text
            AND session.provider_state_data->'metaAccountProof'->>'credentialFingerprint'=$4
            AND operation.result->'metaAccountProof'->>'credentialFingerprint'=$4
            AND session.opaque_session_id=$5 AND session.provider_state_data->>'wabaId'=$6
            AND connection.secret_reference=$7 ORDER BY operation.updated_at DESC LIMIT 1`,
          [row.tenant_id,row.connection_id,row.id,row.credential_fingerprint,row.selected_choice?.phoneId,row.selected_choice?.wabaId,
            `secret://${row.tenant_id}/connections/${row.connection_id}/meta`])).rows[0];
        if (recovered && ["AVAILABLE","LIMITED"].includes(String(recovered.result.metaSignupMessaging))) {
          await client.query("UPDATE meta_signup_attempts SET status='COMPLETED',reason_code=NULL,readiness=$3,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
            [row.tenant_id,id,{...row.readiness,number:"REGISTERED",subscription:"CONFIRMED",messaging:recovered.result.metaSignupMessaging}]);
          await this.audit(client,request,id,"meta_signup.registration_reconciled",{originalOperationId:row.operation_id,recoveryOperationId:recovered.id});
          row = await this.row(client,request,id);
        }
      }
      if (row.status === "PROVISIONING" && row.operation_id) {
        const stage = (await client.query<{ state: string }>("SELECT state FROM connection_operations WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.operation_id])).rows[0];
        if (["RECONNECT", "ADD_ACCESS", "TRANSITION_READBACK", "LEGACY_MIGRATION"].includes(row.purpose) && stage?.state === "STAGED") {
          try { await this.targetCurrent(client, row); }
          catch (error) {
            if (!(error instanceof ConflictException || error instanceof NotFoundException)) throw error;
            return { ...view(row), status: "ACTION_REQUIRED", nextAction: "REVIEW_OUTCOME", reasonCode: row.purpose === "ADD_ACCESS" ? "META_SIGNUP_ADD_ACCESS_STAGE_CHANGED" : "META_SIGNUP_RECONNECT_TARGET_CHANGED",
              canCancel: row.purpose === "RECONNECT" || row.purpose === "TRANSITION_READBACK" || row.purpose === "LEGACY_MIGRATION", choices: view(row).choices.map(choice => ({ ...choice, selectable: false })) };
          }
        }
        if (stage?.state === "STAGED") return { ...view(row), canCancel: row.purpose !== "NEW_NUMBER", status: "SELECTION_REQUIRED" as const, nextAction: "SELECT_NUMBER" as const, reasonCode: "META_SIGNUP_CREDENTIAL_UNAVAILABLE" as const,
          choices: view(row).choices.map(choice => ({ ...choice, selectable: choice.choiceId === row.selected_choice?.choiceId })) };
      }
      return view(row);
    });
  }

  async exchange(request: AuthenticatedRequest, id: string, body: MetaSignupExchangeRequest) {
    const exchangeDeadline = Date.now() + 20_000;
    only(body, ["challenge", "code", "expectedRevision"]); revision(body.expectedRevision); this.origin(request);
    if (typeof body.challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(body.challenge)
      // eslint-disable-next-line no-control-regex -- Preserve the exact ASCII control/space exclusion for one-use authorization codes.
      || typeof body.code !== "string" || body.code.length < 1 || body.code.length > 4096 || /[\x00-\x20\x7f]/u.test(body.code)) throw invalid();
    await this.authorize(request);
    // Essential secret is resolved before consuming the code. Optional readiness work occurred before SDK invocation.
    const config = configured();
    const appSecret = await this.webhookSecrets.resolveHmac(config.secretReference, { kind: "exact", expectedReference: config.secretReference });
    const attempt = await this.database.withTenant(request.principal.tenantId, async client => {
      await this.authorize(request, client);
      const row = await this.row(client, request, id, true); this.current(row, request, body.expectedRevision);
      await this.targetCurrent(client, row);
      if (row.status !== "AWAITING_AUTHORIZATION" || !timingSafeEqual(Buffer.from(hash(body.challenge)), Buffer.from(row.challenge_sha256))) throw conflict("META_SIGNUP_CONSUMED");
      const claimed = (await client.query<Attempt>(`UPDATE meta_signup_attempts SET status='EXCHANGING',code_sha256=$3,
        exchange_claimed_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [row.tenant_id, row.id, hash(body.code)])).rows[0]!;
      await this.audit(client, request, row.id, "meta_signup.exchange_claimed"); return claimed;
    }).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") throw conflict("META_SIGNUP_CONSUMED");
      throw error;
    });
    if (Date.now() >= exchangeDeadline) {
      await this.result(request, attempt, "FAILED", "META_SIGNUP_EXPIRED");
      return this.get(request, id);
    }
    let token: string;
    try { token = await new MetaSignupClient(attempt.config).exchange(body.code, appSecret); }
    catch (error) {
      const known = error instanceof MetaGraphClientError && error.outcomeKnown;
      await this.result(request, attempt, known ? "FAILED" : "OUTCOME_UNKNOWN", known ? "META_SIGNUP_EXCHANGE_REJECTED" : "META_SIGNUP_EXCHANGE_UNKNOWN");
      return this.get(request, id);
    }
    try {
      await this.database.withTenant(attempt.tenant_id, async client => {
        const saved = await client.query("UPDATE meta_signup_attempts SET credential_fingerprint=$3 WHERE tenant_id=$1 AND id=$2 AND status='EXCHANGING' AND revision=$4 AND credential_fingerprint IS NULL",
          [attempt.tenant_id, id, hash(token), attempt.revision]);
        if (saved.rowCount !== 1) throw conflict();
      });
      await this.secrets.storeMetaCredential(attempt.secret_reference, { accessToken: token });
      await this.database.withTenant(attempt.tenant_id, async client => {
        await this.authorize(request, client);
        const written = await client.query(`UPDATE meta_signup_attempts SET credential_fingerprint=$3,credential_stored_at=clock_timestamp(),
          status='ACTION_REQUIRED',reason_code='META_SIGNUP_DISCOVERY_UNAVAILABLE',revision=revision+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2 AND status='EXCHANGING' AND revision=$4`, [attempt.tenant_id, id, hash(token), attempt.revision]);
        if (written.rowCount !== 1) throw conflict();
      });
    } catch {
      await this.result(request, attempt, "OUTCOME_UNKNOWN", "META_SIGNUP_CREDENTIAL_UNAVAILABLE");
      return this.get(request, id);
    }
    return this.discover(request, id, { expectedRevision: attempt.revision + 1 });
  }

  async discover(request: AuthenticatedRequest, id: string, body: { expectedRevision: number }) {
    only(body, ["expectedRevision"]); revision(body.expectedRevision); this.origin(request); await this.authorize(request);
    let attempt = await this.database.withTenant(request.principal.tenantId, async client => {
      const row = await this.row(client, request, id);
      if (row.revision !== body.expectedRevision || !sameConfig(row.config, configured(row.config.variant)) || row.config.origin !== this.origin(request)) throw conflict();
      if (row.status === "OUTCOME_UNKNOWN" && row.reason_code === "META_SIGNUP_CREDENTIAL_UNAVAILABLE" && row.credential_fingerprint && !row.connection_id) return row;
      this.current(row, request, body.expectedRevision);
      await this.targetCurrent(client, row);
      if (!row.credential_stored_at || !["SELECTION_REQUIRED", "NUMBER_REQUIRED", "ACTION_REQUIRED"].includes(row.status) || row.connection_id) throw conflict();
      return row;
    });
    if (attempt.status === "OUTCOME_UNKNOWN") {
      // Reconcile only the exact attempt-owned staged value, never re-exchange the code or rewrite its secret.
      try { await this.token(attempt); } catch { return this.get(request, id); }
      attempt = await this.database.withTenant(attempt.tenant_id, async client => {
        await this.authorize(request, client);
        const row = await this.row(client, request, id, true);
        if (row.revision !== attempt.revision || row.status !== "OUTCOME_UNKNOWN" || row.credential_fingerprint !== attempt.credential_fingerprint) throw conflict();
        return (await client.query<Attempt>(`UPDATE meta_signup_attempts SET status=CASE WHEN expires_at>clock_timestamp() THEN 'ACTION_REQUIRED' ELSE 'EXPIRED' END,
          credential_stored_at=clock_timestamp(),reason_code='META_SIGNUP_DISCOVERY_UNAVAILABLE',revision=revision+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`, [row.tenant_id, id])).rows[0]!;
      });
      if (attempt.status === "EXPIRED") return this.get(request, id);
    }
    try {
      const token = await this.token(attempt);
      const secret = await this.webhookSecrets.resolveHmac(attempt.config.secretReference, { kind: "exact", expectedReference: attempt.config.secretReference });
      const discovered = await new MetaSignupClient(attempt.config, token, () => this.guard(request, attempt)).discover(secret);
      const choices = await this.available(attempt, discovered.choices);
      await this.database.withTenant(attempt.tenant_id, async client => {
        await this.authorize(request, client);
        const row = await this.row(client, request, id, true); this.current(row, request, attempt.revision);
        await this.targetCurrent(client, row);
        await client.query(`UPDATE meta_signup_attempts SET choices=$3,credential_metadata=$4,status=$5,reason_code=$6,
          readiness=$7,selection_revision=selection_revision+1,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
        [attempt.tenant_id, id, JSON.stringify(choices), discovered.metadata, choices.length ? "SELECTION_REQUIRED" : "NUMBER_REQUIRED",
          choices.length ? null : "META_SIGNUP_NO_PHONE", row.purpose === "RECONNECT" ? reconnectReadiness() : { ...initialReadiness(), authorization: "VERIFIED", payment: { requestedPayer: "CUSTOMER", status: "MANAGED_IN_META", paymentMethodVerified: false } }]);
      });
    } catch (error) {
      if (error instanceof ConflictException || error instanceof ForbiddenException || error instanceof NotFoundException) throw error;
      await this.result(request, attempt, "ACTION_REQUIRED", error instanceof MetaGraphClientError && error.providerStatus === 403 ? "META_SIGNUP_PERMISSION_REQUIRED" : "META_SIGNUP_DISCOVERY_UNAVAILABLE");
    }
    return this.get(request, id);
  }

  async prepareSelection(request: AuthenticatedRequest, id: string, body: MetaSignupSelectRequest): Promise<SignupSelection> {
    only(body, ["expectedRevision", "selectionRevision", "choiceId", "registrationPin"]); revision(body.expectedRevision); revision(body.selectionRevision);
    this.origin(request); await this.authorize(request);
    if (typeof body.choiceId !== "string" || !uuid(body.choiceId) || (body.registrationPin !== undefined && (typeof body.registrationPin !== "string" || !/^\d{6}$/u.test(body.registrationPin)))) throw invalid();
    const attempt = await this.database.withTenant(request.principal.tenantId, async client => {
      const row = await this.row(client, request, id); this.current(row, request, body.expectedRevision);
      if (row.purpose !== "NEW_NUMBER" && Object.hasOwn(body, "registrationPin")) throw invalid();
      await this.targetCurrent(client, row);
      if (row.selection_revision !== body.selectionRevision) throw conflict();
      if (row.connection_id) {
        const operation = (await client.query<{ state: string }>("SELECT state FROM connection_operations WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.operation_id])).rows[0];
        if (row.status !== "PROVISIONING" || operation?.state !== "STAGED" || row.selected_choice?.choiceId !== body.choiceId) throw conflict();
      } else if (row.status !== "SELECTION_REQUIRED") throw conflict();
      return row;
    });
    const selected = attempt.choices.find(choice => choice.choiceId === body.choiceId);
    if (!selected?.selectable) throw conflict();
    if (attempt.config.variant === "BUSINESS_APP" && Object.hasOwn(body, "registrationPin")) throw invalid();
    const accessToken = await this.token(attempt);
    const secret = await this.webhookSecrets.resolveHmac(attempt.config.secretReference, { kind: "exact", expectedReference: attempt.config.secretReference });
    const discovered = await new MetaSignupClient(attempt.config, accessToken, () => this.guard(request, attempt)).discover(secret);
    const choices = await this.available(attempt, discovered.choices);
    const choice = choices.find(item => item.businessId === selected.businessId && item.wabaId === selected.wabaId && item.phoneId === selected.phoneId);
    if (!choice?.selectable) throw conflict("META_SIGNUP_PHONE_UNVERIFIED");
    if (attempt.purpose !== "NEW_NUMBER" && attempt.purpose !== "LEGACY_MIGRATION") return { attempt, choice: { ...choice, choiceId: selected.choiceId }, accessToken, credentialMetadata: discovered.metadata };
    if (attempt.config.variant === "BUSINESS_APP") {
      if (choice.mode !== "COEXISTENCE" || choice.numberState !== "REGISTERED" || !attempt.coexistence_consent) throw conflict();
      return { attempt, choice: { ...choice, choiceId: selected.choiceId }, accessToken, credentialMetadata: discovered.metadata };
    }
    // Stable secret-derived default: an uncertain exact-key stage must never receive a rerolled PIN.
    let registrationPin = body.registrationPin ?? String(Number.parseInt(createHmac("sha256", secret).update(`meta-signup-pin:${attempt.tenant_id}:${attempt.id}:${attempt.config.configId}`).digest("hex").slice(0, 8), 16) % 1_000_000).padStart(6, "0");
    if (attempt.connection_id) {
      let staged: { accessToken: string; registrationPin?: string } | undefined;
      const reference = attempt.purpose === "LEGACY_MIGRATION"
        ? metaCredentialRotationReference(attempt.tenant_id,attempt.connection_id,`meta-legacy-authorization-${attempt.id}`)
        : `secret://${attempt.tenant_id}/connections/${attempt.connection_id}/meta`;
      try { staged = await this.credentials.resolveSignupConnection(reference, { tenantId: attempt.tenant_id, connectionId: attempt.connection_id }); }
      catch { /* A retry is admitted only when its original immutable PIN fingerprint matches below. */ }
      if (staged) {
        if (hash(staged.accessToken) !== attempt.credential_fingerprint || !staged.registrationPin || pinFingerprint(attempt, staged.registrationPin, accessToken) !== attempt.registration_pin_fingerprint
          || (body.registrationPin !== undefined && body.registrationPin !== staged.registrationPin)) throw conflict("META_SIGNUP_CREDENTIAL_UNAVAILABLE");
        registrationPin = staged.registrationPin;
      }
      if (pinFingerprint(attempt, registrationPin, accessToken) !== attempt.registration_pin_fingerprint) throw conflict("META_SIGNUP_CREDENTIAL_UNAVAILABLE");
    }
    return { attempt, choice: { ...choice, choiceId: selected.choiceId }, accessToken, registrationPin, credentialMetadata: discovered.metadata };
  }

  /** Called from the existing connection provision transaction, never from another HTTP controller. */
  async bindProvision(client: PoolClient, request: AuthenticatedRequest, selection: SignupSelection, connectionId: string, operationId: string) {
    await this.authorize(request, client);
    const row = await this.row(client, request, selection.attempt.id, true); this.current(row, request, selection.attempt.revision);
    if (!["NEW_NUMBER", "ADD_ACCESS"].includes(row.purpose) || (row.purpose === "NEW_NUMBER" && row.config.variant !== "BUSINESS_APP" ? !selection.registrationPin : selection.registrationPin !== undefined)
      || row.purpose !== selection.attempt.purpose || row.status !== "SELECTION_REQUIRED" || row.connection_id || row.credential_fingerprint !== hash(selection.accessToken)
      || !metaSignupChoiceAdmission(selection.choice, undefined, row.purpose, row.config.variant).selectable) throw conflict();
    const bound = (await client.query<Attempt>(`UPDATE meta_signup_attempts SET connection_id=$3,operation_id=$4,selected_choice=$5,status='PROVISIONING',
      readiness=$6,registration_pin_fingerprint=$7,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [row.tenant_id, row.id, connectionId, operationId, { choiceId: selection.choice.choiceId, businessId: selection.choice.businessId, wabaId: selection.choice.wabaId, phoneId: selection.choice.phoneId, mode: selection.choice.mode, numberState: selection.choice.numberState, proofSha256: selection.choice.proofSha256,
      ...(selection.choice.lastOnboardedTime !== undefined ? { lastOnboardedTime: selection.choice.lastOnboardedTime } : {}) }, { ...row.readiness, number: selection.choice.numberState }, selection.registrationPin ? pinFingerprint(row, selection.registrationPin, selection.accessToken) : null])).rows[0]!;
    selection.attempt = bound;
    await this.audit(client, request, row.id, "meta_signup.selection_bound", { connectionId, operationId });
  }

  async cancel(request: AuthenticatedRequest, id: string, body: { expectedRevision: number }) {
    only(body, ["expectedRevision"]); revision(body.expectedRevision); this.origin(request);
    await this.database.withTenant(request.principal.tenantId, async client => {
      await this.authorize(request, client); const row = await this.row(client, request, id, true);
      if (row.revision !== body.expectedRevision) throw conflict();
      if ((row.purpose === "TRANSITION_READBACK" || row.purpose === "LEGACY_MIGRATION") && row.connection_id) {
        const legacy = row.purpose === "LEGACY_MIGRATION";
        const reference = metaCredentialRotationReference(row.tenant_id, row.connection_id, `${legacy ? "meta-legacy-authorization" : "meta-transition-readback"}-${row.id}`);
        let stored;
        try { stored = await this.credentials.inspectSignupConnection(reference, { tenantId: row.tenant_id, connectionId: row.connection_id }); }
        catch { throw new ServiceUnavailableException("Read the original credential stage before cancelling."); }
        if (stored && (legacy ? !stored.registrationPin || pinFingerprint(row,stored.registrationPin,stored.accessToken) !== row.registration_pin_fingerprint
          : stored.registrationPin !== undefined)) throw conflict("META_SIGNUP_CREDENTIAL_UNAVAILABLE");
        const cancelled = (await client.query<{ cancelled: boolean }>(legacy ? "SELECT app.cancel_meta_legacy_authorization($1,$2,$3,$4) AS cancelled" : "SELECT app.cancel_meta_transition_observer($1,$2,$3,$4) AS cancelled",
          [row.id, request.principal.userId, row.revision, stored ? hash(stored.accessToken) : null])).rows[0]?.cancelled;
        if (!cancelled) throw conflict("META_SIGNUP_CREDENTIAL_UNAVAILABLE");
        await this.audit(client, request, row.id, "meta_signup.cancelled"); return;
      }
      if (row.purpose !== "NEW_NUMBER" && row.connection_id && row.operation_id && row.status === "PROVISIONING") {
        const operation = (await client.query<{ id: string; state: string; idempotency_key: string; payload: Record<string, unknown> }>(
          "SELECT id,state,idempotency_key,payload FROM connection_operations WHERE tenant_id=$1 AND id=$2 AND connection_id=$3 FOR UPDATE", [row.tenant_id, row.operation_id, row.connection_id])).rows[0];
        if (!operation || operation.state !== "STAGED" || operation.payload.metaSignupAttemptId !== row.id || operation.payload.metaSignupPurpose !== row.purpose) throw conflict();
        const reference = row.purpose === "RECONNECT" ? metaCredentialRotationReference(row.tenant_id, row.connection_id, operation.idempotency_key)
          : `secret://${row.tenant_id}/connections/${row.connection_id}/meta`;
        if (reference !== (row.purpose === "RECONNECT" ? operation.payload.newSecretReference : operation.payload.credentialReference)) throw conflict();
        const connection = (await client.query<{ secret_reference: string }>("SELECT secret_reference FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [row.tenant_id, row.connection_id])).rows[0];
        if (!connection || (row.purpose === "RECONNECT" ? connection.secret_reference === reference : connection.secret_reference !== reference)) throw conflict();
        if (row.purpose === "ADD_ACCESS") await this.targetCurrent(client, row);
        let staged;
        try { staged = await this.credentials.inspectSignupConnection(reference, { tenantId: row.tenant_id, connectionId: row.connection_id }); }
        catch { throw new ServiceUnavailableException("The credential stage needs a confirmed read before cancellation."); }
        if (hasCoexistenceTarget(row.target_binding) && row.connection_credential_write_claimed_at && !staged) throw new ServiceUnavailableException("The credential write outcome is unknown. A confirmed matching stage is required.");
        if (staged && (staged.registrationPin !== undefined || hash(staged.accessToken) !== row.credential_fingerprint)) throw conflict("META_SIGNUP_CREDENTIAL_UNAVAILABLE");
        // Absence after a committed write claim cannot disprove an in-flight write.
        if (row.purpose === "ADD_ACCESS" && row.connection_credential_write_claimed_at && !staged) throw conflict("META_SIGNUP_CREDENTIAL_UNAVAILABLE");
        await client.query(`UPDATE connection_operations SET state='CANCELLED',error_code='META_SIGNUP_CANCELLED',
          result=jsonb_build_object('stageReconciled',true,'promoted',false),completed_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2 AND state='STAGED'`, [row.tenant_id, operation.id]);
        if (row.purpose === "ADD_ACCESS") {
          await client.query("UPDATE connections SET state='REVOKED',action_reason='Account access setup cancelled.',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND state='PROVISIONING'", [row.tenant_id, row.connection_id]);
          await client.query("UPDATE provider_sessions SET state='REVOKED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE'", [row.tenant_id, row.connection_id]);
          await client.query("UPDATE webhook_routes SET state='REVOKED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND connection_id=$2 AND state='PAUSED'", [row.tenant_id, row.connection_id]);
        }
      } else if (!view(row).canCancel) throw conflict();
      await client.query(`UPDATE meta_signup_attempts SET status='CANCELLED',reason_code='META_SIGNUP_CANCELLED',choices='[]',revision=revision+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2`, [row.tenant_id, id]); await this.audit(client, request, id, "meta_signup.cancelled");
    }); return this.get(request, id);
  }

  async guardPromotion(client: PoolClient, request: AuthenticatedRequest, selection: SignupSelection, operation: { id: string; connection_id: string; payload: Record<string, unknown> }) {
    await this.authorize(request, client);
    const row = await this.row(client, request, selection.attempt.id, true);
    this.current(row, request, selection.attempt.revision);
    if (!["NEW_NUMBER", "ADD_ACCESS"].includes(row.purpose) || row.purpose !== selection.attempt.purpose || row.status !== "PROVISIONING" || row.connection_id !== operation.connection_id || row.operation_id !== operation.id
      || operation.payload.metaSignupAttemptId !== row.id || (operation.payload.metaSignupPurpose ?? "NEW_NUMBER") !== row.purpose || row.selected_choice?.choiceId !== selection.choice.choiceId
      || row.credential_fingerprint !== hash(selection.accessToken)
      || (row.purpose === "NEW_NUMBER" && row.config.variant !== "BUSINESS_APP" ? !selection.registrationPin || row.registration_pin_fingerprint !== pinFingerprint(row, selection.registrationPin, selection.accessToken)
        : selection.registrationPin !== undefined || row.registration_pin_fingerprint != null)) throw conflict();
    await this.targetCurrent(client, row);
  }

  async guardSelection(request: AuthenticatedRequest, selection: SignupSelection) { return this.guard(request, selection.attempt); }

  async sessionLog(request: AuthenticatedRequest, id: string, body: MetaSignupSessionLogRequest) {
    only(body, ["challenge", "event", "sessionInfoVersion", "sourceOrigin", "traceSha256"]);
    if (typeof body.challenge !== "string" || body.challenge.length > 100 || body.sessionInfoVersion !== "3"
      || !["https://www.facebook.com", "https://web.facebook.com"].includes(body.sourceOrigin)
      || !["FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "CANCEL", "ERROR"].includes(body.event)
      || typeof body.traceSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(body.traceSha256)) throw invalid();
    this.origin(request);
    await this.database.withTenant(request.principal.tenantId, async client => {
      await this.authorize(request, client);
      const row = await this.row(client, request, id, true);
      this.current(row, request, row.revision);
      if (row.config.variant !== "BUSINESS_APP" || !["AWAITING_AUTHORIZATION", "EXCHANGING"].includes(row.status)
        || !timingSafeEqual(Buffer.from(row.challenge_sha256, "hex"), Buffer.from(hash(body.challenge), "hex"))) throw conflict();
      // Diagnostic only: deliberately no status, selection, consent or clock transition.
      await client.query(`UPDATE meta_signup_attempts SET session_log=CASE WHEN jsonb_array_length(session_log)<20
        THEN session_log||$3::jsonb ELSE session_log END WHERE tenant_id=$1 AND id=$2`,
      [row.tenant_id, row.id, JSON.stringify([{ event: body.event, sourceOrigin: body.sourceOrigin, traceSha256: body.traceSha256 }])]);
    });
    return { recorded: true };
  }

  async bindRotation(client: PoolClient, request: AuthenticatedRequest, selection: SignupSelection, operation: { id: string; connection_id: string }) {
    await this.authorize(request, client);
    const row = await this.row(client, request, selection.attempt.id, true); this.current(row, request, selection.attempt.revision);
    if (row.purpose !== "RECONNECT" || row.status !== "SELECTION_REQUIRED" || row.connection_id || row.target_connection_id !== operation.connection_id
      || row.credential_fingerprint !== hash(selection.accessToken) || selection.registrationPin !== undefined) throw conflict();
    await this.targetCurrent(client, row, operation.id);
    const admission = metaSignupChoiceAdmission(selection.choice, row.target_binding, row.purpose, row.config.variant);
    if (!admission.selectable) throw reconnectConflict();
    selection.attempt = (await client.query<Attempt>(`UPDATE meta_signup_attempts SET connection_id=$3,operation_id=$4,selected_choice=$5,
      status='PROVISIONING',readiness=$6,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [row.tenant_id, row.id, operation.connection_id, operation.id, { choiceId: selection.choice.choiceId, businessId: selection.choice.businessId, wabaId: selection.choice.wabaId,
        phoneId: selection.choice.phoneId, mode: selection.choice.mode, numberState: selection.choice.numberState, proofSha256: selection.choice.proofSha256 }, reconnectReadiness()])).rows[0]!;
    await this.audit(client, request, row.id, "meta_signup.reconnect_bound", { connectionId: operation.connection_id, operationId: operation.id });
  }

  async guardRotation(client: PoolClient, request: AuthenticatedRequest, selection: SignupSelection, operation: { id: string; connection_id: string; state: string; payload: Record<string, unknown> }) {
    await this.authorize(request, client);
    const row = await this.row(client, request, selection.attempt.id, true); this.current(row, request, selection.attempt.revision);
    if (row.purpose !== "RECONNECT" || row.connection_id !== operation.connection_id || row.operation_id !== operation.id
      || operation.payload.metaSignupAttemptId !== row.id || operation.payload.metaSignupPurpose !== row.purpose
      || row.selected_choice?.choiceId !== selection.choice.choiceId || row.credential_fingerprint !== hash(selection.accessToken)
      || selection.registrationPin !== undefined || !["PROVISIONING", "COMPLETED"].includes(row.status)) throw conflict();
    // A historical result does not depend on this token remaining current after a later rotation.
    if (operation.state !== "SUCCEEDED") await this.targetCurrent(client, row);
  }

  async completeRotation(client: PoolClient, selection: SignupSelection) {
    if (hasCoexistenceTarget(selection.attempt.target_binding)) {
      await client.query("SELECT app.rebind_meta_coexistence_credential($1,$2)", [selection.attempt.id, selection.attempt.operation_id]);
    }
    const updated = (await client.query<Attempt>(`UPDATE meta_signup_attempts SET status='COMPLETED',reason_code=NULL,readiness=$3,
      revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='PROVISIONING' AND operation_id=$4 RETURNING *`,
      [selection.attempt.tenant_id, selection.attempt.id, reconnectReadiness(), selection.attempt.operation_id])).rows[0];
    if (!updated) throw conflict();
    selection.attempt = updated;
  }

  /** Shared sidecar-write claim; composed with ADD_ACCESS's existing guarded caller. */
  async claimConnectionCredentialWrite(client: PoolClient, selection: SignupSelection) {
    const row = (await client.query<Attempt>(`UPDATE meta_signup_attempts attempt
      SET connection_credential_write_claimed_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND id=$2 AND status='PROVISIONING' AND revision=$3
        AND connection_credential_write_claimed_at IS NULL AND (purpose='ADD_ACCESS' OR (purpose='RECONNECT'
        AND target_connection_id=connection_id AND selected_choice->>'mode'='COEXISTENCE'
        AND app.meta_coexistence_privacy_snapshot()=attempt.target_binding->'coexistence'->>'privacySnapshotSha256'
        AND EXISTS(SELECT 1 FROM meta_coexistence_contexts capture WHERE capture.tenant_id=attempt.tenant_id
          AND capture.connection_id=attempt.connection_id AND capture.id::text=attempt.target_binding->'coexistence'->>'contextId'
          AND capture.provider_session_id::text=attempt.target_binding->>'providerSessionId'
          AND capture.credential_fingerprint=attempt.target_binding->'coexistence'->>'credentialFingerprint'
          AND encode(sha256(convert_to(to_jsonb(capture)::text,'UTF8')),'hex')=attempt.target_binding->'coexistence'->>'snapshotSha256')))
      RETURNING attempt.*`, [selection.attempt.tenant_id, selection.attempt.id, selection.attempt.revision])).rows[0];
    if (!row) throw conflict("META_SIGNUP_CREDENTIAL_UNAVAILABLE");
    selection.attempt = row;
  }

  async completeAddAccess(client: PoolClient, request: AuthenticatedRequest, selection: SignupSelection) {
    const updated = (await client.query<Attempt>(`UPDATE meta_signup_attempts SET status='COMPLETED',reason_code=NULL,readiness=$3,
      revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND purpose='ADD_ACCESS'
      AND status='PROVISIONING' AND operation_id=$4 AND revision=$5 RETURNING *`,
      [selection.attempt.tenant_id, selection.attempt.id, addAccessReadiness(), selection.attempt.operation_id, selection.attempt.revision])).rows[0];
    if (!updated) throw conflict();
    selection.attempt = updated;
    await this.audit(client, request, updated.id, "meta_signup.access_added_paused", { connectionId: updated.connection_id, operationId: updated.operation_id });
  }

  private async targetCurrent(client: PoolClient, row: Attempt, ownOperationId = row.operation_id) {
    if (row.purpose === "TRANSITION_READBACK" || row.purpose === "LEGACY_MIGRATION") {
      if (!row.target_transition_id || !row.target_connection_id || !row.target_binding) throw conflict();
      const current = await this.observerTarget(client, row.target_transition_id, row.target_connection_id, row.requested_by, row.purpose === "LEGACY_MIGRATION");
      if (current.contextSha256 !== row.target_binding.contextSha256) throw conflict("META_SIGNUP_RECONNECT_TARGET_CHANGED");
      return;
    }
    if (row.purpose === "ADD_ACCESS" && row.connection_id) {
      const current = await client.query(`SELECT 1 FROM connections connection
        JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
        JOIN webhook_routes route ON route.tenant_id=connection.tenant_id AND route.connection_id=connection.id
        JOIN connection_operations operation ON operation.tenant_id=connection.tenant_id AND operation.connection_id=connection.id
        WHERE connection.tenant_id=$1 AND connection.id=$2 AND connection.provider='META' AND connection.state='PROVISIONING'
          AND connection.secret_reference=$3 AND session.ownership_state='ACTIVE' AND session.state='PROVISIONING'
          AND session.opaque_session_id=$4 AND session.provider_state_data->>'wabaId'=$5
          AND session.provider_state_data->'metaSignup'->>'attemptId'=$6 AND session.provider_state_data->'metaSignup'->>'purpose'='ADD_ACCESS'
          AND session.worker_id IS NULL AND route.provider='META' AND route.external_key=$4 AND route.state='PAUSED'
          AND operation.id=$7 AND operation.operation_type='PROVISION' AND operation.state='STAGED'
          AND operation.payload->>'metaSignupAttemptId'=$6 AND operation.payload->>'metaSignupPurpose'='ADD_ACCESS'
          AND NOT EXISTS (SELECT 1 FROM connection_operations other WHERE other.tenant_id=$1 AND other.connection_id=$2
            AND other.id<>$7 AND other.state IN ('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE'))`,
        [row.tenant_id, row.connection_id, `secret://${row.tenant_id}/connections/${row.connection_id}/meta`,
          row.selected_choice?.phoneId, row.selected_choice?.wabaId, row.id, row.operation_id]);
      if (current.rowCount !== 1) throw conflict("META_SIGNUP_ADD_ACCESS_STAGE_CHANGED");
    }
    if (row.purpose !== "RECONNECT") return;
    if (!row.target_connection_id || !row.target_binding) throw reconnectConflict();
    assertMetaReconnectTarget(row.target_binding as MetaReconnectTarget, await loadMetaReconnectTarget(client, row.tenant_id, row.target_connection_id, ownOperationId));
  }

  private async observerTarget(client: PoolClient, transitionId: string, connectionId: string, actorId: string, legacy = false): Promise<ObserverTarget> {
    const value = (await client.query<{ value: ObserverTarget }>(legacy ? "SELECT app.meta_legacy_authorization_target($1,$2,$3) AS value" : "SELECT app.meta_transition_observer_target($1,$2,$3) AS value", [transitionId, connectionId, actorId])).rows[0]?.value;
    if (!value) throw conflict("META_SIGNUP_RECONNECT_TARGET_CHANGED"); return value;
  }

  /** Exact one-use credential stage, with no ordinary rotation or worker enqueue. */
  async selectTransitionObserver(request: AuthenticatedRequest, selection: SignupSelection) {
    const legacy = selection.attempt.purpose === "LEGACY_MIGRATION";
    if ((!legacy && selection.attempt.purpose !== "TRANSITION_READBACK") || !selection.credentialMetadata
      || (legacy ? !selection.registrationPin : selection.registrationPin !== undefined)) throw invalid();
    const staged = await this.database.withTenant(request.principal.tenantId, async client => {
      await this.authorize(request, client);
      const row = await this.row(client, request, selection.attempt.id); this.current(row, request, selection.attempt.revision);
      const value = (await client.query<{ value: { operation: { id: string; payload: { newSecretReference: string } }; attemptRevision: number; claimed: boolean } }>(
        legacy ? "SELECT app.stage_meta_legacy_authorization($1,$2,$3,$4,$5,$6,$7,$8) AS value" : "SELECT app.stage_meta_transition_observer($1,$2,$3,$4,$5,$6,$7) AS value",
        [row.id, request.principal.userId, row.revision, selection.choice.choiceId, selection.choice, selection.credentialMetadata,
          ...(legacy ? [pinFingerprint(row,selection.registrationPin!,selection.accessToken)] : []), String(request.id)])).rows[0]?.value;
      if (!value) throw conflict(); return value;
    });
    let currentRevision = staged.attemptRevision;
    const reference = staged.operation.payload.newSecretReference;
    if (!staged.claimed) {
      currentRevision = await this.database.withTenant(request.principal.tenantId, async client => {
        await this.authorize(request, client);
        const value = (await client.query<{ revision: number }>(legacy ? "SELECT app.claim_meta_legacy_authorization_write($1,$2,$3) AS revision" : "SELECT app.claim_meta_transition_observer_write($1,$2,$3) AS revision",
          [selection.attempt.id, request.principal.userId, currentRevision])).rows[0]?.revision;
        if (!value) throw conflict(); return value;
      });
      // A lost PUT response never permits another PUT, including on selection resume.
      try { await this.secrets.storeMetaCredential(reference, { accessToken: selection.accessToken, ...(legacy ? {registrationPin:selection.registrationPin} : {}) }); }
      catch { throw new ServiceUnavailableException("Read the original authorization stage before continuing."); }
    }
    const stored = await this.credentials.inspectSignupConnection(reference, { tenantId: request.principal.tenantId, connectionId: selection.attempt.target_connection_id! });
    if (!stored || (legacy ? stored.registrationPin !== selection.registrationPin : stored.registrationPin !== undefined)
      || hash(stored.accessToken) !== selection.attempt.credential_fingerprint) throw conflict("META_SIGNUP_CREDENTIAL_UNAVAILABLE");
    const target = selection.attempt.target_binding!;
    const proof = { schemaVersion: 1, claim: "PHONE_ACCOUNT_RELATION_VERIFIED", tenantId: request.principal.tenantId,
      connectionId: selection.attempt.target_connection_id, providerSessionId: target.providerSessionId,
      phoneNumberId: selection.choice.phoneId, wabaId: selection.choice.wabaId, graphVersion: selection.attempt.config.graphVersion,
      secretReference: reference, credentialFingerprint: hash(stored.accessToken), operationId: staged.operation.id, fencingToken: 0,
      credentialMetadata: selection.credentialMetadata, responseSha256: selection.choice.proofSha256, verifiedAt: new Date().toISOString() };
    await this.database.withTenant(request.principal.tenantId, async client => {
      await this.authorize(request, client);
      const completed = (await client.query<{ completed: boolean }>(legacy ? "SELECT app.complete_meta_legacy_authorization($1,$2,$3,$4,$5) AS completed" : "SELECT app.complete_meta_transition_observer($1,$2,$3,$4) AS completed",
        [selection.attempt.id, request.principal.userId, currentRevision, proof,
          ...(legacy ? [pinFingerprint(selection.attempt,stored.registrationPin!,stored.accessToken)] : [])])).rows[0]?.completed;
      if (!completed) throw conflict();
      await this.audit(client, request, selection.attempt.id, "meta_signup.transition_readback_renewed", { operationId: staged.operation.id });
    });
  }

  private async token(row: Attempt) {
    const token = await this.credentials.resolveSignupToken(row.secret_reference, { tenantId: row.tenant_id, attemptId: row.id });
    if (hash(token) !== row.credential_fingerprint) throw conflict("META_SIGNUP_CREDENTIAL_UNAVAILABLE"); return token;
  }
  private async available(attempt: Attempt, choices: VerifiedSignupChoice[]) {
    for (const choice of choices) {
      const admission = metaSignupChoiceAdmission(choice, attempt.target_binding, attempt.purpose, attempt.config.variant);
      choice.selectable = admission.selectable; choice.reasonCode = admission.reasonCode;
      if (["RECONNECT", "TRANSITION_READBACK", "LEGACY_MIGRATION"].includes(attempt.purpose)) continue; // Exact owned route is checked by targetCurrent at every boundary.
      if (attempt.connection_id && choice.phoneId === attempt.selected_choice?.phoneId && choice.wabaId === attempt.selected_choice?.wabaId) continue;
      const row = (await this.database.rows<{ available: boolean }>(attempt.tenant_id, "SELECT app.meta_signup_phone_available($1) AS available", [choice.phoneId]))[0];
      if (row?.available !== true) {
        choice.selectable = false; choice.reasonCode = "META_SIGNUP_ASSET_CONFLICT";
        if (attempt.purpose === "ADD_ACCESS") {
          const existing = await this.database.rows<{ connection_id: string; name: string }>(attempt.tenant_id, `SELECT connection.id AS connection_id,connection.name
            FROM connections connection JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
            JOIN webhook_routes route ON route.tenant_id=connection.tenant_id AND route.connection_id=connection.id
            WHERE connection.tenant_id=$1 AND connection.provider='META' AND connection.state<>'REVOKED'
              AND session.ownership_state='ACTIVE' AND session.opaque_session_id=$2 AND session.provider_state_data->>'wabaId'=$3
              AND route.provider='META' AND route.external_key=$2 AND route.state<>'REVOKED'`, [attempt.tenant_id, choice.phoneId, choice.wabaId]);
          if (existing.length === 1) choice.existingConnection = { connectionId: existing[0]!.connection_id, name: existing[0]!.name };
        }
      }
    } return choices;
  }
  private async guard(request: AuthenticatedRequest, expected: Attempt) {
    await this.database.withTenant(expected.tenant_id, async client => {
      await this.authorize(request, client); const row = await this.row(client, request, expected.id); this.current(row, request, expected.revision);
      await this.targetCurrent(client, row);
      if (row.status !== expected.status || row.credential_fingerprint !== expected.credential_fingerprint) throw conflict();
    });
  }
  private async result(request: AuthenticatedRequest, expected: Attempt, status: MetaSignupStatus, reason: MetaSignupReason) {
    await this.database.withTenant(expected.tenant_id, async client => {
      const changed = await client.query(`UPDATE meta_signup_attempts SET status=$3,reason_code=$4,revision=revision+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND requested_by=$5 AND revision=$6`, [expected.tenant_id, expected.id, status, reason, request.principal.userId, expected.revision]);
      if (changed.rowCount === 1) await this.audit(client, request, expected.id, "meta_signup.outcome_recorded", { status, reason });
    });
  }
  private async row(client: PoolClient, request: AuthenticatedRequest, id: string, lock = false) {
    if (!uuid(id)) throw new NotFoundException("Authorization attempt not found");
    if (lock) {
      // Match rotation/lifecycle lock order. A stale target still permits an exact
      // stage cancellation; only lock here, and validate currentness at mutation.
      const target = (await client.query<{ target_connection_id?: string }>(
        "SELECT COALESCE(target_connection_id,connection_id) AS target_connection_id FROM meta_signup_attempts WHERE tenant_id=$1 AND id=$2 AND requested_by=$3",
        [request.principal.tenantId, id, request.principal.userId])).rows[0];
      if (target?.target_connection_id) await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [request.principal.tenantId, target.target_connection_id]);
    }
    const row = (await client.query<Attempt>(`SELECT attempt.*,
      (SELECT connection.name FROM connections connection WHERE connection.tenant_id=attempt.tenant_id AND connection.id=attempt.target_connection_id) AS target_name
      FROM meta_signup_attempts attempt WHERE attempt.tenant_id=$1 AND attempt.id=$2 AND attempt.requested_by=$3${lock ? " FOR UPDATE OF attempt" : ""}`,
      [request.principal.tenantId, id, request.principal.userId])).rows[0];
    if (!row) throw new NotFoundException("Authorization attempt not found"); return row;
  }
  private current(row: Attempt, request: AuthenticatedRequest, expectedRevision: number) {
    if (row.revision !== expectedRevision) throw conflict();
    // The authorization deadline does not invalidate an already-bound durable operation.
    if (!row.connection_id && new Date(row.expires_at).getTime() <= Date.now()) throw conflict("META_SIGNUP_EXPIRED");
    if (!sameConfig(row.config, configured(row.config.variant)) || row.config.origin !== this.origin(request)) throw conflict("META_SIGNUP_STATE_INVALID");
  }
  private origin(request: AuthenticatedRequest) {
    const expected = configured().origin;
    if (request.headers.origin !== expected) throw new ForbiddenException({ code: "META_SIGNUP_STATE_INVALID", message: "The authorization origin is invalid." });
    return expected;
  }
  private async authorize(request: AuthenticatedRequest, client?: PoolClient): Promise<void> {
    if (!client) return this.database.withTenant(request.principal.tenantId, bound => this.authorize(request, bound));
    await client.query("SELECT app.lock_current_active_tenant_for_event_admission()");
    const allowed = await client.query(`SELECT 1 FROM tenant_memberships membership JOIN tenants tenant ON tenant.id=membership.tenant_id
      WHERE membership.tenant_id=$1 AND membership.user_id=$2 AND membership.state='ACTIVE'
      AND membership.role IN ('tenant_owner','tenant_admin') AND tenant.state='ACTIVE' FOR SHARE OF membership`,
    [request.principal.tenantId, request.principal.userId]);
    if (allowed.rowCount !== 1) throw new ForbiddenException("Connection administration requires an active owner or administrator");
    await requirePrivilegedAuthentication(client, request.principal, "connecting a WhatsApp account");
  }
  private async preflight(variant?: "STANDARD" | "BUSINESS_APP") {
    const config = configured(variant);
    const [appSecret, ready] = await Promise.all([this.webhookSecrets.resolveHmac(config.secretReference, { kind: "exact", expectedReference: config.secretReference }), this.secrets.ready()]);
    if (!ready) throw new ServiceUnavailableException("Secure account setup is unavailable"); return { config, appSecret };
  }
  private audit(client: PoolClient, request: AuthenticatedRequest, id: string, action: string, details: Record<string, unknown> = {}) {
    return appendAudit(client, request.principal, { action, targetType: "meta_signup_attempt", targetId: id, requestId: String(request.id), newValue: details });
  }
}

function configured(variant?: "STANDARD" | "BUSINESS_APP"): SignupConfig {
  if (variant === "BUSINESS_APP" && !businessAppConfigured()) throw new ServiceUnavailableException("Business app setup is unavailable");
  const appId = process.env.META_APP_ID ?? "", configId = (variant === "BUSINESS_APP" ? process.env.META_SIGNUP_BUSINESS_APP_CONFIG_ID : process.env.META_SIGNUP_CUSTOMER_CONFIG_ID) ?? "";
  const graphVersion = process.env.META_GRAPH_VERSION ?? "", secretReference = process.env.META_APP_SECRET_REFERENCE ?? "";
  const origin = process.env.PORTAL_PUBLIC_ORIGIN ?? "";
  let url: URL; try { url = new URL(origin); } catch { throw new ServiceUnavailableException("Meta signup is not configured"); }
  if (process.env.META_SIGNUP_ENABLED !== "true" || !metaId(appId) || !metaId(configId) || graphVersion !== "v24.0"
    || !secretReference.startsWith("secret://") || url.origin !== origin || (url.protocol !== "https:" && process.env.NODE_ENV === "production")) {
    throw new ServiceUnavailableException("Meta signup is not configured");
  } return { appId, configId, graphVersion, secretReference, origin, ...(variant === "BUSINESS_APP" ? { variant } : {}) };
}
function businessAppConfigured() { return process.env.META_COEXISTENCE_ENABLED === "true" && metaId(process.env.META_SIGNUP_BUSINESS_APP_CONFIG_ID); }
function sameConfig(a: SignupConfig, b: SignupConfig) { return (a.variant ?? "STANDARD") === (b.variant ?? "STANDARD") && a.appId === b.appId && a.configId === b.configId && a.graphVersion === b.graphVersion && a.secretReference === b.secretReference && a.origin === b.origin; }
function sdk(config: SignupConfig) { return { appId: config.appId, configId: config.configId, graphVersion: config.graphVersion,
  ...(config.variant === "BUSINESS_APP" ? { variant: config.variant, extras: { featureType: "whatsapp_business_app_onboarding" as const, sessionInfoVersion: "3" as const, setup: {} } } : {}) }; }
function pinFingerprint(attempt: Attempt, pin: string, token: string) { return createHmac("sha256", token).update(`meta-signup-pin-equality:${attempt.tenant_id}:${attempt.id}:${attempt.config.configId}:${pin}`).digest("hex"); }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value); }
function revision(value: unknown) { if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid(); }
function only(value: unknown, fields: string[]) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw invalid(); }
function invalid() { return new BadRequestException({ code: "META_SIGNUP_STATE_INVALID", message: "The account setup request is invalid." }); }
function conflict(code: MetaSignupReason = "META_SIGNUP_REVISION_CONFLICT") { return new ConflictException({ code, message: "Account setup changed. Refresh its current status." }); }
function initialReadiness(): MetaSignupReadiness { return { authorization: "PENDING", number: "PENDING", subscription: "PENDING", messaging: "UNKNOWN", payment: { requestedPayer: "CUSTOMER", status: "UNKNOWN", paymentMethodVerified: false } }; }
function reconnectReadiness(): MetaSignupReadiness { return { ...initialReadiness(), authorization: "VERIFIED", number: "UNKNOWN", subscription: "UNKNOWN" }; }
function addAccessReadiness(): MetaSignupReadiness { return { ...initialReadiness(), authorization: "VERIFIED", number: "REGISTERED", subscription: "UNKNOWN" }; }
function view(row: Attempt): MetaSignupAttemptView {
  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(row.status);
  const nextAction = row.status === "AWAITING_AUTHORIZATION" ? "AUTHORIZE" : row.status === "SELECTION_REQUIRED" ? "SELECT_NUMBER"
    : row.status === "NUMBER_REQUIRED" ? "COMPLETE_META_SETUP" : ["EXCHANGING", "PROVISIONING"].includes(row.status) ? "WAIT"
    : row.status === "OUTCOME_UNKNOWN" ? "REVIEW_OUTCOME" : row.status === "COMPLETED" ? "DONE" : terminal ? "START_AGAIN" : "COMPLETE_META_SETUP";
  return { purpose: row.purpose, ...(row.target_connection_id && row.target_binding ? { target: { connectionId: row.target_connection_id, name: row.target_name ?? "", state: row.target_binding.state, mode: hasCoexistenceTarget(row.target_binding) ? "COEXISTENCE" as const : "STANDARD" as const } } : {}),
    ...(row.purpose === "RECONNECT" && row.status === "COMPLETED" ? { outcome: "ACCESS_RENEWED_PAUSED" as const } : {}),
    ...(row.target_transition_id ? row.purpose === "LEGACY_MIGRATION" ? { targetLegacyMigrationId:row.target_transition_id } : { targetTransitionId: row.target_transition_id } : {}),
    ...(row.purpose === "TRANSITION_READBACK" && row.status === "COMPLETED" ? { outcome: "READBACK_ACCESS_RENEWED" as const } : {}),
    ...(row.purpose === "LEGACY_MIGRATION" && row.status === "COMPLETED" ? { outcome: "MIGRATION_ACCESS_VERIFIED" as const } : {}),
    ...(row.purpose === "ADD_ACCESS" && row.status === "COMPLETED" ? { outcome: "ACCESS_ADDED_PAUSED" as const } : {}),
    attemptId: row.id, revision: row.revision, expiresAt: new Date(row.expires_at).toISOString(), status: row.status, nextAction,
    variant: row.config.variant ?? "STANDARD", ...(row.coexistence_consent ? { coexistenceConsent: row.coexistence_consent } : {}),
    ...(row.reason_code ? { reasonCode: row.reason_code } : {}), readiness: row.readiness,
    canCancel: !row.connection_id && ["AWAITING_AUTHORIZATION", "SELECTION_REQUIRED", "NUMBER_REQUIRED", "ACTION_REQUIRED"].includes(row.status),
    canStartAgain: terminal || row.status === "OUTCOME_UNKNOWN", choices: row.choices.map(choice => ({
      choiceId: choice.choiceId, businessName: choice.businessName, accountName: choice.accountName,
      displayPhoneNumber: choice.displayPhoneNumber, mode: choice.mode, numberState: choice.numberState, selectable: choice.selectable,
      ...(choice.verifiedName !== undefined ? { verifiedName: choice.verifiedName } : {}),
      ...(choice.reasonCode !== undefined ? { reasonCode: choice.reasonCode } : {}),
      ...(choice.existingConnection !== undefined ? { existingConnection: choice.existingConnection } : {}),
    })),
    ...(row.selection_revision ? { selectionRevision: row.selection_revision } : {}), ...(row.connection_id ? { connectionId: row.connection_id } : {}), ...(row.operation_id ? { operationId: row.operation_id } : {}) };
}

/** Observer access is readback-only and cannot acquire business-app mode. */
export function hasCoexistenceTarget(target: Attempt["target_binding"]): boolean {
  return Boolean(target && "coexistence" in target && target.coexistence);
}
