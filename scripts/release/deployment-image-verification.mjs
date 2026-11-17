import assert from'node:assert/strict';
import{createHash}from'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
const sha=value=>/^sha256:[a-f0-9]{64}$/u.test(value??'');
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const valid=images=>Array.isArray(images)&&images.length>0&&images.every(image=>sha(image.runningDigest)&&image.runningDigest===image.expectedDigest);
const proof=(value,candidate,read)=>{assert(value?.path&&/^[a-f0-9]{64}$/u.test(value.sha256)&&timestamp(value.capturedAt),'Immutable image proof required');assert.equal(value.originalSha,candidate.commitSha);assert.equal(value.originalTree,candidate.treeSha);const bytes=read(value.path);assert.equal(digest(bytes),value.sha256,'Deployment image proof changed');return JSON.parse(bytes)};
// Explicit mixed-source runtime admission; immutable actual proof, never label substitution.
function verifyFreshImageSources(data,deployment,images,read,ancestors){
 const candidate=data.candidates.find(row=>row.id===deployment.candidateId),tool=data.candidates.find(row=>row.id===deployment.toolingCandidateId);
 assert(tool&&tool.commitSha===deployment.toolingCommitSha&&tool.treeSha===deployment.toolingTreeSha,'Fresh runtime tooling identity missing');
 const binding=proof(deployment.imageBindingReceipt,tool,read),runtime=proof(deployment.runtimeIdentityReceipt,tool,read);
 assert.equal(binding.kind,'fresh-image-binding-readback');
 assert.equal(binding.applicationSha,candidate.commitSha);assert.equal(binding.applicationTree,candidate.treeSha);
 assert.equal(binding.toolingSha,tool.commitSha);assert.equal(binding.toolingTree,tool.treeSha);
 assert.equal(binding.project,deployment.project);assert.equal(binding.namespace,deployment.namespace);
 assert.equal(binding.currentRuntimeCensusSha256,deployment.runtimeIdentityReceipt.sha256);
 assert.equal(binding.planSha256,deployment.freshPlanReceipt?.sha256);const plan=proof(deployment.freshPlanReceipt,tool,read);assert.equal(plan.project,deployment.project);
 assert.deepEqual(binding.images,images);
 const original=data.deployments.find(row=>row.id===binding.retainedImageDeploymentId);
 assert(original&&original.id!==deployment.id&&original.status==='verified'&&original.evidenceMode==='simulated','Verified image source deployment required');
 assert.equal(original.candidateId,deployment.candidateId);
 assert.deepEqual(deployment.buildReceipt,original.buildReceipt);assert.deepEqual(deployment.sourceImpactEquivalenceReceipt,original.sourceImpactEquivalenceReceipt);
 assert.equal(binding.retainedPortalReceiptSha256,original.buildReceipt.sha256);assert.equal(binding.retainedSourceImpactReceiptSha256,original.sourceImpactEquivalenceReceipt.sha256);
 const prior=verifiedDeploymentImages(data,original,read,ancestors);
 assert.equal(runtime.status,'PASS_FRESH_RUNTIME_READONLY');assert.equal(runtime.runtimeMutation,false);
 assert.equal(runtime.deploymentId,deployment.id);assert.equal(runtime.project,deployment.project);assert.equal(runtime.namespace,deployment.namespace);
 assert.deepEqual(runtime.application,{sha:candidate.commitSha,tree:candidate.treeSha});assert.deepEqual(runtime.qualificationTooling,{sha:tool.commitSha,tree:tool.treeSha});
 assert(timestamp(runtime.observedAt)&&timestamp(deployment.verifiedAt));assert.equal(runtime.observedAt,deployment.verifiedAt);
 assert(Date.parse(runtime.observedAt)<=Date.parse(deployment.runtimeIdentityReceipt.capturedAt));
 assert.equal(binding.runtimeServices,Object.keys(runtime.services).length);assert.equal(runtime.serviceCount,binding.runtimeServices);
 assert.deepEqual(Object.keys(plan.images).sort(),Object.keys(runtime.services).sort());
 for(const [service,image]of Object.entries(plan.images)){assert(sha(image));assert.equal(runtime.services[service].image,image,'Fresh runtime differs from planned image');}
 assert.deepEqual(images.map(row=>row.service).sort(),prior.map(row=>row.service).sort());
 assert.equal(new Set(images.map(row=>row.service)).size,images.length);assert.equal(new Set(images.map(row=>row.containerId)).size,images.length);
 for(const image of images){
  const old=prior.find(row=>row.service===image.service),actual=runtime.services[image.service];
  for(const key of ['expectedDigest','runningDigest','sourceSha','sourceTree'])assert.equal(image[key],old[key],'Fresh image source changed: '+key);
  assert(/^[a-f0-9]{64}$/u.test(image.containerId??''));assert.equal(actual.id,image.containerId);assert.equal(actual.image,image.runningDigest);
  assert(actual.state==='running'||actual.state==='exited'&&actual.exitCode===0,'Fresh image service failed');if(actual.state==='running'&&actual.health)assert.equal(actual.health,'healthy');
  const labels=runtime.candidateImageLabels[image.runningDigest];assert.equal(labels['org.opencontainers.image.revision'],image.sourceSha);assert.equal(labels['io.wasalx.source.tree'],image.sourceTree);
 }
}
function prebuiltImageSources(data,impact,candidate,runtime,read){
 const declared=impact.prebuiltImageSources??[];
 assert(Array.isArray(declared)&&new Set(declared.map(row=>row.imageId)).size===declared.length,'Ambiguous prebuilt image sources');
 const sources=new Map();
 for(const row of declared){
  assert(row.id&&sha(row.imageId),'Prebuilt image identity missing');
  const source=data.candidates.find(value=>value.id===row.sourceCandidateId);
  assert(source&&source.commitSha!==candidate.commitSha,'Distinct prebuilt source candidate required');
  const build=proof(row.buildReceipt,source,read),completion=proof(row.completionReceipt,source,read),observed=proof(row.readbackReceipt,source,read),equivalence=proof(row.sourceEquivalenceReceipt,candidate,read);
  assert.equal(build.sha,source.commitSha);assert.equal(build.tree,source.treeSha);
  assert.equal(completion.candidateSha,source.commitSha);assert.equal(completion.treeSha,source.treeSha);
  assert.equal(completion.status,'FAILED');assert.equal(completion.exitCode,1);
  assert.equal(observed.status,'PARTIAL_IMAGES_VERIFIED_ORIGINAL_FAILED');assert.equal(observed.candidateSha,source.commitSha);assert.equal(observed.tree,source.treeSha);
  assert.equal(observed.progressSha256,row.buildReceipt.sha256);assert.equal(observed.completionSha256,row.completionReceipt.sha256);assert(observed.unit.includes('MainPID=0'));
  const built=build.results.filter(value=>value.id===row.id&&value.imageId===row.imageId),actual=observed.completed.filter(value=>value.id===row.id&&value.imageId===row.imageId);
  assert.equal(built.length,1);assert.equal(actual.length,1);
  for(const labels of [actual[0].labels,runtime.imageLabels?.[row.imageId]]){assert(labels,'Prebuilt runtime labels missing');assert.equal(labels['org.opencontainers.image.revision'],source.commitSha);assert.equal(labels['io.wasalx.source.tree'],source.treeSha);}
  assert.equal(equivalence.kind,'prebuilt-image-source-equivalence');assert.equal(equivalence.status,'PASS');assert(equivalence.reviewer?.trim()&&equivalence.reason?.trim());
  assert.equal(equivalence.base,source.commitSha);assert.equal(equivalence.baseTree,source.treeSha);assert.equal(equivalence.head,candidate.commitSha);assert.equal(equivalence.headTree,candidate.treeSha);
  const scope=equivalence.images.filter(value=>value.id===row.id&&value.imageId===row.imageId);assert.equal(scope.length,1);assert.equal(scope[0].dockerfile,built[0].dockerfile);
  const objects=scope[0].unchangedCanonicalObjects;assert(Array.isArray(objects)&&objects.length&&new Set(objects.map(value=>value.path)).size===objects.length,'Prebuilt copied object proof missing');
  assert(objects.some(value=>value.path===scope[0].dockerfile),'Prebuilt Dockerfile proof missing');
  assert.equal(scope[0].copiedObjectScopeComplete,true);
  for(const object of objects){assert(object.path&&/^[a-f0-9]{40}$/u.test(object.baseObject));assert.equal(object.baseObject,object.headObject,'Prebuilt copied object changed');}
  assert(timestamp(observed.at)&&Date.parse(observed.at)<=Date.parse(runtime.at),'Prebuilt readback occurred after runtime');
  sources.set(row.imageId,source);
 }
 return sources;
}
function verifyImageSources(data,deployment,images,read,ancestors){
 if(!images.some(row=>row.sourceSha!==undefined||row.sourceTree!==undefined))return;
 const candidate=data.candidates.find(row=>row.id===deployment.candidateId);assert(candidate,'Deployment candidate missing');
 assert.equal(deployment.evidenceMode,'simulated');assert.equal(deployment.status,'verified');
 const impact=proof(deployment.sourceImpactEquivalenceReceipt,candidate,read);
 if(impact.deploymentId!==deployment.id&&deployment.imageBindingReceipt)return verifyFreshImageSources(data,deployment,images,read,ancestors);
 assert.equal(impact.kind,'qualification-runtime-source-impact-equivalence');assert.equal(impact.status,'PASS');assert(impact.reviewer?.trim()&&impact.reason?.trim()&&impact.source?.trim(),'Reviewed retained image source equivalence required');
 assert.equal(impact.application.sha,candidate.commitSha);assert.equal(impact.application.tree,candidate.treeSha);
 assert.equal(impact.deploymentId,deployment.id);assert.equal(impact.project,deployment.project);
 const original=data.deployments.find(row=>row.id===impact.preservedOriginalDeploymentId);
 assert(original&&original.id!==deployment.id&&original.status==='verified'&&original.project===deployment.project);
 assert.equal(original.id,deployment.originalRuntimeDeploymentId);
 const base=data.candidates.find(row=>row.id===original.candidateId);assert(base&&base.id!==candidate.id);
 const mixedOriginal=original.images.some(row=>row.sourceSha!==undefined||row.sourceTree!==undefined);
 const originalImages=verifiedDeploymentImages(data,original,read,ancestors);
 const originalBuild=proof(original.buildReceipt,base,read),build=proof(deployment.buildReceipt,candidate,read);
 assert.equal(originalBuild.status,'PASS');assert.equal(originalBuild.sha,base.commitSha);assert.equal(originalBuild.tree,base.treeSha);
 assert.equal(build.status,'PASS');assert.equal(build.sha,candidate.commitSha);assert.equal(build.tree,candidate.treeSha);
 const refs=impact.actualPrerequisiteReceipts,runtime=proof(refs.currentRuntimeReceipt,candidate,read),inputs=proof(refs.buildInputEquivalenceReceipt,candidate,read),closure=proof(refs.productionClosureReceipt,candidate,read);
 assert.equal(runtime.project,deployment.project);assert(timestamp(runtime.at));assert(Array.isArray(runtime.images));
 for(const evidence of [inputs,closure]){assert.equal(evidence.base,base.commitSha);assert.equal(evidence.head,candidate.commitSha);}
 assert(Array.isArray(inputs.unchangedCanonicalObjects)&&inputs.unchangedCanonicalObjects.length,'Retained canonical input proof missing');
 assert.equal(new Set(inputs.unchangedCanonicalObjects.map(row=>row.path)).size,inputs.unchangedCanonicalObjects.length);
 for(const row of inputs.unchangedCanonicalObjects){assert(row.path);assert(/^[a-f0-9]{40}$/u.test(row.baseObject));assert.equal(row.baseObject,row.headObject,'Retained source changed: '+row.path);}
 assert(Array.isArray(closure.rows)&&closure.rows.length,'Retained production closure proof missing');
 assert.equal(new Set(closure.rows.map(row=>row.importer)).size,closure.rows.length);
 for(const row of closure.rows){assert(row.importer);assert.equal(row.equal,true);assert(/^[a-f0-9]{64}$/u.test(row.oldSha256));assert.equal(row.oldSha256,row.newSha256,'Retained production closure changed');}
 assert(Array.isArray(impact.retainedImages)&&impact.retainedImages.length,'Reviewed retained image coverage missing');
 assert.equal(new Set(impact.retainedImages.map(row=>row.imageId)).size,impact.retainedImages.length);
 for(const row of impact.retainedImages)assert(row.id&& (mixedOriginal?originalImages.some(prior=>prior.runningDigest===row.imageId):originalBuild.results.some(prior=>prior.id===row.id&&prior.imageId===row.imageId)),'Retained image coverage differs from canonical original');
 const historical=impact.retainedHistoricalServices??[];
 assert(Array.isArray(historical)&&new Set(historical.map(row=>row.service)).size===historical.length,'Ambiguous retained historical service coverage');
 let before;
 if(historical.length){assert(mixedOriginal,'Historical service declarations require canonical mixed parent');before=proof(refs.retainedRuntimeBeforeReceipt,candidate,read);assert.equal(before.project,deployment.project);assert(timestamp(before.at)&&Date.parse(before.at)<=Date.parse(runtime.at));assert(Array.isArray(before.images));}
 const prebuilt=prebuiltImageSources(data,impact,candidate,runtime,read),usedPrebuilt=new Set();
 const observedHistorical=[];
 assert(timestamp(impact.recordedAt)&&timestamp(build.completedAt));assert(Date.parse(runtime.at)>=Date.parse(build.completedAt)&&Date.parse(runtime.at)<=Date.parse(impact.recordedAt),'Mixed runtime proof time mismatch');
 assert.equal(images.length,originalImages.length);assert.equal(new Set(images.map(row=>row.service)).size,images.length);
 assert.deepEqual(images.map(row=>row.service).sort(),originalImages.map(row=>row.service).sort());
 for(const image of images){
  assert(/^[a-f0-9]{40}$/u.test(image.sourceSha??'')&&/^[a-f0-9]{40}$/u.test(image.sourceTree??''));
  const rows=runtime.images.filter(row=>row.service===image.service);assert.equal(rows.length,1);
  const actual=rows[0];assert.equal(actual.containerId,image.containerId);assert.equal(actual.imageId,image.runningDigest);assert.equal(actual.sourceSha,image.sourceSha);assert.equal(actual.sourceTree,image.sourceTree);
  if(mixedOriginal){assert(actual.state==='running'||actual.state==='exited'&&actual.exitCode===0,'Mixed replacement service failed');if(actual.state==='running'&&actual.health)assert.equal(actual.health,'healthy');}
  if(image.sourceSha===candidate.commitSha){assert.equal(image.sourceTree,candidate.treeSha);assert(build.results.some(row=>row.imageId===image.runningDigest),'Rebuilt image absent from current build');}
  else if(prebuilt.has(image.runningDigest)){
   const source=prebuilt.get(image.runningDigest),prior=originalImages.find(row=>row.service===image.service);
   assert.equal(image.sourceSha,source.commitSha);assert.equal(image.sourceTree,source.treeSha);
   assert.notEqual(image.containerId,prior.containerId,'Prebuilt service must be newly installed');
   usedPrebuilt.add(image.runningDigest);
  }else{
   const prior=originalImages.find(row=>row.service===image.service);
   assert.equal(image.sourceSha,mixedOriginal?prior.sourceSha:base.commitSha);assert.equal(image.sourceTree,mixedOriginal?prior.sourceTree:base.treeSha);
   assert.equal(prior.containerId,image.containerId);assert.equal(prior.runningDigest,image.runningDigest);assert.equal(prior.expectedDigest,image.expectedDigest);
   assert(impact.retainedImages.some(row=>row.imageId===image.runningDigest),'Retained image outside reviewed coverage');
   if(mixedOriginal){
    const declaration=historical.find(row=>row.service===image.service);
    if(actual.state==='exited'){
     assert(declaration&&actual.exitCode===0,'Retained completed one-shot needs explicit historical proof');
     const rows=before.images.filter(row=>row.service===image.service);assert.equal(rows.length,1);const previous=rows[0];
     for(const key of ['containerId','imageId','sourceSha','sourceTree','state','exitCode','startedAt','finishedAt'])assert.equal(actual[key],previous[key],'Retained historical service changed: '+key);
     assert(timestamp(actual.startedAt)&&timestamp(actual.finishedAt)&&Date.parse(actual.startedAt)<=Date.parse(actual.finishedAt)&&Date.parse(actual.finishedAt)<=Date.parse(before.at),'Historical service did not complete before replacement');
     assert.deepEqual(declaration,{service:image.service,state:'exited',exitCode:0,finishedAt:actual.finishedAt},'Historical declaration differs from actual completion');
     observedHistorical.push(image.service);
    }else{assert(!declaration,'Running service cannot use historical completion');assert.equal(actual.state,'running');if(actual.health)assert.equal(actual.health,'healthy');}
   }
  }
 }
 assert.deepEqual([...prebuilt.keys()].sort(),[...usedPrebuilt].sort(),'Unused prebuilt image source declaration');
 assert.deepEqual(historical.map(row=>row.service).sort(),observedHistorical.sort(),'Historical service declaration outside retained coverage');
}
export function verifiedDeploymentImages(data,deployment,read,visited=new Set()){
 assert(!visited.has(deployment.id),'Cyclic deployment image provenance');const ancestors=new Set(visited);ancestors.add(deployment.id);
 const corrections=(data.reviews??[]).filter(review=>review.kind==='deployment-image-verification-correction'&&review.deploymentId===deployment.id);
 assert(corrections.length<=1,'Ambiguous deployment image correction');
 if(valid(deployment.images)){assert.equal(corrections.length,0,'Verified deployment must not have an image correction');verifyImageSources(data,deployment,deployment.images,read,ancestors);return deployment.images}
 assert.equal(corrections.length,1,'Deployment images are not verified');assert.equal(deployment.evidenceMode,'simulated','Image correction cannot admit live evidence');const correction=corrections[0],candidate=data.candidates.find(value=>value.id===deployment.candidateId);assert(candidate,'Deployment candidate missing');
 assert(correction.id&&correction.reviewer?.trim()&&correction.source?.trim()&&correction.reason?.trim()&&timestamp(correction.recordedAt),'Reviewed deployment image correction required');assert.equal(correction.candidateId,deployment.candidateId);assert.equal(correction.project,deployment.project);assert.equal(correction.originalImagesSha256,digest(Buffer.from(JSON.stringify(deployment.images))),'Stale deployment image correction');
 const build=proof(correction.buildReceipt,candidate,read),runtime=proof(correction.runtimeReceipt,candidate,read);assert.equal(build.sha,candidate.commitSha);assert.equal(build.tree,candidate.treeSha);assert.equal(runtime.status,'PASS');assert.equal(runtime.deploymentId,deployment.id);assert.equal(runtime.project,deployment.project);assert.equal(runtime.runtimeGeneration?.project,deployment.project);assert(timestamp(build.completedAt)&&timestamp(runtime.observedAt));assert(Date.parse(build.completedAt)<=Date.parse(runtime.observedAt));assert(Date.parse(runtime.observedAt)<=Date.parse(correction.recordedAt));
 assert(Array.isArray(build.results)&&build.results.length>0);const byDigest=new Map;for(const row of build.results){assert(row.id&&sha(row.imageId));assert(!byDigest.has(row.imageId),'Ambiguous build image digest');byDigest.set(row.imageId,row)}
 const containers=runtime.runtimeGeneration?.containers;assert(containers&&typeof containers==='object'&&!Array.isArray(containers));const verificationSource=`build:${correction.buildReceipt.sha256};runtime:${correction.runtimeReceipt.sha256}`;const derived=[];
 for(const[service,container]of Object.entries(containers)){if(container?.status!=='running'||!byDigest.has(container.image))continue;assert(/^[a-f0-9]{64}$/u.test(container.id??''),'Invalid runtime container identity');derived.push({service,expectedDigest:container.image,runningDigest:container.image,containerId:container.id,verificationSource})}
 derived.sort((a,b)=>a.service.localeCompare(b.service));assert(derived.length>0,'No running candidate images');assert.equal(new Set(derived.map(row=>row.service)).size,derived.length);assert(Array.isArray(correction.images));const supplied=structuredClone(correction.images).sort((a,b)=>String(a.service).localeCompare(String(b.service)));assert.deepEqual(supplied,derived,'Corrected runtime images differ from immutable receipts');assert(valid(supplied));return supplied;
}
