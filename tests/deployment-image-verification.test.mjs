import test from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{verifiedDeploymentImages}from'../scripts/release/deployment-image-verification.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),digest=value=>'sha256:'+value.repeat(64).slice(0,64),at='2026-09-21T15:00:00.000Z',sha='a'.repeat(40),tree='b'.repeat(40);
function fixture(){const build={sha,tree,completedAt:'2026-09-21T14:00:00.000Z',results:[{id:'portal',imageId:digest('1')},{id:'build-only',imageId:digest('2')}]},runtime={status:'PASS',deploymentId:'d',project:'project',observedAt:'2026-09-21T14:30:00.000Z',runtimeGeneration:{project:'project',containers:{portal:{status:'running',id:'c'.repeat(64),image:digest('1')},removed:{status:'exited',id:'d'.repeat(64),image:digest('2')},postgres:{status:'running',id:'e'.repeat(64),image:digest('3')}}}},files=new Map([['build',Buffer.from(JSON.stringify(build))],['runtime',Buffer.from(JSON.stringify(runtime))]]),proof=path=>({path,sha256:hash(files.get(path)),capturedAt:at,originalSha:sha,originalTree:tree}),deployment={id:'d',candidateId:'c',project:'project',evidenceMode:'simulated',images:[{id:'build-catalog',imageId:digest('1')}]},verificationSource=`build:${proof('build').sha256};runtime:${proof('runtime').sha256}`,images=[{service:'portal',expectedDigest:digest('1'),runningDigest:digest('1'),containerId:'c'.repeat(64),verificationSource}],review={id:'image-correction',kind:'deployment-image-verification-correction',deploymentId:'d',candidateId:'c',project:'project',reviewer:'auditor',source:'immutable receipts',reason:'Separate build catalog from running services',recordedAt:at,originalImagesSha256:hash(Buffer.from(JSON.stringify(deployment.images))),buildReceipt:proof('build'),runtimeReceipt:proof('runtime'),images},data={candidates:[{id:'c',commitSha:sha,treeSha:tree}],deployments:[deployment],reviews:[]},read=path=>files.get(path);data.reviews.push(review);return{data,deployment,review,build,runtime,files,read}}
test('derives exact usual service records and excludes build-only and upstream images',()=>{const f=fixture();assert.deepEqual(verifiedDeploymentImages(f.data,f.deployment,f.read),f.review.images)});
test('preserves directly verified deployments without evidence reads',()=>{const f=fixture(),deployment={...f.deployment,images:[{service:'portal',expectedDigest:digest('1'),runningDigest:digest('1'),containerId:'c'.repeat(64)}]};assert.deepEqual(verifiedDeploymentImages({...f.data,reviews:[]},deployment,()=>{throw Error('unused')}),deployment.images)});
test('rejects altered runtime digest',()=>{const f=fixture();f.review.images[0].runningDigest=digest('4');assert.throws(()=>verifiedDeploymentImages(f.data,f.deployment,f.read),/immutable receipts/)});
test('rejects build-only service relabeled as running',()=>{const f=fixture();f.review.images.push({service:'removed',expectedDigest:digest('2'),runningDigest:digest('2'),containerId:'d'.repeat(64),verificationSource:f.review.images[0].verificationSource});assert.throws(()=>verifiedDeploymentImages(f.data,f.deployment,f.read),/immutable receipts/)});
test('rejects missing running service',()=>{const f=fixture();f.review.images=[];assert.throws(()=>verifiedDeploymentImages(f.data,f.deployment,f.read),/immutable receipts/)});
test('rejects duplicate correction',()=>{const f=fixture();f.data.reviews.push(structuredClone(f.review));assert.throws(()=>verifiedDeploymentImages(f.data,f.deployment,f.read),/Ambiguous deployment image correction/)});
test('rejects ambiguous build digest',()=>{const f=fixture();f.build.results.push({id:'duplicate',imageId:digest('1')});f.files.set('build',Buffer.from(JSON.stringify(f.build)));f.review.buildReceipt.sha256=hash(f.files.get('build'));f.review.images[0].verificationSource=`build:${f.review.buildReceipt.sha256};runtime:${f.review.runtimeReceipt.sha256}`;assert.throws(()=>verifiedDeploymentImages(f.data,f.deployment,f.read),/Ambiguous build image digest/)});
test('rejects changed proof bytes',()=>{const f=fixture();f.files.set('runtime',Buffer.from('{}'));assert.throws(()=>verifiedDeploymentImages(f.data,f.deployment,f.read),/proof changed/)});
test('rejects stale preimage and candidate or project mismatch',()=>{for(const mutate of[f=>f.review.originalImagesSha256='0'.repeat(64),f=>f.review.candidateId='other',f=>f.review.project='other']){const f=fixture();mutate(f);assert.throws(()=>verifiedDeploymentImages(f.data,f.deployment,f.read))}});
test('never uses a metadata correction to admit live evidence',()=>{const f=fixture();f.deployment.evidenceMode='live';assert.throws(()=>verifiedDeploymentImages(f.data,f.deployment,f.read),/cannot admit live evidence/)});

