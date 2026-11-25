import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BadRequestException, ForbiddenException } from "../services/control-api/node_modules/@nestjs/common/index.js";
import { DeliveriesController } from "../services/control-api/dist/deliveries.controller.js";
import { PermissionGuard } from "../services/control-api/dist/permission.guard.js";
import { can as canControlPlane } from "../services/control-api/dist/rbac.js";
import {
  authenticatePortalRequest,
  AuthorizationError,
  can as canPortal,
} from "../lib/request-auth.ts";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";

const operationalRoles = ["tenant_owner", "tenant_admin", "supervisor", "agent"];
const permission = "delivery:content:read";
const tenantId = "10000000-0000-4000-8000-000000000001";
const deliveryId = "20000000-0000-4000-8000-000000000002";

const request = {
  id: "request-content-review",
  principal: {
    subject: "user-subject",
    userId: "30000000-0000-4000-8000-000000000003",
    tenantId,
    email: "agent@example.test",
    displayName: "Operations Agent",
    role: "agent",
  },
};
test("delivery list and detail preserve group and direct immutable evidence", async () => {
  let listQuery;
  let detailQuery;
  const database = {
    rows: async (resolvedTenantId, sql, values) => {
      assert.equal(resolvedTenantId, tenantId);
      listQuery = { sql, values };
      return [
        { id: "ticket", delivery_origin: "TICKET", direct_origin: null },
        { id: "workspace", delivery_origin: "GROUP_WORKSPACE", direct_origin: null },
        { id: "bot", delivery_origin: "TICKET", direct_origin: "BOT" },
        { id: "human", delivery_origin: "TICKET", direct_origin: "HUMAN" },
      ];
    },
    withTenant: async (resolvedTenantId, operation) => {
      assert.equal(resolvedTenantId, tenantId);
      return operation({
        query: async (sql, values) => {
          if (sql.includes("SELECT d.id")) {
            detailQuery = { sql, values };
            return { rows: [{ id: deliveryId, destination_kind: "DIRECT", group_name: "Private WhatsApp conversation" }] };
          }
          if (sql.includes("FROM delivery_receipts") || sql.includes("FROM delivery_attempts")) return { rows: [] };
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      });
    },
  };
  const controller = new DeliveriesController(database, { wake: async () => {} });
  const rows = await controller.list(request, deliveryId, "25");
  assert.deepEqual(rows.map((row) => row.id), ["ticket", "workspace", "bot", "human"]);
  assert.deepEqual(listQuery.values, [tenantId, deliveryId, 25]);
  assert.match(listQuery.sql, /WITH cursor AS/);
  assert.match(listQuery.sql, /LEFT JOIN group_bindings b/);
  assert.match(listQuery.sql, /LEFT JOIN whatsapp_groups bound_group/);
  assert.match(listQuery.sql, /LEFT JOIN whatsapp_groups workspace_group/);
  assert.match(listQuery.sql, /d\.delivery_origin/);
  assert.match(listQuery.sql, /d\.direct_origin/);
  assert.match(listQuery.sql, /destination_kind/);
  assert.match(listQuery.sql, /\(d\.created_at,d\.id\)<\(SELECT created_at,id FROM cursor\)/);
  // Destination identifiers may be compared for ordering, never projected as content.
  const withoutDestinationComparisons=sql=>sql.replaceAll("predecessor.external_chat_id=d.external_chat_id","destination_matches")
    .replaceAll("d.external_chat_id IS NOT NULL","destination_exists");
  assert.doesNotMatch(withoutDestinationComparisons(listQuery.sql), /d\.message_body\s+AS|external_chat_id|bot_content/);
  assert.match(listQuery.sql, /AS body_available/);

  const detail = await controller.detail(request, deliveryId);
  assert.equal(detail.destination_kind, "DIRECT");
  assert.deepEqual(detailQuery.values, [tenantId, deliveryId]);
  assert.match(detailQuery.sql, /LEFT JOIN group_bindings b/);
  assert.match(detailQuery.sql, /LEFT JOIN whatsapp_groups workspace_group/);
  assert.doesNotMatch(withoutDestinationComparisons(detailQuery.sql), /d\.message_body\s+AS|external_chat_id|bot_content/);
  assert.match(detailQuery.sql, /AS body_available/);

  assert.throws(() => controller.list(request, "not-a-cursor"), BadRequestException);
  assert.throws(() => controller.list(request, undefined, "201"), BadRequestException);
});

test("portal and control-plane role matrices allow operational delivery review but deny auditors", async () => {
  for (const role of operationalRoles) {
    assert.equal(canPortal(role, permission), true, `portal must allow ${role}`);
    assert.equal(canControlPlane(role, permission), true, `control API must allow ${role}`);
  }
  assert.equal(canPortal("auditor", permission), false);
  assert.equal(canControlPlane("auditor", permission), false);
  assert.equal(canPortal("auditor", "delivery:read"), true);
  assert.equal(canControlPlane("auditor", "delivery:read"), true);
  for (const role of ["supervisor", "agent"]) {
    assert.equal(canPortal(role, "group:write"), false);
    assert.equal(canControlPlane(role, "group:write"), false);
  }
  assert.equal(canPortal("supervisor", "delivery:retry"), true);
  assert.equal(canControlPlane("supervisor", "delivery:retry"), true);
  assert.equal(canPortal("agent", "delivery:retry"), false);
  assert.equal(canControlPlane("agent", "delivery:retry"), false);

  const previousBackend = process.env.PORTAL_DATA_BACKEND;
  const previousRole = process.env.PORTAL_FIXTURE_ROLE;
  process.env.PORTAL_DATA_BACKEND = "fixture";
  try {
    for (const role of operationalRoles) {
      process.env.PORTAL_FIXTURE_ROLE = role;
      const principal = await authenticatePortalRequest(
        new Request("http://127.0.0.1/api/deliveries/delivery-a/content", {
          method: "POST",
        }),
        permission,
      );
      assert.equal(principal.role, role);
    }
    process.env.PORTAL_FIXTURE_ROLE = "auditor";
    await assert.rejects(
      () => authenticatePortalRequest(
        new Request("http://127.0.0.1/api/deliveries/delivery-a/content", {
          method: "POST",
        }),
        permission,
      ),
      AuthorizationError,
    );
  } finally {
    if (previousBackend === undefined) delete process.env.PORTAL_DATA_BACKEND;
    else process.env.PORTAL_DATA_BACKEND = previousBackend;
    if (previousRole === undefined) delete process.env.PORTAL_FIXTURE_ROLE;
    else process.env.PORTAL_FIXTURE_ROLE = previousRole;
  }
});

test("the control API permission guard enforces the same operational-role boundary", () => {
  const guard = new PermissionGuard({
    getAllAndOverride: () => permission,
  });
  const contextFor = (role) => ({
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => ({ principal: { role } }),
    }),
  });
  for (const role of operationalRoles) assert.equal(guard.canActivate(contextFor(role)), true);
  assert.throws(() => guard.canActivate(contextFor("auditor")), ForbiddenException);
});

