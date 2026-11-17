import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyMetaCostStatementCsv} from '../scripts/release/meta-cost-statement-journey.mjs';
import {createHash} from 'node:crypto';
import {MetaCostController,PlatformMetaCostController,metaCostStatementCsv} from '../services/control-api/dist/meta-cost.controller.js';
import {PermissionGuard} from '../services/control-api/dist/permission.guard.js';
import {Reflector} from '../services/control-api/node_modules/@nestjs/core/index.js';

const tenant='31000000-0000-4000-8000-000000000001',account='31000000-0000-4000-8000-000000000002',id='31000000-0000-4000-8000-000000000003';
const from='2026-10-01T00:00:00.000Z',to='2026-11-01T00:00:00.000Z';
const request={id:'statement-unit',principal:{tenantId:tenant,userId:'synthetic-user',role:'auditor'},platformOperator:{subject:'synthetic-platform-operator'}};
const row={id,purpose:'UPSTREAM_REFERENCE',basisKind:'FULL_REPLACEMENT',evidenceMode:'SIMULATED',currency:'USD',periodFrom:from,periodTo:to,
 amount:'12345678901234567890.123456789012',quantity:null,coverage:'ACCOUNT_PERIOD_ONLY',publishedAt:from,predecessorId:null,superseded:false,publicationSha256:'a'.repeat(64),sourceAvailability:'READY'};
const status=expected=>error=>error.getStatus()===expected;

test('statement reads and exports retain the existing billing permission boundary',()=>{
 const guard=new PermissionGuard(new Reflector());
 for(const method of ['statements','statement','exportStatements'])for(const role of ['tenant_owner','tenant_admin','auditor','supervisor','agent']){
  const context={getHandler:()=>MetaCostController.prototype[method],getClass:()=>MetaCostController,switchToHttp:()=>({getRequest:()=>({principal:{role}})})};
  if(['tenant_owner','tenant_admin','auditor'].includes(role))assert.equal(guard.canActivate(context),true);else assert.throws(()=>guard.canActivate(context),status(403));
 }
 assert.equal(Reflect.getMetadata('wasalx:platform-operator',PlatformMetaCostController),true);
});

test('statement CSV keeps exact decimal bytes and never confuses absent quantity with zero',()=>{
 const csv=metaCostStatementCsv([{...row,coverage:'=PRIVATE_FORMULA'}]);
 assert(csv.startsWith('\uFEFF'));assert(csv.includes(row.amount));assert(csv.includes("'=PRIVATE_FORMULA"));
 assert(!csv.includes('providerMessageId'));assert(!csv.includes('objectKey'));
 assert.throws(()=>metaCostStatementCsv(Array(1001).fill(row)),status(409));
 assert.throws(()=>metaCostStatementCsv([{...row,coverage:'x'.repeat(10_485_761)}]),status(409));
});

test('scoped statement export validates bytes before audit and refuses over-bound or unattributed selection',async()=>{
 const calls=[];let rows=[row],body;
 const controller=new MetaCostController({withTenant:async(scope,run)=>{assert.equal(scope,tenant);return run({query:async(sql,args)=>{
  calls.push({sql,args});return sql.includes('meta_cost_statement_summaries')?{rows:[{value:rows}]}:{rows:[]};
 }});}});
 const headers={},reply={header:(key,value)=>{headers[key]=value;return reply;},send:value=>{body=value;}};
 await controller.exportStatements(request,reply,account,from,to);
 assert(body.includes(row.amount));assert.equal(headers['cache-control'],'private, no-store');
 const audit=calls.find(call=>call.sql.includes('INSERT INTO audit_events'));assert.equal(audit.args[2],'meta.statement.exported');assert.deepEqual(audit.args[6],{count:1,from,to});
 for(const invalidRows of [Array(1001).fill(row),[{...row,coverage:'x'.repeat(10_485_761)}]]){
  rows=invalidRows;calls.length=0;body=undefined;await assert.rejects(()=>controller.exportStatements(request,reply,account,from,to),status(409));
  assert.equal(body,undefined);assert.equal(calls.some(call=>call.sql.includes('audit_events')),false);
 }
 assert.throws(()=>controller.statements(request,'unattributed',from,to),status(400));
});

