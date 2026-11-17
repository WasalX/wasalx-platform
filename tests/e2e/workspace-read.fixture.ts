import type { Page } from "@playwright/test";
import type { IdentityStatus } from "../../lib/service-access-contract.ts";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
/** Synthetic sibling-panel reads only. No native authorization or mutation evidence. */
export function workspaceReadFixture(role: string, method: string, body: unknown): { items: never[]; next_cursor: null } | { allowed: true } | { items: never[]; next_cursor: null; can_create: false; mail_ready: false } | IdentityStatus | null {
  if (method !== "POST" || !record(body) || Object.keys(body).sort().join() !== "input,operation" || !record(body.input)) return null;
  const input = body.input;
  if (["tenant_owner", "tenant_admin", "supervisor", "agent"].includes(role)) {
    if (body.operation === "CHECK" && Object.keys(input).length === 0) return { allowed: true };
    if (body.operation === "LIST" && Object.keys(input).sort().join() === "limit,state" && input.limit === 50 && input.state === "open") return { items: [], next_cursor: null };
  }
  if (body.operation === "TEAM_LIST" && Object.keys(input).join() === "limit" &&
    (input.limit === 50 && ["tenant_owner", "tenant_admin"].includes(role) || input.limit === 100 && role === "tenant_owner")) return { items: [], next_cursor: null };
  if (body.operation === "MAILBOX_LIST" && role === "tenant_owner" && Object.keys(input).length === 0) return { items: [], next_cursor: null, can_create: false, mail_ready: false };
  if (body.operation === "IDENTITY_STATUS" && role === "tenant_owner") {
    if (Object.keys(input).length !== 0) return null;
    return { mode: "FRESH", phase: "BOUND", portal_ready: true, access_required: false,
      status_version: "a".repeat(64), operation_id: "33000000-0000-4000-8000-000000000071",
      can_initialize: false, can_prepare: false, can_bind: false, can_complete: false, legacy_retirement_ready: false,
      legacy_member: null, groups: [], groups_next_cursor: null };
  }
  return null;
}
/** Conservative default for co-mounted SupportTeams/owner ServiceAccess in local UI journeys. */
export async function installWorkspaceReadFixture(page: Pick<Page, "route">, role: string) {
  await page.route("**/api/inbox", async route => {
    let body: unknown;
    try { body = route.request().postDataJSON(); } catch { return route.fallback(); }
    const value = workspaceReadFixture(role, route.request().method(), body);
    if (value === null) return route.fallback();
    return route.fulfill({ status: 200, json: value });
  });
}
