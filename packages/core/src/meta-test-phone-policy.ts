import type { TicketEventTransaction } from "./ticket-event-runtime.js";
import { parseWahaTestRecipientAllowlist } from "./waha-test-recipient-scope.js";

type Sender = {
  tenantId: string; connectionId: string; providerSessionId: string;
  appId: string; wabaId: string; phoneNumberId: string;
};
export type MetaTestPhonePolicy = { environment: "development" | "test"; senders: Sender[]; recipients: string[] };

/** Operator configuration only; neither requests nor provider payloads select this policy. */
export function parseMetaTestPhonePolicy(env: Record<string, string | undefined>): MetaTestPhonePolicy | undefined {
  const raw = env.WASALX_META_TEST_PHONE_SENDERS;
  if (!raw?.trim() || !["development", "test"].includes(env.NODE_ENV ?? "")) return undefined;
  const invalid = () => new Error("WASALX_META_TEST_PHONE_SENDERS is invalid or lacks its test-recipient fence");
  if (raw.length > 65_536) throw invalid();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!Array.isArray(value) || value.length > 64) throw invalid();
  if (value.length === 0) return undefined;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  const graph = /^[0-9]{1,32}$/u;
  const keys = ["appId", "connectionId", "phoneNumberId", "providerSessionId", "tenantId", "wabaId"];
  for (const sender of value) {
    if (!sender || typeof sender !== "object" || Object.keys(sender).sort().join() !== keys.join()
      || ![sender.tenantId, sender.connectionId, sender.providerSessionId].every(v => typeof v === "string" && uuid.test(v))
      || ![sender.appId, sender.wabaId, sender.phoneNumberId].every(v => typeof v === "string" && graph.test(v))) throw invalid();
  }
  const scope = parseWahaTestRecipientAllowlist(env.WASALX_TEST_RECIPIENT_ALLOWLIST);
  if (!scope?.size || [...scope].some(v => !v.endsWith("@c.us"))) throw invalid();
  return {
    environment: env.NODE_ENV as "development" | "test",
    senders: value.filter(sender => sender.appId === env.META_APP_ID),
    recipients: [...scope].map(v => v.slice(0, -5)),
  };
}

const configuredPolicy = parseMetaTestPhonePolicy(process.env);

/** Clear inherited defaults too; all policy state expires at transaction end. */
export async function setMetaTestPhoneTransaction(client: TicketEventTransaction, tenantId: string, policy = configuredPolicy) {
  const senders = policy?.senders.filter(sender => sender.tenantId === tenantId) ?? [];
  await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.meta_test_phone_policy',$2,true)", [
    tenantId, senders.length ? JSON.stringify({ ...policy, senders }) : "",
  ]);
}
