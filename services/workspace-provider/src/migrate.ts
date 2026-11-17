import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { loadMigrationDatabaseUrl } from "./config.js";

const client = new Client({ connectionString: loadMigrationDatabaseUrl(), application_name: "wasalx-workspace-provider-migration", statement_timeout: 60_000 });
await client.connect();
try {
  const directory = join(dirname(fileURLToPath(import.meta.url)), "../migrations");
  const migrations = (await readdir(directory))
    .filter((entry) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(entry))
    .sort();
  if (migrations.length === 0) throw new Error("Workspace provider migrations are missing");
  await client.query("SELECT pg_advisory_lock(hashtext('wasalx-workspace-provider-migrations'))");
  try {
    for (const migration of migrations) {
      await client.query("BEGIN");
      try {
        await client.query(await readFile(join(directory, migration), "utf8"));
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('wasalx-workspace-provider-migrations'))");
  }
} finally { await client.end(); }
