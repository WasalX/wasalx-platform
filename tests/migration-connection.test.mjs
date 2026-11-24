import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "../services/control-api/node_modules/pg/lib/index.js";
import { connectMigrationDatabase, executeMigrationSql } from "../services/control-api/dist/migrate.js";
const { Client } = pg;

test("Meta inbox app constraint is added without a table scan and validated in a later migration", async () => {
  const directory = new URL("../services/control-api/migrations/", import.meta.url);
  const add = "0202_meta_webhook_app_binding.sql";
  const validate = "0203_validate_meta_webhook_app_binding.sql";
  const [addition, validation] = await Promise.all([add, validate].map(file => readFile(new URL(file, directory), "utf8")));
  assert.match(addition, /ADD CONSTRAINT event_inbox_meta_webhook_app CHECK \([\s\S]+?\) NOT VALID;/u);
  assert.doesNotMatch(addition, /VALIDATE CONSTRAINT/u);
  assert.match(validation, /ALTER TABLE public\.event_inbox VALIDATE CONSTRAINT event_inbox_meta_webhook_app;/u);
});

test("migration startup retries only refused connections, never SQL or authentication", async (t) => {
  const clients = [], closed = [];
  let failures = 4, code = "ECONNREFUSED", queries = 0;
  t.mock.method(Client.prototype, "connect", async function () {
    clients.push(this);
    if (failures-- > 0) throw Object.assign(new Error("connection failure"), { code });
  });
  t.mock.method(Client.prototype, "end", async function () { closed.push(this); });
  t.mock.method(Client.prototype, "query", async () => {
    queries++;
    throw Object.assign(new Error("query failure"), { code: "ECONNREFUSED" });
  });
  const client = await connectMigrationDatabase("postgresql://localhost/unused");
  assert.equal(clients.length, 5);
  assert.notEqual(clients[0], client);
  assert.deepEqual(closed, clients.slice(0, 4));
  assert.equal(new Set(clients).size, 5);
  assert.equal(queries, 0);
  await assert.rejects(executeMigrationSql(client, "SELECT 1"), /query failure/);
  assert.equal(queries, 1);
  assert.equal(clients.length, 5);
  await client.end();

  for (const failureCode of ["28P01", "CERT_HAS_EXPIRED", "ECONNREFUSED"]) {
    clients.length = closed.length = 0;
    failures = 100;
    code = failureCode;
    await assert.rejects(connectMigrationDatabase("postgresql://localhost/unused"), { code });
    assert.equal(clients.length, code === "ECONNREFUSED" ? 5 : 1);
    assert.deepEqual(closed, clients);
    assert.equal(new Set(clients).size, clients.length);
  }
});
