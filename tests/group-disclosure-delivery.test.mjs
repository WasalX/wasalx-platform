import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { InboundRepository } from "../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js";

const migrationUrl = new URL("../services/control-api/migrations/0032_group_disclosure_delivery.sql", import.meta.url);
const outboxRepositoryUrl = new URL("../services/connector-worker/src/repository.ts", import.meta.url);
const deliveriesControllerUrl = new URL("../services/control-api/src/deliveries.controller.ts", import.meta.url);

const tenantId = "10000000-0000-4000-8000-000000000001";
const connectionId = "20000000-0000-4000-8000-000000000001";
const bindingId = "30000000-0000-4000-8000-000000000001";

class DisclosureDatabase {
  deliveries = new Map();
  disclosures = [];
  links = [];

  async query(sql, params = []) {
    const statement = String(sql);
    if(statement.includes('SELECT correlation.zammad_ticket_id,correlation.zammad_ticket_number,execution.mode'))return{rows:[],rowCount:0};
    if(statement.startsWith('UPDATE ticket_event_executions execution'))return{rows:[],rowCount:0};
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement) || statement.includes("set_config")) {
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("SELECT id,content_redacted_at FROM delivery_outbox")) {
      const delivery = this.deliveries.get(params[1]);
      return { rows: delivery ? [{ id: delivery.id, content_redacted_at: null }] : [], rowCount: delivery ? 1 : 0 };
    }
    if (statement.startsWith("SELECT 1 FROM group_bindings")) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (statement.includes("SELECT 1 FROM group_disclosure_deliveries")) {
      const exists = this.disclosures.some((row) =>
        row.tenantId === params[0]
        && row.bindingId === params[1]
        && row.digest === params[2]
        && ["QUEUED", "SENT", "OUTCOME_UNKNOWN"].includes(row.state),
      );
      return { rows: exists ? [{ ok: 1 }] : [], rowCount: exists ? 1 : 0 };
    }
    if (statement.startsWith("INSERT INTO delivery_outbox")) {
      const id = `40000000-0000-4000-8000-${String(this.deliveries.size + 1).padStart(12, "0")}`;
      this.deliveries.set(params[7], { id, body: params[5], replyToMessageId:params[6], idempotencyKey: params[7] });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (statement.includes("INSERT INTO group_disclosure_deliveries")) {
      this.disclosures.push({ tenantId: params[0], bindingId: params[1], digest: params[2], deliveryId: params[3], state: "QUEUED" });
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("INSERT INTO delivery_ticket_links")) {
      this.links.push(params);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${statement}`);
  }

  release() {}
}

function event(messageId) {
  return { id: crypto.randomUUID(), tenantId, connectionId, provider: "waha", providerEventId: `event-${messageId}`, eventType: "message", payload: {}, attempts: 1 };
}

function message(messageId) {
  return {
    provider: "waha", connectionId, eventId: `event-${messageId}`, messageId,
    groupId: "120363000000000000@g.us", participantId: "12025550129@c.us",
    text: "ABC1234567", fromApi: false, timestamp: new Date().toISOString(),
  };
}

const context = { bindingId };
const acknowledgementKey = (messageId) => `ack:${createHash("sha256").update(`wasalx-ack\x1f${tenantId}\x1f${connectionId}\x1f${messageId}`, "utf8").digest("hex")}`;

test("disclosure delivery schema is tenant-isolated and fences duplicate recovery", async () => {
  const [migration, repository, controller] = await Promise.all([
    readFile(migrationUrl, "utf8"), readFile(outboxRepositoryUrl, "utf8"), readFile(deliveriesControllerUrl, "utf8"),
  ]);
  assert.match(migration, /CREATE TABLE group_disclosure_deliveries/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /FOREIGN KEY \(tenant_id,group_binding_id\)/);
  assert.match(migration, /FOREIGN KEY \(tenant_id,delivery_id\)/);
  assert.match(migration, /disclosure_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /WHERE state IN \('QUEUED','SENT','OUTCOME_UNKNOWN'\)/);
  assert.match(migration, /REVOKE ALL ON group_disclosure_deliveries FROM PUBLIC, wasalx_app/);
  assert.match(migration, /GRANT UPDATE \(state,external_message_id,updated_at\)/);
  assert.match(repository, /SET state='SENT',external_message_id=\$1/);
  assert.match(repository, /SET state='FAILED',updated_at=now\(\)/);
  assert.match(repository, /SET state='OUTCOME_UNKNOWN',updated_at=now\(\)/);
  assert.match(controller, /SET state='QUEUED',updated_at=now\(\)/);
  assert.match(controller, /A newer delivery already carries this group disclosure/);
  assert.match(controller, /SELECT 1 FROM group_bindings WHERE tenant_id=\$1 AND id=\$2 FOR UPDATE/);
});

test("the same disclosure is queued once per group and a changed version is queued once again", async () => {
  const database = new DisclosureDatabase();
  const repository = new InboundRepository({ connect: async () => database });
  const firstDisclosure = "Operational references may be copied to our support case system.";
  const changedDisclosure = "Operational references are copied to WasalX for support case processing.";

  await repository.enqueueAcknowledgement(event("message-1"), context, message("message-1"), "Cases 10380", ["10380"], firstDisclosure);
  await repository.enqueueAcknowledgement(event("message-2"), context, message("message-2"), "Cases 10381", ["10381"], firstDisclosure);
  await repository.enqueueAcknowledgement(event("message-1"), context, message("message-1"), "Cases 10380", ["10380"], firstDisclosure);
  await repository.enqueueAcknowledgement(event("message-3"), context, message("message-3"), "Cases 10382", ["10382"], changedDisclosure);

  assert.equal(database.deliveries.get(acknowledgementKey("message-1")).replyToMessageId,"message-1","ordinary inbound keeps its provider message as the reply target");
  const reviewEvent={...event("review-event"),eventType:"quarantine.reprocess"},reviewMessage=message("review:review-id:review-event");
  await assert.rejects(repository.enqueueAcknowledgement(reviewEvent,context,reviewMessage,"Case 10383",["10383"],null),/Original provider reply target is unavailable/);
  await repository.enqueueAcknowledgement(reviewEvent,context,reviewMessage,"Case 10383",["10383"],null,"false_120363000000000000@g.us_PROVIDER");
  assert.equal(database.deliveries.get(acknowledgementKey(reviewMessage.messageId)).replyToMessageId,"false_120363000000000000@g.us_PROVIDER");

  assert.equal(database.deliveries.size, 4, "inbound replay must reuse the original acknowledgement and reprocess adds one separately keyed delivery");
  assert.equal(database.disclosures.length, 2, "only one attempt per disclosure version is scheduled");
  assert.match(database.deliveries.get(acknowledgementKey("message-1")).body, /support case system/);
  assert.doesNotMatch(database.deliveries.get(acknowledgementKey("message-2")).body, /support case system/);
  assert.match(database.deliveries.get(acknowledgementKey("message-3")).body, /copied to WasalX/);
  assert.equal(database.disclosures.some((row) => row.digest.includes("Operational")), false, "only a digest is retained");
  assert.equal(new Set(database.disclosures.map((row) => row.digest)).size, 2);
});
