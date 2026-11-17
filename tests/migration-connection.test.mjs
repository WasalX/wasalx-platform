import assert from "node:assert/strict";
import test from "node:test";
import pg from "../services/control-api/node_modules/pg/lib/index.js";
import { connectMigrationDatabase, executeMigrationSql } from "../services/control-api/dist/migrate.js";
const { Client } = pg;

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
