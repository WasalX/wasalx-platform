import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {adoptCompletedReviewFixtureStage,reviewFixtureSql} from '../scripts/release/simulation-review-fixture.mjs';
import {applyCompletedReviewObserver,applyCompletedReviewFixture,applyReviewedSelection,applyRetainedFixtures} from '../scripts/release/build-selected-simulation-manifest.mjs';
import {fullSuiteMappings} from '../scripts/release/simulation-full-suite-mappings.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const prior='alpha-b3-full3-v1',current='alpha-b3-review-test';
const unknown=['02','03'].map(x=>'cases-deliveries/delivery-state-retry-and-unknown-outcome-recovery::unknown-outcome-never-auto-resends::'+x);
const paths={fixture:`scenario-${prior}/fixture-remaining-quality.json`,claim:`review-fixture-${prior}.claim.json`,intents:`scenario-${prior}/intents.jsonl`,manifest:`manifest.${prior}.full.json`,terminal:`qualification-app-${prior}.result.json`,stageOutcomes:`scenario-${prior}/stage-outcomes.json`};
async function harness(t){
 const root=await mkdtemp(join(tmpdir(),'completed-review-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const tenant=id(1),connection=id(2),binding=id(3),delivery=id(4),review=id(5),attempt=id(6),arm='synthetic-arm',ticket='17',article='19',wire='a'.repeat(64),container='c'.repeat(64),image='sha256:'+'d'.repeat(64),chat='123456789@g.us',groupId=id(7),providerSession=id(8),opaqueSession='synthetic-session';
 const source={scenario:'remaining-quality',fixture:'remainingQuality',namespace:prior,evidenceMode:'simulated',result:{reviewFixture:{evidenceMode:'simulated',namespace:prior,tenantId:tenant,connectionId:connection,reviewId:review,deliveryId:delivery,ticketId:ticket,articleId:article,runtimeBinding:{project:'wasalx-simulation-test',connectionId:connection,providerSessionId:providerSession,containerId:container,imageId:image,socketPath:'/tmp/synthetic.sock'},retainedUnknown:{id:delivery,state:'OUTCOME_UNKNOWN',attempts:1,external_message_id:null},providerReceipt:{id:'true_'+chat+'_receipt',textSha256:wire},attemptIds:[attempt],disposition:'retain-readonly-unknown'}}};
 const claim={namespace:prior,tenantId:tenant,connectionId:connection,ticketId:ticket,wireSha256:wire,armId:arm,disposition:'reconcile-before-resume'};
 const intents=[{phase:'review-armed',armed:{id:arm,state:'ARMED'}},{phase:'review-native-accepted',articleId:Number(article)}];
 const manifest={namespace:prior},outcomes={namespace:prior,outcomes:[{scenario:'remaining-quality',status:'passed'}]};
 const values={fixture:source,claim,intents,manifest,terminal:null,stageOutcomes:outcomes},config={sourceNamespace:prior,sourceProject:'wasalx-simulation-test',sourceCandidate:{sha:'b'.repeat(40),tree:'e'.repeat(40)},sources:{}};
 async function save(name,value){const path=paths[name],bytes=Buffer.from(name==='intents'?value.map(x=>JSON.stringify(x)).join('\n')+'\n':JSON.stringify(value));await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes);config.sources[name]={path,sha256:sha(bytes)};}
 for(const name of ['fixture','claim','intents','manifest'])await save(name,values[name]);
 values.terminal={status:'terminal',exitCode:0,namespace:prior,manifestSha256:config.sources.manifest.sha256,applicationSha:config.sourceCandidate.sha,applicationTree:config.sourceCandidate.tree};
 for(const name of ['terminal','stageOutcomes'])await save(name,values[name]);
 config.requireNoFurtherAttempts=true;
 const deliveryRow={id:delivery,state:'OUTCOME_UNKNOWN',attempts:1,lease_id:null,lease_expires_at:null,external_message_id:null,group_binding_id:binding,external_chat_id:null,delivery_no_further_attempts:true},attemptRows=[{id:attempt,attempt_number:1,state:'OUTCOME_UNKNOWN',provider_code:'GOWS_NETWORK',started_at:'2026-10-03T00:00:00Z',finished_at:'2026-10-03T00:00:01Z'}],reviewRows=[{id:review,tenant_id:tenant,connection_id:connection,delivery_id:delivery,state:'RESOLVED',reason_code:'PROVIDER_OUTCOME_UNKNOWN',resolution_code:'DELIVERY_NO_FURTHER_ATTEMPTS',version:2}],stopAudits=[{tenant_id:tenant,target_type:'quarantine_record',target_id:review,action:'review.delivery_no_further_attempts',new_value:{state:'RESOLVED',version:2,resolution_code:'DELIVERY_NO_FURTHER_ATTEMPTS',provider_outcome:'OUTCOME_UNKNOWN',no_further_attempts:true,provider_reissued:false}}],receipts=[{id:'true_'+chat+'_receipt',textSha256:wire}];
 const calls=[];const s={privateDir:root,model:{name:config.sourceProject},tenantId:tenant,containers:{'waha-gows':{Id:container,Image:image}},socketPath:'/tmp/synthetic.sock',capabilities:{},checkpoint:async x=>calls.push(['checkpoint',x.phase]),readReviewArms:async x=>{calls.push(['control',x.action]);return[{id:arm,state:'CONSUMED'}]},run:async(command,args)=>{calls.push(['run',command,args]);return JSON.stringify({evidenceClass:'simulated-provider',receipts})},scoped:async(sql,args)=>{assert.match(sql,/^(SELECT|WITH)\b/u);calls.push(['scoped',sql,args]);if(sql.includes('SELECT b.routing_group_id'))return[{routing_group_id:chat,external_group_id:chat,whatsapp_group_id:groupId}];if(sql.startsWith('SELECT id,opaque_session_id FROM provider_sessions'))return[{id:providerSession,opaque_session_id:opaqueSession}];if(sql===reviewFixtureSql.delivery)return[deliveryRow];if(sql===reviewFixtureSql.attempts)return structuredClone(attemptRows);if(sql===reviewFixtureSql.review)return reviewRows;if(sql===reviewFixtureSql.stopAudit)return structuredClone(stopAudits);return[{inbox:[],deliveries:[],unknowns:[source.result.reviewFixture.retainedUnknown],pending_inbox:0,pending_actions:0,pending_status:0,pending_operations:0,pending_direct:0,unknown_direct:0,unknown_actions:0}];}};
 const group={evidenceMode:'simulated',namespace:current,tenantId:tenant,connectionId:connection,bindingId:binding,groupId,groupRef:chat};
 return{root,values,config,s,group,calls,save,deliveryRow,attemptRows,reviewRows,stopAudits,receipts};
}
test('completed passed full3 source adopts only exact current UNKNOWN with read-only actions',async t=>{const h=await harness(t),result=await adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}});assert.equal(result.reviewId,id(5));assert.equal(result.namespace,current);assert.equal(result.noReplay,true);await h.s.capabilities.reviewFixture.verifyReadOnly();assert(h.calls.some(x=>x[0]==='control'&&x[1]==='read-arms'));assert(h.calls.filter(x=>x[0]==='run').every(x=>x[1]==='docker'&&x[2][2]==='node'&&x[2].at(-1).includes("fetch('http://127.0.0.1:3000/__simulation/receipts")));assert(!h.calls.some(x=>JSON.stringify(x).includes('arm-next-send')||JSON.stringify(x).includes('POST')));});
for(const [name,change] of Object.entries({claim:h=>h.values.claim.wireSha256='f'.repeat(64),intents:h=>h.values.intents[1].articleId=20,terminal:h=>h.values.terminal.exitCode=1,outcome:h=>h.values.stageOutcomes.outcomes[0].status='failed'}))test('rejects changed '+name+' even with recomputed source hash',async t=>{const h=await harness(t);change(h);await h.save(name==='outcome'?'stageOutcomes':name,h.values[name==='outcome'?'stageOutcomes':name]);await assert.rejects(adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}}));assert(!h.calls.some(x=>x[0]==='run'));});
for(const [name,change] of Object.entries({delivery:h=>h.deliveryRow.state='SENT',attempt:h=>h.attemptRows[0].state='SENT',openReview:h=>h.reviewRows[0].state='OPEN',reviewCode:h=>h.reviewRows[0].resolution_code='DELIVERY_CONFIRMED_SENT',stopFunction:h=>h.deliveryRow.delivery_no_further_attempts=false,stopAudit:h=>h.stopAudits[0].new_value.provider_reissued=true,provider:h=>h.receipts.push(h.receipts[0]),binding:h=>h.group.groupRef='987654321@g.us',session:h=>h.s.scoped=async sql=>sql.startsWith('SELECT id,opaque_session_id FROM provider_sessions')?[{id:id(9),opaque_session_id:'synthetic-session'}]:[],arm:h=>h.s.readReviewArms=async()=>[{id:'synthetic-arm',state:'ARMED'}]}))test('rejects changed current '+name,async t=>{const h=await harness(t);change(h);await assert.rejects(adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}}));});
test('selected builder owns exactly two review IDs and excludes effectful producers',()=>{const base='scripts/release/',scenarios=[{id:'fresh-group',module:base+'simulation-fresh-group.mjs',export:'runFreshGroupVertical',requires:[],produces:'group',testIds:[],supporting:true},{id:'meta-terminal',module:base+'simulation-meta-terminal.mjs',export:'metaTerminalStage',requires:[],produces:'metaTerminal',testIds:[unknown[0]]},{id:'remaining-quality',module:base+'simulation-remaining-quality-stage.mjs',export:'remainingCasesWorkflowQualityStage',requires:['group'],produces:'remainingQuality',testIds:[unknown[1]]}],selection={schemaVersion:1,reviewedBy:'focused-test',baseSourceSha256:'a'.repeat(64),additionalSourceSha256:'b'.repeat(64),baseTestIds:[],additionalTestIds:unknown,multiStageTestIds:[],consumedNamespaces:[],consumedPaths:[]},setup={namespace:current,project:'wasalx-simulation-test',scope:'selected-vertical',stateMode:'continuation',reviewedSelection:selection,completedReviewObserver:{sourceNamespace:prior,sourceProject:'wasalx-simulation-test',sourceCandidate:{sha:'a'.repeat(40),tree:'b'.repeat(40)},sources:Object.fromEntries(Object.entries(paths).map(([key,path])=>[key,{path,sha256:'a'.repeat(64)}]))},retainedFixtures:{schemaVersion:1,sourceNamespace:prior,stages:{'fresh-group':{sourceStage:'fresh-group',expectedFixture:'group',path:`scenario-${prior}/fixture-fresh-group.json`,sha256:'a'.repeat(64)}},rerunStageIds:['completed-review-adoption']}};applyCompletedReviewObserver(scenarios,setup,base,(id,module,fn,requires,produces,testIds,config)=>scenarios.push({id,module,export:fn,requires,produces,testIds,config}));const selected=[];applyReviewedSelection(selected,scenarios,selection,{namespace:current,paths:[resolve('private/new-setup.json'),resolve('private/new-manifest.json')]});applyRetainedFixtures(selected,setup.retainedFixtures);assert.deepEqual(selected.map(x=>x.id),['fresh-group','completed-review-adoption','unknown-review-completed']);assert.deepEqual(selected.flatMap(x=>x.testIds),unknown);assert(selected.slice(0,2).every(x=>x.supporting));const catalog={contexts:[{id:'tenant_owner-en-desktop'}],journeys:[{useCases:[{tests:unknown.map(id=>({id,requiredContextIds:['tenant_owner-en-desktop']}))}]}]};const mapping=fullSuiteMappings(catalog,selected,()=>assert.fail('no applicability'),{selected:true});assert.equal([...mapping.byStage.values()].flat().length,2);});

