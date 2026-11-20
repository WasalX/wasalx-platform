import assert from "node:assert/strict";

// Existing isolated PostgreSQL gate owns the connection; leave no fixture changes.
export async function verifyTeamNumberValidation(client, tenantId) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const groupId = "13900000-0000-4000-8000-000000000098";
    const connectionId = "12000000-0000-4000-8000-000000000001";
    const externalGroup = "120363000000098@g.us";
    await client.query("INSERT INTO whatsapp_groups(id,tenant_id,connection_id,external_group_id,display_name) VALUES($1,$2,$3,$4,'Team number check')", [groupId,tenantId,connectionId,externalGroup]);
    await client.query("SET LOCAL ROLE wasalx_app");
    for (const [numbers, expected] of [
      [[], true],
      [["+12025550132", "+12025550141"], true],
      [["+12025550132", "+12025550132"], false],
      [["+12025550132", null], false],
      [["12025550132"], false],
      [["0555550123"], false],
      [["+0123456"], false],
      [["+1234567890123456"], false],
    ]) {
      const result = await client.query("SELECT app.valid_team_whatsapp_numbers($1::text[]) AS valid", [numbers]);
      assert.equal(result.rows[0].valid, expected, JSON.stringify(numbers));
    }
    const saved = await client.query("UPDATE tenant_memberships SET whatsapp_numbers=$2 WHERE tenant_id=$1 RETURNING id", [tenantId,["+12025550132", "+12025550141"]]);
    assert(saved.rowCount > 0);
    await client.query("SAVEPOINT invalid_numbers");
    await assert.rejects(client.query("UPDATE tenant_memberships SET whatsapp_numbers=ARRAY['invalid'] WHERE tenant_id=$1", [tenantId]), { code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT invalid_numbers");
    await client.query("RESET ROLE");
    await client.query("INSERT INTO group_workspace_participants(tenant_id,whatsapp_group_id,external_participant_id,normalized_phone) VALUES($1,$2,'987654321@lid','+12025550141')", [tenantId,groupId]);
    await client.query("INSERT INTO group_workspace_participants(tenant_id,whatsapp_group_id,external_participant_id,normalized_phone) VALUES($1,$2,'12025550132@c.us','+12025550141'),($1,$2,'12025550141@c.us','+12025550141')", [tenantId,groupId]);
    await client.query("SET LOCAL ROLE wasalx_connector_worker");
    for (const [participant, expected] of [["12025550132@c.us", "unknown"], ["12025550141@c.us", "team"], ["12025550141@s.whatsapp.net", "team"], ["12025550193@c.us", "customer"], ["12025550132@lid", "unknown"]]) {
      const result = await client.query("SELECT app.group_rule_sender($1,$2,$3,$4) AS sender", [tenantId,connectionId,externalGroup,participant]);
      assert.equal(result.rows[0].sender, expected);
    }
    assert.equal((await client.query("SELECT app.group_rule_sender($1,$2,$3,'987654321@lid') AS sender", [tenantId,connectionId,externalGroup])).rows[0].sender, "team");
    await client.query("RESET ROLE");
    await client.query("UPDATE tenant_memberships SET whatsapp_numbers=ARRAY['+12025550132'] WHERE tenant_id=$1", [tenantId]);
    await client.query("SET LOCAL ROLE wasalx_connector_worker");
    assert.equal((await client.query("SELECT app.group_rule_sender($1,$2,$3,'987654321@lid') AS sender", [tenantId,connectionId,externalGroup])).rows[0].sender, "customer");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", ["20000000-0000-4000-8000-000000000002"]);
    assert.equal((await client.query("SELECT app.group_rule_sender($1,$2,$3,$4) AS sender", [tenantId,connectionId,externalGroup,"12025550132@c.us"])).rows[0].sender, "unknown");
  } finally {
    await client.query("ROLLBACK");
  }
}
