import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Client } from "pg";

const lockId = 8_724_591_307;
const commercialGoBoundary = "0133_commercial_go_boundaries.sql";
const cleanInstallMarker = "__wasalx_clean_install_0133__";
const nonTransactionalMarker = "-- wasalx:non-transactional";
const statementBreak = "-- wasalx:statement-break";
const concurrentIndex = /^CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z][a-z0-9_]*)\s+ON\b[\s\S]*;$/iu;

type MigrationClient = Pick<Client, "query">;
type MigrationPlan = { transactional: true; statements: [string] } | {
  transactional: false;
  statements: Array<{ sql: string; indexName: string }>;
};

export function parseMigrationSql(sql: string): MigrationPlan {
  const normalized = sql.replace(/\r\n?/gu, "\n");
  const marked = normalized.startsWith(`${nonTransactionalMarker}\n`);
  if (!marked) {
    if (normalized.includes(nonTransactionalMarker) || normalized.includes(statementBreak)) {
      throw new Error("Migration directives must begin with the non-transactional marker");
    }
    return { transactional: true, statements: [sql] };
  }

  const chunks = normalized.slice(nonTransactionalMarker.length + 1).split(`\n${statementBreak}\n`);
  const statements = chunks.map((chunk) => {
    const statement = chunk.trim();
    const executable = statement.replace(/^(?:--[^\n]*(?:\n|$)\s*)+/u, "").trim();
    const match = concurrentIndex.exec(executable);
    if (!match || executable.slice(0, -1).includes(";")) {
      throw new Error("Non-transactional migrations may contain only one idempotent concurrent index per statement");
    }
    return { sql: statement, indexName: match[1]! };
  });
  if (statements.length === 0) throw new Error("Non-transactional migration is empty");
  return { transactional: false, statements };
}

