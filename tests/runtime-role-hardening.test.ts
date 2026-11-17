import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl=new URL("../services/control-api/migrations/0008_runtime_role_hardening.sql",import.meta.url);

test("ordinary runtime cannot mutate global identity, tenant, or provisioning records",async()=>{const sql=await readFile(migrationUrl,"utf8");for(const table of ["tenants","users","tenant_memberships","zammad_instances","provisioning_operations","secret_references"])assert.match(sql,new RegExp(`REVOKE INSERT, UPDATE, DELETE ON public\\.${table} FROM wasalx_app`));assert.match(sql,/GRANT SELECT ON public\.tenants/);assert.match(sql,/ALTER DEFAULT PRIVILEGES IN SCHEMA public\s+REVOKE INSERT, UPDATE, DELETE ON TABLES FROM wasalx_app/)});

test("provisioning mutations use a separate non-login role and remain RLS scoped",async()=>{const sql=await readFile(migrationUrl,"utf8");assert.match(sql,/CREATE ROLE wasalx_provisioner NOLOGIN/);assert.match(sql,/TO wasalx_provisioner/);assert.doesNotMatch(sql,/BYPASSRLS|SUPERUSER/)});

test("later secret and platform tables undo inherited runtime privileges",async()=>{
  const [cleanup,provisioning,support,waha,metering,upgrade]=await Promise.all([
    "0010_secret_cleanup_outbox.sql",
    "0013_tenant_provisioning_runtime.sql",
    "0023_platform_support_access.sql",
    "0024_waha_worker_capacity.sql",
    "0026_platform_operations_metering.sql",
    "0030_runtime_least_privilege.sql",
  ].map(file=>readFile(new URL(`../services/control-api/migrations/${file}`,import.meta.url),"utf8")));
  assert.match(cleanup,/REVOKE ALL ON public\.secret_cleanup_outbox FROM wasalx_app/);
  assert.match(cleanup,/GRANT INSERT ON public\.secret_cleanup_outbox TO wasalx_app/);
  assert.match(provisioning,/REVOKE ALL ON public\.provisioning_operator_requests FROM PUBLIC, wasalx_app, wasalx_provisioner/);
  assert.match(support,/REVOKE INSERT,UPDATE,DELETE ON platform_support_access_requests FROM wasalx_app/);
  assert.match(waha,/REVOKE ALL ON public\.waha_workers,public\.waha_worker_events FROM PUBLIC,wasalx_app/);
  assert.doesNotMatch(waha,/GRANT SELECT ON public\.waha_workers TO wasalx_app/);
  assert.match(metering,/REVOKE ALL ON public\.usage_meter_events[\s\S]*FROM PUBLIC,wasalx_app,wasalx_provisioner/);
  assert.match(upgrade,/REVOKE INSERT,UPDATE,DELETE ON public\.platform_support_access_requests[\s\S]*FROM wasalx_app/);
  assert.match(upgrade,/current_waha_session_runtime/);
});
