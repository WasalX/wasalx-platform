import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { QuarantineController } from "../services/control-api/dist/quarantine.controller.js";
import { DeliveriesController } from "../services/control-api/dist/deliveries.controller.js";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";

test("delivery inbox lookup binds the conversation, tenant and native ticket without exposing its ID", async () => {
  let capturedSql;
  const id = "12000000-0000-4000-8000-000000000001";
  const request = { principal: { tenantId: "tenant-1", role: "tenant_owner" } };
  const controller = new DeliveriesController({ rows: async (tenant, sql, values) => {
    assert.equal(tenant, request.principal.tenantId);
    assert.deepEqual(values, [tenant, id]);
    capturedSql = sql;
    return [{ zammad_ticket_number: "91022" }];
  } }, {});
  assert.deepEqual(await controller.agentDestination(request, id), { ticket_number: "91022" });
  assert.match(capturedSql, /conversation\.tenant_id=delivery\.tenant_id/u);
  assert.match(capturedSql, /conversation\.id=delivery\.bot_conversation_id/u);
  assert.match(capturedSql, /conversation\.zammad_ticket_id=delivery\.zammad_ticket_id/u);
  assert.doesNotMatch(capturedSql, /agent_base_url/u);
  await assert.rejects(() => controller.agentDestination({ principal: { ...request.principal, role: "auditor" } }, id), { name: "ForbiddenException" });
  for (const rows of [[], [{ zammad_ticket_id: "22" }], [{ zammad_ticket_number: "../22" }]]) {
    const missing = new DeliveriesController({ rows: async () => rows }, {});
    await assert.rejects(() => missing.agentDestination(request, id), { name: "NotFoundException" });
  }
});

test("delivery API resolves friendly Zammad numbers without confusing internal IDs", async () => {
  const controller = await readFile(new URL("../services/control-api/src/deliveries.controller.ts", import.meta.url), "utf8");

  assert.ok((controller.match(/CASE WHEN d\.zammad_ticket_id IS NULL THEN NULL/g) ?? []).length >= 2);
  assert.ok((controller.match(/bot_conversations direct_conversation/g) ?? []).length >= 2);
  assert.ok((controller.match(/case_correlations correlation/g) ?? []).length >= 2);
  assert.ok((controller.match(/direct_conversation\.tenant_id\s*=\s*d\.tenant_id/g) ?? []).length >= 2);
  assert.ok((controller.match(/correlation\.tenant_id\s*=\s*d\.tenant_id/g) ?? []).length >= 2);
  assert.ok((controller.match(/direct_conversation\.zammad_ticket_number/g) ?? []).length >= 2);
  assert.ok((controller.match(/correlated_case\.zammad_ticket_number/g) ?? []).length >= 2);
  assert.ok((controller.match(/AS ticket_number/g) ?? []).length >= 2);
});

test("portal strips internal ticket IDs and makes ticketless deliveries non-navigable", async () => {
  const [bridge, portal, english, arabic] = await Promise.all([
    readFile(new URL("../lib/control-plane-data.ts", import.meta.url), "utf8"),
    readTenantPortalSource(),
    readFile(new URL("../lib/i18n/messages/en/tenant.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/i18n/messages/ar/tenant.ts", import.meta.url), "utf8"),
  ]);

  assert.match(bridge, /delete publicRow\.zammad_ticket_id/u);
  assert.match(bridge, /ticket_number: friendlyTicketNumber\(row\.ticket_number\)/u);
  assert.doesNotMatch(bridge, /ticket_number: `#\$\{row\.zammad_ticket_id\}`/u);
  assert.match(portal, /ticketNumber \? openCase \?/u);
  assert.match(portal, /openCase\(ticketNumber\)/u);
  assert.doesNotMatch(portal, /directDestination|agentTicketView/u);
  assert.match(portal, /typeof delivery\.ticket_number === "string" \? delivery\.ticket_number : t\("tenant\.deliveries\.table\.noCase"\)/u);
  assert.match(portal, /tenant\.deliveries\.table\.noCase/u);
  assert.match(english, /"tenant\.deliveries\.table\.noCase": "No support case"/u);
  assert.match(arabic, /"tenant\.deliveries\.table\.noCase": "لا توجد حالة دعم"/u);
});

test("review API returns the same friendly ticket number used by failed deliveries", async () => {
  let capturedSql = "";
  const database = {
    rows: async (tenantId, sql) => {
      assert.equal(tenantId, "tenant-1");
      capturedSql = sql;
      return [{ id: "review-1", zammad_ticket_id: "22", ticket_number: "91022" }];
    },
  };
  const controller = new QuarantineController(database, {}, {});
  const rows = await controller.list({ principal: { tenantId: "tenant-1" } });
  assert.equal(rows[0].ticket_number, "91022");
  assert.match(capturedSql, /direct_conversation\.tenant_id=d\.tenant_id/u);
  assert.match(capturedSql, /correlation\.tenant_id=d\.tenant_id/u);
  assert.match(capturedSql, /AS ticket_number/u);
});
