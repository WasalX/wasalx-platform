import assert from 'node:assert/strict';import {writeFile}from'node:fs/promises';import{createSyntheticRequest}from'./seed-simulation-group.mjs';const journey='cases-deliveries/delivery-state-retry-and-unknown-outcome-recovery';
export async function readRecoveryState(db,tenantId,id){
  await db.query('BEGIN READ ONLY');
  try{
    await db.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    const delivery=(await db.query(`SELECT id,state,attempts,manual_retry_allowed,lease_id,lease_expires_at
      FROM delivery_outbox WHERE tenant_id=$1 AND id=$2`,[tenantId,id])).rows;
    assert.equal(delivery.length,1);
    const attempts=(await db.query(`SELECT id,attempt_number,state,started_at,finished_at FROM delivery_attempts
      WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY attempt_number,id`,[tenantId,id])).rows;
    const reviews=(await db.query(`SELECT id,state,version,resolution_code FROM quarantine_records
      WHERE tenant_id=$1 AND delivery_id=$2 AND reason_code='PROVIDER_OUTCOME_UNKNOWN' ORDER BY id`,[tenantId,id])).rows;
    const audit=(await db.query(`SELECT id,action,target_id FROM audit_events WHERE tenant_id=$1 AND
      (target_id=$2::text OR target_id IN (SELECT id::text FROM quarantine_records WHERE tenant_id=$1 AND delivery_id=$2::uuid)) ORDER BY id`,[tenantId,id])).rows;
    return {delivery:delivery[0],attempts,reviews,audit};
  }finally{await db.query('ROLLBACK');}
}

export function assertStableAttempts(before,after){
  assert.equal(after.delivery.id,before.delivery.id);
  assert.equal(after.delivery.attempts,before.delivery.attempts);
  const persisted = rows => rows.map(row=>({...row,started_at:row.started_at instanceof Date?row.started_at.toISOString():row.started_at,finished_at:row.finished_at instanceof Date?row.finished_at.toISOString():row.finished_at}));
  assert.deepEqual(persisted(after.attempts),persisted(before.attempts));
  assert.equal(after.delivery.lease_id,null);assert.equal(after.delivery.lease_expires_at,null);
}

async function confirmedMutation({page,path,checkpoint,step,expectedBody,click}){
  const pattern=`**${path}`;let intent;
  const intercept=async route=>{
    const req=route.request();assert.equal(req.method(),'POST');assert(!intent,'Repeated confirmation request');
    const body=req.postDataJSON();assert.deepEqual(body,expectedBody);
    intent={phase:'intent',step,path,key:req.headers()['idempotency-key'],body};assert(intent.key);
    await checkpoint(intent);await route.continue();
  };
  await page.route(pattern,intercept);
  try{
    const responsePending=page.waitForResponse(r=>r.url().endsWith(path)&&r.request().method()==='POST');
    await click();const response=await responsePending;
    assert(response.ok(),`${step}: HTTP ${response.status()}; reconcile intent, never auto-retry`);
    const result=await response.json();await checkpoint({phase:'accepted',step,result,key:intent.key});return result;
  }finally{await page.unroute(pattern,intercept);}
}

// Complete the remaining four business assertions on genuine retained fixtures.
// Run unknown/no-resend + predecessor readback first; this resolves that unknown fixture.
export async function runStopRetryPhase({page,db,tenantId,origin,runId,failedId,candidate,
  evidencePath,checkpoint,assertAdmission,readProviderReceipts}){
  await assertAdmission({evidenceMode:'simulated',tenantId,failedId,candidate});
  const request=createSyntheticRequest({page,origin,runId,checkpoint});
  const startedAt=new Date().toISOString();
  const failedBefore=await readRecoveryState(db,tenantId,failedId);
  assert.equal(failedBefore.delivery.state,'FAILED_TERMINAL');assert.equal(failedBefore.delivery.manual_retry_allowed,true);
  assert.equal(failedBefore.delivery.lease_id,null);assert.equal(failedBefore.delivery.lease_expires_at,null);
  assert.equal(failedBefore.reviews.length,0);
  const failedProviderBefore=await readProviderReceipts(failedId);assert.equal(failedProviderBefore.length,0);
  const detail=await request(`/api/deliveries/${failedId}`);assert.equal(typeof detail.revision,'string');
  await checkpoint({phase:'evidence',step:'known-failure-before-stop',failedBefore});
  await page.goto(`${origin}/app?view=deliveries&delivery=${failedId}`);
  const stop=page.getByRole('button',{name:'Stop retrying',exact:true});await stop.click();
  const stopConfirmation=page.getByRole('alertdialog',{name:'Stop retrying',exact:true});
  await stopConfirmation.getByRole('button',{name:'Cancel',exact:true}).click();
  await stopConfirmation.waitFor({state:'hidden'});
  assert.deepEqual(await readRecoveryState(db,tenantId,failedId),failedBefore);
  await checkpoint({phase:'evidence',step:'stop-cancel-unchanged',failedBefore});
  await stop.click();
  await confirmedMutation({page,path:`/api/deliveries/${failedId}/stop-retrying`,checkpoint,step:'stop-retrying',
    expectedBody:{expectedRevision:detail.revision,confirmation:'STOP'},
    click:()=>stopConfirmation.getByRole('button',{name:'Stop retrying',exact:true}).click()});
  const failedAfter=await readRecoveryState(db,tenantId,failedId);
  assertStableAttempts(failedBefore,failedAfter);assert.equal(failedAfter.delivery.state,'FAILED_TERMINAL');
  assert.equal(failedAfter.delivery.manual_retry_allowed,false);
  assert.equal(failedAfter.audit.filter(r=>r.action==='delivery.retry_stopped').length,1);
  await page.reload();await page.getByText('Retry stopped',{exact:true}).waitFor({state:'visible'});
  const reloaded=await request(`/api/deliveries/${failedId}`);assert.equal(reloaded.retry_stopped,true);
  assert.equal(reloaded.state,'FAILED_TERMINAL');assert.equal(Number(reloaded.attempts),Number(failedBefore.delivery.attempts));
  assert.deepEqual(await readProviderReceipts(failedId),failedProviderBefore);
  await checkpoint({phase:'evidence',step:'stopped-reload-durable',failedAfter});
  const result={evidenceMode:'simulated',candidate,startedAt,finishedAt:new Date().toISOString(),status:'bounded-stop-retry-passed',
    testIds:[`${journey}::stop-retrying-preserves-failed-state-and-history::01`,`${journey}::stop-retrying-preserves-failed-state-and-history::02`],
    failedBefore,failedAfter,limitations:['Caller binds actual fixture, actor and runtime evidence']};
  await writeFile(evidencePath,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});return result;
}
