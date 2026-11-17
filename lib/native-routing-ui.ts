import type { DepartmentDefaultPolicy, NativeRoutingSyncStatus } from "../packages/core/src/native-routing-contract";

export type NativeRoutingCatalog = {
  groups: Array<{ id: string; name: string; active: boolean; serviceIdentityCanCreate: boolean }>;
  owners: Array<{ id: string; name: string; active: boolean; groupIds: string[] }>;
};

export function nativeRoutingDisplayState(status: NativeRoutingSyncStatus): NativeRoutingSyncStatus["state"] {
  if (status.state !== "SYNCED") return status.state;
  // A successful Source write is not a native readback receipt.
  return status.desiredRevision > 0 && status.desiredRevision === status.appliedRevision
    && Boolean(status.lastCheckedAt && status.desiredSha256 && status.desiredSha256 === status.observedSha256)
    ? "SYNCED" : "PENDING";
}

export function nativeRoutingCanRetry(status: NativeRoutingSyncStatus) {
  return status.safeRetry === true && ["PENDING", "FAILED"].includes(status.state);
}

export function nativeRoutingDefaultsValid(policies: DepartmentDefaultPolicy[], catalog: NativeRoutingCatalog) {
  return policies.length <= 100 && new Set(policies.map(policy => policy.id)).size === policies.length
    && new Set(policies.map(policy => policy.zammadGroupId)).size === policies.length
    && policies.every(policy => Boolean(policy.zammadGroupId && policy.zammadOwnerId)
    && (!policy.enabled || (catalog.groups.some(group => group.id === policy.zammadGroupId && group.active && group.serviceIdentityCanCreate)
      && catalog.owners.some(owner => owner.id === policy.zammadOwnerId && owner.active && owner.groupIds.includes(policy.zammadGroupId)))));
}
