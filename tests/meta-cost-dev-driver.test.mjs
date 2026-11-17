// Pure finite-driver oracles. Synthetic objects here are not installed evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCostManifest,costFlow,tariffDefinition,selectorEvidence,assertCostAuthority,assertCostDataset,statementDescription,assertStatementPublication,costContextSha256,admitCostPhase,assertRetainedCostRecord,sha} from '../scripts/release/meta-cost-dev-contract.mjs';
import {mkdtemp,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {costDriverFiles} from '../scripts/release/meta-cost-dev-entry.mjs';
import {parseBotFlow,advanceBotFlow} from '../packages/core/dist/bot-flow.js';
import {parseMetaCostTariff,parseMetaCostSelectorEvidence,parseMetaCostStatement} from '../packages/core/dist/meta-cost.js';
import {validatePrivacyReadset,financeArtifactSql} from "../scripts/release/meta-cost-dev-privacy.mjs";
import {validatePlatformIdentityConfiguration,validatePlatformIdentity} from '../scripts/release/meta-deletion-dev-guest.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,h='a'.repeat(64);
const manifest=()=>({mode:'happy',evidenceMode:'simulated',runId:'unit',tenantId:id(1),ownerId:id(2),fixture:{signup:{wabaId:'123456'}},p10:{namespace:'p10-unit',locale:'en',width:1440,role:'tenant_owner',actorId:id(2),connectionId:id(3),accountId:id(4),termsVersionId:id(5),tenantName:'Synthetic',zammadGroupId:'42',documentReviewSha256:h,tariffSourceSha256:h,retentionBasisSha256:h,platformManifestPath:'/private/platform.json',platformManifestSha256:h,platformSubjectSha256:h,guestSha256:h,contractSha256:h,browserSha256:h,currency:'USD',minorUnits:2,unitPrice:'0.005',count:102,from:'2026-10-01T00:00:00.000Z',to:'2026-11-01T00:00:00.000Z',deliveredAt:1791500000,runtime:{accountId:id(4),receiptId:id(6),descriptorSha256:h,transportBindingSha256:h,releaseEvidenceSha256:h,workerImageDigest:'sha256:'+h},database:{id:h,image:'sha256:'+h,service:'postgres',database:'wasalx',user:'wasalx'}}});
test('one finite dataset uses actual flow/price/statement input parsers',()=>{
 const m=validateCostManifest(manifest()),flow=parseBotFlow(costFlow(m)),advanced=advanceBotFlow(flow,flow.start,{type:'text',text:'synthetic'});assert.equal(advanced.state,'RESOLVED');assert.equal(advanced.effects.filter(e=>e.type==='send_text').length*2,102);assert.equal(advanced.steps,52);
 for(const purpose of ['UPSTREAM_REFERENCE','CUSTOMER_TARIFF'])assert.equal(parseMetaCostTariff(tariffDefinition(m,purpose)).purpose,purpose);
 assert.equal(parseMetaCostSelectorEvidence(selectorEvidence(m)).evidenceMode,'SIMULATED');
 for(const spec of [{ordinal:1},{ordinal:2,kind:'CREDIT_DEBIT_ADJUSTMENT',priorId:id(7),total:'-0.01'},{ordinal:3,total:'0.55'}])assert.equal(parseMetaCostStatement(statementDescription(m,id(8),spec).description).basisKind,'UPSTREAM_SOURCE');
});
test('dataset contract rejects changed mode, authority, size, partial period or arbitrary price',()=>{
 for(const change of [m=>{m.evidenceMode='live';},m=>{m.p10.runtime.accountId=id(20);},m=>{m.p10.count=200;},m=>{m.p10.locale='ar';},m=>{m.p10.to='2026-10-31T00:00:00.000Z';},m=>{m.p10.unitPrice='0';},m=>{m.p10.actorId=id(20);}]){const m=manifest();change(m);assert.throws(()=>validateCostManifest(m),/P10/u);}
});
const authority=()=>({account_id:id(4),evidence_mode:'SIMULATED',commercial_terms_version_id:id(5),accepted_tariff_version_id:id(9),policy_version_id:id(8),payer_authority_version_id:id(10),allocation_line_version_id:id(11)});
test('a draft, requested currency, current customer choice or runtime alone is not accepted managed authority',()=>{
 const row={tenantId:id(1),connection:{id:id(3),provider:'META',state:'WORKING'},authority:authority(),payment:{ready:true,enrolled:true,account_id:id(4),policy_version_id:id(8)}};assertCostAuthority(row,manifest(),id(9));
 for(const change of [r=>{r.authority.accepted_tariff_version_id=null;},r=>{r.authority.payer_authority_version_id=null;},r=>{r.authority.evidence_mode='LIVE';},r=>{r.payment.ready=false;},r=>{r.authority.policy_version_id=id(40);},r=>{r.connection.state='PAUSED';}]){const r=structuredClone(row);change(r);assert.throws(()=>assertCostAuthority(r,manifest(),id(9)),/P10/u);}
});
const dataset=()=>({authority:authority(),ingress:[1,2].map(n=>({id:id(300+n),status:'PROCESSED',lease_id:null,processing_status:'COMPLETE'})),deliveries:Array.from({length:102},(_,n)=>({id:id(400+n),state:'SENT',attempts:1,lease_id:null,attemptId:id(600+n),externalMessageId:'wamid.'+n,textSha256:h,effectState:'ATTRIBUTED',executionMode:'SIMULATED',accountId:id(4),policyId:id(8)})),provider:Array.from({length:102},(_,n)=>({id:'wamid.'+n,acceptance:'ACCEPTED',textSha256:h})),heads:['UPSTREAM_REFERENCE','CUSTOMER_TARIFF'].flatMap(purpose=>Array.from({length:102},(_,n)=>({id:id(900+n),purpose,delivered:true,deliveredAt:new Date(manifest().p10.deliveredAt*1000).toISOString(),evidenceMode:'SIMULATED',evidenceRedacted:false,state:'ESTIMATED',currency:'USD',unroundedAmount:'0.005000000000'})))});
test('same-time pages require unique known attempts and exact provider receipts, not counts alone',()=>{
 assertCostDataset(dataset(),manifest(),{delivered:true,priced:true});
 for(const change of [r=>{r.deliveries[1].id=r.deliveries[0].id;},r=>{r.deliveries[0].effectState='UNKNOWN_ATTRIBUTION';},r=>{r.deliveries[0].attempts=2;},r=>{r.provider.pop();},r=>{r.provider[0].textSha256='b'.repeat(64);},r=>{r.heads[0].deliveredAt='2026-10-02T00:00:00.000Z';},r=>{r.heads[0].state='UNPRICED';},r=>{r.heads[0].evidenceMode='UNKNOWN';}]){const r=dataset();change(r);assert.throws(()=>assertCostDataset(r,manifest(),{delivered:true,priced:true}),/P10/u);}
});
test('publication oracle retains decimal strings, independent credit arithmetic and terminal original write',()=>{
 const row={id:id(20),state:'PUBLISHED',evidenceMode:'SIMULATED',publicationSha256:h,computedPublicationSha256:h,basisKind:'UPSTREAM_SOURCE',currency:'USD',predecessorId:id(21),publication:{amount:'0.490000000000',estimatedAmount:'0.510000000000',difference:'-0.020000000000',adjustments:[{statementVersionId:id(20),amount:'-0.01',treatment:'EXCLUDED_FROM_REPLACEMENT'}]},sourceState:'READY',writeDisposition:'WRITTEN',writeAttemptId:id(22),scanSha256:h,originalSha256:h,originalByteSize:24,description:{source:{originalSha256:h,originalByteSize:24}}};
 const expected={amount:'0.49',difference:'-0.02',predecessorId:id(21),adjustments:[{statementVersionId:id(20),amount:'-0.01',treatment:'EXCLUDED_FROM_REPLACEMENT'}]};assert.equal(assertStatementPublication(row,expected).difference,'-0.020000000000');
 for(const change of [r=>{r.writeDisposition='UNKNOWN';},r=>{r.writeDisposition='ADMITTED';},r=>{r.computedPublicationSha256='b'.repeat(64);},r=>{r.publication.amount='0.50';},r=>{r.publication.adjustments=[];},r=>{r.predecessorId=null;},r=>{r.scanSha256=null;}]){const r=structuredClone(row);change(r);assert.throws(()=>assertStatementPublication(r,expected),/P10/u);}
});
test('fresh root admission adopts only the exact durable terminal predecessor and unchanged context',()=>{
 const m=manifest();m.admission={path:'/private/admission-1.json',sha256:h};const digest='b'.repeat(64),contextSha256=costContextSha256(m),first={reviewedAt:'2026-10-09T20:00:00Z',p10:{phase:'draft',contextSha256}};
 assert.deepEqual(admitCostPhase(m,digest,first).admittedManifests,[digest]);
 const terminal={phase:'draft',disposition:'TERMINAL',manifestSha256:digest,contextSha256,admittedManifests:[digest],completedAt:'2026-10-09T20:04:00Z',validUntil:'2026-10-09T20:05:00Z'},bytes=Buffer.from(JSON.stringify(terminal));
 const next=structuredClone(m);next.admission={path:'/private/admission-2.json',sha256:'c'.repeat(64)};const current='d'.repeat(64),admission={reviewedAt:'2026-10-09T20:06:00Z',p10:{phase:'dataset',contextSha256,previous:{phase:'draft',manifestSha256:digest,terminalSha256:sha(bytes)}}};const binding=admitCostPhase(next,current,admission,bytes);assert.equal(costContextSha256(next),contextSha256);assertRetainedCostRecord({contextSha256,manifestSha256:digest},binding);
 for(const mutate of [a=>{a.p10.previous.terminalSha256=h;},a=>{a.p10.phase='statements';},a=>{a.p10.previous.manifestSha256=h;},a=>{a.p10.contextSha256=h;}]){const a=structuredClone(admission);mutate(a);assert.throws(()=>admitCostPhase(next,current,a,bytes),/P10/u);}
 for(const mutate of [v=>{v.disposition='UNKNOWN';},v=>{v.completedAt='2026-10-09T20:06:00Z';},v=>{v.admittedManifests=[];}]){const v=structuredClone(terminal);mutate(v);const bad=Buffer.from(JSON.stringify(v)),a=structuredClone(admission);a.p10.previous.terminalSha256=sha(bad);assert.throws(()=>admitCostPhase(next,current,a,bad),/P10/u);}
 const changed=structuredClone(next);changed.p10.accountId=id(40);assert.throws(()=>admitCostPhase(changed,current,admission,bytes),/PHASE_CONTEXT/u);assert.throws(()=>admitCostPhase(next,current,admission,null),/EXACT_PREDECESSOR/u);assert.throws(()=>admitCostPhase(next,digest,admission,bytes),/TERMINAL_PREDECESSOR/u);
});
test('reused platform verifier retains exact OIDC, principal and current MFA boundaries',()=>{
 const p={platform:{issuer:'https://identity.invalid/platform',audience:'platform',subjectSha256:h,emailSha256:'b'.repeat(64),maxAuthAgeSeconds:900},ordinaryIssuer:'https://identity.invalid/tenant',ordinaryAudience:'tenant'};
 const api={PLATFORM_OPERATOR_OIDC_ISSUER:p.platform.issuer+'/',PLATFORM_OPERATOR_OIDC_AUDIENCE:'platform',OIDC_ISSUER:p.ordinaryIssuer,OIDC_AUDIENCE:'tenant',PLATFORM_OPERATOR_MAX_AUTH_AGE_SECONDS:'900'},portal={PLATFORM_OPERATOR_OIDC_ISSUER:p.platform.issuer};
 validatePlatformIdentityConfiguration(api,portal,p);
 for(const key of ['PLATFORM_OPERATOR_OIDC_ISSUER','PLATFORM_OPERATOR_OIDC_AUDIENCE','OIDC_ISSUER','OIDC_AUDIENCE','PLATFORM_OPERATOR_MAX_AUTH_AGE_SECONDS'])assert.throws(()=>validatePlatformIdentityConfiguration({...api,[key]:'changed'},portal,p));
 assert.throws(()=>validatePlatformIdentityConfiguration(api,{PLATFORM_OPERATOR_OIDC_ISSUER:p.ordinaryIssuer},p));
 const actual={verified:true,subjectSha256:h,emailSha256:'b'.repeat(64),authenticatedAt:1000,expiresAt:2000};assert.equal(validatePlatformIdentity(actual,p.platform,1100),actual);
 for(const mutate of [r=>{r.subjectSha256='c'.repeat(64);},r=>{r.emailSha256=h;},r=>{r.verified=false;},r=>{r.authenticatedAt=1;},r=>{r.authenticatedAt=1106;},r=>{r.expiresAt=1110;}]){const r={...actual};mutate(r);assert.throws(()=>validatePlatformIdentity(r,p.platform,1100));}
});
test('the actual flat entry rejects missing or changed staged bytes before importing the guest',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'wasalx-p10-entry-')),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 try{const files=[];for(const path of costDriverFiles){const source=join(root,'scripts/release',path);await copyFile(source,join(directory,path));files.push({path,sha256:sha(await readFile(source))});}
  const digest=name=>files.find(x=>x.path===name).sha256,m={guestDriverSha256:digest('meta-cost-dev-entry.mjs'),p10:{driverFiles:files,contractSha256:digest('meta-cost-dev-contract.mjs'),guestSha256:digest('meta-cost-dev-guest.mjs')}},raw=Buffer.from(JSON.stringify(m)),path=join(directory,'manifest.json');await writeFile(path,raw);
  const {verifyCostDriverClosure}=await import(pathToFileURL(join(directory,'meta-cost-dev-entry.mjs')));assert.equal((await verifyCostDriverClosure(path,sha(raw))).guestDriverSha256,m.guestDriverSha256);
  await writeFile(join(directory,'meta-cost-dev-contract.mjs'),'changed');await assert.rejects(verifyCostDriverClosure(path,sha(raw)),/DRIVER_CLOSURE/u);await copyFile(join(root,'scripts/release/meta-cost-dev-contract.mjs'),join(directory,'meta-cost-dev-contract.mjs'));
  await rm(join(directory,'meta-cost-dev-contract.mjs'));await assert.rejects(verifyCostDriverClosure(path,sha(raw)),/DRIVER_CLOSURE/u);
 }finally{await rm(directory,{recursive:true,force:true});}
});
