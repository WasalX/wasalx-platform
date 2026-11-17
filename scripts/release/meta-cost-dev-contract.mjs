// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// Finite simulated installed P10 data. No authority or application rows are seeded.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const need=(value,reason)=>assert(Boolean(value),'P10 '+reason);
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
export const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
export const deliveryCount=102;
export const costPhases=['draft','dataset','statements','export','offboard','delete','privacy-review','retry'];
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export function costContextSha256(m){const value=structuredClone(m);value.admission={...value.admission};delete value.admission.path;delete value.admission.sha256;return sha('p10-context-v1\0'+JSON.stringify(canonical(value)));}
export function admitCostPhase(m,digest,admission,priorBytes=null){
 const contextSha256=costContextSha256(m),phase=admission.p10?.phase,index=costPhases.indexOf(phase);need(index>=0&&admission.p10.contextSha256===contextSha256&&hex(digest),'PHASE_CONTEXT');
 if(index===0){need(admission.p10.previous===undefined&&priorBytes===null,'FIRST_PHASE');return{contextSha256,phase,admittedManifests:[digest],previous:null};}
 const p=admission.p10.previous;need(p?.phase===costPhases[index-1]&&hex(p.manifestSha256)&&hex(p.terminalSha256)&&priorBytes&&sha(priorBytes)===p.terminalSha256,'EXACT_PREDECESSOR');const previous=JSON.parse(priorBytes);
 need(previous.disposition==='TERMINAL'&&previous.phase===p.phase&&previous.manifestSha256===p.manifestSha256&&previous.contextSha256===contextSha256&&Array.isArray(previous.admittedManifests)&&previous.admittedManifests.length===index&&previous.admittedManifests.every(hex)&&new Set(previous.admittedManifests).size===index&&previous.admittedManifests.at(-1)===p.manifestSha256&&!previous.admittedManifests.includes(digest),'TERMINAL_PREDECESSOR');
 need(Number.isFinite(Date.parse(previous.completedAt))&&Date.parse(previous.completedAt)<=Date.parse(previous.validUntil)&&Date.parse(previous.completedAt)<=Date.parse(admission.reviewedAt),'TERMINAL_TIME');return{contextSha256,phase,admittedManifests:[...previous.admittedManifests,digest],previous};
}
export function assertRetainedCostRecord(record,binding){need(record.contextSha256===binding.contextSha256&&binding.admittedManifests.includes(record.manifestSha256),'RECORD_BINDING');return record;}
export function validateCostManifest(m){
 const p=m.p10;need(m.mode==='happy'&&m.evidenceMode==='simulated'&&p?.namespace==='p10-'+m.runId,'MODE');
 need(p.locale==='en'&&p.width===1440&&p.actorId===m.ownerId&&p.role==='tenant_owner','ONE_PRODUCER_CONTEXT');
 need([p.connectionId,p.accountId,p.termsVersionId].every(uuid)&&typeof p.tenantName==='string'&&p.tenantName.length>0&&p.tenantName.length<=160,'SCOPE');
 need(/^\d{1,15}$/u.test(p.zammadGroupId)&&[p.documentReviewSha256,p.tariffSourceSha256,p.retentionBasisSha256,p.platformManifestSha256,p.platformSubjectSha256,p.guestSha256,p.contractSha256,p.browserSha256].every(hex),'INPUTS');
 need(typeof p.platformManifestPath==='string'&&/^\/[A-Za-z0-9_./-]+$/u.test(p.platformManifestPath)&&!p.platformManifestPath.split('/').includes('..'),'PLATFORM_DESCRIPTOR');
 need(p.currency==='USD'&&p.minorUnits===2&&p.unitPrice==='0.005'&&p.count===deliveryCount,'FINITE_PRICE_DATA');
 const from=new Date(p.from),to=new Date(p.to);need(Number.isFinite(from.valueOf())&&from.toISOString()===p.from&&from.getUTCDate()===1&&from.getUTCHours()===0&&from.getUTCMinutes()===0&&from.getUTCSeconds()===0&&from.getUTCMilliseconds()===0,'PERIOD_FROM');
 need(to.valueOf()===Date.UTC(from.getUTCFullYear(),from.getUTCMonth()+1,1)&&to.toISOString()===p.to,'WHOLE_PERIOD');
 need(Number.isSafeInteger(p.deliveredAt)&&p.deliveredAt*1000>=from.valueOf()&&p.deliveredAt*1000<to.valueOf(),'PROVIDER_TIME');
 need(p.runtime?.accountId===p.accountId&&uuid(p.runtime.receiptId)&&[p.runtime.descriptorSha256,p.runtime.transportBindingSha256,p.runtime.releaseEvidenceSha256].every(hex)&&/^sha256:[a-f0-9]{64}$/u.test(p.runtime.workerImageDigest),'ACTUAL_RUNTIME_INPUT');
 need(hex(p.database?.id)&&/^sha256:[a-f0-9]{64}$/u.test(p.database.image)&&p.database.service==='postgres'&&p.database.database==='wasalx'&&/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(p.database.user),'READ_DATABASE');
 return m;
}
export function costFlow(m){return{schemaVersion:1,name:m.p10.namespace,start:'s0',maxSteps:52,nodes:[...Array.from({length:51},(_,i)=>({id:'s'+i,type:'send_text',text:m.p10.namespace+' message '+i,next:i===50?'end':'s'+(i+1)})),{id:'end',type:'end'}]};}
export function tariffDefinition(m,purpose){need(['UPSTREAM_REFERENCE','CUSTOMER_TARIFF'].includes(purpose),'PURPOSE');const p=m.p10;return{tenantId:m.tenantId,accountId:p.accountId,purpose,evidenceMode:'SIMULATED',sourceSha256:p.tariffSourceSha256,currency:p.currency,minorUnits:p.minorUnits,timezone:'UTC',effectiveFrom:p.from,effectiveTo:p.to,rounding:'PERIOD',product:'CLOUD_API',unit:'DELIVERED_MESSAGE',pricingModel:'PMP',policyFamily:'ORDINARY_BUSINESS_MESSAGING',commercialTermsVersionId:purpose==='CUSTOMER_TARIFF'?p.termsVersionId:null,rates:[{category:'utility',pricingType:'regular',billable:true,schedule:'ORDINARY',market:'SYNTHETIC',tier:'REFERENCE',unitPrice:p.unitPrice}]};}
export function selectorEvidence(m){return{sourceSha256:m.p10.tariffSourceSha256,evidenceMode:'SIMULATED',product:'CLOUD_API',unit:'DELIVERED_MESSAGE',policyFamily:'ORDINARY_BUSINESS_MESSAGING',market:'SYNTHETIC',marketBasis:'AUTHORITATIVE_EFFECT_MARKET',schedule:'ORDINARY',applicabilityFrom:m.p10.from,applicabilityTo:m.p10.to,tier:'REFERENCE',tierBasis:'APPROVED_PROVISIONAL_REFERENCE',timeBasis:'PROVIDER_DELIVERED_TIMESTAMP'};}
export function assertCostAuthority(row,m,tariffId){
 const p=m.p10;need(row.tenantId===m.tenantId&&row.connection?.id===p.connectionId&&row.connection.provider==='META'&&row.connection.state==='WORKING','CONNECTION');
 const a=row.authority;need(a?.account_id===p.accountId&&a.evidence_mode==='SIMULATED'&&a.commercial_terms_version_id===p.termsVersionId&&a.accepted_tariff_version_id===tariffId&&uuid(a.policy_version_id)&&uuid(a.payer_authority_version_id)&&uuid(a.allocation_line_version_id),'GENUINE_ACCEPTED_MANAGED_TARIFF');
 need(row.payment?.ready===true&&row.payment.enrolled===true&&row.payment.account_id===p.accountId&&row.payment.policy_version_id===a.policy_version_id,'CURRENT_SEND_AUTHORITY');return a;
}
export function assertCostDataset(row,m,{delivered=false,priced=false}={}){
 need(row.deliveries.length===deliveryCount&&new Set(row.deliveries.map(x=>x.id)).size===deliveryCount,'EXACT_EFFECT_COUNT');
 need(row.ingress.length===2&&row.ingress.every(x=>x.status==='PROCESSED'&&x.lease_id===null&&x.processing_status==='COMPLETE'),'TWO_PROCESSED_INPUTS');
 for(const d of row.deliveries){need(['SENT','DELIVERED','READ'].includes(d.state)&&d.attempts===1&&d.lease_id===null&&uuid(d.attemptId)&&d.effectState==='ATTRIBUTED'&&d.executionMode==='SIMULATED'&&d.accountId===m.p10.accountId&&d.policyId===row.authority.policy_version_id,'EXACT_SUCCESS_ADMISSION');need(row.provider.filter(x=>x.id===d.externalMessageId&&x.acceptance==='ACCEPTED'&&x.textSha256===d.textSha256).length===1,'PROVIDER_ACCEPTANCE');}
 need(row.provider.length===deliveryCount,'NO_UNACCOUNTED_PROVIDER_EFFECT');
 if(delivered)for(const purpose of ['UPSTREAM_REFERENCE','CUSTOMER_TARIFF']){const heads=row.heads.filter(x=>x.purpose===purpose);need(heads.length===deliveryCount&&heads.every(x=>x.delivered&&Date.parse(x.deliveredAt)===m.p10.deliveredAt*1000&&x.evidenceMode==='SIMULATED'&&!x.evidenceRedacted),'COMPLETE_SAME_TIME_HEADS');if(priced)need(heads.every(x=>x.state==='ESTIMATED'&&x.currency==='USD'&&x.unroundedAmount==='0.005000000000'),'EXACT_PROVISIONAL_PRICE');}
 return row;
}
export function statementDescription(m,policyId,{kind='FULL_REPLACEMENT',priorId=null,total='0.50',ordinal=1}={}){
 const p=m.p10;need(uuid(policyId)&&['FULL_REPLACEMENT','CREDIT_DEBIT_ADJUSTMENT'].includes(kind)&&(priorId===null||uuid(priorId))&&/^-?\d+\.\d{2}$/u.test(total)&&[1,2,3].includes(ordinal),'STATEMENT_INPUT');
 const bytes=Buffer.from(JSON.stringify({evidenceMode:'SIMULATED',claim:'SYNTHETIC_SOFTWARE_DOCUMENT_NOT_META_INVOICE',namespace:p.namespace,revision:ordinal,messagingSubtotal:total,currency:p.currency}));
 return{bytes,description:{schemaVersion:1,basisKind:'UPSTREAM_SOURCE',accountId:p.accountId,policyVersionId:policyId,commercialTermsVersionId:p.termsVersionId,periodFrom:p.from,periodTo:p.to,timezone:'UTC',currency:p.currency,minorUnits:p.minorUnits,source:{issuerKind:'META',issuerAuthorityVersionId:null,documentId:p.namespace+'-'+ordinal,documentRevision:'1',sourceScopeLocator:p.namespace,originalSha256:sha(bytes),originalByteSize:bytes.length,originalMime:'application/json',sourceIssuedAt:new Date(p.deliveredAt*1000).toISOString(),sourceKind:kind,priorStatementVersionId:priorId,sourceAccountIdentifierKind:'MESSAGING_ACCOUNT_ID',sourceAccountIdentifier:m.fixture.signup.wabaId,coverage:'ACCOUNT_PERIOD',sourceTotal:total,sourceQuantity:null,grossOriginalTotal:null,excludedOriginalAmount:null,supportedSubtotalLocator:null},lines:[]}};
}
// Compare fixed synthetic arithmetic to independently retained DB publication,
// then pass that exact projection to the incumbent tenant/CSV UI oracle.
export function assertStatementPublication(row,{amount,estimatedAmount='0.51',difference,predecessorId,adjustments=[]}){
 need(row?.state==='PUBLISHED'&&row.evidenceMode==='SIMULATED'&&row.publicationSha256===row.computedPublicationSha256,'PUBLISHED_DIGEST');
 const decimal=x=>{need(typeof x==='string'&&/^-?\d+(?:\.\d+)?$/u.test(x),'DECIMAL_STRING');const [i,f='']=x.split('.');return i+'.'+f.padEnd(12,'0');};
 const p=row.publication;need(decimal(p.amount)===decimal(amount)&&decimal(p.estimatedAmount)===decimal(estimatedAmount)&&decimal(p.difference)===decimal(difference)&&row.predecessorId===predecessorId,'INDEPENDENT_TOTAL_ORACLE');
 need(p.adjustments.length===adjustments.length&&adjustments.every(a=>p.adjustments.some(x=>x.statementVersionId===a.statementVersionId&&decimal(x.amount)===decimal(a.amount)&&x.treatment===a.treatment)),'ADJUSTMENT_LINEAGE');
 if(row.basisKind==='UPSTREAM_SOURCE')need(row.sourceState==='READY'&&row.writeDisposition==='WRITTEN'&&uuid(row.writeAttemptId)&&hex(row.scanSha256)&&row.originalSha256===row.description.source.originalSha256&&row.originalByteSize===row.description.source.originalByteSize,'ACTUAL_SCANNER_STORAGE_COMPLETION');
 return{id:row.id,evidenceMode:'SIMULATED',currency:row.currency,amount:p.amount,estimatedAmount:p.estimatedAmount,difference:p.difference,adjustments:p.adjustments};
}
