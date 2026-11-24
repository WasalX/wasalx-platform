import type { PoolClient } from "pg";
import { parseMetaDirectRecipientSnapshot } from "../../../packages/core/src/meta-direct-identity.js";

async function marketingSubject(client: PoolClient, tenantId: string, connectionId: string, value: unknown) {
  const snapshot = parseMetaDirectRecipientSnapshot(value);
  let phone = snapshot.recipient.kind === "PHONE" ? snapshot.recipient.value : null;
  let bsuid = snapshot.recipient.kind === "BSUID" ? snapshot.recipient.value : null;
  if (snapshot.claim === "ALIAS_VERIFIED") {
    const { rows } = await client.query<{ kind: "PHONE" | "BSUID"; value: string }>(
      "SELECT kind,value FROM meta_direct_identity_aliases WHERE tenant_id=$1 AND connection_id=$2"
      + " AND participant_identity_id=$3 AND provider_session_id=$4 AND phone_number_id=$5 AND waba_id=$6 AND state='ACTIVE'",
      [tenantId, connectionId, snapshot.participantId, snapshot.asset.providerSessionId, snapshot.asset.phoneNumberId, snapshot.asset.wabaId],
    );
    phone ??= rows.find(row => row.kind === "PHONE")?.value ?? null;
    bsuid ??= rows.find(row => row.kind === "BSUID")?.value ?? null;
  }
  return { phone, bsuid };
}

export async function whatsappMarketingOptedOut(client: PoolClient, tenantId: string, connectionId: string, snapshot: unknown) {
  const { phone, bsuid } = await marketingSubject(client, tenantId, connectionId, snapshot);
  const result = await client.query<{ opted_out: boolean }>(
    "SELECT opted_out FROM whatsapp_marketing_preferences WHERE tenant_id=$1"
    + " AND ((subject_kind='PHONE' AND subject=$2) OR (subject_kind='BSUID' AND subject=$3))"
    + " ORDER BY observed_at DESC,opted_out DESC LIMIT 1",
    [tenantId, phone, bsuid],
  );
  return result.rows[0]?.opted_out === true;
}

export async function recordWhatsAppMarketingRejection(client: PoolClient, tenantId: string, connectionId: string,
  snapshot: unknown, observedAt: Date | string, requestId: string) {
  const { phone, bsuid } = await marketingSubject(client, tenantId, connectionId, snapshot);
  await client.query("SELECT app.record_whatsapp_marketing_preference($1,$2,true,$3,'PROVIDER_131050',$4,$5)",
    [phone, bsuid, observedAt, connectionId, requestId]);
}