test('source JWT admission rechecks exact original state, lifetime and active privacy fence',async()=>{
 let source={originalSha256:'a'.repeat(64),originalByteSize:14,originalMime:'application/pdf',state:'RESERVED',sourceState:'RESERVED',sourceFenced:false,
  expiresAt:new Date(Date.now()+60_000).toISOString(),sourceDeleteAfter:new Date(Date.now()+120_000).toISOString()};
 const reads=[],tokens=[],controller=new PlatformMetaCostController({isConfigured:()=>true,metaStatementRead:async value=>{reads.push(value);return source;}},
  {issueMetaCostSourceToken:async(...values)=>{tokens.push(values);return 'synthetic-scoped-token';}});
 assert.equal((await controller.sourceAccess(request,tenant,id,{operation:'UPLOAD'})).token,'synthetic-scoped-token');assert.deepEqual(tokens[0],[tenant,id,'UPLOAD']);
 source={...source,sourceState:'READY'};await controller.sourceAccess(request,tenant,id,{operation:'READ'});
 const accepted={...source};
 for(const delta of [{sourceFenced:true},{state:'EXPIRED'},{sourceState:'PURGE_PENDING'},{expiresAt:new Date(0).toISOString()},{sourceDeleteAfter:new Date(0).toISOString()}]){
  source={...accepted,...delta};await assert.rejects(()=>controller.sourceAccess(request,tenant,id,{operation:'READ'}),status(409));
 }
 source={...accepted,state:'PUBLISHED',sourceDeleteAfter:new Date(0).toISOString()};
 await assert.rejects(()=>controller.sourceAccess(request,tenant,id,{operation:'UPLOAD'}),status(409));
 assert.equal(tokens.length,2);assert(reads.every(value=>value.tenantId===tenant&&value.id===id&&value.operator===request.platformOperator));
 await assert.rejects(()=>controller.sourceAccess(request,tenant,id,{operation:'READ',evidenceMode:'LIVE'}),status(400));
 assert.equal(tokens.length,2);
});

test('finite operator transitions retain object, actor, CAS and operation key without exposing database detail',async()=>{
 const calls=[],controller=new PlatformMetaCostController({isConfigured:()=>true,metaStatementAction:async value=>{calls.push(value);return{id,version:2};}});
 const body={expectedVersion:1,expectedInputSha256:'a'.repeat(64),expectedPreviewSha256:'b'.repeat(64)};
 await controller.transitionStatement(request,tenant,id,'publish','same-intent',body);
 assert.equal(calls[0].action,'META_STATEMENT_PUBLISH');assert.equal(calls[0].objectId,id);assert.equal(calls[0].operator,request.platformOperator);assert.deepEqual(calls[0].body,body);
 for(const operation of ['settle','charge','delete','reclassify-live'])assert.throws(()=>controller.transitionStatement(request,tenant,id,operation,'key',body),status(404));
 for(const invalid of [{expectedVersion:0},{expectedVersion:1,extra:'x'.repeat(524_288)}])assert.throws(()=>controller.transitionStatement(request,tenant,id,'review','key',invalid),status(400));
 assert.throws(()=>controller.transitionStatement(request,tenant,id,'review',' bad-key ',body),status(400));assert.equal(calls.length,1);
 const rejected=new PlatformMetaCostController({isConfigured:()=>true,metaStatementAction:async()=>{throw Object.assign(new Error('PRIVATE_SOURCE_DETAIL'),{code:'40001'});}});
 await assert.rejects(()=>rejected.transitionStatement(request,tenant,id,'publish','key',body),error=>error.getStatus()===409&&!error.message.includes('PRIVATE_SOURCE_DETAIL'));
});