test('admission binds current original attempt code and guards later drift',async t=>{const h=await harness(t);assert.equal(h.values.fixture.result.reviewFixture.providerCode,undefined);const f=await adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}});assert.equal(f.providerCode,'GOWS_NETWORK');assert.equal(f.providerCodeObservation,'current-original-attempt-at-admission');h.attemptRows[0].provider_code='UNRELATED_SAFE_CODE';await assert.rejects(h.s.capabilities.reviewFixture.verifyReadOnly);});
test('admission rejects missing code and disagreement with recorded source code',async t=>{for(const missing of[true,false]){const h=await harness(t);if(missing)delete h.attemptRows[0].provider_code;else{h.values.fixture.result.reviewFixture.providerCode='UNRELATED_SAFE_CODE';await h.save('fixture',h.values.fixture);}await assert.rejects(adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}}));}});

test('reviewed failed run retains a passed review fixture without changing its terminal result',async t=>{
 const h=await harness(t);h.config.sourceExitCode=1;h.values.terminal.exitCode=1;
 h.values.stageOutcomes.outcomes.push({scenario:'native-business',status:'failed'});
 await h.save('terminal',h.values.terminal);await h.save('stageOutcomes',h.values.stageOutcomes);
 const result=await adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}});
 assert.equal(result.noReplay,true);assert.equal(result.deliveryId,h.deliveryRow.id);
 assert.equal(h.values.terminal.exitCode,1);assert(!h.calls.some(x=>JSON.stringify(x).includes('POST')));
});
test('reviewed failed run rejects failed, missing or duplicate relevant stage outcomes',async t=>{
 for(const outcomes of[[],[{scenario:'remaining-quality',status:'failed'}],[{scenario:'remaining-quality',status:'passed'},{scenario:'remaining-quality',status:'passed'}]]){
  const h=await harness(t);h.config.sourceExitCode=1;h.values.terminal.exitCode=1;h.values.stageOutcomes.outcomes=outcomes;
  await h.save('terminal',h.values.terminal);await h.save('stageOutcomes',h.values.stageOutcomes);
  await assert.rejects(adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}}));
  assert(!h.calls.some(x=>x[0]==='run'));
 }
});
test('retained native selection adopts the exact review before direct capabilities without adding tests',()=>{
 const base='scripts/release/',testId='native-business-check';
 const scenarios=[{id:'fresh-group',requires:[],produces:'group',testIds:[],supporting:true},{id:'direct-capabilities',requires:['group'],produces:'directConnection',testIds:[],supporting:true},{id:'native-business',requires:['group','directConnection'],produces:'nativeBusiness',testIds:[testId]}];
 const selection={schemaVersion:1,reviewedBy:'focused-test',baseSourceSha256:'a'.repeat(64),additionalSourceSha256:'b'.repeat(64),baseTestIds:[],additionalTestIds:[testId],multiStageTestIds:[],consumedNamespaces:[],consumedPaths:[]};
 const setup={namespace:current,project:'wasalx-simulation-test',scope:'selected-vertical',stateMode:'continuation',reviewedSelection:selection,completedReviewFixture:{sourceNamespace:prior,sourceProject:'wasalx-simulation-test',sourceCandidate:{sha:'a'.repeat(40),tree:'b'.repeat(40)},sourceExitCode:1,requireNoFurtherAttempts:true,sources:Object.fromEntries(Object.entries(paths).map(([key,path])=>[key,{path,sha256:'a'.repeat(64)}]))},retainedFixtures:{schemaVersion:1,sourceNamespace:prior,stages:{'fresh-group':{sourceStage:'fresh-group',expectedFixture:'group',path:`scenario-${prior}/fixture-fresh-group.json`,sha256:'a'.repeat(64)}},rerunStageIds:['completed-review-adoption','direct-capabilities']}};
 assert.throws(()=>applyCompletedReviewFixture(structuredClone(scenarios),{...setup,completedReviewFixture:{...setup.completedReviewFixture,requireNoFurtherAttempts:false}},base));
 applyCompletedReviewFixture(scenarios,setup,base);
 const selected=[];applyReviewedSelection(selected,scenarios,selection,{namespace:current,paths:[resolve('private/new-setup.json'),resolve('private/new-manifest.json')]});applyRetainedFixtures(selected,setup.retainedFixtures);
 assert.deepEqual(selected.map(x=>x.id),['fresh-group','completed-review-adoption','direct-capabilities','native-business']);
 assert.deepEqual(selected.flatMap(x=>x.testIds),[testId]);
 assert.deepEqual(selected.find(x=>x.id==='direct-capabilities').requires,['group','reviewFixture']);
 assert.deepEqual(selected.find(x=>x.id==='direct-capabilities').config,{completedReview:true});
 assert.equal(selected.find(x=>x.id==='completed-review-adoption').supporting,true);
 assert.throws(()=>applyCompletedReviewFixture([], {...setup,scope:'full-suite'},base));
});

