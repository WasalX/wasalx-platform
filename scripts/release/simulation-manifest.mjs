import {currentPortalStageChecks} from './simulation-current-portal-stages.mjs';
import {validateComposePrefix} from './simulation-stack-session.mjs';
import {relativeModuleDependencies} from './simulation-module-dependencies.mjs';
import assert from 'node:assert/strict';
import {readFile,realpath,mkdir,writeFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {applicableAutomationObligations} from './automation-coverage.mjs';
import {simulationEvidenceBound} from './simulation-full-suite-mappings.mjs';
import {verifiedDeploymentImages} from './deployment-image-verification.mjs';
import {projectStageImportRows} from './simulation-import-rows.mjs';
import {selectExactResults} from './full-suite-result-importer.mjs';
import {validateExecutionViewport} from './alpha-test-baseline.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function frozenFailureLocation(error,checked){if(typeof error?.stack!=='string')return{};const frozen=new Map([...checked].map(([path,target])=>[resolve(target),path]));for(const frame of error.stack.split(/\r?\n/u).slice(1)){const match=frame.match(/(?:\(|\s)(file:\/\/\/[^)\s]+|\/[^)\s]+):([1-9]\d*):([1-9]\d*)\)?$/u);if(!match)continue;let target;try{target=resolve(match[1].startsWith('file:')?fileURLToPath(match[1]):match[1]);}catch{continue;}const path=frozen.get(target);if(path!==undefined)return{sourceLocation:{path,line:Number(match[2]),column:Number(match[3])}};}return{};}
const nativeOperations=new Set(['native-agent-existing-verification','native-agent-lookup','native-agent-navigation','native-agent-sign-in','native-agent-ui-admission','native-agent-capability-checkpoint','direct-native-drain','direct-native-admission','direct-native-agent','direct-native-verify','direct-native-viewport','direct-native-readback','direct-native-mail-navigate','direct-native-mail-first-article','direct-native-mail-reload','direct-native-mail-reloaded-article','direct-native-capture','direct-native-restore-viewport','workflow-lifecycle-readback','workflow-lifecycle-select-original','workflow-lifecycle-select-intervening','workflow-lifecycle-select-current','workflow-select-viewport','workflow-select-navigate','workflow-select-card-visible','workflow-select-card-count','workflow-select-card-click','workflow-select-detail-visible']);
export function privateErrorSummary(error,checked){
 const ancestors=new Set();let remaining=32;
 const visit=(value,depth)=>{
  remaining--;
  const errorClass=typeof value?.name==='string'&&/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(value.name)?value.name:'Error',operation=value?.qualificationOperation;
  const summary={errorClass,messageSha256:sha(String(value?.message??value)),...(typeof value?.stack==='string'?{stackSha256:sha(value.stack)}:{}),...(nativeOperations.has(operation)?{operation}:{}),...frozenFailureLocation(value,checked)};
  if(!(value instanceof AggregateError))return summary;
  if(ancestors.has(value))return{...summary,errorsTruncated:'cycle'};
  if(depth===4)return{...summary,errorsTruncated:'depth'};
  ancestors.add(value);summary.errors=[];
  for(const child of value.errors){if(remaining===0){summary.errorsTruncated='count';break;}summary.errors.push(visit(child,depth+1));}
  ancestors.delete(value);return summary;
 };
 return visit(error,0);
}

export function downstreamStageChecks(manifest,stage){
 const products=new Set(stage.produces?[stage.produces]:[]),selected=new Map;let changed=true;
 while(changed){changed=false;for(const consumer of manifest.scenarios){if(!(consumer.requires??[]).some(product=>products.has(product)))continue;for(const check of consumer.checks??[])selected.set(JSON.stringify([check.testId,check.contextId]),check);if(consumer.produces&&!products.has(consumer.produces)){products.add(consumer.produces);changed=true;}}}
 return[...selected.values()];
}
function downstreamStageIds(manifest,initialProducts){
 const products=new Set(initialProducts),selected=new Set;let changed=true;
 while(changed){changed=false;for(const stage of manifest.scenarios){if(!(stage.requires??[]).some(product=>products.has(product)))continue;selected.add(stage.id);if(stage.produces&&!products.has(stage.produces)){products.add(stage.produces);changed=true;}}}
 return selected;
}
export function stageResult(stage,fixture){if(stage.supporting)return{status:'passed',counts:{passed:0,failed:0,blocked:0,unknown:0},missing:[]};const allowed=new Set(['passed','failed','blocked','unknown']),contextual=Array.isArray(stage.checks)&&stage.checks.length>0,key=row=>contextual?JSON.stringify([row.testId,row.contextId]):row.testId,expected=new Set((contextual?stage.checks:stage.testIds.map(testId=>({testId}))).map(key)),rows=[...(Array.isArray(fixture.results)?fixture.results:[]),...(Array.isArray(fixture.proofs)?fixture.proofs:[])].filter(row=>row&&allowed.has(row.result)&&expected.has(key(row))),unique=new Map;for(const row of rows)if(!unique.has(key(row)))unique.set(key(row),row);const canonical=[...unique.values()],present=new Set(unique.keys()),missing=[...expected].filter(value=>!present.has(value)),counts=canonical.reduce((value,row)=>(value[row.result]++,value),{passed:0,failed:0,blocked:0,unknown:0}),duplicate=canonical.length!==rows.length;return{status:duplicate||counts.failed?'failed':counts.blocked?'blocked':counts.unknown?'unknown':missing.length?'incomplete':'passed',counts,missing,...(duplicate?{formatError:'duplicate-stage-result'}:{})};}
export function evidenceReader(root,{read=readFileSync,realpath=realpathSync}={}) {
 const base=resolve(root);assert.equal(realpath(base),base,'Evidence root must be an exact real path');
 return path=>{assert(typeof path==='string'&&!isAbsolute(path),'Evidence path must be relative');const target=resolve(base,path),r=relative(base,target);assert(r&&!r.startsWith('..')&&!isAbsolute(r),'Evidence path escaped snapshot');assert.equal(realpath(target),target,'Evidence path must not traverse a symlink');return read(target);};
}
export async function runSimulationManifest(file,{root=process.cwd(),collectionStartedAt}={}) {
 const m=JSON.parse(await readFile(file,'utf8'));
 assert.equal(m.evidenceMode,'simulated');assert.match(m.namespace,/^[a-zA-Z0-9-]{1,40}$/);
 assert(['selected-vertical','full-suite'].includes(m.scope)); // Scheduling is not acceptance.
 assert(Array.isArray(m.requiredTestIds)&&m.requiredTestIds.length);assert.equal(new Set(m.requiredTestIds).size,m.requiredTestIds.length);
 assert(m.session?.options?.privateDir);assert.equal(m.session.options.runtimeImageBindings,undefined,'Runtime image bindings must come from verified registry');const applicationRoot=resolve(root),privateDir=resolve(m.session.options.privateDir),harnessRoot=m.harnessRoot===undefined?applicationRoot:resolve(privateDir,m.harnessRoot);
 if(m.harnessRoot!==undefined){assert(m.harnessRoot==='driver'||/^drivers\/[A-Za-z0-9-]{1,40}$/.test(m.harnessRoot));assert.equal(await realpath(harnessRoot),harnessRoot);}
 const checked=new Map();
 for(const f of m.files??[]) {assert.match(f.sha256,/^[a-f0-9]{64}$/);const p=resolve(harnessRoot,f.path),r=relative(harnessRoot,p);assert(r&&!r.startsWith('..')&&!isAbsolute(r));assert.equal(await realpath(p),p);assert(!checked.has(f.path));assert.equal(sha(await readFile(p)),f.sha256);checked.set(f.path,p);}
 assert(m.catalog?.path&&checked.has(m.catalog.path));
 if(m.harnessRoot?.startsWith('drivers/'))assert(m.entrypoint?.path&&checked.has(m.entrypoint.path),'Frozen qualification entrypoint required');
 const catalog=JSON.parse(await readFile(checked.get(m.catalog.path),'utf8'));
 const known=new Set(catalog.journeys.flatMap(j=>j.useCases.flatMap(u=>u.tests.map(t=>t.id))));
 for(const id of m.requiredTestIds)assert(known.has(id),'Unknown exact test ID');
 assert(m.session?.module&&checked.has(m.session.module));assert(m.session.options.composeArgs?.length&&m.session.options.harnessHashes);
 if(m.harnessRoot!==undefined)assert(Object.keys(m.session.options.harnessHashes).every(x=>x.startsWith(m.harnessRoot+'/')),'Mixed qualification driver roots denied');
 assert(Array.isArray(m.session.options.composeArgs)&&m.session.options.composeArgs.every(x=>typeof x==='string'));
 validateComposePrefix(m.session.options.composeArgs,{root:applicationRoot,privateDir,profiles:m.session.options.profiles});
 assert(Array.isArray(m.scenarios)&&m.scenarios.length);
 // Verify relative import closure before any code import, including session helpers.
 for(const [name,path] of checked)if(name.endsWith('.mjs')){
  const source=await readFile(path,'utf8');
  const imports=relativeModuleDependencies(source);
  for(const spec of imports){const dep=resolve(dirname(path),spec);assert([...checked.values()].includes(dep),'Unfrozen relative import: '+name);}
 }
 const covered=new Set(),outputs=new Set(),ids=new Set();
 // Validate EVERY stage before importing even the session (imports may have effects).
 for(const s of m.scenarios){assert(!ids.has(s.id));ids.add(s.id);assert(checked.has(s.module));assert.match(s.export,/^[A-Za-z][A-Za-z0-9_]*$/);assert(Array.isArray(s.testIds)&&(s.supporting?s.testIds.length===0:s.testIds.length));for(const t of s.testIds){assert(m.requiredTestIds.includes(t));covered.add(t);}for(const d of s.requires??[])assert(outputs.has(d),'Unknown/forward fixture dependency');assert(s.produces&&!outputs.has(s.produces));outputs.add(s.produces);assert(Array.isArray(s.dependencies));for(const d of s.dependencies)assert(checked.has(d),'Unfrozen dependency');}
 assert.deepEqual([...covered].sort(),[...m.requiredTestIds].sort(),'Missing declared coverage');
 if(m.scope==='selected-vertical'&&m.session.options.operatorSurface==='portal'){const expected=currentPortalStageChecks(m.scenarios,catalog);for(const stage of m.scenarios)assert.deepEqual(stage.checks,expected.get(stage.id),'Missing/invalid current context allocation '+stage.id); }
 const evidenceBound=simulationEvidenceBound(m);let runtimeImageBindings;
 if(evidenceBound) {
 assert(m.featureMatrix?.path&&checked.has(m.featureMatrix.path),'Frozen feature matrix required');
  const {validate,validateContract}=await import('./alpha-test-baseline.mjs');
  assert(isAbsolute(m.evidenceSnapshot?.root??''),'Evidence-bound simulation snapshot required');
  assert.equal(catalog.schemaVersion,1,'Frozen baseline schema required');
  // Selected runs admit the frozen contract and current deployment only. The
  // canonical importer validates new rows; historical evidence is not replayed.
  if(m.scope==='full-suite')validate(catalog,evidenceReader(m.evidenceSnapshot.root));
  validateContract(catalog,JSON.parse(await readFile(checked.get(m.featureMatrix.path),'utf8')),evidenceReader(m.evidenceSnapshot.root));
  const obligations=applicableAutomationObligations(catalog,path=>{assert(checked.has(path),'Unfrozen applicability source');return readFileSync(checked.get(path));});
  if(m.scope==='full-suite')assert.deepEqual([...m.requiredTestIds].sort(),[...obligations.testIds].sort(),'Incomplete full-suite test mapping');
  else assert(m.requiredTestIds.every(id=>obligations.testIds.includes(id)),'Selected test is not an applicable obligation');
  const knownContexts=new Set(catalog.contexts.map(c=>c.id));
  const actual=[];
  for(const stage of m.scenarios){
   if(stage.supporting){assert.equal(stage.testIds.length,0);assert.deepEqual(stage.checks??[],[]);continue;}
   assert(Array.isArray(stage.checks)&&stage.checks.length,'Missing stage context mapping');
   for(const check of stage.checks){assert(stage.testIds.includes(check.testId),'Context mapped outside stage tests');assert(knownContexts.has(check.contextId),'Unknown context');actual.push(check);}
   assert.deepEqual([...new Set(stage.checks.map(c=>c.testId))].sort(),[...new Set(stage.testIds)].sort(),'Stage test lacks context mapping');
  }
  // One stage may exercise several obligations with one effect; duplicates across stages are allowed.
  const key=c=>JSON.stringify([c.testId,c.contextId]);
  assert.deepEqual([...new Set(actual.map(key))].sort(),obligations.checks.filter(check=>m.scope==='full-suite'||m.requiredTestIds.includes(check.testId)).map(key).sort(),'Missing or invalid simulation context obligation');
  const deployment=catalog.deployments.find(row=>row.id===m.deploymentId),candidate=catalog.candidates.find(row=>row.id===deployment?.candidateId);
  assert(candidate?.commitSha===m.application?.sha&&candidate?.treeSha===m.application?.tree&&deployment.status==='verified','Frozen application/deployment binding must be verified before session');
  assert.equal(deployment.evidenceMode,'simulated','Simulation deployment mode required');
  const runtimeImages=verifiedDeploymentImages(catalog,deployment,evidenceReader(m.evidenceSnapshot.root));
  if(runtimeImages.some(row=>row.sourceSha!==undefined||row.sourceTree!==undefined))runtimeImageBindings=runtimeImages.filter(row=>['portal','control-api','connector-worker'].includes(row.service));
 }
 const fixtures=Object.create(null);
 await mkdir(join(m.session.options.privateDir,'manifest-'+m.namespace),{mode:0o700}); // Exclusive namespace claim: failure/ambiguity requires reconciliation, not rerun.
 const sessionModule=await import(pathToFileURL(checked.get(m.session.module)));
 return sessionModule.withSyntheticStackSession({...m.session.options,...(runtimeImageBindings===undefined?{}:{runtimeImageBindings}),root:applicationRoot,runId:m.namespace,...(m.harnessRoot===undefined?{}:{driverRoot:harnessRoot})},async session=>{
   collectionStartedAt??=new Date().toISOString();assert(Number.isFinite(Date.parse(collectionStartedAt)),'Valid collection start required');
   const importRelativeRoot=`output/alpha-simulation-import/${m.namespace}`;
   // The browser runner mounts applicationRoot read-only. Immutable row bytes are
   // written to the private session, then copied to this same relative path in
   // the workspace before import; their embedded path never changes.
   const privateImportPath=path=>{const prefix=`${importRelativeRoot}/`;assert(path.startsWith(prefix));const name=path.slice(prefix.length);assert(/^[a-zA-Z0-9-]+\.json$/u.test(name));return join(session.output,name);};
   await session.checkpoint({phase:'manifest-admitted',manifestSha256:sha(await readFile(file)),harnessRoot:m.harnessRoot??'application',namespace:m.namespace,evidenceMode:'simulated',scope:m.scope});
   const diagnosticStages=new Set(['routing-quality','navigation-quality','group-rule-quality','rule-preview']);
   const outcomes=[],emailDependentStages=downstreamStageIds(m,['emailSetup']);
   const persistOutcomes=()=>writeFile(join(session.output,'stage-outcomes.json'),JSON.stringify({namespace:m.namespace,evidenceMode:'simulated',outcomes},null,2),{mode:0o600});
   const persistImportRows=async(s,fixture,stageWindow,missingResult='unknown')=>{
    if(!evidenceBound)return[];
    const produced=projectStageImportRows({stage:s,fixture,manifest:m,catalog,stageWindow:{...stageWindow,collectionStartedAt},missingResult,artifactPathFor:(stage,row)=>`${importRelativeRoot}/import-row-${sha(JSON.stringify([stage.id,row.testId,row.contextId]))}.json`});
    for(const artifact of produced.artifacts){
     await writeFile(privateImportPath(artifact.path),artifact.bytes,{flag:'wx',mode:0o600});
     const selected=selectExactResults(m,[artifact.selection],path=>readFileSync(privateImportPath(path)));
     validateExecutionViewport(catalog,{id:artifact.row.testId,expectedResults:[]},{...selected[0].row,evidence:[artifact.selection.artifact]},path=>readFileSync(privateImportPath(path)));
    }
    await writeFile(join(session.output,'import-selections-'+sha(s.id)+'.json'),JSON.stringify({scenario:s.id,selections:produced.artifacts.map(artifact=>artifact.selection),gaps:produced.gaps},null,2),{flag:'wx',mode:0o600});
    return produced.gaps;
   };
   const requireSettledEmail=async()=>{
    const latest=outcomes.at(-1);
    // Check each outcome before advancing. Later activation must not turn an
    // earlier, contained independent failure into uncertain email work.
    if(session.capabilities?.nativeEmailAuthentication?.requiresReconciliation&&latest&&latest.status!=='passed'&&!(latest.status==='blocked'&&latest.phase==='dependencies')){await session.checkpoint({phase:'native-email-reconciliation-required',notificationState:session.capabilities.nativeEmailAuthentication.notificationState,failedScenarios:[latest.scenario]});throw Error('Owned email effects require reconciliation before further scenarios');}
   };
    const finishCompletedEmailBeforeIndependent=async(index,s)=>{
     const authentication=session.capabilities?.nativeEmailAuthentication;
     if(!authentication?.requiresReconciliation||!fixtures.email?.effectReceipt||emailDependentStages.has(s.id)||m.scenarios.slice(index+1).some(stage=>emailDependentStages.has(stage.id)))return;
     await session.checkpoint({phase:'native-email-independent-boundary',scenario:s.id,notificationState:authentication.notificationState});
     await authentication.finishCollection(fixtures);
     assert.equal(authentication.requiresReconciliation,false,'Completed email fixture remains unsettled before independent collection');
     await session.checkpoint({phase:'native-email-independent-boundary-settled',scenario:s.id});
    };
    for(const [stageIndex,s] of m.scenarios.entries()){
    await requireSettledEmail();
     await finishCompletedEmailBeforeIndependent(stageIndex,s);
    const startedAt=new Date().toISOString();
    const missing=(s.requires??[]).filter(k=>fixtures[k]===undefined);
    if(missing.length){const finishedAt=new Date().toISOString();try{await persistImportRows(s,{}, {startedAt,finishedAt},'blocked');}catch(error){outcomes.push({scenario:s.id,status:'failed',phase:'producer-contract',startedAt,finishedAt:new Date().toISOString(),...privateErrorSummary(error,checked)});await persistOutcomes();continue;}outcomes.push({scenario:s.id,status:'blocked',phase:'dependencies',missing,startedAt,finishedAt});await persistOutcomes();continue;}
    const scenarioModule=await import(pathToFileURL(checked.get(s.module)));
    assert.equal(typeof scenarioModule[s.export],'function');
    const diagnosticStartedAt=Date.now();
    if(diagnosticStages.has(s.id))try{process.stdout.write(JSON.stringify({phase:'stage-diagnostic',scenario:s.id,event:'started',at:new Date(diagnosticStartedAt).toISOString()})+'\n');}catch{/* Diagnostics must not affect qualification. */}
    let result,failure;
    try{result=await scenarioModule[s.export](session,{namespace:m.namespace,inputs:Object.fromEntries((s.requires??[]).map(k=>[k,fixtures[k]])),config:s.config??{},checks:s.checks?.map(check=>({...check})),testIds:[...s.testIds],dependencyChecks:downstreamStageChecks(m,s)});assert(result&&Object.getPrototypeOf(result)===Object.prototype,'Fixture must be plain object');}catch(error){failure=error;}
    finally{if(diagnosticStages.has(s.id))try{process.stdout.write(JSON.stringify({phase:'stage-diagnostic',scenario:s.id,event:'finished',at:new Date().toISOString(),durationMs:Date.now()-diagnosticStartedAt})+'\n');}catch{/* Diagnostics must not affect qualification. */}}
    const finishedAt=new Date().toISOString();
    if(failure){
     const diagnostic='stage-failure-'+String(outcomes.length+1).padStart(5,'0')+'.private.json';
     let diagnosticWritten=false;
     try{
      const detail={scenario:s.id,startedAt,finishedAt,...privateErrorSummary(failure,checked)};
      await writeFile(join(session.output,diagnostic),JSON.stringify(detail,null,2),{flag:'wx',mode:0o600});
      diagnosticWritten=true;
     }catch{/* Preserve the original stage failure and aggregate behavior. */}
     try{await persistImportRows(s,{}, {startedAt,finishedAt});}catch(error){outcomes.push({scenario:s.id,status:'failed',phase:'producer-contract',startedAt,finishedAt:new Date().toISOString(),...privateErrorSummary(error,checked)});await persistOutcomes();continue;}
     outcomes.push({scenario:s.id,status:'failed',startedAt,finishedAt,...privateErrorSummary(failure,checked),privateDiagnostic:diagnosticWritten?diagnostic:null});
     await persistOutcomes();
     if(failure instanceof AggregateError)throw new AggregateError([],s.id+': aggregate stage failure; inspect hashed private diagnostic');
     continue;
    }
    fixtures[s.produces]=result;
    await writeFile(join(session.output,'fixture-'+s.id+'.json'),JSON.stringify({namespace:m.namespace,evidenceMode:'simulated',scenario:s.id,fixture:s.produces,result},null,2),{flag:'wx',mode:0o600});
    await session.checkpoint({phase:s.supporting?'supporting-fixture-produced':'fixture-produced',scenario:s.id,fixture:s.produces,testIds:s.testIds});
    let producerGaps=[];
    try{producerGaps=await persistImportRows(s,result,{startedAt,finishedAt});}catch(error){outcomes.push({scenario:s.id,status:'failed',phase:'producer-contract',startedAt,finishedAt:new Date().toISOString(),...privateErrorSummary(error,checked)});await persistOutcomes();continue;}
    const behavior=stageResult(s,result);
    outcomes.push({scenario:s.id,startedAt,finishedAt,...behavior,...(producerGaps.length?{status:behavior.status==='passed'?'incomplete':behavior.status,producerGaps}:{})});
    await persistOutcomes();
   }
   // Existing session recorder/cleanup owns artifacts and primary failures.
   await writeFile(join(session.output,'fixtures.json'),JSON.stringify({namespace:m.namespace,evidenceMode:'simulated',fixtures},null,2),{mode:0o600});await requireSettledEmail();await session.capabilities?.nativeEmailAuthentication?.finishCollection(fixtures);const failures=outcomes.filter(x=>x.status!=='passed');if(failures.length)throw new AggregateError(failures.map(x=>new Error(x.scenario+': '+x.status)),failures.length+' simulation stages failed');return fixtures;
 });
}
