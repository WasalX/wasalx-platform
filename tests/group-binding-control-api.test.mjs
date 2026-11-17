import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestException, ConflictException } from "../services/control-api/node_modules/@nestjs/common/index.js";
import { GroupsController } from "../services/control-api/dist/groups.controller.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const groupId = "12000000-0000-4000-8000-000000000001";
const connectionId = "11000000-0000-4000-8000-000000000001";
const ruleSetId = "13000000-0000-4000-8000-000000000001";
const request = {
  id: "request-1",
  principal: {
    subject: "subject-1",
    userId: "14000000-0000-4000-8000-000000000001",
    tenantId,
    email: "admin@example.test",
    displayName: "Admin",
    role: "tenant_admin",
  },
};
const readyCatalogs = { verifySelection: async () => [] };
const operation = (sql) => {
  if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
  if (sql.includes("FROM bot_flow_operations")) return { rows: [] };
  if (sql.includes("INSERT INTO bot_flow_operations")) return { rows: [] };
  return null;
};

test("group search is server-side, tenant scoped, bounded, and connection filtered", async () => {
  let statement;
  const controller=new GroupsController({rows:async(tenant,sql,values)=>{statement={tenant,sql,values};return[]}},readyCatalogs);
  assert.deepEqual(await controller.list(request,undefined,"50","  Example  ",connectionId),[]);
  assert.equal(statement.tenant,tenantId);
  assert.match(statement.sql,/g\.tenant_id = \$1[\s\S]*position\(lower\(\$4\)[\s\S]*g\.connection_id=\$5/u);
  assert.deepEqual(statement.values,[tenantId,null,50,"Example",connectionId]);
  await assert.rejects(()=>controller.list(request,undefined,"50","x".repeat(161)),BadRequestException);
  await assert.rejects(()=>controller.list(request,undefined,"50","Example","invalid"),BadRequestException);
});

test("concurrent activation constraint becomes an actionable conflict without hiding other database errors", async () => {
  const error = Object.assign(new Error("private database detail"), { code: "23505", constraint: "group_designated_binding_unique" });
  const controller = new GroupsController({ withTenant: async () => { throw error; } }, readyCatalogs);
  const actionable = result => result instanceof ConflictException && result.getResponse().code === "GROUP_BOT_ALREADY_DESIGNATED"
    && !JSON.stringify(result.getResponse()).includes("private database detail");
  const binding = { ruleSetId, zammadGroupId: "2", acknowledgementTemplate: "Cases {{tickets}}", agentPrefix: "Support", expectedRevision: 0 };
  await assert.rejects(() => controller.toggle(request, groupId, "race", { enabled: true, expectedRevision: 1 }), actionable);
  await assert.rejects(() => controller.bind(request, groupId, "bind-race", binding), actionable);
  error.constraint = "unrelated_constraint";
  await assert.rejects(() => controller.toggle(request, groupId, "other", { enabled: true, expectedRevision: 1 }), result => result === error);
  await assert.rejects(() => controller.bind(request, groupId, "bind-other", binding), result => result === error);
});

test("group activation fails closed when any runtime dependency is not ready", async () => {
  const client = {
    async query(sql) {
      const receipt = operation(sql); if (receipt) return receipt;
      if (sql.includes("FOR UPDATE OF c,g")) return { rows: [{ id: groupId }] };
      if (sql.includes("FOR UPDATE OF b")) return { rows: [{ id: "binding-1", state: "DRAFT", revision: 1 }] };
      if (sql.includes("enabled_rule_count")) {
        return {
          rows: [{
            binding_id: "binding-1",
            connection_state: "DEGRADED",
            zammad_state: "WORKING",
            rule_set_state: "ACTIVE",
            enabled_rule_count: "1",
            working_session_count: "0",
            pending_operation_count: "0",
            webhook_route_state: "ACTIVE",
            provider: "WAHA",
            sync_state: "ACTIVE",
            last_synced_at: new Date().toISOString(),
            waha_worker_ready_count: "1",
            zammad_group_id: "2",
            assignment_mode: "zammad_auto",
            fixed_owner_id: null,
            sla_policy_id: null,
            business_hours_mode: "ALWAYS",
            business_hours_calendar_id: null,
          }],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const database = { withTenant: async (_tenant, operation) => operation(client) };
  const controller = new GroupsController(database, readyCatalogs);
  await assert.rejects(
    () => controller.toggle(request, groupId, "activate-degraded", { enabled: true, expectedRevision: 1 }),
    (error) => error instanceof BadRequestException && error.getResponse()?.code === "CONNECTION_NOT_WORKING",
  );
});

test("group activation succeeds only after connection, session, Zammad, and rules are ready", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      const receipt = operation(sql); if (receipt) return receipt;
      if (sql.includes("FOR UPDATE OF c,g")) return { rows: [{ id: groupId }] };
      if (sql.includes("FOR UPDATE OF b")) return { rows: [{ id: "binding-1", state: "DRAFT", revision: 1 }] };
      if (sql.includes("enabled_rule_count")) {
        return {
          rows: [{
            binding_id: "binding-1",
            connection_state: "WORKING",
            zammad_state: "WORKING",
            rule_set_state: "ACTIVE",
            enabled_rule_count: "1",
            working_session_count: "1",
            pending_operation_count: "0",
            webhook_route_state: "ACTIVE",
            provider: "WAHA",
            sync_state: "ACTIVE",
            last_synced_at: new Date().toISOString(),
            waha_worker_ready_count: "1",
            zammad_group_id: "2",
            assignment_mode: "zammad_auto",
            fixed_owner_id: null,
            sla_policy_id: null,
            business_hours_mode: "ALWAYS",
            business_hours_calendar_id: null,
          }],
        };
      }
      if (sql.includes("UPDATE group_bindings")) {
        calls.push("activated");
        return { rows: [{ id: "binding-1", state: "ACTIVE", revision: 2 }] };
      }
      if (sql.includes("app.record_group_binding_version")) return { rows: [{}] };
      if (sql.includes("INSERT INTO audit_events")) {
        calls.push("audited");
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const database = { withTenant: async (_tenant, operation) => operation(client) };
  const controller = new GroupsController(database, readyCatalogs);
  assert.deepEqual(await controller.toggle(request, groupId, "activate-ready", { enabled: true, expectedRevision: 1 }), { id: "binding-1", state: "ACTIVE", revision: 2, duplicate: false });
  assert.deepEqual(calls, ["activated", "audited"]);
});

test("group activation rejects a second designated bot before changing the binding", async () => {
  const client = {
    async query(sql) {
      const receipt = operation(sql); if (receipt) return receipt;
      if (sql.includes("FOR UPDATE OF c,g")) return { rows: [{ id: groupId }] };
      if (sql.includes("FOR UPDATE OF b")) return { rows: [{ id: "binding-1", state: "DRAFT", revision: 1 }] };
      if (sql.includes("enabled_rule_count")) return { rows: [{
        binding_id: "binding-1", connection_state: "WORKING", zammad_state: "WORKING",
        rule_set_state: "ACTIVE", enabled_rule_count: "1", working_session_count: "1",
        pending_operation_count: "0", webhook_route_state: "ACTIVE", provider: "WAHA",
        sync_state: "ACTIVE", last_synced_at: new Date().toISOString(), waha_worker_ready_count: "1",
        designated_binding_conflicts: "1", zammad_group_id: "2", assignment_mode: "zammad_auto",
        fixed_owner_id: null, sla_policy_id: null, business_hours_mode: "ALWAYS", business_hours_calendar_id: null,
      }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const controller = new GroupsController({ withTenant: async (_tenant, run) => run(client) }, readyCatalogs);
  await assert.rejects(
    () => controller.toggle(request, groupId, "activate-second-bot", { enabled: true, expectedRevision: 1 }),
    (error) => error instanceof BadRequestException && error.getResponse()?.code === "GROUP_BOT_ALREADY_DESIGNATED",
  );
});

test("group activation fails closed when the selected Zammad routing target is stale", async () => {
  const client = {
    async query(sql) {
      const receipt = operation(sql); if (receipt) return receipt;
      if (sql.includes("FOR UPDATE OF c,g")) return { rows: [{ id: groupId }] };
      if (sql.includes("FOR UPDATE OF b")) return { rows: [{ id: "binding-1", state: "DRAFT", revision: 1 }] };
      if (sql.includes("enabled_rule_count")) return { rows: [{
        binding_id: "binding-1", connection_state: "WORKING", zammad_state: "WORKING",
        rule_set_state: "ACTIVE", enabled_rule_count: "1", working_session_count: "1",
        pending_operation_count: "0", webhook_route_state: "ACTIVE", provider: "WAHA",
        sync_state: "ACTIVE", last_synced_at: new Date().toISOString(), waha_worker_ready_count: "1",
        zammad_group_id: "2", assignment_mode: "fixed_owner", fixed_owner_id: "19",
        sla_policy_id: null, business_hours_mode: "ALWAYS", business_hours_calendar_id: null,
      }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const catalogs = { verifySelection: async () => ["the selected fixed owner is not assigned to the selected Zammad group"] };
  const controller = new GroupsController({ withTenant: async (_tenant, operation) => operation(client) }, catalogs);
  await assert.rejects(
    () => controller.toggle(request, groupId, "activate-stale", { enabled: true, expectedRevision: 1 }),
    (error) => error instanceof BadRequestException && error.getResponse()?.code === "ZAMMAD_ROUTING_NOT_READY",
  );
});

test("binding configuration validates enums, identifiers, and fixed-owner semantics before database access", async () => {
  const controller = new GroupsController({
    withTenant: async () => {
      throw new Error("Database must not be called for invalid input");
    },
  }, readyCatalogs);
  const validBase = {
    ruleSetId,
    zammadGroupId: "2",
    acknowledgementTemplate: "Cases {{tickets}}",
    agentPrefix: "Support",
  };
  await assert.rejects(
    () => controller.bind(request, groupId, "bind-fixed", { ...validBase, assignmentMode: "fixed_owner" }),
    (error) => error instanceof BadRequestException && /fixed owner is required/i.test(error.message),
  );
  await assert.rejects(
    () => controller.bind(request, groupId, "bind-priority", { ...validBase, defaultPriority: "critical" }),
    (error) => error instanceof BadRequestException && /priority is invalid/i.test(error.message),
  );
  await assert.rejects(
    () => controller.bind(request, groupId, "bind-state", { ...validBase, state: "WORKING" }),
    (error) => error instanceof BadRequestException && /state is invalid/i.test(error.message),
  );
  await assert.rejects(
    () => controller.bind(request, groupId, "bind-placement", { ...validBase, agentIdentityPlacement: "SIDE" }),
    (error) => error instanceof BadRequestException && /identity placement is invalid/i.test(error.message),
  );
});

test("binding configuration stores the tenant alias separately from the provider display name", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      const receipt = operation(sql); if (receipt) return receipt;
      if (sql.includes("FOR UPDATE OF c,g")) return { rows: [{ wasalx_name: null }] };
      if (sql.includes("FOR UPDATE OF b")) return { rows: [] };
      if (sql.includes("INSERT INTO group_bindings")) return { rows: [{ id: "binding-1", state: "DRAFT", revision: 1 }] };
      if (sql.includes("app.record_group_binding_version")) return { rows: [{}] };
      if (sql.includes("UPDATE whatsapp_groups")) {
        calls.push({ type: "alias", values });
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO audit_events")) {
        calls.push({ type: "audit" });
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const database = { withTenant: async (_tenant, operation) => operation(client) };
  const controller = new GroupsController(database, readyCatalogs);
  assert.deepEqual(
    await controller.bind(request, groupId, "bind-alias", {
      displayName: "Riyadh · Evening dispatch",
      ruleSetId,
      zammadGroupId: "2",
      acknowledgementTemplate: "Cases {{tickets}}",
      agentPrefix: "Dispatch",
      agentIdentityPlacement: "FOOTER",
      state: "DRAFT",
      expectedRevision: 0,
    }),
    { id: "binding-1", state: "DRAFT", revision: 1, duplicate: false },
  );
  assert.deepEqual(calls, [
    { type: "alias", values: ["Riyadh · Evening dispatch", tenantId, groupId] },
    { type: "audit" },
  ]);
});