function mixedFixture(services=['portal','control-api','connector-worker']){
 const baseSha='8'.repeat(40),baseTree='9'.repeat(40),currentSha='a'.repeat(40),currentTree='b'.repeat(40),at='2026-10-03T23:30:00Z',project='mixed-project';
 const images=services.map((service,index)=>({service,containerId:String(index+1).repeat(64),expectedDigest:digest(String(index+1)),runningDigest:digest(String(index+1))}));
 const original={id:'original',candidateId:'base',project,status:'verified',evidenceMode:'simulated',images:structuredClone(images)};
 const deployment={id:'mixed',candidateId:'current',project,status:'verified',evidenceMode:'simulated',originalRuntimeDeploymentId:'original',images:images.map(row=>({...row,sourceSha:baseSha,sourceTree:baseTree}))};
 Object.assign(deployment.images[0],{containerId:'4'.repeat(64),expectedDigest:digest('4'),runningDigest:digest('4'),sourceSha:currentSha,sourceTree:currentTree});
 const files=new Map(),binding=(path,sourceSha=currentSha,sourceTree=currentTree)=>({path,sha256:hash(files.get(path)),capturedAt:at,originalSha:sourceSha,originalTree:sourceTree});
 const put=(path,value)=>files.set(path,Buffer.from(JSON.stringify(value)));
 put('old-build',{status:'PASS',sha:baseSha,tree:baseTree,results:images.map((row,index)=>({id:services[index],imageId:row.runningDigest}))});original.buildReceipt=binding('old-build',baseSha,baseTree);
 put('new-build',{status:'PASS',sha:currentSha,tree:currentTree,completedAt:'2026-10-03T23:00:00Z',results:[{id:'portal',imageId:digest('4')}]});deployment.buildReceipt=binding('new-build');
 put('runtime',{at:'2026-10-03T23:20:00Z',project,images:deployment.images.map(row=>({service:row.service,containerId:row.containerId,imageId:row.runningDigest,sourceSha:row.sourceSha,sourceTree:row.sourceTree,state:'running',health:'healthy'}))});
 put('inputs',{base:baseSha,head:currentSha,unchangedCanonicalObjects:[{path:'service-input',baseObject:'c'.repeat(40),headObject:'c'.repeat(40)}]});
 put('closure',{base:baseSha,head:currentSha,rows:[{importer:'retained-service',equal:true,oldSha256:'d'.repeat(64),newSha256:'d'.repeat(64)}]});
 const impact={kind:'qualification-runtime-source-impact-equivalence',status:'PASS',reviewer:'independent-reviewer',reason:'Reviewed retained build/source closure',source:'immutable build, runtime and source receipts',recordedAt:at,application:{sha:currentSha,tree:currentTree},deploymentId:'mixed',project,preservedOriginalDeploymentId:'original',retainedImages:images.slice(1).map(row=>({id:row.service,imageId:row.runningDigest})),actualPrerequisiteReceipts:{currentRuntimeReceipt:binding('runtime'),buildInputEquivalenceReceipt:binding('inputs'),productionClosureReceipt:binding('closure')}};
 put('impact',impact);deployment.sourceImpactEquivalenceReceipt=binding('impact');
 const data={candidates:[{id:'base',commitSha:baseSha,treeSha:baseTree},{id:'current',commitSha:currentSha,treeSha:currentTree}],deployments:[original,deployment]};
 const rewrite=(path,change)=>{const value=JSON.parse(files.get(path));change(value);put(path,value);if(path==='impact')deployment.sourceImpactEquivalenceReceipt=binding(path);else if(path==='new-build')deployment.buildReceipt=binding(path);else{const key={runtime:'currentRuntimeReceipt',inputs:'buildInputEquivalenceReceipt',closure:'productionClosureReceipt'}[path];impact.actualPrerequisiteReceipts[key]=binding(path);put('impact',impact);deployment.sourceImpactEquivalenceReceipt=binding('impact');}};
 return{data,deployment,original,files,rewrite,read:path=>files.get(path)};
}
test('mixed source images require original build, actual census and reviewed unchanged production closure',()=>{const f=mixedFixture();assert.deepEqual(verifiedDeploymentImages(f.data,f.deployment,f.read),f.deployment.images);});
for(const[name,change]of Object.entries({
 unreviewedProof:f=>f.rewrite('impact',value=>delete value.reviewer),
 missingProof:f=>delete f.deployment.sourceImpactEquivalenceReceipt,
 tamperedProof:f=>f.files.set('impact',Buffer.from('{}')),
 unknownOriginal:f=>f.data.candidates=f.data.candidates.filter(row=>row.id!=='base'),
 cyclicOriginal:f=>f.original.images[0].sourceSha='a'.repeat(40),
 wrongRuntimeDigest:f=>f.rewrite('runtime',value=>value.images[1].imageId=digest('8')),
 wrongRuntimeSource:f=>f.rewrite('runtime',value=>value.images[1].sourceSha='f'.repeat(40)),
 wrongContainer:f=>f.deployment.images[1].containerId='f'.repeat(64),
 wrongCurrentBuild:f=>f.rewrite('new-build',value=>value.results[0].imageId=digest('8')),
 changedCanonicalInput:f=>f.rewrite('inputs',value=>value.unchangedCanonicalObjects[0].headObject='f'.repeat(40)),
 changedProductionClosure:f=>f.rewrite('closure',value=>value.rows[0].newSha256='f'.repeat(64)),
 missingCanonicalInputs:f=>f.rewrite('inputs',value=>value.unchangedCanonicalObjects=[]),
 missingProductionClosure:f=>f.rewrite('closure',value=>value.rows=[]),
 retainedCoverageMissing:f=>f.rewrite('impact',value=>value.retainedImages.pop()),
 unrelatedOriginalImage:f=>f.original.images[1].runningDigest=digest('8'),
 partialSourceBinding:f=>delete f.deployment.images[1].sourceTree,
 liveMode:f=>f.deployment.evidenceMode='live'
}))test('mixed source proof rejects '+name,()=>{const f=mixedFixture();change(f);assert.throws(()=>verifiedDeploymentImages(f.data,f.deployment,f.read));});

