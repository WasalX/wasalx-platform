// Proposal only. Main supplies an already admitted isolated owner browser.
import assert from 'node:assert/strict';
import {createSyntheticRequest} from './seed-simulation-group.mjs';

export async function runTeamNumberScenario({page, origin, runId, ownerId, tenantId,
  checkpoint, assertIsolatedRuntime, readMember, completeProofs=false, ui, classify, numbers}) {
  await assertIsolatedRuntime({origin, evidenceMode:'simulated'});
  assert.match(runId,/^[a-zA-Z0-9_-]{1,60}$/);
  if(completeProofs){assert(ui&&typeof ui.save==='function'&&typeof ui.reload==='function'&&typeof ui.reject==='function');assert.equal(typeof classify,'function');}
  assert(Array.isArray(numbers)&&numbers.length===3&&new Set(numbers).size===3&&numbers.every(x=>/^\+[1-9][0-9]{7,14}$/.test(x)));
  const [first,second,third]=numbers, formatted='+'+first.slice(1).split('').join(' ');
  const request=createSyntheticRequest({page,origin,runId,checkpoint});
  const spaces=await request('/api/workspaces');
  assert(spaces.data.some(x=>x.id===tenantId&&x.current&&x.role==='tenant_owner'));
  const original=(await request('/api/team')).members.find(x=>x.user_id===ownerId);
  assert(original?.is_current_user && original.state==='ACTIVE');
  const path=`/api/team/members/${original.id}`;
  const project=x=>({role:x.role,state:x.state,whatsapp_numbers:x.whatsapp_numbers});
  const proofs=[];
  const current=async()=>{
    const x=(await request('/api/team')).members.find(x=>x.id===original.id);
    assert(x);const db=await readMember(original.id);
    assert.deepEqual(project(db),project(x));assert.equal(Number(db.version),Number(x.version));return x;
  };
  let lastAcknowledged=original,primaryFailure;
  const patch=async(numbers,step)=>{
    const before=await current();
    if(completeProofs&&step!=='restore'){
      await checkpoint({phase:'intent',step,path,method:'PATCH',expectedVersion:Number(before.version)});
      await ui.save({member:before,numbers});
      await checkpoint({phase:'accepted',step,id:before.id});
    }else await request(path,'PATCH',{role:before.role,state:before.state,expectedVersion:Number(before.version),whatsappNumbers:numbers},step);
    const after=await current();assert.equal(Number(after.version),Number(before.version)+1);lastAcknowledged=after;return after;
  };
  // Main persists this in private storage. On interruption reconcile it before
  // repeating this batch; do not automatically overwrite a concurrent change.
  await checkpoint({phase:'initial-configuration',step:'team-numbers',member:original});
  const prove=async(step,numbers,expected)=>{
    const after=await patch(numbers,step);assert.deepEqual(after.whatsapp_numbers,expected);
    const proof={step,version:Number(after.version),count:expected.length,matched:true};
    if(completeProofs){
      proof.uiReload=await ui.reload({member:after,expected});
      if(step==='save-many'){const classifications=await Promise.all(expected.map(classify));assert(classifications.every(x=>x==='team'));proof.eachClassifies=classifications;}
      if(step==='edit'||step==='remove-one'){
        const removed=await classify(first),retained=await classify(second);
        assert.equal(removed,'customer');assert.equal(retained,'team');
        proof.classification={removed,retained};
      }
    }
    proofs.push(proof);await checkpoint({phase:'proof',step,proof});
  };
  const denied=async(step,numbers,status,version)=>{
    const before=await current();
    await assert.rejects(()=>request(path,'PATCH',{role:before.role,state:before.state,
      expectedVersion:version??Number(before.version),whatsappNumbers:numbers},step),
      error=>error.message.includes(`HTTP ${status}; reconcile intent before retry`));
    const after=await current();assert.deepEqual(after,before);
    const proof={step,status,unchanged:true};proofs.push(proof);await checkpoint({phase:'proof',step,proof});
    if(completeProofs&&status===400){
      await checkpoint({phase:'intent',step:step+'-ui',path,method:'PATCH'});
      proof.uiFeedback=await ui.reject({member:after,numbers,status,requireActionable:step==='invalid-atomic'});
      assert.deepEqual(await current(),after);await checkpoint({phase:'proof',step:step+'-ui',proof});
    }
  };
  try{
  await prove('add',[first],[first]);
  const staleVersion=Number((await current()).version);
  await prove('edit',[second],[second]);
  await prove('save-many',[first,second],[first,second]);
  await prove('normalize',[formatted,second],[first,second]);
  await denied('duplicate-normalized',[first,formatted],400);
  await denied('invalid',['not-a-phone'],400);
  await denied('invalid-atomic',[third,'not-a-phone'],400);
  await denied('stale',[third],409,staleVersion);
  await prove('remove-one',[second],[second]);
  await prove('clear',[],[]);
  }catch(error){primaryFailure=error;throw error;}finally{
   try{const before=await current();assert.equal(Number(before.version),Number(lastAcknowledged.version),'Uncertain mutation: retain state for reconciliation');assert.deepEqual(project(before),project(lastAcknowledged));await prove('restore',original.whatsapp_numbers,original.whatsapp_numbers);await checkpoint({phase:'restored',step:'team-numbers',restored:true});}
  // Preserve the primary failure; otherwise restoration failure must fail the test.
  // eslint-disable-next-line no-unsafe-finally
   catch(error){await checkpoint({phase:'cleanup-failure',step:'team-numbers',memberId:original.id});if(!primaryFailure)throw error;}
  }
  assert.deepEqual(project(await current()),project(original));
  return {evidenceMode:'simulated',proofs,restored:true,
    limitations:completeProofs?['Join audit readback before acceptance; role-denial and foreign-tenant tests remain separate.']:['API and database checks only; UI controls, audit readback and actor authorization are separate.']};
}

// Run these independently only with genuinely separate authenticated contexts.
export async function checkActorTeamAccess({page,origin,runId,tenantId,role,checkpoint}) {
  assert(['tenant_owner','tenant_admin','supervisor','agent','auditor'].includes(role));
  const request=createSyntheticRequest({page,origin,runId,checkpoint});
  const spaces=await request('/api/workspaces');
  assert(spaces.data.some(x=>x.current&&x.id===tenantId&&x.role===role));
  if(role==='agent')await assert.rejects(()=>request('/api/team'),/HTTP 403;/);
  else assert(Array.isArray((await request('/api/team')).members));
  return {evidenceMode:'simulated',role,tenantId,teamRead:role==='agent'?'denied':'allowed'};
}
