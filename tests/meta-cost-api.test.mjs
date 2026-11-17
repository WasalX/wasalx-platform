import assert from "node:assert/strict";
import test from "node:test";
import { MetaCostController,PlatformMetaCostController,metaCostCsv,parseCostWindow } from "../services/control-api/dist/meta-cost.controller.js";
import { PermissionGuard } from "../services/control-api/dist/permission.guard.js";
import { Reflector } from "../services/control-api/node_modules/@nestjs/core/index.js";

const tenant="31000000-0000-4000-8000-000000000001",account="31000000-0000-4000-8000-000000000002",delivery="31000000-0000-4000-8000-000000000003",head="31000000-0000-4000-8000-000000000004";
const from="2026-10-01T00:00:00.000Z",to="2026-11-01T00:00:00.000Z";
const request={id:"cost-test",principal:{tenantId:tenant,userId:"cost-user",role:"auditor"},platformOperator:{subject:"cost-operator"}};
function snapshot(){return{complete:true,selectedCount:1,selectedSha256:"f".repeat(64),accountId:account,from,to,coverage:[],totals:[],rows:[{
  id:head,deliveryId:delivery,accountId:account,purpose:"UPSTREAM_REFERENCE",evidenceMode:"SIMULATED",state:"ESTIMATED",reason:"PROVISIONAL_RATE",
  delivered:true,reportedFree:false,deliveredAt:from,observedAt:from,tariffVersionId:head,currency:"USD",minorUnits:2,rounding:"LINE",
  unroundedAmount:"12345678901234567890.123456",amount:"12345678901234567890.12",evidenceRedacted:false,
  inputSha256:"a".repeat(64),receiptSetSha256:"b".repeat(64),admissionSha256:"c".repeat(64),admissionDigestFormat:"pg-jsonb-text-v1",paymentMode:"CUSTOMER",payerState:"UNVERIFIED",timeBasis:"PROVIDER_DELIVERED_TIMESTAMP",
}]};}

test("billing permission guard admits only owner, administrator and auditor reads/exports",()=>{
  const guard=new PermissionGuard(new Reflector());
  for(const method of ["accounts","usage","export"])for(const role of ["tenant_owner","tenant_admin","auditor","supervisor","agent"]){
    const context={getHandler:()=>MetaCostController.prototype[method],getClass:()=>MetaCostController,switchToHttp:()=>({getRequest:()=>({principal:{role}})})};
    if(["tenant_owner","tenant_admin","auditor"].includes(role))assert.equal(guard.canActivate(context),true);
    else assert.throws(()=>guard.canActivate(context),error=>error.getStatus()===403);
  }
  assert.equal(Reflect.getMetadata("wasalx:platform-operator",PlatformMetaCostController),true);
});

test("cost period accepts exact account scope and rejects malformed or oversized windows",()=>{
  assert.deepEqual(parseCostWindow(account,from,to),{accountId:account,from,to});
  assert.equal(parseCostWindow("unattributed",from,to).accountId,null);
  for(const values of [["all",from,to],[account,to,from],[account,"2026-02-30T00:00:00.000Z",to],[account,"2020-01-01T00:00:00.000Z",to]])
    assert.throws(()=>parseCostWindow(...values),error=>error.getStatus()===400);
});

test("complete cost export preserves decimal bytes, digest domains and CSV formula safety",()=>{
  const value=snapshot();value.rows[0].reason='=HYPERLINK("x")';
  const csv=metaCostCsv(value);
  assert.ok(csv.startsWith("\uFEFF"));assert.ok(csv.includes("12345678901234567890.123456"));assert.ok(csv.includes("12345678901234567890.12"));
  assert.ok(csv.includes("pg-jsonb-text-v1"));assert.ok(csv.includes("UNVERIFIED"));assert.ok(csv.includes(value.selectedSha256));assert.match(csv,/'=HYPERLINK\(""x""\)/);
  assert.throws(()=>metaCostCsv({...value,complete:false}),error=>error.getStatus()===409);
  assert.throws(()=>metaCostCsv({...value,rows:Array(10001).fill(value.rows[0])}),error=>error.getStatus()===409);
});

test("usage and export audit exactly the returned MVCC selection and never emit partial bytes",async()=>{
  const calls=[],value=snapshot();let complete=true;
  const database={withTenant:async(scope,run)=>{assert.equal(scope,tenant);return run({query:async(sql,args)=>{calls.push({sql,args});return sql.includes("meta_cost_usage_snapshot")?{rows:[{result:{...value,complete}}]}:{rows:[],rowCount:1};}});}};
  const controller=new MetaCostController(database),headers={};let body;
  const reply={header:(key,val)=>{headers[key]=val;return reply;},send:val=>{body=val;}};
  await controller.export(request,reply,account,from,to);
  assert.equal(headers["cache-control"],"private, no-store");assert.equal(headers["x-content-type-options"],"nosniff");assert.ok(body.includes(value.selectedSha256));
  const audit=calls.find(call=>call.sql.includes("INSERT INTO audit_events"));assert.equal(audit.args[2],"meta.cost.exported");assert.deepEqual(audit.args[6],{from,to,selectedCount:1,selectedSha256:value.selectedSha256});
  complete=false;calls.length=0;body=undefined;
  await assert.rejects(()=>controller.export(request,reply,account,from,to),error=>error.getStatus()===409);
  assert.equal(body,undefined);assert.equal(calls.some(call=>call.sql.includes("audit_events")),false);
});

test("operator reassessment distinguishes retain, withdraw and replace facts while retaining expected heads",async()=>{
  const calls=[];const controller=new PlatformMetaCostController({isConfigured:()=>true,metaCostAction:async input=>{calls.push(input);return{count:1};}});
  await controller.reassess(request,tenant,account,"retain-key",{purpose:"UPSTREAM_REFERENCE",items:[{deliveryId:delivery,expectedHeadId:head}]});
  await controller.reassess(request,tenant,account,"withdraw-key",{purpose:"UPSTREAM_REFERENCE",items:[{deliveryId:delivery,expectedHeadId:head,selectorEvidence:null}]});
  assert.equal(Object.hasOwn(calls[0].body.items[0],"selectorEvidence"),false);assert.equal(calls[1].body.items[0].selectorEvidence,null);
  assert.equal(calls[0].body.items[0].expectedHeadId,head);assert.equal(calls[0].operator,request.platformOperator);
  for(const items of [[{deliveryId:delivery,expectedHeadId:head,amount:"0.01"}],Array(101).fill({deliveryId:delivery,expectedHeadId:head}),[{deliveryId:delivery,expectedHeadId:head},{deliveryId:delivery,expectedHeadId:head}]])
    assert.throws(()=>controller.reassess(request,tenant,account,"invalid-key",{purpose:"UPSTREAM_REFERENCE",items}),error=>error.getStatus()===400);
  assert.equal(calls.length,2);
});

test("operator database failures become bounded errors without leaking private evidence",async()=>{
  const controller=new PlatformMetaCostController({isConfigured:()=>true,metaCostRead:async()=>{throw Object.assign(new Error("private evidence"),{code:"40001"});}});
  await assert.rejects(()=>controller.read(request,tenant,account,from,to),error=>error.getStatus()===409&&!error.message.includes("private evidence"));
});