test("delivery content retrieval is tenant-scoped, explicitly confirmed, and audited without the body", async () => {
  const sensitiveBody = "Customer secret that must never enter audit metadata";
  let selectedValues;
  let auditValues;
  const client = {
    query: async (sql, values = []) => {
      if (sql.includes("SELECT message_body")) {
        assert.match(sql, /WHERE tenant_id = \$1\s+AND id = \$2/u);
        selectedValues = values;
        return {
          rows: [{
            message_body: sensitiveBody,
            zammad_ticket_id: "42",
            zammad_article_id: "9",
          }],
        };
      }
      if (sql.includes("INSERT INTO audit_events")) {
        auditValues = values;
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const database = {
    withTenant: async (resolvedTenantId, operation) => {
      assert.equal(resolvedTenantId, tenantId);
      return operation(client);
    },
  };
  const controller = new DeliveriesController(database, { wake: async () => {} });
  const result = await controller.content(request, deliveryId, {
    purpose: "OPERATIONAL_REVIEW",
    confirmation: "REVEAL",
  });
  assert.equal(result.body, sensitiveBody);
  assert.equal(result.expires_in_seconds, 60);
  assert.match(result.revealed_at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.deepEqual(selectedValues, [tenantId, deliveryId]);
  assert.equal(auditValues[2], "delivery.content_revealed");
  assert.equal(auditValues[4], deliveryId);
  assert.equal(auditValues[7], request.id);
  assert.equal(JSON.stringify(auditValues).includes(sensitiveBody), false);
  assert.deepEqual(auditValues[6], {
    purpose: "OPERATIONAL_REVIEW",
    zammad_ticket_id: "42",
    zammad_article_id: "9",
    revealed_at: result.revealed_at,
  });

  await assert.rejects(
    () => controller.content(request, deliveryId, {
      purpose: "OPERATIONAL_REVIEW",
      confirmation: "",
    }),
    /Explicit operational-review confirmation is required/u,
  );
});

test("both portal and control API content endpoints require the explicit permission", async () => {
  const root = new URL("../", import.meta.url);
  const [portalRoute, controlController, bridge, data, portal] = await Promise.all([
    readFile(new URL("app/api/deliveries/[id]/content/route.ts", root), "utf8"),
    readFile(new URL("services/control-api/src/deliveries.controller.ts", root), "utf8"),
    readFile(new URL("lib/control-plane-data.ts", root), "utf8"),
    readFile(new URL("lib/data.ts", root), "utf8"),
    readTenantPortalSource(),
  ]);
  assert.match(portalRoute, /authenticatePortalRequest\(request, "delivery:content:read"\)/u);
  assert.match(controlController, /@Post\(":id\/content"\)[\s\S]*?@Requires\("delivery:content:read"\)/u);
  assert.match(controlController, /@Header\("cache-control", "private, no-store"\)/u);
  assert.doesNotMatch(controlController, /can\(request\.principal\.role, "group:write"\)/u);
  assert.match(bridge, /\/v1\/deliveries\/\$\{encodeURIComponent\(id\)\}\/content/u);
  assert.match(bridge, /body_available: row\.body_available === true/u);
  assert.match(data, /if\(controlPlaneMode\)return\(await controlPlane\(\)\)\.revealDeliveryContent\(id\)/u);
  assert.match(portal, /const canReadDeliveryContent = !isPrivateDemo && can\(role, "delivery:content:read"\)/u);
  assert.match(portal, /canReadContent=\{canReadDeliveryContent\}/u);
  assert.match(portal, /canReadContent && !compact && row\.body_available === true/u);
  assert.match(portal, /if \(!canReadContent \|\| !revealId/u);
});
