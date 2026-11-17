import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readRetainedRoutingPrecondition} from '../scripts/release/simulation-retained-fixture.mjs';
import {nativeEmailSetupStage} from '../scripts/release/simulation-email-stages.mjs';

test('retained email fixture projects only the current read-only routing precondition',async()=>{
 const privateDir=await mkdtemp(join(tmpdir(),'wasalx-retained-routing-')),sourceNamespace='prior-email',runId='current-email',relative=`scenario-${sourceNamespace}/fixture-email-setup.json`,path=join(privateDir,relative),checkpoints=[];
 try{
  await mkdir(join(privateDir,`scenario-${sourceNamespace}`));
  const fixture={evidenceMode:'simulated',namespace:sourceNamespace,scenario:'email-setup',fixture:'emailSetup',result:{evidenceMode:'simulated',namespace:sourceNamespace,tenantId:'tenant',routing:{routingVersionId:'route-1'},channel:{channelId:9},effectBudget:{namespace:sourceNamespace},sourceHashes:{old:'a'.repeat(64)},ownership:{sinkId:'old'}}},bytes=Buffer.from(JSON.stringify(fixture)),config={sourceNamespace,sourceStage:'email-setup',expectedFixture:'emailSetup',path:relative,sha256:createHash('sha256').update(bytes).digest('hex')};
  await writeFile(path,bytes);
  const result=await readRetainedRoutingPrecondition({privateDir,runId,tenantId:'tenant',checkpoint:async value=>checkpoints.push(value)},config);
  assert.deepEqual(result,{evidenceMode:'simulated',namespace:runId,tenantId:'tenant',routingVersionId:'route-1',readOnly:true});
  for(const key of ['channel','effectBudget','sourceHashes','ownership','effectReceipt'])assert.equal(Object.hasOwn(result,key),false,key);
  assert.deepEqual(checkpoints.map(value=>[value.phase,value.supportingOnly,value.noReplay]),[['retained-routing-precondition-admitted',true,true]]);
  await assert.rejects(readRetainedRoutingPrecondition({privateDir,runId,tenantId:'other',checkpoint:async()=>{}},config));
  await assert.rejects(readRetainedRoutingPrecondition({privateDir,runId,tenantId:'tenant',checkpoint:async()=>{}},{...config,sha256:'0'.repeat(64)}));
  await assert.rejects(readRetainedRoutingPrecondition({privateDir,runId,tenantId:'tenant',checkpoint:async()=>{}},{...config,sourceStage:'fresh-group'}));
 }finally{await rm(privateDir,{recursive:true,force:true});}
});

test('email setup rejects two routing owners before any runtime access',async()=>{
 const namespace='current-email',tenantId='tenant',routing={evidenceMode:'simulated',namespace,tenantId,routingVersionId:'route-1'};
 const session={actorBinding:{userMatched:true,workspaceMatched:true},model:{name:'wasalx-simulation-test'},tenantId,containers:{'zammad-railsserver':{}},capabilities:{nativeAgent:{}},ownerPage:new Proxy({},{get(){assert.fail('No runtime access before routing ownership admission');}})};
 await assert.rejects(nativeEmailSetupStage(session,{namespace,inputs:{group:{evidenceMode:'simulated',namespace,tenantId},routing},config:{routingPrecondition:{}}}),/one owner/);
});