export async function executeMigrationSql(client: MigrationClient, sql: string) {
  const plan = parseMigrationSql(sql);
  if (plan.transactional) {
    await client.query(plan.statements[0]);
    return;
  }
  for (const statement of plan.statements) {
    const existing = await client.query<{indisvalid:boolean;indisready:boolean}>(`SELECT index_record.indisvalid,index_record.indisready
      FROM pg_class index_class
      JOIN pg_namespace namespace_record ON namespace_record.oid=index_class.relnamespace AND namespace_record.nspname='public'
      JOIN pg_index index_record ON index_record.indexrelid=index_class.oid
      WHERE index_class.relname=$1`, [statement.indexName]);
    if (existing.rows[0] && (!existing.rows[0].indisvalid || !existing.rows[0].indisready)) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public."${statement.indexName}"`);
    }
    await client.query(statement.sql);
  }
}

type Migration = { name: string; sql: string; checksum: string };

async function revokeMigrationLedgerAccess(client: MigrationClient) {
  await client.query("REVOKE ALL ON TABLE public.wasalx_schema_migrations FROM PUBLIC");
  const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname='wasalx_app'");
  if (role.rows.length > 0) {
    await client.query("REVOKE ALL ON TABLE public.wasalx_schema_migrations FROM wasalx_app");
  }
}

async function protectMigrationLedger(client: MigrationClient, required = false) {
  const relation = await client.query<{ ledger: string | null }>(
    "SELECT to_regclass('public.wasalx_schema_migrations')::text AS ledger",
  );
  if (!relation.rows[0]?.ledger) {
    if (required) throw new Error("The WasalX migration ledger is missing");
    return false;
  }
  await client.query("BEGIN");
  try {
    await client.query("LOCK TABLE public.wasalx_schema_migrations IN ACCESS EXCLUSIVE MODE");
    await revokeMigrationLedgerAccess(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return true;
}

function rejectCommercialGoUpgrade(): never {
  const error = new Error("existing tenants or a partial schema require the WasalX adoption/upgrade lifecycle before this release") as Error & { code: string };
  error.code = "55000";
  throw error;
}

async function assertCommercialGoDatabaseIsClean(
  client: MigrationClient,
  migrations: Migration[],
  manifestChecksum: string,
) {
  const boundaryIndex = migrations.findIndex(({ name }) => name === commercialGoBoundary);
  if (boundaryIndex < 0) throw new Error(`Required migration ${commercialGoBoundary} is missing`);
  const relations = await client.query<{ migrations: string | null; tenants: string | null }>(
    "SELECT to_regclass('public.wasalx_schema_migrations')::text AS migrations,to_regclass('public.tenants')::text AS tenants",
  );
  const migrationRelation = relations.rows[0]?.migrations;
  const tenantRelation = relations.rows[0]?.tenants;
  if (!migrationRelation && !tenantRelation) {
    await client.query("BEGIN");
    try {
      await client.query(`CREATE TABLE public.wasalx_schema_migrations (
        name text PRIMARY KEY,
        checksum_sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      await revokeMigrationLedgerAccess(client);
      await client.query(
        "INSERT INTO public.wasalx_schema_migrations (name,checksum_sha256) VALUES ($1,$2)",
        [cleanInstallMarker, manifestChecksum],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    return;
  }
  if (!migrationRelation) rejectCommercialGoUpgrade();
  const applied = await client.query<{ name: string; checksum_sha256: string }>(
    "SELECT name,checksum_sha256 FROM public.wasalx_schema_migrations ORDER BY name",
  );
  const marker = applied.rows.find(({ name }) => name === cleanInstallMarker);
  const realApplied = applied.rows.filter(({ name }) => name !== cleanInstallMarker);
  const exactPrefix = realApplied.every((row, index) => {
    const expected = migrations[index];
    return expected?.name === row.name && expected.checksum === row.checksum_sha256;
  });
  if (!exactPrefix || realApplied.length > migrations.length) rejectCommercialGoUpgrade();
  if (marker) {
    if (
      marker.checksum_sha256 !== manifestChecksum ||
      realApplied.length > boundaryIndex ||
      realApplied.some(({ name }) => name === commercialGoBoundary) ||
      Boolean(tenantRelation) !== (realApplied.length > 0)
    ) rejectCommercialGoUpgrade();
    if (!tenantRelation) return;
  } else {
    if (!tenantRelation) rejectCommercialGoUpgrade();
    if (realApplied.some(({ name }) => name === commercialGoBoundary)) return;
    if (realApplied.length !== boundaryIndex) rejectCommercialGoUpgrade();
  }
  const tenants = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM public.tenants");
  if (tenants.rows[0]?.count !== "0") rejectCommercialGoUpgrade();
}

export async function connectMigrationDatabase(connectionString: string) {
  for (let attempt = 1; ; attempt++) {
    const client = new Client({ connectionString, application_name: "wasalx-migration", connectionTimeoutMillis: 10_000 });
    client.on("error", () => { /* Query rejections retain the actionable PostgreSQL failure. */ });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      // Only connection refusal before any SQL is safe to retry. Never replay migrations.
      if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED" || attempt >= 5) throw error;
      process.stderr.write(`Database connection refused; waiting before connection attempt ${attempt + 1}/5\n`);
      await setTimeout(2_000);
    }
  }
}

export async function migrate(migrationsPath: string) {
  const connectionString = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL is required");
  const directory = resolve(migrationsPath);
  const files = (await readdir(directory)).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort();
  if (files.length === 0) throw new Error(`No migrations were found in ${directory}`);
  const migrations = await Promise.all(files.map(async (name) => {
    const sql = await readFile(resolve(directory, name), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
  const manifestChecksum = createHash("sha256")
    .update(JSON.stringify(migrations.map(({ name, checksum }) => [name, checksum])))
    .digest("hex");
  if (!migrations.some(({ name }) => name === commercialGoBoundary)) {
    throw new Error(`Required migration ${commercialGoBoundary} is missing`);
  }

  const client = await connectMigrationDatabase(connectionString);
  try {
    await client.query("SET lock_timeout = '30s'");
    await client.query("SET statement_timeout = '10min'");
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [lockId]);
    if (lock.rows[0]?.locked !== true) {
      const error = new Error("another WasalX migration is already running") as Error & { code: string };
      error.code = "55P03";
      throw error;
    }
    await protectMigrationLedger(client);
    await assertCommercialGoDatabaseIsClean(client, migrations, manifestChecksum);
    for (const { name: file, sql, checksum } of migrations) {
      const existing = await client.query<{checksum_sha256:string}>("SELECT checksum_sha256 FROM public.wasalx_schema_migrations WHERE name=$1", [file]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum_sha256 !== checksum) throw new Error(`Applied migration ${file} has been modified`);
        process.stdout.write(`${file}: already applied\n`);
        continue;
      }
      const plan = parseMigrationSql(sql);
      if (plan.transactional) await client.query("BEGIN");
      try {
        await executeMigrationSql(client, sql);
        await revokeMigrationLedgerAccess(client);
        await client.query("INSERT INTO public.wasalx_schema_migrations (name,checksum_sha256) VALUES ($1,$2)", [file, checksum]);
        if (file === commercialGoBoundary) {
          await client.query("DELETE FROM public.wasalx_schema_migrations WHERE name=$1", [cleanInstallMarker]);
        }
        if (plan.transactional) await client.query("COMMIT");
        process.stdout.write(`${file}: applied\n`);
      } catch (error) {
        if (plan.transactional) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    await protectMigrationLedger(client, true);
    const finalLedger = await client.query<{ name: string; checksum_sha256: string }>(
      "SELECT name,checksum_sha256 FROM public.wasalx_schema_migrations ORDER BY name",
    );
    if (
      finalLedger.rows.length !== migrations.length ||
      finalLedger.rows.some((row, index) => row.name !== migrations[index]?.name || row.checksum_sha256 !== migrations[index]?.checksum)
    ) rejectCommercialGoUpgrade();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}
