import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Only the named routines in the disposable test database resolve the fixture clock.
export async function withPostgresClock(admin, routine, run) {
  assert.match(routine, /^app\.[a-z_]+\([a-z]+(?:,[a-z]+)*\)$/u);
  const schema = "test_clock_" + randomUUID().replaceAll("-", "");
  const applicationPath = "pg_catalog, public, app, pg_temp";

  await admin.query("BEGIN");
  try {
    const { rows: [binding] } = await admin.query(
      "SELECT proconfig, prosrc FROM pg_catalog.pg_proc WHERE oid = $1::regprocedure", [routine],
    );
    assert(binding?.proconfig?.includes("search_path=" + applicationPath), routine + " search path changed");
    assert.match(binding.prosrc, /(?<![.\w])clock_timestamp\(\)/u, routine + " must resolve the clock by search path");
    await admin.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.time (instant timestamptz);
      INSERT INTO ${schema}.time VALUES (NULL);
      CREATE FUNCTION ${schema}.clock_timestamp() RETURNS timestamptz
        LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
        AS 'SELECT COALESCE(instant, pg_catalog.clock_timestamp()) FROM ${schema}.time';
      GRANT USAGE ON SCHEMA ${schema} TO PUBLIC;
      ALTER FUNCTION ${routine} SET search_path = ${schema}, ${applicationPath}`);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }

  try {
    return await run(async instant => {
      const result = await admin.query(`UPDATE ${schema}.time SET instant = $1`, [instant]);
      assert.equal(result.rowCount, 1, "Fixture clock update");
    });
  } finally {
    await admin.query(`ALTER FUNCTION ${routine} SET search_path = ${applicationPath}`);
    await admin.query(`DROP FUNCTION ${schema}.clock_timestamp();
      DROP TABLE ${schema}.time;
      DROP SCHEMA ${schema}`);
  }
}
