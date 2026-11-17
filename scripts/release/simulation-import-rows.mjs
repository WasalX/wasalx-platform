import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {selectExactResults, validateResultViewport} from './full-suite-result-importer.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const rowKeys = ['testId','contextId','result','evidenceStatus','candidateId','deploymentId','evidenceMode','startedAt','finishedAt','proof','actorRef','tenantRef','coverageKind','actualViewport','viewportReviewId'];
const digest = value => /^sha256:[a-f0-9]{64}$/u.test(value ?? '');
const viewport = value => Number.isSafeInteger(value?.width) && value.width > 0 && Number.isSafeInteger(value?.height) && value.height > 0;
const key = row => JSON.stringify([row.testId,row.contextId]);

// Capture import envelopes before writing each stage fixture. This does not
// mutate the original result rows or infer that a passing assertion is complete.
export function projectStageImportRows({stage, fixture, manifest, catalog, artifactPathFor, stageWindow, missingResult='unknown'}) {
  assert.equal(manifest.evidenceMode,'simulated');
  assert(['unknown','blocked'].includes(missingResult));
  assert.equal(typeof artifactPathFor,'function');
  const deployment=catalog.deployments.find(row=>row.id===manifest.deploymentId);
  const candidate=catalog.candidates.find(row=>row.id===deployment?.candidateId);
  assert(candidate?.commitSha===manifest.application?.sha&&candidate?.treeSha===manifest.application?.tree&&deployment.status==='verified','Exact application SHA/tree and simulated deployment must be verified');
  const contexts=new Map(catalog.contexts.map(row=>[row.id,row]));
  const validTime=(start,end)=>Number.isFinite(Date.parse(start))&&Number.isFinite(Date.parse(end))&&Date.parse(start)<=Date.parse(end);
  assert(validTime(stageWindow?.startedAt,stageWindow?.finishedAt)&&validTime(stageWindow?.collectionStartedAt,stageWindow?.startedAt),'Current collection window required');
  const exact=new Set((stage.checks??[]).map(key));
  if(stage.supporting){assert.equal(exact.size,0);return{artifacts:[],gaps:[]};}
  const source=[...(fixture.results??[]),...(fixture.proofs??[])].filter(row=>row&&exact.has(key(row)));
  const seen=new Set(),artifacts=[],gaps=[];
  for(const raw of source){
    const pair=key(raw);
    assert(!seen.has(pair),'Duplicate exact producer row');seen.add(pair);
    const context=contexts.get(raw.contextId);
    assert(context&&stage.testIds.includes(raw.testId),'Unknown test/context in producer row');
    const path=artifactPathFor(stage,raw);
    assert(typeof path==='string'&&path.length,'Producer artifact path required');
    const row=Object.fromEntries(rowKeys.filter(field=>Object.hasOwn(raw,field)).map(field=>[field,raw[field]]));
    row.candidateId=candidate.id;row.deploymentId=deployment.id;row.evidenceMode='simulated';
    row.evidenceStatus='incomplete';
    const missing=[];
    if(!validTime(row.startedAt,row.finishedAt))missing.push('timestamps');
    else if(Date.parse(row.startedAt)<Date.parse(stageWindow.collectionStartedAt)||Date.parse(row.finishedAt)>Date.parse(stageWindow.finishedAt))missing.push('outside-collection-window');
    if(!['passed','failed','blocked','unknown'].includes(raw.result))missing.push('invalid-result');
    if(!row.proof||typeof row.proof!=='object'||!Object.keys(row.proof).length)missing.push('assertion-proof');
    if(context.role==='anonymous'){
      if(raw.actorRef!==null||raw.tenantRef!==null)missing.push('anonymous-identity');
    }else{
      if(!digest(raw.actorRef))missing.push('actor-digest');
      if(context.role==='platform_operator'?raw.tenantRef!==null:!digest(raw.tenantRef))missing.push('tenant-digest');
      if(raw.proof?.actorVerified!==true)missing.push('actor-verification');
    }
    if(context.role==='zammad_agent'){
      const actor=raw.verifiedContext?.nativeActor;
      if(!Number.isSafeInteger(actor?.id)||!Array.isArray(actor?.roles)||!actor.roles.includes(2)||actor.roles.includes(1)||raw.actorRef!=='sha256:'+hash('zammad:'+actor.id))missing.push('native-agent-not-bootstrap-admin');
    }
    const binding=raw.verifiedContext;
    if(!binding||binding.role!==context.role||binding.locale!==context.locale||binding.actorRef!==(raw.actorRef??null)||binding.tenantRef!==(raw.tenantRef??null))missing.push('verified-context-binding');
    const needsViewport=raw.testId.includes('::ui-quality::')||raw.coverageKind==='business'||raw.actualViewport!==undefined;
    if(needsViewport){
      if(!viewport(raw.actualViewport))missing.push('actual-viewport');
      if(!binding||!viewport(binding.viewport)||binding.viewport.width!==raw.actualViewport?.width||binding.viewport.height!==raw.actualViewport?.height)missing.push('verified-viewport-binding');
      else row.actualViewport={width:binding.viewport.width,height:binding.viewport.height,sourceEvidencePath:path};
    }
    if(missing.includes('timestamps')){assert(validTime(stageWindow?.startedAt,stageWindow?.finishedAt),'Actual stage window required for a row with invalid timestamps');row.startedAt=stageWindow.startedAt;row.finishedAt=stageWindow.finishedAt;}
    const outside=missing.includes('outside-collection-window'),originalObservation=outside?{result:['passed','failed','blocked','unknown'].includes(raw.result)?raw.result:'unknown',startedAt:new Date(raw.startedAt).toISOString(),finishedAt:new Date(raw.finishedAt).toISOString(),actorRef:digest(raw.actorRef)?raw.actorRef:null,tenantRef:digest(raw.tenantRef)?raw.tenantRef:null,...(Object.hasOwn(raw,'candidateId')?{candidateId:catalog.candidates.some(value=>value.id===raw.candidateId)?raw.candidateId:null}:{}),...(Object.hasOwn(raw,'deploymentId')?{deploymentId:catalog.deployments.some(value=>value.id===raw.deploymentId)?raw.deploymentId:null}:{})}:null;
    if(missing.includes('verified-viewport-binding')||missing.includes('actual-viewport'))delete row.actualViewport;
    if(outside){row.startedAt=stageWindow.startedAt;row.finishedAt=stageWindow.finishedAt;row.actorRef=null;row.tenantRef=null;delete row.actualViewport;}
    else{if(!digest(row.actorRef))row.actorRef=null;if(!digest(row.tenantRef))row.tenantRef=null;}
    if(raw.result==='passed'&&missing.length===0)row.evidenceStatus='complete';
    else{row.result=outside?'unknown':['failed','blocked','unknown'].includes(raw.result)?raw.result:'unknown';row.proof=outside?{originalObservation,missingEvidence:missing}:{...(row.proof&&typeof row.proof==='object'&&!Array.isArray(row.proof)?row.proof:{}),originalResult:raw.result??null,missingEvidence:missing};}
    const envelope={...(!outside&&binding?{...(viewport(binding.viewport)?{viewport:binding.viewport}:{}),role:binding.role,locale:binding.locale,actorRef:binding.actorRef,tenantRef:binding.tenantRef,...(context.role==='zammad_agent'?{nativeActor:binding.nativeActor}:{})}:{}),result:row};
    const bytes=Buffer.from(JSON.stringify(envelope));
    const artifact={path,sha256:hash(bytes),originalSha:candidate.commitSha,originalTree:candidate.treeSha,capturedAt:new Date().toISOString()};
    const selection={stageId:stage.id,artifact,pointer:['result']};
    const selected=selectExactResults(manifest,[selection],()=>bytes);
    validateResultViewport(selected[0].row,catalog.contexts);
    artifacts.push({path,bytes,row,selection:{stageId:stage.id,artifact,pointer:['result']}});
    if(row.evidenceStatus!=='complete'||missing.length)gaps.push({stageId:stage.id,testId:raw.testId,contextId:raw.contextId,missing:[...new Set(missing)]});
  }
  for(const check of stage.checks??[])if(!seen.has(key(check))){
    assert(validTime(stageWindow?.startedAt,stageWindow?.finishedAt),'Actual stage window required for missing result row');
    const missingReason=missingResult==='blocked'?'dependency-blocked':'result-row';
    const path=artifactPathFor(stage,check),row={...check,result:missingResult,evidenceStatus:'incomplete',candidateId:candidate.id,deploymentId:deployment.id,evidenceMode:'simulated',startedAt:stageWindow.startedAt,finishedAt:stageWindow.finishedAt,actorRef:null,tenantRef:null,proof:{originalResult:null,missingEvidence:[missingReason]}};
    const bytes=Buffer.from(JSON.stringify({result:row})),artifact={path,sha256:hash(bytes),originalSha:candidate.commitSha,originalTree:candidate.treeSha,capturedAt:new Date().toISOString()};
    selectExactResults(manifest,[{stageId:stage.id,artifact,pointer:['result']}],()=>bytes);
    artifacts.push({path,bytes,row,selection:{stageId:stage.id,artifact,pointer:['result']}});
    gaps.push({stageId:stage.id,testId:check.testId,contextId:check.contextId,missing:[missingReason]});
  }
  return{artifacts,gaps};
}
