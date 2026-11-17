import assert from 'node:assert/strict';
import {runTeamNumberScenario} from './simulation-team-number-scenario.mjs';
import {createTeamNumberUi} from './simulation-team-number-ui.mjs';
import {readTeamNumberAudit} from './simulation-team-number-audit.mjs';

// Called from existing launcher AFTER admission/login. This is not a second auth
// launcher. Main owns this membership/configuration batch; no provider sends.
export async function runCompleteTeamNumberPacket({page,origin,runId,ownerId,tenantId,
  connectionId,externalGroupId,checkpoint,assertIsolatedRuntime,scoped,numbers}) {
  await assertIsolatedRuntime({origin,evidenceMode:'simulated'});
  const groups=await scoped('SELECT id FROM whatsapp_groups WHERE tenant_id=$1 AND connection_id=$2 AND external_group_id=$3',
    [tenantId,connectionId,externalGroupId]);assert.equal(groups.length,1,'Classifier group must exist in this tenant');
  const collision=await scoped(`SELECT id FROM tenant_memberships
    WHERE user_id<>$1 AND whatsapp_numbers && $2::text[]`,
    [ownerId,numbers]);
  assert.equal(collision.length,0,'Fixture numbers belong to another member; select isolated fixture before starting');
  let original;
  const record=async row=>{
    if(row.phase==='initial-configuration'&&row.step==='team-numbers')original=row.member;
    await checkpoint(row);
  };
  const startedAt=new Date().toISOString();
  const result=await runTeamNumberScenario({page,origin,runId,ownerId,tenantId,
    checkpoint:record,assertIsolatedRuntime,completeProofs:true,numbers,
    ui:createTeamNumberUi({page,origin}),
    readMember:async id=>(await scoped('SELECT role,state,version,whatsapp_numbers FROM tenant_memberships WHERE id=$1',[id]))[0],
    classify:async number=>(await scoped('SELECT app.group_rule_sender($1,$2,$3,$4) AS sender',
      [tenantId,connectionId,externalGroupId,number.slice(1)+'@c.us']))[0].sender});
  const finishedAt=new Date().toISOString();assert(original);
  const audit=await readTeamNumberAudit({scoped,original,proofs:result.proofs,tenantId,ownerId,startedAt,finishedAt});
  return {startedAt,finishedAt,...result,audit,limitations:[
    'This packet covers ten number-management tests in the owner desktop context.',
    'Not role-denial, foreign-tenant, suspension, complete journey UI or live-provider acceptance.',
    'Main must bind actual actor/context and runtime identity before importing accepted results.'
  ]};
}