function freshFixture(){
 const f=mixedFixture(['portal','migrate','connector-worker']),prior=f.deployment,tool={id:'tool',commitSha:'e'.repeat(40),treeSha:'f'.repeat(40)};
 const deployment={...prior,id:'fresh',project:'fresh-project',namespace:'fresh-run',verifiedAt:at,toolingCandidateId:tool.id,toolingCommitSha:tool.commitSha,toolingTreeSha:tool.treeSha,images:prior.images.map((row,index)=>({...row,containerId:String(index+6).repeat(64)}))};
 f.data.candidates.push(tool);f.data.deployments.push(deployment);
 const put=(name,value)=>{f.files.set(name,Buffer.from(JSON.stringify(value)));return{path:name,sha256:hash(f.files.get(name)),capturedAt:at,originalSha:tool.commitSha,originalTree:tool.treeSha};};
 deployment.freshPlanReceipt=put('fresh-plan',{project:deployment.project,images:Object.fromEntries(deployment.images.map(row=>[row.service,row.runningDigest]))});
 const runtime={status:'PASS_FRESH_RUNTIME_READONLY',runtimeMutation:false,deploymentId:deployment.id,project:deployment.project,namespace:deployment.namespace,observedAt:at,application:{sha:deployment.images[0].sourceSha,tree:deployment.images[0].sourceTree},qualificationTooling:{sha:tool.commitSha,tree:tool.treeSha},serviceCount:3,services:Object.fromEntries(deployment.images.map(row=>[row.service,{id:row.containerId,image:row.runningDigest,state:'running',health:'healthy'}])),candidateImageLabels:Object.fromEntries(deployment.images.map(row=>[row.runningDigest,{'org.opencontainers.image.revision':row.sourceSha,'io.wasalx.source.tree':row.sourceTree}]))};
 deployment.runtimeIdentityReceipt=put('fresh-runtime',runtime);
 const binding={kind:'fresh-image-binding-readback',applicationSha:runtime.application.sha,applicationTree:runtime.application.tree,toolingSha:tool.commitSha,toolingTree:tool.treeSha,project:deployment.project,namespace:deployment.namespace,planSha256:deployment.freshPlanReceipt.sha256,retainedImageDeploymentId:prior.id,retainedPortalReceiptSha256:prior.buildReceipt.sha256,retainedSourceImpactReceiptSha256:prior.sourceImpactEquivalenceReceipt.sha256,currentRuntimeCensusSha256:deployment.runtimeIdentityReceipt.sha256,runtimeServices:3,images:deployment.images};
 deployment.imageBindingReceipt=put('fresh-binding',binding);
 const rewrite=(name,change)=>{const value=JSON.parse(f.files.get(name));change(value);const ref=put(name,value);if(name==='fresh-runtime'){deployment.runtimeIdentityReceipt=ref;binding.currentRuntimeCensusSha256=ref.sha256;deployment.imageBindingReceipt=put('fresh-binding',binding);}else if(name==='fresh-binding')deployment.imageBindingReceipt=ref;else if(name==='fresh-plan'){deployment.freshPlanReceipt=ref;binding.planSha256=ref.sha256;deployment.imageBindingReceipt=put('fresh-binding',binding);}};
 return{...f,deployment,prior,runtime,binding,put,rewrite};
}
test('fresh isolated runtime reuses canonically verified images with new exact containers',()=>{const f=freshFixture();assert.deepEqual(verifiedDeploymentImages(f.data,f.deployment,f.read),f.deployment.images);assert.notEqual(f.deployment.project,f.prior.project);});
test('fresh runtime admits successful one-shot services',()=>{const f=freshFixture();f.rewrite('fresh-runtime',x=>Object.assign(x.services.migrate,{state:'exited',exitCode:0,health:''}));assert.deepEqual(verifiedDeploymentImages(f.data,f.deployment,f.read),f.deployment.images);});
for(const[name,change]of Object.entries({
 tamperedBinding:f=>f.files.set('fresh-binding',Buffer.from('{}')),
 historicalClosureTampered:f=>f.files.set('closure',Buffer.from('{}')),
 wrongBindingOwner:f=>f.deployment.imageBindingReceipt.originalSha='1'.repeat(40),
 missingTool:f=>delete f.deployment.toolingCandidateId,
 wrongToolTree:f=>f.deployment.toolingTreeSha='1'.repeat(40),
 wrongApplication:f=>f.rewrite('fresh-binding',x=>x.applicationSha='1'.repeat(40)),
 wrongNamespace:f=>f.rewrite('fresh-binding',x=>x.namespace='other'),
 wrongPlan:f=>f.rewrite('fresh-binding',x=>x.planSha256='0'.repeat(64)),
 unrelatedPlan:f=>f.rewrite('fresh-plan',x=>x.project='other'),
 changedPlannedImage:f=>f.rewrite('fresh-plan',x=>x.images.portal=digest('9')),
 missingPlannedService:f=>f.rewrite('fresh-plan',x=>delete x.images.migrate),
 wrongOriginal:f=>f.rewrite('fresh-binding',x=>x.retainedImageDeploymentId='missing'),
 selfOriginal:f=>f.rewrite('fresh-binding',x=>x.retainedImageDeploymentId=f.deployment.id),
 substitutedBuild:f=>f.deployment.buildReceipt={...f.prior.buildReceipt,path:'other'},
 wrongHistoricalImpact:f=>f.rewrite('fresh-binding',x=>x.retainedSourceImpactReceiptSha256='0'.repeat(64)),
 wrongHistoricalBuild:f=>f.rewrite('fresh-binding',x=>x.retainedPortalReceiptSha256='0'.repeat(64)),
 wrongRuntimeHash:f=>f.rewrite('fresh-binding',x=>x.currentRuntimeCensusSha256='0'.repeat(64)),
 relabeledSource:f=>f.rewrite('fresh-binding',x=>{x.images[1].sourceSha=f.deployment.images[0].sourceSha;f.deployment.images=x.images;}),
 missingService:f=>f.rewrite('fresh-binding',x=>{x.images.pop();f.deployment.images=x.images;}),
 wrongRuntimeProject:f=>f.rewrite('fresh-runtime',x=>x.project='old-project'),
 wrongRuntimeDeployment:f=>f.rewrite('fresh-runtime',x=>x.deploymentId='old'),
 wrongRuntimeTool:f=>f.rewrite('fresh-runtime',x=>x.qualificationTooling.sha='1'.repeat(40)),
 wrongRuntimeTime:f=>f.rewrite('fresh-runtime',x=>x.observedAt='2026-09-21T16:00:00Z'),
 wrongRuntimeContainer:f=>f.rewrite('fresh-runtime',x=>x.services.portal.id='1'.repeat(64)),
 wrongRuntimeDigest:f=>f.rewrite('fresh-runtime',x=>x.services.portal.image=digest('9')),
 wrongRuntimeLabels:f=>f.rewrite('fresh-runtime',x=>x.candidateImageLabels[f.deployment.images[1].runningDigest]['io.wasalx.source.tree']='1'.repeat(40)),
 unhealthyRuntime:f=>f.rewrite('fresh-runtime',x=>x.services.portal.health='unhealthy'),
 failedOneShot:f=>f.rewrite('fresh-runtime',x=>Object.assign(x.services.migrate,{state:'exited',exitCode:1})),
 liveMode:f=>f.deployment.evidenceMode='live'
}))test('fresh runtime proof rejects '+name,()=>{const f=freshFixture();change(f);assert.throws(()=>verifiedDeploymentImages(f.data,f.deployment,f.read));});
test('fresh runtime rejects cyclic inherited provenance',()=>{const f=freshFixture();const second={...f.deployment,id:'fresh-second'};f.data.deployments.push(second);second.imageBindingReceipt=f.put('second-binding',{...f.binding,retainedImageDeploymentId:f.deployment.id});f.rewrite('fresh-binding',x=>x.retainedImageDeploymentId=second.id);assert.throws(()=>verifiedDeploymentImages(f.data,f.deployment,f.read),/Cyclic deployment image provenance/);});


