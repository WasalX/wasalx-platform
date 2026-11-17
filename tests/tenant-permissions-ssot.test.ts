import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  can as canonicalCan,
  tenantPermissions,
  tenantRoles,
} from "../packages/core/src/tenant-permissions.ts";
import { can as portalCan } from "../lib/tenant-permissions.ts";

test("tenant authorization has one canonical role-permission matrix", async () => {
  const [portalSource, controlApiSource] = await Promise.all([
    readFile(new URL("../lib/tenant-permissions.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/control-api/src/rbac.ts", import.meta.url), "utf8"),
  ]);
  assert.match(portalSource, /packages\/core\/src\/tenant-permissions\.ts/);
  assert.match(controlApiSource, /@wasalx\/core\/tenant-permissions/);
  assert.doesNotMatch(portalSource, /new Set|rolePermissions/);
  assert.doesNotMatch(controlApiSource, /new Set|rolePermissions|const permissions/);

  for (const role of tenantRoles) {
    for (const permission of tenantPermissions) {
      assert.equal(portalCan(role, permission), canonicalCan(role, permission), `${role} ${permission}`);
    }
  }
});

test("canonical tenant roles keep representative least-privilege boundaries", () => {
  assert.equal(canonicalCan("tenant_owner", "settings:write"), true);
  assert.equal(canonicalCan("tenant_admin", "settings:write"), false);
  assert.equal(canonicalCan("supervisor", "delivery:retry"), true);
  assert.equal(canonicalCan("agent", "delivery:retry"), false);
  assert.equal(canonicalCan("auditor", "audit:export"), true);
  assert.equal(canonicalCan("auditor", "support:approve"), false);
});
