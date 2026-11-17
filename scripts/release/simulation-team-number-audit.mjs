import assert from 'node:assert/strict';

// Retained readback only. scoped executes a tenant-bound READ ONLY transaction.
// original is from the private initial-configuration checkpoint, never log it.
export async function readTeamNumberAudit({scoped,original,proofs,tenantId,ownerId,startedAt,finishedAt}) {
  assert(Number.isFinite(Date.parse(startedAt))&&Date.parse(finishedAt)>=Date.parse(startedAt));
  const successes=proofs.filter(p=>Number.isSafeInteger(p.version));
  assert.deepEqual(successes.map(p=>p.step),['add','edit','save-many','normalize','remove-one','clear','restore']);
  const rows=await scoped(`SELECT id,tenant_id,actor_type,actor_id,action,target_type,target_id,
    previous_value,new_value,request_id,created_at FROM audit_events
    WHERE tenant_id=$1 AND target_type='tenant_membership' AND target_id=$2
      AND action='team.membership_updated' AND created_at >= $3::timestamptz
      AND created_at <= $4::timestamptz ORDER BY created_at,id`,
    [tenantId,original.id,startedAt,finishedAt]);
  assert.equal(rows.length,successes.length,'Missing/extra audit: inspect concurrency; do not select only favorable rows');
  let previousVersion=Number(original.version),previousCount=original.whatsapp_numbers.length;
  const output=[];
  for(const proof of successes){
    const matches=rows.filter(r=>Number(r.new_value?.version)===proof.version);
    assert.equal(matches.length,1);const r=matches[0],p=r.previous_value,n=r.new_value;
    assert.equal(r.tenant_id,tenantId);assert.equal(r.actor_type,'USER');assert.equal(r.actor_id,ownerId);
    assert.equal(r.target_id,original.id);assert.equal(r.target_type,'tenant_membership');
    assert.equal(r.action,'team.membership_updated');assert(r.request_id&&r.request_id!=='undefined');
    assert.equal(p.user_id,ownerId);assert.equal(n.user_id,ownerId);
    assert.equal(p.role,original.role);assert.equal(n.role,original.role);
    assert.equal(p.state,original.state);assert.equal(n.state,original.state);
    assert.equal(Number(p.version),previousVersion);assert.equal(proof.version,previousVersion+1);
    assert.equal(p.whatsapp_numbers_registered,previousCount);assert.equal(n.whatsapp_numbers_registered,proof.count);
    if(proof.step==='normalize')assert.equal(n.whatsapp_numbers_changed,false);
    else if(proof.step==='restore')assert.equal(n.whatsapp_numbers_changed,original.whatsapp_numbers.length>0);
    else if(proof.step!=='add')assert.equal(n.whatsapp_numbers_changed,true);
    // add can be a no-op if the initial private fixture already has this number.
    assert(!Object.hasOwn(p,'whatsapp_numbers')&&!Object.hasOwn(n,'whatsapp_numbers'));
    output.push({step:proof.step,auditId:r.id,requestId:r.request_id,version:proof.version,
      previousCount,count:proof.count,actorMatched:true,createdAt:new Date(r.created_at).toISOString()});
    previousVersion=proof.version;previousCount=proof.count;
  }
  assert.equal(new Set(output.map(r=>r.requestId)).size,output.length);
  return {evidenceMode:'simulated',readbackAt:new Date().toISOString(),audits:output,
    limitations:['Version/time/actor correlation; PATCH does not implement idempotency-key receipts.',
      'Retained audit readback does not supply missing historical UI or sender-classification assertions.']};
}