function mixedSuccessorFixture(){
 const f=mixedFixture(['portal','control-api','migrate']),prior=f.deployment,head='e'.repeat(40),tree='f'.repeat(40),time='2026-10-04T00:00:00Z';
 const deployment={...prior,id:'successor',candidateId:'next',originalRuntimeDeploymentId:prior.id,images:structuredClone(prior.images)};
 Object.assign(deployment.images[1],{containerId:'7'.repeat(64),expectedDigest:digest('7'),runningDigest:digest('7'),sourceSha:head,sourceTree:tree});
 f.data.candidates.push({id:'next',commitSha:head,treeSha:tree});f.data.deployments.push(deployment);
 const put=(path,value)=>{f.files.set(path,Buffer.from(JSON.stringify(value)));return{path,sha256:hash(f.files.get(path)),capturedAt:time,originalSha:head,originalTree:tree};};
 const census=images=>images.map(row=>({service:row.service,containerId:row.containerId,imageId:row.runningDigest,sourceSha:row.sourceSha,sourceTree:row.sourceTree,state:row.service==='migrate'?'exited':'running',health:row.service==='migrate'?'':'healthy',exitCode:0,startedAt:'2026-10-03T23:00:00Z',finishedAt:row.service==='migrate'?'2026-10-03T23:01:00Z':''}));
 deployment.buildReceipt=put('successor-build',{status:'PASS',sha:head,tree,completedAt:'2026-10-03T23:40:00Z',results:[{id:'control-api',imageId:digest('7')}]});
 const refs={currentRuntimeReceipt:put('successor-runtime',{project:prior.project,at:'2026-10-03T23:50:00Z',images:census(deployment.images)}),retainedRuntimeBeforeReceipt:put('successor-before',{project:prior.project,at:'2026-10-03T23:35:00Z',images:census(prior.images)}),buildInputEquivalenceReceipt:put('successor-inputs',{base:'a'.repeat(40),head,unchangedCanonicalObjects:[{path:'retained-input',baseObject:'c'.repeat(40),headObject:'c'.repeat(40)}]}),productionClosureReceipt:put('successor-closure',{base:'a'.repeat(40),head,rows:[{importer:'retained-running-portal',equal:true,oldSha256:'d'.repeat(64),newSha256:'d'.repeat(64)}]})};
 const impact={kind:'qualification-runtime-source-impact-equivalence',status:'PASS',reviewer:'independent-reviewer',reason:'Retained running source closure unchanged; completed migration retained as historical execution only, no current implementation credit.',source:'Canonical original mixed deployment and immutable replacement pre/post census',recordedAt:time,application:{sha:head,tree},deploymentId:deployment.id,project:prior.project,preservedOriginalDeploymentId:prior.id,retainedImages:[{id:'portal',imageId:digest('4')},{id:'migrate',imageId:digest('3')}],retainedHistoricalServices:[{service:'migrate',state:'exited',exitCode:0,finishedAt:'2026-10-03T23:01:00Z'}],actualPrerequisiteReceipts:refs};
 deployment.sourceImpactEquivalenceReceipt=put('successor-impact',impact);
 const rewrite=(name,change)=>{const value=JSON.parse(f.files.get(name));change(value);const ref=put(name,value);if(name==='successor-impact')deployment.sourceImpactEquivalenceReceipt=ref;else if(name==='successor-build')deployment.buildReceipt=ref;else{const key={'successor-runtime':'currentRuntimeReceipt','successor-before':'retainedRuntimeBeforeReceipt','successor-inputs':'buildInputEquivalenceReceipt','successor-closure':'productionClosureReceipt'}[name];impact.actualPrerequisiteReceipts[key]=ref;deployment.sourceImpactEquivalenceReceipt=put('successor-impact',impact);}};
 return{...f,deployment,prior,rewrite};
}
test('mixed parent successor retains actual per-image source and completed historical one-shot without relabel',()=>{const f=mixedSuccessorFixture();assert.deepEqual(verifiedDeploymentImages(f.data,f.deployment,f.read),f.deployment.images);assert.equal(f.deployment.images[0].sourceSha,'a'.repeat(40));assert.equal(f.deployment.images[2].sourceSha,'8'.repeat(40));});
for(const[name,change]of Object.entries({
 priorProofTampered:f=>f.files.set('impact',Buffer.from('{}')),
 retainedSourceRelabel:f=>f.deployment.images[0].sourceSha='8'.repeat(40),
 retainedContainerChanged:f=>f.deployment.images[0].containerId='9'.repeat(64),
 rebuiltMissing:f=>f.rewrite('successor-build',x=>x.results=[]),
 rebuiltUnhealthy:f=>f.rewrite('successor-runtime',x=>x.images[1].health='unhealthy'),
 rebuiltFailedOneShot:f=>f.rewrite('successor-runtime',x=>Object.assign(x.images[1],{state:'exited',exitCode:1})),
 historicalMissing:f=>f.rewrite('successor-impact',x=>x.retainedHistoricalServices=[]),
 historicalFailed:f=>f.rewrite('successor-runtime',x=>x.images[2].exitCode=1),
 historicalRestarted:f=>f.rewrite('successor-runtime',x=>x.images[2].finishedAt='2026-10-03T23:36:00Z'),
 historicalPreimageTampered:f=>f.files.set('successor-before',Buffer.from('{}')),
 historicalWrongProject:f=>f.rewrite('successor-before',x=>x.project='other'),
 runningDeclaredHistorical:f=>f.rewrite('successor-impact',x=>x.retainedHistoricalServices.push({service:'portal',state:'exited',exitCode:0,finishedAt:'2026-10-03T23:01:00Z'})),
 inheritedCycle:f=>{f.prior.originalRuntimeDeploymentId=f.deployment.id;const impact=JSON.parse(f.files.get('impact'));impact.preservedOriginalDeploymentId=f.deployment.id;const bytes=Buffer.from(JSON.stringify(impact));f.files.set('impact',bytes);f.prior.sourceImpactEquivalenceReceipt.sha256=hash(bytes);}
}))test('mixed parent successor rejects '+name,()=>{const f=mixedSuccessorFixture();change(f);assert.throws(()=>verifiedDeploymentImages(f.data,f.deployment,f.read));});

