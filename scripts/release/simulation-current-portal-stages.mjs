// OUTPUT ONLY. Proposed small existing-manifest transition helper, not a runner.
import assert from 'node:assert/strict';
export function bindCurrentPortalStages(scenarios,{setup,bindings,groupFixture,groupObservation,nativeAdmission,teamGrant,groupIngress}){
 assert.equal(setup.stateMode,'fresh','Current portal stages need a reviewed fresh fixture; historical adoption remains historical');
 assert(!Object.keys(setup).some(key=>key.startsWith('retained')),'Do not relabel retained execution as current portal proof');
 const original=new Map(scenarios.map(s=>[s.id,s]));assert.equal(original.size,scenarios.length,'Duplicate input stage');
 const fixture=original.get('fresh-group'),team=original.get('team-roles');assert(fixture&&team,'Fresh group/team fixture producers required');
 const replace=(id,binding)=>{
  const stage=original.get(id);assert(stage,'Missing current producer '+id);
  assert.deepEqual(stage.testIds,binding.historicalTestIds,'Unexpected historical producer contract '+id);
  assert(!binding.supporting||binding.historicalTestIds.length===0,'Behavior cannot become supporting without a successor observer '+id);
  assert(Array.isArray(binding.testIds)&&(binding.supporting?binding.testIds.length===0:binding.testIds.length>0),'Current assertion IDs required '+id);
  assert.equal(new Set(binding.testIds).size,binding.testIds.length,'Duplicate current ID '+id);
  Object.assign(stage,{module:binding.module,export:binding.export,testIds:[...binding.testIds],supporting:binding.supporting===true,
   requires:[...new Set([...(binding.requires??stage.requires??[]),'nativeAccountAccess','portalTeamAccess'])],
   config:{...stage.config,...binding.config}});
 };
 for(const binding of bindings)replace(binding.id,binding);
 const freshIds=fixture.testIds.map(id=>id+'::portal');
 if(groupObservation.supporting){const owner=original.get(groupObservation.assertionOwnerStageId);assert(owner&&freshIds.every(id=>owner.testIds.includes(id)),'Fresh fixture assertion needs one explicit current owner');assert.deepEqual(groupObservation.testIds,[]);assert.equal(groupObservation.config?.assertionDisposition,'supporting');}
 else assert.deepEqual(groupObservation.testIds,freshIds,'Fresh fixture must retain exact successor observation');
 Object.assign(fixture,{module:groupFixture.module,export:groupFixture.export,produces:'groupPreparation',testIds:[],supporting:true});
 for(const id of ['team-numbers','team-suspension','team-roles']){const early=original.get(id);if(early)early.requires=early.requires.map(key=>key==='group'?'groupPreparation':key);}
 const barrier=[nativeAdmission,teamGrant,groupIngress,groupObservation].map(row=>({...row,config:{...row.config},dependencies:[]}));
 assert.deepEqual(barrier.map(row=>row.produces),['nativeAccountAccess','portalTeamAccess','group','freshGroupObservation']);
 for(const row of barrier){assert(!original.has(row.id),'Duplicate admission stage');assert(Array.isArray(row.requires));}
 scenarios.splice(scenarios.indexOf(team)+1,0,...barrier);
 const products=new Set();for(const stage of scenarios){
  for(const dependency of stage.requires??[])assert(products.has(dependency),'Forward/missing fixture '+stage.id+'/'+dependency);
  assert(!products.has(stage.produces),'Duplicate fixture '+stage.produces);products.add(stage.produces);
 }
 return scenarios;
}

// Current selected qualification is contextual even when it is not full-alpha admission.
// Shared navigation owns one effect family but its actual role/width observers differ.
const sharedNavigation='tenant-navigation/responsive-collapse-pin-and-workspace-switch::navigation-collapses-and-expands-at-each-viewport::03';
export function currentPortalStageChecks(stages,catalog){
 const tests=new Map(catalog.journeys.flatMap(j=>j.useCases.flatMap(u=>u.tests)).map(t=>[t.id,t]));
 const owners=new Map();for(const stage of stages)for(const id of stage.testIds){const list=owners.get(id)??[];list.push(stage.id);owners.set(id,list);}
 for(const [id,list]of owners)if(list.length>1)assert(id===sharedNavigation&&list.length===2&&list.includes('team-roles')&&list.includes('navigation'),'Unknown shared current assertion allocation '+id);
 const expected=new Map(),all=[];
 for(const stage of stages){
  const checks=[];if(stage.supporting)assert.deepEqual(stage.testIds,[]);
  else for(const testId of stage.testIds){
   const test=tests.get(testId);assert(test&&Array.isArray(test.requiredContextIds)&&test.requiredContextIds.length,'Current selected test lacks exact contexts '+testId);
   assert.equal(new Set(test.requiredContextIds).size,test.requiredContextIds.length);
   for(const contextId of test.requiredContextIds){
    if(owners.get(testId).length>1&&((stage.id==='navigation')!==(contextId==='tenant_owner-en-desktop')))continue;
    checks.push({testId,contextId});
   }
  }
  if(!stage.supporting)assert(checks.length,'Current assertion stage has no owned contexts '+stage.id);
  expected.set(stage.id,checks);all.push(...checks);
 }
 const key=c=>c.testId+'|'+c.contextId,required=[...owners.keys()].flatMap(testId=>tests.get(testId).requiredContextIds.map(contextId=>({testId,contextId})));
 assert.equal(new Set(all.map(key)).size,all.length,'Duplicate current context owner');
 assert.deepEqual(all.map(key).sort(),required.map(key).sort(),'Missing current context allocation');
 return expected;
}