test('read-only verifier rejects stopped-review audit drift after admission',async t=>{const h=await harness(t);await adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}});h.stopAudits[0].new_value.version=3;await assert.rejects(h.s.capabilities.reviewFixture.verifyReadOnly);});

// A selected source may fail its aggregate while the exact review fixture rows passed.
test('selected failed aggregate admits only the exact passed retained review proof',async t=>{
 const h=await harness(t),prefix='cases-deliveries/delivery-state-retry-and-unknown-outcome-recovery::';
 const ids=[prefix+'unknown-outcome-never-auto-resends::01',prefix+'unknown-outcome-never-auto-resends::03',...['loading','safe-error-recovery','empty','degraded','keyboard-focus'].map(x=>prefix+'ui-quality::'+x)];
 h.values.fixture.result.status='quality-collection-completed';h.values.fixture.result.results=ids.map(testId=>({testId,result:'passed'}));
 h.values.fixture.result.unknownReview={proofs:[{testId:ids[1],result:'passed'}]};await h.save('fixture',h.values.fixture);
 h.config.sourceExitCode=1;
 const manifestPath=`manifest.${prior}.roster1.selected.json`,bytes=Buffer.from(JSON.stringify(h.values.manifest));
 await writeFile(join(h.root,manifestPath),bytes);h.config.sources.manifest={path:manifestPath,sha256:sha(bytes)};
 h.values.terminal.exitCode=1;h.values.terminal.manifestSha256=sha(bytes);await h.save('terminal',h.values.terminal);
 h.values.stageOutcomes.outcomes[0].status='failed';await h.save('stageOutcomes',h.values.stageOutcomes);
 const adopted=await adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}});
 assert.equal(adopted.noReplay,true);assert.equal(h.values.stageOutcomes.outcomes[0].status,'failed');
 h.values.fixture.result.results[1].result='failed';await h.save('fixture',h.values.fixture);
 await assert.rejects(adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}}));
 assert(!h.calls.some(x=>JSON.stringify(x).includes('POST')));
});
test('completed review producer rejects a separately retained fixture namespace',()=>{
 const base='scripts/release/',scenarios=[{id:'fresh-group',requires:[],produces:'group',testIds:[],supporting:true},{id:'direct-capabilities',requires:['group'],produces:'directConnection',testIds:[],supporting:true}];
 const setup={namespace:current,project:'wasalx-simulation-test',scope:'selected-vertical',stateMode:'continuation',reviewedSelection:{baseTestIds:[]},completedReviewFixture:{sourceNamespace:prior,sourceProject:'wasalx-simulation-test',sourceCandidate:{sha:'a'.repeat(40),tree:'b'.repeat(40)},sourceExitCode:1,requireNoFurtherAttempts:true,sources:Object.fromEntries(Object.entries(paths).map(([key,path])=>[key,{path,sha256:'a'.repeat(64)}]))},retainedFixtures:{schemaVersion:1,sourceNamespace:'different-retained-source',stages:{},rerunStageIds:['completed-review-adoption','direct-capabilities']}};
 assert.throws(()=>applyCompletedReviewFixture(structuredClone(scenarios),setup,base));
 applyCompletedReviewFixture(scenarios,{...setup,retainedFixtures:{...setup.retainedFixtures,sourceNamespace:prior}},base);
 assert.deepEqual(scenarios.map(x=>x.id),['fresh-group','completed-review-adoption','direct-capabilities']);
 assert.deepEqual(scenarios.at(-1).requires,['group','reviewFixture']);
 assert.throws(()=>applyCompletedReviewFixture(structuredClone(scenarios.slice(0,2)),{...setup,retainedFixtures:{...setup.retainedFixtures,sourceNamespace:'../foreign'},completedReviewFixture:{...setup.completedReviewFixture,sourceNamespace:'../foreign'}},base));
});

