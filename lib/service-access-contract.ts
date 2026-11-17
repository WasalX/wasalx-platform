export type IdentityKind = "IDENTITY_INITIALIZE" | "IDENTITY_PREPARE" | "IDENTITY_BIND" | "IDENTITY_COMPLETE" | "IDENTITY_GRANT";
export type IdentityOperation = IdentityKind | "IDENTITY_STATUS" | "IDENTITY_RECEIPT";
export type IdentityIntent = { request_id: string; kind: IdentityKind; team_id?: string };
export type IdentityTeam = { id: string; name: string; active: boolean; enabled: boolean; version: string };
export type IdentityStatus = { mode: "FRESH" | "LEGACY"; phase: "UNCONFIGURED" | "PREPARED" | "BOUND" | "COMPLETE"; portal_ready: boolean; access_required: boolean; status_version: string; operation_id: string | null; can_initialize: boolean; can_prepare: boolean; can_bind: boolean; can_complete: boolean; legacy_retirement_ready: boolean; legacy_member?: { name: string; email: string } | null; groups: IdentityTeam[]; groups_next_cursor: string | null };
export type IdentityReceipt = { state: "APPLIED" | "NOT_APPLIED" | "UNKNOWN"; terminal: boolean };
export type IdentityExecute = <T>(operation: IdentityOperation, input: Record<string, unknown>, signal?: AbortSignal) => Promise<T>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const kinds: IdentityKind[] = ["IDENTITY_INITIALIZE", "IDENTITY_PREPARE", "IDENTITY_BIND", "IDENTITY_COMPLETE", "IDENTITY_GRANT"];
export function parseIdentityRecovery(raw: string | null): IdentityIntent | null {
  if (raw === null) return null;
  if (raw.length > 1024) throw new Error("Oversized service-access recovery");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid service-access recovery");
  const row = value as Record<string, unknown>;
  if (typeof row.request_id !== "string" || !uuid.test(row.request_id) || typeof row.kind !== "string" || !kinds.includes(row.kind as IdentityKind)) throw new Error("Invalid service-access recovery");
  const keys = row.kind === "IDENTITY_GRANT" ? ["kind", "request_id", "team_id"] : ["kind", "request_id"];
  if (Object.keys(row).sort().join() !== keys.sort().join() || row.kind === "IDENTITY_GRANT" && (typeof row.team_id !== "string" || !/^[1-9][0-9]{0,15}$/u.test(row.team_id))) throw new Error("Invalid service-access recovery");
  return row.kind === "IDENTITY_GRANT" ? { kind: row.kind, request_id: row.request_id, team_id: row.team_id as string } : { kind: row.kind as IdentityKind, request_id: row.request_id };
}
export function identityTerminal(receipt: IdentityReceipt): boolean {
  return receipt.terminal === true && (receipt.state === "APPLIED" || receipt.state === "NOT_APPLIED");
}
