import assert from "node:assert/strict";

const remoteRoles = ["tenant_owner", "tenant_admin", "supervisor", "agent", "auditor", "anonymous", "platform_operator", "zammad_agent"];

const tenantRoles = remoteRoles.slice(0, 5);

export const remoteViewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
];

export function deferredAlphaContexts(contract={}) {
  const deferral = contract.portalMobileDeferral;
  if (!deferral) return new Set();
  assert.equal(deferral.profile, 'first-client-alpha-live');
  assert.ok(deferral.approval?.source && Number.isFinite(Date.parse(deferral.approval.recordedAt)));
  const allowed = remoteRoles.filter(role => role !== 'zammad_agent').map(role => `${role}-en-mobile`);
  assert.ok(Array.isArray(deferral.contextIds) && deferral.contextIds.length);
  assert.equal(new Set(deferral.contextIds).size, deferral.contextIds.length);
  for (const id of deferral.contextIds) assert.ok(allowed.includes(id), `Invalid portal mobile deferral ${id}`);
  return new Set(deferral.contextIds);
}

export function remoteRolesForSurface(surface, actorRoles) {
  if (actorRoles !== undefined) {
    assert.ok(Array.isArray(actorRoles) && actorRoles.length > 0 && new Set(actorRoles).size === actorRoles.length && actorRoles.every(role => remoteRoles.includes(role)), 'Invalid actorRoles');
    return actorRoles;
  }
  const tokens = surface.split("-");
  return [
    ...(tokens.includes("public") ? ["anonymous"] : []),
    ...(tokens.includes("portal") ? tenantRoles : []),
    ...(tokens.includes("platform") ? ["platform_operator"] : []),
    ...(tokens.includes("zammad") ? ["zammad_agent"] : []),
    ...(tokens.includes("provider") ? ["tenant_owner"] : []),
  ];
}