test('statement CSV preserves immutable adjustment lineage and exact estimate/reconciliation amounts',()=>{
 const adjustments=[{statementVersionId:id,amount:'-0.000000000001',treatment:'INCLUDED_IN_REPLACEMENT'},
  {statementVersionId:account,amount:'-12345678901234567890.123456789012',treatment:'EXCLUDED_FROM_REPLACEMENT'}];
 const csv=metaCostStatementCsv([{...row,estimatedAmount:'0.000000000001',difference:'12345678901234567890.123456789011',adjustments}]);
 const lines=csv.slice(1).trimEnd().split('\r\n');assert.equal(lines.length,4);
 const columns=lines[0].split(',').map(value=>value.replaceAll('"',''));
 const index=name=>{const i=columns.indexOf(name);assert(i>=0);return i;};
 const cells=line=>line.split(',').map(value=>value.replaceAll('"',''));
 const summary=cells(lines[1]);assert.equal(summary[index('rowType')],'STATEMENT');assert.equal(summary[index('amount')],row.amount);
 assert.equal(summary[index('estimatedAmount')],'0.000000000001');assert.equal(summary[index('difference')],'12345678901234567890.123456789011');
 for(let i=0;i<adjustments.length;i++){
  const values=cells(lines[i+2]);assert.equal(values[index('rowType')],'ADJUSTMENT');assert.equal(values[index('amount')],'');
  assert.equal(values[index('adjustmentStatementId')],adjustments[i].statementVersionId);
  // CSV formula protection may prefix negative strings; decimal bytes remain exact.
  assert.equal(values[index('adjustmentAmount')].replace(/^'/u,''),adjustments[i].amount);
  assert.equal(values[index('adjustmentTreatment')],adjustments[i].treatment);
 }
 assert.throws(()=>metaCostStatementCsv([{...row,adjustments:Array(1001).fill(adjustments[0])}]),status(409));
 assert.throws(()=>metaCostStatementCsv(Array(10).fill({...row,adjustments:Array(1000).fill(adjustments[0])})),status(409));
 assert(!csv.includes('selectedRows'));assert(!csv.includes('payerAuthorityVersionId'));
});

test('downloaded CSV oracle consumes the actual protected base credit replacement encoder',()=>{
 const creditId='31000000-0000-4000-8000-000000000004',replacementId='31000000-0000-4000-8000-000000000005';
 const base={...row,basisKind:'ACCOUNT_PERIOD',estimatedAmount:'12345678901234567890.123456789013',difference:'-0.000000000001',adjustments:[]};
 const credit={...row,id:creditId,basisKind:'CREDIT',amount:'-0.01',estimatedAmount:'0',difference:'-0.01',predecessorId:id,adjustments:[]};
 const replacement={...row,id:replacementId,amount:'0.000000000001',estimatedAmount:'12345678901234567890.123456789012',difference:'-12345678901234567890.123456789011',
  adjustments:[{statementVersionId:creditId,amount:'-0.01',treatment:'INCLUDED_IN_REPLACEMENT'},
   {statementVersionId:account,amount:'12345678901234567890.123456789012',treatment:'EXCLUDED_FROM_REPLACEMENT'}]};
 const bytes=Buffer.from(metaCostStatementCsv([base,credit,replacement])),before=createHash('sha256').update(bytes).digest('hex');
 for(const value of [base,credit,replacement]){const result=verifyMetaCostStatementCsv(bytes,value);assert.equal(result.sha256,before);assert.equal(result.adjustmentRows,value.adjustments.length);}
 assert(bytes.toString().includes('"\'-0.01"'));assert.equal(createHash('sha256').update(bytes).digest('hex'),before);
 assert.throws(()=>verifyMetaCostStatementCsv(Buffer.from(bytes.toString().replaceAll("'-0.01",'-0.01')),replacement),'Unprotected negative cells must not pass');
 const duplicate={...replacement,adjustments:[replacement.adjustments[0],replacement.adjustments[0]]};
 assert.throws(()=>verifyMetaCostStatementCsv(Buffer.from(metaCostStatementCsv([duplicate])),duplicate));
});
