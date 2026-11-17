export type DepartmentDefaultPolicy = { id: string; zammadGroupId: string; zammadOwnerId: string; enabled: boolean };
export type NativeRoutingSyncState = "UNCONFIGURED" | "PENDING" | "APPLYING" | "SYNCED" | "DRIFT" | "FAILED" | "OUTCOME_UNKNOWN";
export type NativeRoutingSyncStatus = {
  state: NativeRoutingSyncState; desiredRevision: number; appliedRevision: number;
  desiredSha256: string | null; observedSha256: string | null; lastCheckedAt: string | null;
  errorCode: string | null; safeRetry: boolean; departmentDefaults: DepartmentDefaultPolicy[];
};
export type NativeRoutingSyncCommand =
  | { action: "CHECK" | "RECONCILE"; expectedRevision: number }
  | { action: "SAVE_DEFAULTS"; expectedRevision: number; departmentDefaults: DepartmentDefaultPolicy[] };
export type NativeRoutingManifest = {
  group_references: Array<{ group_id: string; owner_ids: string[] }>;
  assignments: Array<{ key: string; source_kind: "GROUP_BINDING" | "BOT_HANDOFF"; source_id: string; source_revision: string; group_id: string; owner_id: string | null }>;
  department_defaults: Array<{ key: string; group_id: string; owner_id: string; enabled: boolean }>;
  client_routing: null | { version_id: string; snapshot_sha256: string; support_group_ids: string[] };
};
export type NativeRoutingRequest = {
  schema_version: 1; action: "CHECK" | "APPLY"; tenant_id: string; instance_id: string;
  revision: number; desired_sha256: string; expected_native_revision: number; manifest: NativeRoutingManifest;
};
export type NativeRoutingResponse = {
  schema_version: 1; tenant_id: string; instance_id: string; revision: number; desired_sha256: string;
  applied_revision: number; observed_sha256: string | null; state: "SYNCED" | "DRIFT" | "CONFLICT";
  items: Array<{ key: string; kind: "CONFIGURATION" | "GROUP_REFERENCE" | "GROUP_BINDING" | "BOT_HANDOFF" | "DEPARTMENT_DEFAULT" | "CLIENT_ROUTING"; native_id: string | null; state: "SYNCED" | "DRIFT" | "UNAPPLIED"; error_code?: string }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
export function nativeRoutingId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/u.test(value) || !Number.isSafeInteger(Number(value))) invalid();
  return value;
}
export function nativeRoutingRevision(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}
function uuid(value: unknown) { if (typeof value !== "string" || !UUID.test(value)) invalid(); return value; }
function hash(value: unknown) { if (typeof value !== "string" || !HASH.test(value)) invalid(); return value; }
function object(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !(key in result))) invalid();
  return result;
}
function array(value: unknown, maximum: number): unknown[] { if (!Array.isArray(value) || value.length > maximum) invalid(); return value; }
function unique(values: string[]) { if (new Set(values).size !== values.length) invalid(); }
function boolean(value: unknown) { if (typeof value !== "boolean") invalid(); return value; }
function invalid(): never { throw new Error("NATIVE_ROUTING_VALIDATION_ERROR"); }

export function parseDepartmentDefaults(value: unknown): DepartmentDefaultPolicy[] {
  const policies = array(value, 100).map(item => {
    const row = object(item, ["id", "zammadGroupId", "zammadOwnerId", "enabled"]);
    return { id: uuid(row.id), zammadGroupId: nativeRoutingId(row.zammadGroupId), zammadOwnerId: nativeRoutingId(row.zammadOwnerId), enabled: boolean(row.enabled) };
  });
  unique(policies.map(row => row.id)); unique(policies.map(row => row.zammadGroupId));
  return policies.sort((left, right) => compare(left.id, right.id));
}
export function parseNativeRoutingSyncCommand(value: unknown): NativeRoutingSyncCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const action = (value as Record<string, unknown>).action;
  if (action !== "CHECK" && action !== "RECONCILE" && action !== "SAVE_DEFAULTS") invalid();
  const input = object(value, action === "SAVE_DEFAULTS" ? ["action", "expectedRevision", "departmentDefaults"] : ["action", "expectedRevision"]);
  const expectedRevision = nativeRoutingRevision(input.expectedRevision);
  return action === "SAVE_DEFAULTS" ? { action, expectedRevision, departmentDefaults: parseDepartmentDefaults(input.departmentDefaults) } : { action, expectedRevision };
}

