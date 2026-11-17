export const tenantRoles = [
  "tenant_owner",
  "tenant_admin",
  "supervisor",
  "agent",
  "auditor",
] as const;

export type TenantRole = (typeof tenantRoles)[number];

export const tenantPermissions = [
  "connection:read", "connection:write", "connection:disconnect",
  "group:read", "group:write",
  "rule:read", "rule:write",
  "bot:read", "bot:write", "bot:operate",
  "case:read", "case:detach", "ticket:read", "ticket:write",
  "delivery:read", "delivery:content:read", "delivery:retry",
  "review:read", "review:write",
  "audit:read", "audit:export",
  "billing:read", "billing:export",
  "settings:read", "settings:write",
  "team:read", "team:invite", "team:write",
  "privacy:read", "privacy:policy:write", "privacy:hold:write", "privacy:export", "privacy:delete",
  "support:read", "support:approve",
] as const;

export type Permission = (typeof tenantPermissions)[number];

const rolePermissions: Record<TenantRole, ReadonlySet<Permission>> = {
  tenant_owner: new Set(tenantPermissions),
  tenant_admin: new Set([
    "connection:read", "connection:write", "connection:disconnect", "group:read", "group:write",
    "rule:read", "rule:write", "bot:read", "bot:write", "bot:operate", "case:read", "case:detach",
    "delivery:read", "delivery:content:read", "delivery:retry", "review:read", "review:write",
    "audit:read", "audit:export", "billing:read", "billing:export", "settings:read", "team:read", "team:invite", "team:write",
    "privacy:read", "privacy:export", "support:read",
    "ticket:read", "ticket:write",
  ]),
  supervisor: new Set([
    "connection:read", "group:read", "rule:read", "bot:read", "bot:operate", "case:read",
    "case:detach", "delivery:read", "delivery:content:read", "delivery:retry", "review:read",
    "review:write", "audit:read", "settings:read", "team:read",
    "ticket:read", "ticket:write",
  ]),
  agent: new Set([
    "connection:read", "group:read", "rule:read", "bot:read", "bot:operate", "delivery:read",
    "delivery:content:read",
    "ticket:read", "ticket:write",
  ]),
  auditor: new Set([
    "connection:read", "group:read", "rule:read", "bot:read", "case:read", "delivery:read",
    "review:read", "audit:read", "audit:export", "billing:read", "billing:export", "settings:read", "team:read", "privacy:read",
    "support:read",
  ]),
};

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === "string" && Object.hasOwn(rolePermissions, value);
}

export function can(role: TenantRole, permission: Permission) {
  return rolePermissions[role].has(permission);
}
