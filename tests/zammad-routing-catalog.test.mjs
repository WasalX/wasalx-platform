import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ZammadRoutingCatalogService } from "../services/control-api/dist/zammad-routing-catalog.service.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const instanceId = "20000000-0000-4000-8000-000000000001";

test("routing catalogs are tenant-fenced, read-only, bounded, filtered, and short-lived", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const databaseCalls = [];
  const database = {
    async rows(actualTenant, sql, values) {
      databaseCalls.push({ actualTenant, sql, values });
      return [{
        id: instanceId,
        tenant_id: tenantId,
        base_url: "https://zammad.tenant.example/",
        service_secret_reference: `secret://tenants/${tenantId}/zammad/service`,
        state: "WORKING",
      }];
    },
  };
  const secretCalls = [];
  const secrets = {
    async resolveApiToken(reference, owner) {
      secretCalls.push({ reference, owner });
      return "zammad-api-token-never-returned";
    },
  };
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    requests.push({ path: parsed.pathname, method: init?.method, authorization: init?.headers?.authorization });
    const payload = parsed.pathname === "/api/v1/users/me"
      ? { id: 7, group_ids: { "2": ["full"], "3": ["read"] } }
      : parsed.pathname === "/api/v1/groups"
        ? [{ id: 2, name: "Operations", active: true, user_ids: [19, 20] }, { id: 3, name: "Restricted", active: true, user_ids: [21] }]
        : parsed.pathname === "/api/v1/users"
          ? [{ id: 19, firstname: "Sara", lastname: "Khan", login: "sara@example.test", active: true, group_ids: { "2": ["full"] } }, { id: 20, firstname: "Limited", lastname: "Agent", login: "limited@example.test", active: true, group_ids: { "2": ["read", "change", "create"] } }, { id: 21, firstname: "Hidden", lastname: "Agent", login: "hidden@example.test", active: true, group_ids: { "3": ["full"] } }]
          : parsed.pathname === "/api/v1/wasalx/service/catalog"
            ? { slas: [{ id: 4, name: "Urgent", active: true, calendar_id: 5 }], calendars: [{ id: 5, name: "Riyadh hours", active: true, timezone: "Asia/Riyadh" }] }
            : null;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };

  const service = new ZammadRoutingCatalogService(database, secrets);
  const first = await service.get(tenantId);
  const cached = await service.get(tenantId);
  assert.strictEqual(cached, first);
  assert.deepEqual(databaseCalls.map((call) => call.actualTenant), [tenantId, tenantId]);
  assert.deepEqual(databaseCalls[0].values, [tenantId]);
  assert.deepEqual(secretCalls, [{ reference: `secret://tenants/${tenantId}/zammad/service`, owner: { tenantId, instanceId } }]);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.method === "GET"));
  assert.ok(requests.every((request) => request.authorization === "Token token=zammad-api-token-never-returned"));
  assert.deepEqual(first.groups, [
    { id: "2", name: "Operations", active: true, serviceIdentityCanCreate: true },
    { id: "3", name: "Restricted", active: true, serviceIdentityCanCreate: false },
  ]);
  assert.deepEqual(first.owners.map((owner) => ({ id: owner.id, groupIds: owner.groupIds })), [
    { id: "19", groupIds: ["2"] },
  ]);
  assert.deepEqual(first.slas, [{ id: "4", name: "Urgent", active: true, calendarId: "5" }]);
  assert.deepEqual(first.calendars, [{ id: "5", name: "Riyadh hours", active: true, timezone: "Asia/Riyadh" }]);
  assert.equal(JSON.stringify(first).includes("zammad-api-token"), false);
  assert.ok(Date.parse(first.expiresAt) - Date.parse(first.fetchedAt) <= 120_000);

  await service.get(tenantId, true);
  assert.equal(requests.length, 8);
  assert.equal(secretCalls.length, 2);
});

test("activation validation rejects inaccessible groups and stale dependent selections", async () => {
  const service = new ZammadRoutingCatalogService({}, {});
  const reads = [];
  service.get = async (actualTenantId, refresh) => {
    reads.push({ actualTenantId, refresh });
    return ({
    instanceId,
    fetchedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    groups: [{ id: "2", name: "Restricted", active: true, serviceIdentityCanCreate: false }],
    owners: [{ id: "19", name: "Agent", login: "agent@example.test", active: true, groupIds: ["3"] }],
    slas: [],
    calendars: [],
    });
  };
  assert.deepEqual(await service.verifySelection(tenantId, {
    zammadGroupId: "2",
    assignmentMode: "fixed_owner",
    fixedOwnerId: "19",
    slaPolicyId: "4",
    businessHoursMode: "ZAMMAD_CALENDAR",
    businessHoursCalendarId: "5",
  }), [
    "the WasalX service identity cannot create tickets in the selected Zammad group",
    "the selected fixed owner is not assigned to the selected Zammad group",
    "the selected Zammad SLA no longer exists",
    "the selected Zammad calendar no longer exists",
  ]);
  assert.deepEqual(reads, [{ actualTenantId: tenantId, refresh: true }]);
});

test("routing catalog endpoint and portal BFF use tenant permissions and no-store responses", async () => {
  const controller = await readFile(new URL("../services/control-api/src/zammad-routing-catalog.controller.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/zammad/routing-catalogs/route.ts", import.meta.url), "utf8");
  assert.match(controller, /@Controller\("v1\/zammad\/routing-catalogs"\)/);
  assert.equal((controller.match(/@Requires\("group:read"\)/g) ?? []).length, 1);
  assert.equal((controller.match(/@Requires\("group:write"\)/g) ?? []).length, 0);
  assert.equal((controller.match(/@Header\("Cache-Control", "private, no-store"\)/g) ?? []).length, 1);
  assert.doesNotMatch(controller, /@Post\("refresh"\)/);
  assert.match(route, /authenticatePortalRequest\(request, "group:read"\)/);
  assert.doesNotMatch(route, /authenticatePortalRequest\(request, "group:write"\)/);
  assert.match(route, /private, no-store/);
});
