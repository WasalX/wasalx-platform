import { portalDataBackend } from "./backend.ts";

export const TENANT_ROLES = [
  "tenant_owner",
  "tenant_admin",
  "supervisor",
  "agent",
  "auditor",
] as const;
export type FixtureTenantRole = typeof TENANT_ROLES[number];

export type FixturePersona = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string;
  role: FixtureTenantRole;
};

const FIXTURE_PERSONAS: Record<FixtureTenantRole, FixturePersona> = {
  tenant_owner: { userId: "local-preview", displayName: "Maya Al-Salem", email: "maya@northstar.example", fullName: "Maya Al-Salem", role: "tenant_owner" },
  tenant_admin: { userId: "32000000-0000-4000-8000-000000000002", displayName: "Omar Haddad", email: "omar@northstar.example", fullName: "Omar Haddad", role: "tenant_admin" },
  supervisor: { userId: "32000000-0000-4000-8000-000000000003", displayName: "Sara Khan", email: "sara@northstar.example", fullName: "Sara Khan", role: "supervisor" },
  agent: { userId: "32000000-0000-4000-8000-000000000005", displayName: "Amal Rahman", email: "amal@northstar.example", fullName: "Amal Rahman", role: "agent" },
  auditor: { userId: "32000000-0000-4000-8000-000000000004", displayName: "Faisal Noor", email: "faisal@northstar.example", fullName: "Faisal Noor", role: "auditor" },
};

export function portalFixtureRole(): FixtureTenantRole | undefined {
  const configured = process.env.PORTAL_FIXTURE_ROLE?.trim();
  if (!configured) return undefined;
  if (portalDataBackend() !== "fixture") {
    throw new Error("PORTAL_FIXTURE_ROLE is allowed only when PORTAL_DATA_BACKEND=fixture");
  }
  if (!(TENANT_ROLES as readonly string[]).includes(configured)) {
    throw new Error(`Invalid PORTAL_FIXTURE_ROLE: ${configured}`);
  }
  return configured as FixtureTenantRole;
}

export function portalFixturePersona(): FixturePersona | undefined {
  const role = portalFixtureRole();
  return role ? FIXTURE_PERSONAS[role] : undefined;
}
