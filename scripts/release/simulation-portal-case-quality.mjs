// OUTPUT ONLY. Proposed scripts/release/simulation-portal-case-quality.mjs.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
import {runCasesWorkflowQuality as readQuality} from './simulation-shared-readonly.mjs';
import {runCasesWorkflowQuality as remainingQuality} from './simulation-remaining-quality.mjs';
import {definitions as readDefinitions} from './simulation-shared-readonly-definitions.mjs';
import {definitions as remainingDefinitions} from './simulation-remaining-quality-definitions.mjs';
import {qualityIds,qualityChecks,exactRows,admitCaseActor,allowCaseReadPost} from './simulation-portal-case-contract.mjs';
import {ensurePortalOperator,capturePortalOperatorEvidence,bindPortalOperatorResult} from './simulation-portal-operator.mjs';
const prefix='cases-deliveries/exact-case-lookup-and-direct-agent-navigation::ui-quality::';
export const portalCaseQualityIds=qualityIds;
const actors=[{contextId:'tenant_owner-en-desktop',role:'tenant_owner',viewport:'desktop',width:1440,height:1000},
 ...[['desktop',1440,1000],['tablet',820,1180],['mobile',390,844]].map(([viewport,width,height])=>({contextId:'agent-en-'+viewport,role:'agent',viewport,width,height}))];
export const portalCaseQualityChecks=qualityChecks;
const hash=x=>'sha256:'+createHash('sha256').update(String(x)).digest('hex');
export async function portalCaseQualityStage(s,{namespace,inputs,config}){
 const startedAt=new Date().toISOString(),results=[];
 assert.deepEqual(config.checks,portalCaseQualityChecks,'Explicit bounded actor checks required; never infer Cartesian contexts');
 const {group:g,actor:agent}=admitCaseActor(s,{namespace,inputs});
 const cases=await s.scoped('SELECT id,zammad_ticket_number FROM case_correlations WHERE tenant_id=$1 AND group_binding_id=$2 AND zammad_ticket_id=$3',[s.tenantId,g.bindingId,String(g.ticketId)]);
 assert.equal(cases.length,1);const target=cases[0];
 const providerRead=async()=>({waha:await s.directCallbacks.providerRead(),meta:await s.metaCallbacks.providerRead()});
 for(const a of actors){
  const page=a.role==='agent'?agent.page:s.ownerPage,userId=a.role==='agent'?agent.userId:s.ownerId;
  await s.verifyOwner(page,userId,a.role,s.tenantId);await page.setViewportSize({width:a.width,height:a.height});
  const operator=await ensurePortalOperator(s,{role:a.role,viewport:{width:a.width,height:a.height}});
  const record=async row=>{
   if(!row.testId?.startsWith(prefix))return;
   const testId=row.testId.endsWith('::02')?row.testId:row.testId+'::02';
   assert(config.checks.some(c=>c.testId===testId&&c.contextId===a.contextId));
   await s.verifyOwner(page,userId,a.role,s.tenantId);
   assert(/^en(?:[-_]|$)/iu.test(await page.evaluate(()=>document.documentElement.lang)));
   assert.deepEqual(page.viewportSize(),{width:a.width,height:a.height});
   const binding=await capturePortalOperatorEvidence(operator);
   const result=bindPortalOperatorResult({...row,testId,contextId:a.contextId,context:{role:a.role,locale:'en',viewport:a.viewport,surface:'portal'}},binding,{testIds:portalCaseQualityIds});
   results.push(result);await s.checkpoint({phase:'portal-case-quality',...result});
  };
  if(a.role==='tenant_owner'){
   const checkpoint=async row=>{if(row.testId)await record(row);else await s.checkpoint(row);};
   await readQuality({page,origin:s.portalOrigin,checkpoint,providerRead,testDefinitions:readDefinitions.filter(t=>t.id.startsWith(prefix))});
   await remainingQuality({page,origin:s.portalOrigin,checkpoint,providerRead,testDefinitions:remainingDefinitions.filter(t=>t.id.startsWith(prefix)),caseId:target.id});
  }else{
   const beforeProvider=await providerRead(),errors={console:0,page:0,network:0},mutations=[];
   const listeners={console:m=>{if(m.type()==='error')errors.console++;},pageerror:()=>errors.page++,requestfailed:()=>errors.network++,response:r=>{if(r.status()>=400)errors.network++;}};
   for(const [event,fn]of Object.entries(listeners))page.on(event,fn);
   const guard=async route=>{const q=route.request(),url=new URL(q.url());
    if(url.origin===s.portalOrigin&&url.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(q.method())){
     const read=allowCaseReadPost(q,s.portalOrigin);
     if(!read){mutations.push({path:url.pathname,method:q.method()});return route.abort('blockedbyclient');}
    }return route.fallback();};
   await page.route('**/api/**',guard);let loaded=false;
   try{
    const request=createSyntheticRequest({page,origin:s.portalOrigin,runId:namespace,checkpoint:s.checkpoint});
    const read=()=>request('/api/inbox','POST',{operation:'SHOW',input:{ticket_id:String(g.ticketId)}});
    await page.goto(s.portalOrigin+'/app?view=inbox&ticket='+encodeURIComponent(target.zammad_ticket_number));
    const before=await read();assert.equal(before.number,target.zammad_ticket_number);await page.getByRole('heading',{name:before.title,exact:true}).waitFor();
    await page.reload();await page.getByRole('heading',{name:before.title,exact:true}).waitFor();
    const after=await read();assert.equal(after.id,before.id);assert.equal(after.number,before.number);assert.equal(after.updated_at,before.updated_at);assert.equal(after.title,before.title);
    assert.deepEqual(await providerRead(),beforeProvider);assert.equal(mutations.length,0);
    loaded=true;await record({testId:prefix+'reload',result:'passed',startedAt,finishedAt:new Date().toISOString(),proof:{stableTicket:true,reload:true,noProviderEffects:true}});
   }catch(error){await record({testId:prefix+'reload',result:'failed',startedAt,finishedAt:new Date().toISOString(),proof:{errorClass:error.name,messageSha256:hash(error.message)}});}
   finally{await page.unroute('**/api/**',guard);for(const[event,fn]of Object.entries(listeners))page.off(event,fn);}
   for(const suffix of ['console','network'])await record({testId:prefix+suffix,result:!loaded?'blocked':(suffix==='console'?errors.console+errors.page:errors.network)?'failed':'passed',startedAt,finishedAt:new Date().toISOString(),proof:{errors,blockedMutations:mutations.length}});
  }
 }
 exactRows(results,config.checks);
 return{evidenceMode:'simulated',namespace,tenantId:s.tenantId,results};
}
