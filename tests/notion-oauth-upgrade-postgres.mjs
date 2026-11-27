import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { SecretCleanupRepository } from "../services/control-api/dist/secret-cleanup.repository.js";
import { SecretCleanupProcessor } from "../services/control-api/dist/secret-cleanup.service.js";
import { withFixtureTenant } from "./meta-routing-fixture.mjs";

const beginSql =
  "SELECT * FROM app.begin_client_routing_notion_oauth($1,$2,$3,$4)";
const oldClaimSql =
  "SELECT * FROM app.claim_client_routing_notion_oauth($1,$2)";
const readSql =
  "SELECT status FROM app.read_client_routing_notion_oauth($1,$2)";
const redirectUri = "https://app.example.invalid/oauth/notion/callback";
const digest = () => randomBytes(32).toString("hex");

export async function seedNotionOAuthUpgrade(admin) {
  const tenantId = randomUUID();
  const actor = randomUUID();
  const otherActor = randomUUID();
  const workspaceId = randomUUID();
  return withFixtureTenant(admin, tenantId, async () => {
    await admin.query(
      "INSERT INTO tenants(id,name,slug,state) VALUES($1,'Notion upgrade',$2,'ACTIVE')",
      [tenantId, `notion-upgrade-${tenantId}`],
    );
    for (const userId of [actor, otherActor]) {
      await admin.query(
        "INSERT INTO users(id,oidc_subject,email,display_name) VALUES($1,$2,$3,'OAuth fixture')",
        [userId, userId, `${userId}@example.invalid`],
      );
      await admin.query(
        "INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'tenant_admin')",
        [tenantId, userId],
      );
    }

    async function begin(requester = actor, integrationId = null) {
      const hash = digest();
      const {
        rows: [row],
      } = await admin.query(beginSql, [
        requester,
        hash,
        redirectUri,
        integrationId,
      ]);
      assert.ok(row);
      return {
        id: row.integration_id,
        reference: row.secret_reference,
        hash,
        requester,
      };
    }
    async function claim(attempt) {
      assert.equal(
        (await admin.query(oldClaimSql, [attempt.hash, attempt.requester]))
          .rowCount,
        1,
      );
    }
    async function activate(id, workspace) {
      assert.equal(
        (
          await admin.query(
            "SELECT * FROM app.complete_client_routing_notion_oauth($1,$2,$3,$4)",
            [id, actor, "Legacy Notion workspace", workspace],
          )
        ).rowCount,
        1,
      );
    }

    const original = await begin();
    await claim(original);
    await activate(original.id, workspaceId);
    const stuck = await begin(actor, original.id);
    await claim(stuck);
    for (const [attempt, hours] of [
      [original, 3],
      [stuck, 2],
    ]) {
      await admin.query(
        `UPDATE client_routing_oauth_states
        SET created_at=created_at-$2*interval '1 hour',
            consumed_at=consumed_at-$2*interval '1 hour',
            expires_at=expires_at-$2*interval '1 hour'
        WHERE state_sha256=$1`,
        [attempt.hash, hours],
      );
    }
    await admin.query(
      "UPDATE client_routing_integrations SET updated_at=now()-interval '2 hours' WHERE id=$1",
      [stuck.id],
    );

    const attempted = await begin();
    await claim(attempted);
    await admin.query(
      "UPDATE secret_cleanup_outbox SET attempts=1 WHERE routing_integration_id=$1",
      [attempted.id],
    );
    const unclaimed = await begin();
    const differentActor = await begin(otherActor, unclaimed.id);
    await claim(differentActor);
    await admin.query(
      "UPDATE secret_cleanup_outbox SET state='FAILED_RETRYABLE' WHERE routing_integration_id=$1",
      [differentActor.id],
    );

    const active = await begin();
    await claim(active);
    await activate(active.id, randomUUID());
    const abandoned = await begin();

    // Give a different provider the same reference mismatch as a repair control.
    const httpId = randomUUID();
    const referenceFor = (id) =>
      `secret://tenants/${tenantId}/routing/integrations/${id}`;
    await admin.query(
      `INSERT INTO client_routing_integrations(id,tenant_id,provider,display_name,secret_reference,created_by)
      VALUES($1,$2,'HTTP_JSON','HTTP upgrade fixture',$3,$4)`,
      [httpId, tenantId, referenceFor(randomUUID()), actor],
    );
    await admin.query(
      "UPDATE client_routing_integrations SET secret_reference=$2 WHERE id=$1",
      [httpId, referenceFor(httpId)],
    );
    const http = { id: httpId, reference: referenceFor(httpId) };

    const outbox = await routingOutbox(admin, tenantId);
    for (const { id, reference } of [
      stuck,
      attempted,
      differentActor,
      active,
      abandoned,
      http,
    ]) {
      assert.ok(outbox.has(id), "The pre-0206 integration has a cleanup task");
      assert.notEqual(
        outbox.get(id).secret_reference,
        reference,
        "The pre-0206 cleanup reference differs from its owner",
      );
    }
    return {
      tenantId,
      actor,
      otherActor,
      workspaceId,
      stuck,
      attempted,
      differentActor,
      active,
      abandoned,
      http,
      outbox,
    };
  });
}

