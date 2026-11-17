import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {bindNativeAgentResult} from './simulation-native-agent.mjs';

const rowKey=row=>`${row.testId}\0${row.contextId}`;
const safeErrorClass=error=>/^[A-Za-z][A-Za-z0-9]*Error$/u.test(error?.name??'')?error.name:'Error';
const safeErrorHash=error=>createHash('sha256').update(`${error?.name??'Error'}\0${error?.message??String(error)}`).digest('hex');
const safePhase=value=>/^[a-z][a-z0-9-]{0,63}$/u.test(value??'')?value:undefined;
const safeFailure=error=>({
 errorClass:safeErrorClass({name:error?.nativeErrorClass??error?.name}),
 errorHash:/^[a-f0-9]{64}$/u.test(error?.nativeErrorHash??'')?error.nativeErrorHash:safeErrorHash(error),
 ...(safePhase(error?.nativePhase)?{phase:error.nativePhase}:{}),
 reason:'Native UI assertion failed',
});

export async function withNativeUiPhase(phase,operation){
 assert.match(phase,/^[a-z][a-z0-9-]{0,63}$/u);assert.equal(typeof operation,'function');
 try{return await operation();}catch(error){if(safePhase(error?.nativePhase))throw error;const wrapped=Error('Native UI assertion failed',{cause:error});wrapped.nativePhase=phase;wrapped.nativeErrorClass=safeErrorClass(error);wrapped.nativeErrorHash=safeErrorHash(error);throw wrapped;}
}

export function nativeBusinessRows(testIds,context,proofs,startedAt=new Date().toISOString()){
 assert(Array.isArray(testIds)&&testIds.length>0);assert.equal(new Set(testIds).size,testIds.length);
 assert(context?.contextId&&context?.surface&&context?.viewport);assert.deepEqual(Object.keys(proofs).sort(),[...testIds].sort());
 return testIds.map(testId=>({testId,result:'passed',startedAt,finishedAt:new Date().toISOString(),contextId:context.contextId,evidenceMode:'simulated',actualViewport:context.viewport,proof:{...proofs[testId],nativeSurface:context.surface,actualViewport:context.viewport}}));
}

export function missingNativeBusinessContexts(contexts,testIds,producerRows=[]){
 assert(Array.isArray(contexts)&&contexts.length);assert.equal(new Set(contexts.map(value=>value.contextId)).size,contexts.length);assert.equal(new Set(testIds).size,testIds.length);
 const occupied=new Set();for(const row of producerRows){assert(testIds.includes(row.testId));assert(row.contextId);assert(!occupied.has(rowKey(row)),'Duplicate producer result');occupied.add(rowKey(row));}
 return contexts.map(context=>({...context,testIds:testIds.filter(testId=>!occupied.has(rowKey({testId,contextId:context.contextId})))})).filter(context=>context.testIds.length);
}

export function mergeNativeBusinessRows(producerRows,nativeRows){
 const rows=[...producerRows,...nativeRows],seen=new Set();for(const row of rows){const key=rowKey(row);assert(!seen.has(key),'Duplicate native business result');seen.add(key);}
 return rows;
}

export async function collectNativeBusinessContexts({contexts,testIds,observe,verifyContext,assertStable=async()=>{},checkpoint,phase}){
 assert(Array.isArray(contexts)&&contexts.length);assert.equal(new Set(contexts.map(value=>value.contextId)).size,contexts.length);assert.equal(typeof observe,'function');assert.equal(typeof verifyContext,'function');assert.equal(typeof assertStable,'function');assert.equal(typeof checkpoint,'function');
 const rows=[];for(const context of contexts){const contextTestIds=context.testIds??testIds,startedAt=new Date().toISOString();assert(contextTestIds.length);await assertStable(context);let mapped;try{const proofs=await observe(context,contextTestIds);mapped=nativeBusinessRows(contextTestIds,context,proofs,startedAt);}catch(error){const proof={...safeFailure(error),nativeSurface:context.surface,actualViewport:context.viewport};mapped=contextTestIds.map(testId=>({testId,result:'failed',startedAt,finishedAt:new Date().toISOString(),contextId:context.contextId,evidenceMode:'simulated',actualViewport:context.viewport,proof}));}let binding;try{binding=await verifyContext(context);assert.deepEqual(binding.actualViewport,context.viewport);}catch(error){for(const row of mapped)try{await checkpoint({phase,...row,actualViewport:binding?.actualViewport,proof:{...row.proof,actorBindingFailure:{...safeFailure(error),reason:'Native identity verification failed'}}});}catch{/* Preserve the identity prerequisite error. */}throw error;}mapped=mapped.map(row=>bindNativeAgentResult({...row,finishedAt:new Date().toISOString()},binding));await assertStable(context);rows.push(...mapped);for(const row of mapped)await checkpoint({phase,...row});}
 assert.equal(rows.length,contexts.reduce((count,context)=>count+(context.testIds??testIds).length,0));return rows;
}

export function assertSharedNativeRoutingTarget(sourceRows,ticket){
 assert(Array.isArray(sourceRows)&&sourceRows.length===5);assert.equal(new Set(sourceRows.map(row=>row.testId)).size,5);assert(Number.isSafeInteger(Number(ticket?.id))&&Number.isSafeInteger(Number(ticket?.groupId)));
 for(const row of sourceRows){assert.equal(row.result,'passed');assert.equal(String(row.nativeTargets?.group?.id),String(ticket.groupId),'Retained native ticket is not the exact authorized route target');assert(row.nativeTargets.group.name);}
 return sourceRows;
}