/** Object keys and identity arrays use ASCII order, shared with the native package. */
export function canonicalNativeRoutingManifest(value: unknown): NativeRoutingManifest {
  const input = object(value, ["group_references", "assignments", "department_defaults", "client_routing"]);
  const groups = array(input.group_references, 10_000).map(item => {
    const row = object(item, ["group_id", "owner_ids"]);
    const owners = array(row.owner_ids, 1_000).map(nativeRoutingId); unique(owners);
    return { group_id: nativeRoutingId(row.group_id), owner_ids: owners.sort(compare) };
  }).sort((left, right) => compare(left.group_id, right.group_id));
  unique(groups.map(row => row.group_id));
  const assignments = array(input.assignments, 10_000).map(item => {
    const row = object(item, ["key", "source_kind", "source_id", "source_revision", "group_id", "owner_id"]);
    if (row.source_kind !== "GROUP_BINDING" && row.source_kind !== "BOT_HANDOFF") invalid();
    if (typeof row.source_id !== "string" || row.source_id.length > 140 || typeof row.key !== "string") invalid();
    if (row.source_kind === "GROUP_BINDING") {
      uuid(row.source_id); if (row.key !== `group-binding:${row.source_id}`) invalid();
    } else {
      const parts = row.source_id.split(":");
      if (parts.length !== 3 || !/^[a-z][a-z0-9_-]{0,63}$/u.test(parts[2]!)) invalid();
      uuid(parts[0]); uuid(parts[1]); if (row.key !== `bot-handoff:${row.source_id}`) invalid();
    }
    if (typeof row.source_revision !== "string" || !/^[1-9][0-9]{0,15}$/u.test(row.source_revision)) invalid();
    nativeRoutingRevision(Number(row.source_revision), 1);
    return { key: row.key, source_kind: row.source_kind, source_id: row.source_id, source_revision: row.source_revision, group_id: nativeRoutingId(row.group_id), owner_id: row.owner_id === null ? null : nativeRoutingId(row.owner_id) };
  }).sort((left, right) => compare(left.source_kind, right.source_kind) || compare(left.source_id, right.source_id) || compare(left.key, right.key));
  unique(assignments.map(row => row.key));
  const defaults = array(input.department_defaults, 100).map(item => {
    const row = object(item, ["key", "group_id", "owner_id", "enabled"]);
    return { key: uuid(row.key), group_id: nativeRoutingId(row.group_id), owner_id: nativeRoutingId(row.owner_id), enabled: boolean(row.enabled) };
  }).sort((left, right) => compare(left.key, right.key));
  unique(defaults.map(row => row.key)); unique(defaults.map(row => row.group_id));
  let routing: NativeRoutingManifest["client_routing"] = null;
  if (input.client_routing !== null) {
    const row = object(input.client_routing, ["version_id", "snapshot_sha256", "support_group_ids"]);
    const ids = array(row.support_group_ids, 100).map(nativeRoutingId); unique(ids);
    routing = { version_id: uuid(row.version_id), snapshot_sha256: hash(row.snapshot_sha256), support_group_ids: ids.sort(compare) };
  }
  const references = new Map(groups.map(group => [group.group_id, new Set(group.owner_ids)]));
  for (const assignment of assignments) if (!references.has(assignment.group_id) || assignment.owner_id && !references.get(assignment.group_id)!.has(assignment.owner_id)) invalid();
  for (const policy of defaults) if (policy.enabled && !references.get(policy.group_id)?.has(policy.owner_id)) invalid();
  for (const id of routing?.support_group_ids ?? []) if (!references.has(id)) invalid();
  return { group_references: groups, assignments, department_defaults: defaults, client_routing: routing } as NativeRoutingManifest;
}
export function serializeNativeRoutingManifest(value: unknown): string {
  const manifest = canonicalNativeRoutingManifest(value);
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted) : item !== null && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => compare(left, right)).map(([key, nested]) => [key, sorted(nested)])) : item;
  return JSON.stringify(sorted(manifest));
}