async function routingOutbox(admin, tenantId) {
  const { rows } = await admin.query(
    `SELECT routing_integration_id,secret_reference,state,attempts
    FROM secret_cleanup_outbox WHERE tenant_id=$1 AND cleanup_kind='ROUTING_INTEGRATION_SECRET'`,
    [tenantId],
  );
  return new Map(
    rows.map(({ routing_integration_id, ...row }) => [
      routing_integration_id,
      row,
    ]),
  );
}

export async function verifyNotionOAuthUpgrade(
  admin,
  fixture,
  appUrl,
  cleanupUrl,
) {
  const {
    tenantId,
    actor,
    otherActor,
    workspaceId,
    stuck,
    attempted,
    differentActor,
    active,
    abandoned,
    http,
    outbox,
  } = fixture;
  const repaired = await routingOutbox(admin, tenantId);
  for (const { id, reference } of [stuck, active, abandoned]) {
    assert.deepEqual(
      repaired.get(id),
      { state: "QUEUED", attempts: 0, secret_reference: reference },
      "0206 repairs the queued, untouched Notion cleanup reference",
    );
  }
  for (const { id } of [attempted, differentActor, http]) {
    assert.deepEqual(
      repaired.get(id),
      outbox.get(id),
      "0206 preserves excluded cleanup references",
    );
  }

  const app = new Client({ connectionString: appUrl });
  await app.connect();
  try {
    await withFixtureTenant(app, tenantId, async () => {
      for (const [attempt, status] of [
        [stuck, "CLAIMED"],
        [attempted, "UNRESOLVED"],
        [differentActor, "UNRESOLVED"],
      ]) {
        assert.deepEqual(
          (await app.query(readSql, [attempt.hash, attempt.requester])).rows,
          [{ status }],
          `0206 classifies the consumed legacy attempt as ${status}`,
        );
      }
      const reconnectHash = digest();
      assert.deepEqual(
        (
          await app.query(beginSql, [
            actor,
            reconnectHash,
            redirectUri,
            active.id,
          ])
        ).rows,
        [{ integration_id: active.id, secret_reference: active.reference }],
      );
      assert.equal(
        (await app.query(oldClaimSql, [reconnectHash, actor])).rowCount,
        0,
        "The previous release cannot claim a new reconnect on an active integration",
      );
      assert.deepEqual(
        (await app.query(readSql, [reconnectHash, actor])).rows,
        [{ status: "PENDING" }],
      );
      assert.deepEqual(
        (
          await app.query(
            "SELECT state FROM client_routing_integrations WHERE id=$1",
            [active.id],
          )
        ).rows,
        [{ state: "CONNECTED" }],
      );
    });
  } finally {
    await app.end();
  }

  const previousUrl = process.env.SECRET_CLEANUP_DATABASE_URL;
  process.env.SECRET_CLEANUP_DATABASE_URL = cleanupUrl.toString();
  const repository = new SecretCleanupRepository();
  const deleted = [];
  const cleanup = new SecretCleanupProcessor(
    repository,
    {
      deleteSecret: async (reference) => {
        deleted.push(reference);
      },
    },
    100,
  );
  try {
    await cleanup.drain();
    const { rows } = await admin.query(
      "SELECT state,external_account_id FROM client_routing_integrations WHERE id=$1",
      [stuck.id],
    );
    assert.deepEqual(
      { integration: rows[0], deleted },
      {
        integration: { state: "CONNECTING", external_account_id: workspaceId },
        deleted: [],
      },
      "Expiry neither revokes the stuck legacy reconnect nor deletes its live credential",
    );

    await admin.query(
      "UPDATE client_routing_integrations SET state='REVOKED' WHERE id=$1",
      [abandoned.id],
    );
    await cleanup.drain();
    assert.deepEqual(
      deleted,
      [abandoned.reference],
      "Cleanup deletes the abandoned setup's real credential",
    );
    assert.equal(
      (await routingOutbox(admin, tenantId)).get(abandoned.id).state,
      "SUCCEEDED",
    );
  } finally {
    if (previousUrl === undefined)
      delete process.env.SECRET_CLEANUP_DATABASE_URL;
    else process.env.SECRET_CLEANUP_DATABASE_URL = previousUrl;
    await repository.onModuleDestroy();
  }

  await withFixtureTenant(admin, tenantId, async () => {
    await admin.query("DELETE FROM secret_cleanup_outbox WHERE tenant_id=$1", [
      tenantId,
    ]);
    await admin.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
      [actor, otherActor],
    ]);
  });
}
