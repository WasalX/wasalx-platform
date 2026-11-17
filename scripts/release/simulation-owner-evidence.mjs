import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {remoteViewports} from "./journey-context-contract.mjs";
const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
export function verifyOwnerEvidence(s,page=s.ownerPage,actorId=s.ownerId,tenantId=s.tenantId){return verifyTenantEvidence(s,page,actorId,'tenant_owner',tenantId);}
export async function verifyTenantEvidence(s,page,actorId,role,tenantId,subject=actorId){
 assert(typeof actorId==='string'&&actorId&&typeof tenantId==='string'&&tenantId);
 assert(['tenant_owner','tenant_admin','supervisor','agent','auditor'].includes(role));assert(typeof subject==='string'&&subject);const proof=await s.verifyOwner(page,actorId,role,tenantId);
 assert(proof?.userMatched&&proof.workspaceMatched);
 const locale=await page.evaluate(()=>document.documentElement.lang);assert.equal(locale,'en');
 const viewport=page.viewportSize();assert(Number.isSafeInteger(viewport?.width)&&viewport.width>0&&Number.isSafeInteger(viewport?.height)&&viewport.height>0);
 return{role,locale,actorRef:digest(subject),tenantRef:digest(tenantId),viewport,verifiedAt:new Date().toISOString()};
}
export function bindOwnerEvidenceRows(rows,binding){assert.equal(binding.role,'tenant_owner');return bindTenantEvidenceRows(rows,binding);}
export function bindTenantEvidenceRows(rows,binding){
 assert(['tenant_owner','tenant_admin','supervisor','agent','auditor'].includes(binding.role));assert.equal(binding.locale,'en');
 for(const ref of [binding.actorRef,binding.tenantRef])assert.match(ref,/^sha256:[a-f0-9]{64}$/u);
 assert(Number.isFinite(Date.parse(binding.verifiedAt)));
 return rows.map(row=>{
  const viewport=remoteViewports.find(value=>row.contextId===binding.role+'-'+binding.locale+'-'+value.name);assert(viewport,'Assertion context differs from the verified tenant role/locale');
  assert.deepEqual(binding.viewport,{width:viewport.width,height:viewport.height},'Assertion context differs from the actual observed viewport');
  assert(Number.isFinite(Date.parse(row.startedAt))&&Number.isFinite(Date.parse(row.finishedAt))&&Date.parse(row.startedAt)<=Date.parse(row.finishedAt));
  assert(row.proof&&typeof row.proof==='object'&&Object.keys(row.proof).length);
  for(const field of ['actorRef','tenantRef'])if(row[field]!==undefined)assert.equal(row[field],binding[field],'Contradictory owner binding');
  for(const viewport of [row.actualViewport,row.proof.viewport].filter(Boolean))assert.deepEqual(viewport,binding.viewport,'Contradictory observed viewport');
  return{...row,actorRef:binding.actorRef,tenantRef:binding.tenantRef,actualViewport:binding.viewport,verifiedContext:binding,proof:{...row.proof,actorVerified:true,actorVerifiedAt:binding.verifiedAt}};
 });
}
// Single-owner leaves do not switch accounts, tenants, or row viewports. Bind the
// existing bounded operation, keeping assertion outcomes and original windows.
export async function withOwnerEvidence(s,run){
 const before=await verifyOwnerEvidence(s);assert.deepEqual(before.viewport,{width:1440,height:1000},'Single-owner stage requires actual desktop before dispatch');const result=await run(),after=await verifyOwnerEvidence(s);
 assert.deepEqual({...before,verifiedAt:null},{...after,verifiedAt:null},'Owner context changed during the bounded stage');
 const mapped={...result},binding={...after,verificationWindow:{startedAt:before.verifiedAt,finishedAt:after.verifiedAt}};
 for(const field of ['results','proofs'])if(Array.isArray(result[field]))mapped[field]=result[field].map(row=>{if(!row.testId||!row.contextId?.startsWith('tenant_owner-en-'))return row;assert(Date.parse(row.startedAt)>=Date.parse(before.verifiedAt)&&Date.parse(row.finishedAt)<=Date.parse(after.verifiedAt),'Assertion outside verified owner operation window');const bound=bindOwnerEvidenceRows([row],binding)[0];return{...bound,proof:{...bound.proof,actorVerificationWindow:binding.verificationWindow}};});
 return mapped;
}