function prebuiltFixture(){
 const f=mixedSuccessorFixture(),source={id:'prebuilt',commitSha:'1'.repeat(40),treeSha:'2'.repeat(40)},time='2026-10-04T00:00:00Z';f.data.candidates.push(source);
 const put=(path,value,owner=source)=>{f.files.set(path,Buffer.from(JSON.stringify(value)));return{path,sha256:hash(f.files.get(path)),capturedAt:time,originalSha:owner.commitSha,originalTree:owner.treeSha};};
 const image=f.deployment.images[0];Object.assign(image,{containerId:'9'.repeat(64),expectedDigest:digest('5'),runningDigest:digest('5'),sourceSha:source.commitSha,sourceTree:source.treeSha});
 const labels={'org.opencontainers.image.revision':source.commitSha,'io.wasalx.source.tree':source.treeSha};
 const buildReceipt=put('prebuilt-progress',{sha:source.commitSha,tree:source.treeSha,results:[{id:'portal',imageId:digest('5'),dockerfile:'Dockerfile.portal'}]});
 const completionReceipt=put('prebuilt-failed',{candidateSha:source.commitSha,treeSha:source.treeSha,status:'FAILED',exitCode:1});
 const readbackReceipt=put('prebuilt-readback',{at:'2026-10-03T23:30:00Z',status:'PARTIAL_IMAGES_VERIFIED_ORIGINAL_FAILED',candidateSha:source.commitSha,tree:source.treeSha,unit:'MainPID=0\nActiveState=failed',progressSha256:buildReceipt.sha256,completionSha256:completionReceipt.sha256,completed:[{id:'portal',imageId:digest('5'),labels}]});
 const current=f.data.candidates.find(row=>row.id===f.deployment.candidateId);
 const sourceEquivalenceReceipt=put('prebuilt-equivalence',{kind:'prebuilt-image-source-equivalence',status:'PASS',reviewer:'independent',reason:'Exact Dockerfile and complete copied objects unchanged; original failed batch preserved.',base:source.commitSha,baseTree:source.treeSha,head:current.commitSha,headTree:current.treeSha,images:[{id:'portal',imageId:digest('5'),dockerfile:'Dockerfile.portal',copiedObjectScopeComplete:true,unchangedCanonicalObjects:[{path:'Dockerfile.portal',baseObject:'c'.repeat(40),headObject:'c'.repeat(40)},{path:'portal-input',baseObject:'d'.repeat(40),headObject:'d'.repeat(40)}]}]},current);
 f.rewrite('successor-runtime',value=>{Object.assign(value.images[0],{containerId:image.containerId,imageId:image.runningDigest,sourceSha:image.sourceSha,sourceTree:image.sourceTree});value.imageLabels={[image.runningDigest]:labels};});
 f.rewrite('successor-impact',value=>{value.retainedImages=value.retainedImages.filter(row=>row.id!=='portal');value.prebuiltImageSources=[{id:'portal',imageId:digest('5'),sourceCandidateId:source.id,buildReceipt,completionReceipt,readbackReceipt,sourceEquivalenceReceipt}];});
 const rewrite=(name,change)=>{const value=JSON.parse(f.files.get(name));change(value);const owner=name==='prebuilt-equivalence'?current:source,ref=put(name,value,owner);f.rewrite('successor-impact',impact=>{const row=impact.prebuiltImageSources[0];row[{'prebuilt-progress':'buildReceipt','prebuilt-failed':'completionReceipt','prebuilt-readback':'readbackReceipt','prebuilt-equivalence':'sourceEquivalenceReceipt'}[name]]=ref;});};
 return{...f,rewritePrebuilt:rewrite};
}
test('new installation preserves completed prebuilt source from a failed batch with exact copied-object equivalence',()=>{const f=prebuiltFixture();assert.deepEqual(verifiedDeploymentImages(f.data,f.deployment,f.read),f.deployment.images);assert.equal(f.deployment.images[0].sourceSha,'1'.repeat(40));});
for(const[name,change]of Object.entries({
 originalBytesChanged:f=>f.files.set('prebuilt-progress',Buffer.from('{}')),
 sourceRelabel:f=>f.deployment.images[0].sourceSha='e'.repeat(40),
 changedCopiedObject:f=>f.rewritePrebuilt('prebuilt-equivalence',value=>value.images[0].unchangedCanonicalObjects[1].headObject='f'.repeat(40)),
 wrongReadbackDigest:f=>f.rewritePrebuilt('prebuilt-readback',value=>value.completed[0].imageId=digest('6')),
 wrongRuntimeLabels:f=>f.rewrite('successor-runtime',value=>value.imageLabels[digest('5')]['io.wasalx.source.tree']='f'.repeat(40)),
 duplicateSource:f=>f.rewrite('successor-impact',value=>value.prebuiltImageSources.push(structuredClone(value.prebuiltImageSources[0]))),
 incompleteCopyScope:f=>f.rewritePrebuilt('prebuilt-equivalence',value=>value.images[0].copiedObjectScopeComplete=false),
 wrongSourceCandidate:f=>f.rewrite('successor-impact',value=>value.prebuiltImageSources[0].sourceCandidateId='missing')
}))test('prebuilt installation rejects '+name,()=>{const f=prebuiltFixture();change(f);assert.throws(()=>verifiedDeploymentImages(f.data,f.deployment,f.read));});