test('an explicit null original provider code is admitted as observed, never substituted',async t=>{const h=await harness(t);h.attemptRows[0].provider_code=null;const f=await adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}});assert.equal(f.providerCode,null);h.attemptRows[0].provider_code='GOWS_NETWORK';await assert.rejects(h.s.capabilities.reviewFixture.verifyReadOnly);});
test('stopped-review audit must be bound to this tenant and review',async t=>{for(const change of [a=>a.tenant_id=id(9),a=>a.target_id=id(9)]){const h=await harness(t);change(h.stopAudits[0]);await assert.rejects(adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}}));}});
test('adopted review requires the current image and active provider session binding',async t=>{
 const image=await harness(t);image.s.containers['waha-gows'].Image='sha256:'+'f'.repeat(64);await assert.rejects(adoptCompletedReviewFixtureStage(image.s,{namespace:current,inputs:{group:image.group},config:{completedReview:image.config}}));
});
import {completedUnknownReadOnlyStage} from '../scripts/release/simulation-review-fixture.mjs';
import {directCapabilitiesStage} from '../scripts/release/simulation-direct-capabilities.mjs';
test('completed read-only stage and direct capabilities require the exact adopted capability',async t=>{
 const h=await harness(t),f=await adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}});
 await assert.rejects(completedUnknownReadOnlyStage(h.s,{namespace:current,inputs:{reviewFixture:{...f}}}),/Exact adopted review capability/);
 await assert.rejects(completedUnknownReadOnlyStage(h.s,{namespace:'other',inputs:{reviewFixture:f}}));
 await assert.rejects(directCapabilitiesStage(h.s,{namespace:current,inputs:{group:h.group,reviewFixture:{...f}},config:{completedReview:true}}),/Exact current completed review capability/);
 let verified=0;h.s.capabilities.reviewFixture.verifyReadOnly=async()=>{verified++;throw Error('changed');};
 await assert.rejects(directCapabilitiesStage(h.s,{namespace:current,inputs:{group:h.group,reviewFixture:f},config:{completedReview:true}}),/changed/);assert.equal(verified,1);
});

test('completed read-only verification re-reads authoritative consumed arms and rejects any later rearm',async t=>{
 const h=await harness(t);await adoptCompletedReviewFixtureStage(h.s,{namespace:current,inputs:{group:h.group},config:{completedReview:h.config}});h.s.readReviewArms=async()=>[{id:h.values.claim.armId,state:'ARMED'}];await assert.rejects(h.s.capabilities.reviewFixture.verifyReadOnly,/arm state changed/u);
});
