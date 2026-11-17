import { ConflictException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { sameMetaConnectionBinding, parseMetaLifecycleState, type MetaConnectionBinding } from "@wasalx/core/meta-account-relation";

type ConnectionState = "PROVISIONING" | "AWAITING_AUTH" | "CONNECTING" | "WORKING" | "DEGRADED" | "ACTION_REQUIRED" | "FAILED" | "PAUSED" | "REVOKED";
export type MetaBinding = MetaConnectionBinding & { state: ConnectionState; lifecycle?: unknown };
export type MetaReconnectTarget = MetaBinding & { state: "PAUSED"; contextSha256: string;
  coexistence?: { contextId: string; revision: number; credentialFingerprint: string; snapshotSha256: string; privacySnapshotSha256: string } };

/** Saving access never grants activation; P07/P08 admission belongs to the later explicit transition. */
export async function assertMetaAddAccessActivationAllowed(client: PoolClient, tenantId: string, connectionId: string) {
  const result = await client.query<{ held: boolean }>("SELECT app.meta_add_access_activation_held($1,$2) AS held", [tenantId, connectionId]);
  if (result.rows[0]?.held !== false) throw new ConflictException({ code: "META_SIGNUP_ADD_ACCESS_ACTIVATION_REQUIRED",
    message: "This connection is saved and paused. Activation requires a separate review." });
}

export async function loadMetaBinding(client: PoolClient, tenantId: string, connectionId: string): Promise<MetaBinding> {
  const connection = (await client.query<{ secret_reference: string; provider: string; state: ConnectionState }>(
    "SELECT c.secret_reference,c.provider,c.state FROM connections c WHERE c.tenant_id=$1 AND c.id=$2 FOR UPDATE", [tenantId, connectionId])).rows[0];
  if (!connection) throw new NotFoundException("Connection not found");
  if (connection.provider !== "META" || connection.state === "REVOKED") throw new ConflictException("The Meta connection is unavailable");
  const sessions = (await client.query<{ id: string; opaque_session_id: string; provider_state_data: Record<string, unknown> }>(
    "SELECT id,opaque_session_id,provider_state_data FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE' FOR UPDATE", [tenantId, connectionId])).rows;
  const session = sessions[0];
  if (sessions.length !== 1 || !session || !/^\d{5,32}$/u.test(session.opaque_session_id)
    || typeof session.provider_state_data?.wabaId !== "string" || !/^\d{5,32}$/u.test(session.provider_state_data.wabaId)) {
    throw new ConflictException("The Meta phone and account relationship is unavailable");
  }
  return { secretReference: connection.secret_reference, state: connection.state, providerSessionId: session.id,
    phoneNumberId: session.opaque_session_id, wabaId: session.provider_state_data.wabaId,
    ...(Object.hasOwn(session.provider_state_data, "metaLifecycle") ? { lifecycle: session.provider_state_data.metaLifecycle } : {}) };
}

/** A paused row alone may be an unfinished PAUSE. Lock and bind the settled local context. */
export async function loadMetaReconnectTarget(client: PoolClient, tenantId: string, connectionId: string, ownOperationId?: string): Promise<MetaReconnectTarget> {
  const binding = await loadMetaBinding(client, tenantId, connectionId);
  if (binding.state !== "PAUSED") throw reconnectConflict("META_SIGNUP_RECONNECT_PAUSE_REQUIRED");
  const lifecycle = (await client.query<{ revision_matches: boolean; unresolved_hold: boolean }>(
    "SELECT * FROM app.meta_lifecycle_guard($1,$2,$3,$4,$5,$6)", [connectionId, binding.providerSessionId, binding.phoneNumberId,
      binding.wabaId, process.env.META_APP_ID ?? "", parseMetaLifecycleState(binding.lifecycle)?.revision ?? 0])).rows;
  if (lifecycle.length !== 1 || lifecycle[0].revision_matches !== true || lifecycle[0].unresolved_hold !== false) throw reconnectConflict();
  const pending = await client.query(`SELECT 1 FROM connection_operations WHERE tenant_id=$1 AND connection_id=$2
    AND state IN ('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE') AND ($3::uuid IS NULL OR id<>$3) LIMIT 1`, [tenantId, connectionId, ownOperationId ?? null]);
  if (pending.rowCount) throw reconnectConflict();
  const context = (await client.query<{ provider_state_data: Record<string, unknown> }>(`SELECT session.provider_state_data
    FROM connections connection JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
    WHERE connection.tenant_id=$1 AND connection.id=$2 AND session.id=$3`, [tenantId, connectionId, binding.providerSessionId])).rows[0];
  const routes = (await client.query<{ id: string; state: string; connection_id: string }>(`SELECT id,state,connection_id FROM webhook_routes
    WHERE tenant_id=$1 AND provider='META' AND external_key=$2 AND reservation_release_id IS NULL FOR UPDATE`, [tenantId, binding.phoneNumberId])).rows;
  if (!context || routes.length !== 1 || routes[0]?.state !== "PAUSED" || routes[0].connection_id !== connectionId) throw reconnectConflict();
  const coex = (await client.query<{ id: string; revision: number; credential_fingerprint: string; snapshot_sha256: string }>(`SELECT capture.id,capture.revision,capture.credential_fingerprint,
    encode(sha256(convert_to(to_jsonb(capture)::text,'UTF8')),'hex') AS snapshot_sha256
    FROM meta_coexistence_contexts capture WHERE tenant_id=$1 AND connection_id=$2 FOR UPDATE`, [tenantId, connectionId])).rows;
  const marker = context.provider_state_data.metaSignup as Record<string, unknown> | undefined;
  const proof = context.provider_state_data.metaAccountProof as Record<string, unknown> | undefined;
  if (coex.length > 1 || (!!coex.length !== (marker?.variant === "BUSINESS_APP"))) throw reconnectConflict();
  let coexistence: MetaReconnectTarget["coexistence"];
  if (coex[0]) {
    const exact = await client.query(`SELECT 1 FROM meta_coexistence_contexts
      WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND provider_session_id=$4 AND phone_id=$5 AND waba_id=$6
        AND app_id=$7 AND graph_version=$8 AND signup_attempt_id::text=$9 AND credential_fingerprint=$10
        AND NOT EXISTS(SELECT 1 FROM privacy_jobs WHERE tenant_id=$1 AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE'))`,
    [tenantId, connectionId, coex[0].id, binding.providerSessionId, binding.phoneNumberId, binding.wabaId,
      process.env.META_APP_ID ?? "", process.env.META_GRAPH_VERSION ?? "", marker?.attemptId, proof?.credentialFingerprint]);
    if (exact.rowCount !== 1 || proof?.providerSessionId !== binding.providerSessionId || proof?.secretReference !== binding.secretReference) throw reconnectConflict();
    const privacy = (await client.query<{ snapshot: string }>("SELECT app.meta_coexistence_privacy_snapshot() AS snapshot")).rows[0];
    if (!privacy || !/^[a-f0-9]{64}$/u.test(privacy.snapshot)) throw reconnectConflict();
    coexistence = { contextId: coex[0].id, revision: coex[0].revision, credentialFingerprint: coex[0].credential_fingerprint,
      snapshotSha256: coex[0].snapshot_sha256, privacySnapshotSha256: privacy.snapshot };
  }
  // Entire provider context is an immutable equality fence, not a claim of legal ownership or payer readiness.
  return { ...binding, state: binding.state, ...(coexistence ? { coexistence } : {}), contextSha256: createHash("sha256").update(JSON.stringify({ data: context.provider_state_data, routes, ...(coexistence ? { coexistence } : {}) })).digest("hex") };
}

export function assertMetaReconnectTarget(expected: MetaReconnectTarget, current: MetaReconnectTarget) {
  if (!expected || expected.state !== "PAUSED" || current.state !== "PAUSED" || !sameMetaConnectionBinding(expected, current)
    || expected.contextSha256 !== current.contextSha256) throw reconnectConflict();
}
export function reconnectConflict(code = "META_SIGNUP_RECONNECT_TARGET_CHANGED") {
  return new ConflictException({ code, message: "The paused connection changed. Review its current status before renewing access." });
}
