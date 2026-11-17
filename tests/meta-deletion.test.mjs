import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { Reflector } from "../services/control-api/node_modules/@nestjs/core/index.js";
import { PlatformOperatorAuthService,assertPlatformOperatorClaims,PLATFORM_OPERATOR_ROUTE } from "../services/control-api/dist/platform-operator-auth.js";
import { PlatformOperationsRepository } from "../services/control-api/dist/platform-operations.repository.js";
import { readFile } from "node:fs/promises";
import { PUBLIC_ROUTE } from "../services/control-api/dist/auth.guard.js";
import { Module } from "../services/control-api/node_modules/@nestjs/common/index.js";
import { NestFactory } from "../services/control-api/node_modules/@nestjs/core/index.js";
import { FastifyAdapter } from "../services/control-api/node_modules/@nestjs/platform-fastify/index.js";
import { registerMetaDeletionForm } from "../services/control-api/dist/meta-deletion-form.js";
import { verifyMetaDeletionRequest,parseMetaDeletionForm,parseMetaDeletionReview } from "../services/control-api/dist/meta-deletion-contract.js";
import { MetaDeletionService,metaDeletionConfiguration,metaDeletionRefusalPolicyUrl } from "../services/control-api/dist/meta-deletion.service.js";
import { MetaDeletionCallbackController,MetaDeletionReviewController } from "../services/control-api/dist/meta-deletion.controller.js";

const app="12025550130",secret="synthetic-deletion-app-secret-never-live",now=Math.floor(Date.now()/1000);
function signed(payload,key=secret){const encoded=Buffer.from(JSON.stringify(payload)).toString("base64url");return `${createHmac("sha256",key).update(encoded).digest("base64url")}.${encoded}`;}
const payload={algorithm:"HMAC-SHA256",issued_at:now,user_id:"444444444",expires:0};

test("signed deletion namespace remains human ASID with hashes only",()=>{
  const request=signed(payload),verified=verifyMetaDeletionRequest(request,app,secret,now);
  assert.equal(verified.namespace,"FACEBOOK_ASID");assert.equal(verified.appId,app);
  assert.match(verified.verificationKeyFingerprint,/^[0-9a-f]{64}$/);
  assert.match(verified.subjectDigest,/^[0-9a-f]{64}$/);assert.match(verified.payloadSha256,/^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(verified),/444444444|synthetic-deletion-app-secret/);
  assert.notEqual(verified.subjectDigest,verifyMetaDeletionRequest(request,"222222222",secret,now).subjectDigest);
  for(const [name,value] of Object.entries({badSecret:signed(payload,"another-synthetic-app-secret"),tampered:`${request.slice(0,-1)}A`,wrongAlgorithm:signed({...payload,algorithm:"NONE"}),missingUser:signed({...payload,user_id:undefined}),numericUser:signed({...payload,user_id:444}),missingIssued:signed({...payload,issued_at:undefined}),future:signed({...payload,issued_at:now+301}),fraction:signed({...payload,issued_at:now+.5})}))assert.throws(()=>verifyMetaDeletionRequest(value,app,secret,now),undefined,name);
});
test("form and review parsers reject confused scope, completion and changed claims",()=>{
  const request=signed(payload);assert.equal(parseMetaDeletionForm(new URLSearchParams({signed_request:request}).toString()),request);
  for(const body of ["",`signed_request=${request}&signed_request=${request}`,`signed_request=${request}&tenant_id=foreign`,{signed_request:request},"signed_request="+"x".repeat(8192)])assert.throws(()=>parseMetaDeletionForm(body));
  const review={expectedVersion:1,state:"REFUSED",reason:"LAWFUL_RETENTION",evidenceSha256:"a".repeat(64)};
  assert.deepEqual(parseMetaDeletionReview(review),review);
  for(const body of [{...review,state:"COMPLETED"},{...review,reason:"NO_DATA"},{...review,tenantId:"invented"},{...review,evidenceSha256:""},{...review,expectedVersion:0}])assert.throws(()=>parseMetaDeletionReview(body));
});
test("callback returns original URL/code on replay without raw subject or new scope",async()=>{
  const saved={...process.env};Object.assign(process.env,{META_APP_ID:app,META_APP_SECRET_REFERENCE:"secret://platform/meta-webhook",META_DELETION_STATUS_ORIGIN:"https://portal.example.invalid",META_DELETION_HELP_URL:"https://support.example.invalid/privacy",META_DELETION_MAX_REQUEST_AGE_SECONDS:"86400",META_DELETION_RECEIPT_RETENTION_DAYS:"30"});
  try{
    let stored;const calls=[];const service=new MetaDeletionService({receiveMetaDeletionReceipt:async input=>{calls.push(input);stored??={locator:input.locator};return stored;},metaDeletionReceiptStatus:async()=>({state:"SCOPE_REVIEW_REQUIRED"})},{resolveHmac:async(reference,owner)=>{assert.equal(reference,process.env.META_APP_SECRET_REFERENCE);assert.deepEqual(owner,{kind:"exact",expectedReference:reference});return secret;}});
    const controller=new MetaDeletionCallbackController(service),form=new URLSearchParams({signed_request:signed(payload)}).toString();
    const first=await controller.receive("application/x-www-form-urlencoded; charset=utf-8",form),second=await controller.receive("application/x-www-form-urlencoded",form);
    assert.deepEqual(second,first);assert.match(first.confirmation_code,/^[0-9a-f]{64}$/);assert.equal(new URL(first.url).hash,`#${first.confirmation_code}`);assert.equal(new URL(first.url).search,"");
    assert.equal(calls.length,2);assert.equal(calls[0].payloadSha256,calls[1].payloadSha256);assert.notEqual(calls[0].locator,calls[1].locator);assert.doesNotMatch(JSON.stringify(calls),/444444444|tenantId|businessId|user_id|signed_request/);
    assert.throws(()=>controller.receive("application/json",{signed_request:signed(payload)}));
    assert.deepEqual(await controller.status({code:first.confirmation_code}),{state:"SCOPE_REVIEW_REQUIRED"});assert.throws(()=>controller.status({code:first.confirmation_code,tenantId:"foreign"}));
    for(const origin of ["http://portal.example.invalid","https://fixture:placeholder@api.example.test/path","https://portal.example.invalid?token=x"]){process.env.META_DELETION_STATUS_ORIGIN=origin;assert.throws(()=>metaDeletionConfiguration());}
    process.env.META_DELETION_STATUS_ORIGIN="https://portal.example.invalid";process.env.META_DELETION_RECEIPT_RETENTION_DAYS="1";assert.throws(()=>metaDeletionConfiguration(),"retention must exceed request age plus admitted clock skew");
  }finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
});
test("review controller binds operator, receipt CAS and idempotency; stale review is sanitized",async()=>{
  const receiptId="10000000-0000-4000-8000-000000000001",operator={subject:"synthetic-platform-reviewer"};let input;
  const controller=new MetaDeletionReviewController({reviewMetaDeletionReceipt:async value=>{input=value;return{state:value.state};},metaDeletionReceipts:async()=>({items:[]})});
  assert.deepEqual(await controller.review({id:"request",platformOperator:operator},receiptId,"review-key-1",{expectedVersion:1,state:"HELD",reason:"OUTCOME_UNRESOLVED",evidenceSha256:"a".repeat(64)}),{state:"HELD"});
  assert.equal(input.operator,operator);assert.equal(input.id,receiptId);assert.equal(input.key,"review-key-1");
  const stale=new MetaDeletionReviewController({reviewMetaDeletionReceipt:async()=>{throw Object.assign(new Error("SECRET_RAW_DETAIL"),{code:"40001"});}});
  await assert.rejects(stale.review({id:"request",platformOperator:operator},receiptId,"review-key-1",{expectedVersion:1,state:"HELD",reason:"OUTCOME_UNRESOLVED",evidenceSha256:"a".repeat(64)}),error=>error.getStatus()===409&&!error.message.includes("SECRET_RAW_DETAIL"));
});
test("production Nest callback accepts bounded form wire; malformed and oversized bodies never admit",async()=>{
  let receives=0,statusReads=0;
  class FixtureModule {}
  Module({controllers:[MetaDeletionCallbackController],providers:[{provide:MetaDeletionService,useValue:{receive:async value=>{receives++;assert.equal(value,signed(payload));return{url:"https://portal.example.invalid/privacy/meta-deletion#"+"a".repeat(64),confirmation_code:"a".repeat(64)};},status:async code=>{statusReads++;assert.equal(code,"a".repeat(64));return{state:"SCOPE_REVIEW_REQUIRED"};}}}]})(FixtureModule);
  const adapter=new FastifyAdapter();registerMetaDeletionForm(adapter);
  adapter.getInstance().post("/fixture-json-raw-body",async request=>({body:request.body,
    raw:Buffer.isBuffer(request.rawBody)?request.rawBody.toString("utf8"):null}));
  const application=await NestFactory.create(FixtureModule,adapter,{logger:false,rawBody:true});
  try{
    await application.init();await adapter.getInstance().ready();
    const jsonWire='{ "retained": true, "order": [2,1] }';
    const json=await adapter.getInstance().inject({method:"POST",url:"/fixture-json-raw-body",headers:{"content-type":"application/json"},payload:jsonWire});
    assert.equal(json.statusCode,200);assert.deepEqual(json.json(),{body:JSON.parse(jsonWire),raw:jsonWire});
    const form=new URLSearchParams({signed_request:signed(payload)}).toString();
    const accepted=await adapter.getInstance().inject({method:"POST",url:"/webhooks/meta/data-deletion",headers:{"content-type":"application/x-www-form-urlencoded"},payload:form});
    assert.equal(accepted.statusCode,200);assert.equal(accepted.json().confirmation_code,"a".repeat(64));assert.equal(accepted.headers["cache-control"],"no-store");
    const wrongType=await adapter.getInstance().inject({method:"POST",url:"/webhooks/meta/data-deletion",headers:{"content-type":"application/json"},payload:{signed_request:signed(payload)}});
    assert.equal(wrongType.statusCode,400);assert.equal(receives,1);
    const malformed=await adapter.getInstance().inject({method:"POST",url:"/webhooks/meta/data-deletion",headers:{"content-type":"application/x-www-form-urlencoded"},payload:`${form}&${form}`});assert.equal(malformed.statusCode,400);
    const oversized=await adapter.getInstance().inject({method:"POST",url:"/webhooks/meta/data-deletion",headers:{"content-type":"application/x-www-form-urlencoded"},payload:"signed_request="+"x".repeat(8192)});assert.equal(oversized.statusCode,413);assert.equal(receives,1);
    const status=await adapter.getInstance().inject({method:"POST",url:"/webhooks/meta/data-deletion/status",payload:{code:"a".repeat(64)}});assert.equal(status.statusCode,200);assert.equal(status.json().state,"SCOPE_REVIEW_REQUIRED");
    const foreign=await adapter.getInstance().inject({method:"POST",url:"/webhooks/meta/data-deletion/status",payload:{code:"a".repeat(64),tenantId:"invented"}});assert.equal(foreign.statusCode,400);assert.equal(statusReads,1);
  }finally{await application.close();}
});

test("refusal is server-policy-bound without changing caller review intent",async()=>{
  const saved=process.env.META_DELETION_REFUSAL_POLICY_URL;
  try{
    delete process.env.META_DELETION_REFUSAL_POLICY_URL;assert.equal(metaDeletionRefusalPolicyUrl(),undefined);
    for(const value of ["http://policy.example.invalid","https://fixture:placeholder@api.example.test/path","https://policy.example.invalid/?token=x","https://policy.example.invalid/#secret"]){process.env.META_DELETION_REFUSAL_POLICY_URL=value;assert.equal(metaDeletionRefusalPolicyUrl(),undefined);}
    process.env.META_DELETION_REFUSAL_POLICY_URL="https://policy.example.invalid/retention";
    let admitted;const controller=new MetaDeletionReviewController({metaDeletionReceipts:async()=>({items:[]}),reviewMetaDeletionReceipt:async input=>{admitted=input;return{state:input.state};}});
    const request={id:"request",platformOperator:{subject:"synthetic-reviewer"}};
    assert.equal((await controller.list(request)).refusalAvailable,true);
    const body={expectedVersion:1,state:"REFUSED",reason:"LAWFUL_RETENTION",evidenceSha256:"a".repeat(64)};
    await controller.review(request,"10000000-0000-4000-8000-000000000001","refusal-key",body);
    assert.equal(admitted.refusalPolicyUrl,process.env.META_DELETION_REFUSAL_POLICY_URL);
    await assert.rejects(controller.review(request,"10000000-0000-4000-8000-000000000001","refusal-key",{...body,refusalPolicyUrl:"https://attacker.example.invalid"}));
    delete process.env.META_DELETION_REFUSAL_POLICY_URL;
    assert.equal((await controller.list(request)).refusalAvailable,false);
    await controller.review(request,"10000000-0000-4000-8000-000000000001","refusal-key",body);
    assert.equal(admitted.refusalPolicyUrl,undefined,"SQL receipt-first replay must remain reachable after config removal");
  }finally{if(saved===undefined)delete process.env.META_DELETION_REFUSAL_POLICY_URL;else process.env.META_DELETION_REFUSAL_POLICY_URL=saved;}
});

test("strict signed envelope rejects noncanonical encoding and hostile claims",()=>{
  const valid=signed(payload),[signature,encoded]=valid.split(".");
  const malformedUtf8=Buffer.from([0xff]).toString("base64url");
  for(const value of [valid+".extra",signature+"=."+encoded,signature+"."+encoded+"=",signature+".@@",createHmac("sha256",secret).update(malformedUtf8).digest("base64url")+"."+malformedUtf8,
    signed({...payload,expires:"0"}),signed({...payload,expires:-1}),signed({...payload,expires:.5})])assert.throws(()=>verifyMetaDeletionRequest(value,app,secret,now));
  const second="another-synthetic-app-key-generation";
  assert.notEqual(verifyMetaDeletionRequest(signed(payload,second),app,second,now).verificationKeyFingerprint,verifyMetaDeletionRequest(valid,app,secret,now).verificationKeyFingerprint);
  assert.throws(()=>verifyMetaDeletionRequest(valid,app,second,now),"old key callback cannot authenticate under current-only key");
});
test("new protected review routes actually invoke existing platform verifier",async()=>{
  const now=Math.floor(Date.now()/1000),reflector=new Reflector();let writes=0;
  assert.equal(reflector.get(PUBLIC_ROUTE,MetaDeletionCallbackController),true);
  assert.equal(reflector.get(PUBLIC_ROUTE,MetaDeletionReviewController),true);
  const verifier={authenticate:async value=>{
    const claims={sub:"synthetic-operator",email:"operator@example.invalid",platform_role:"platform_operator",amr:["mfa"],auth_time:now};
    if(value==="Bearer tenant")delete claims.platform_role;
    if(value==="Bearer no-mfa")claims.amr=[];
    if(value==="Bearer stale")claims.auth_time=now-901;
    return assertPlatformOperatorClaims(claims,now,900);
  }};
  assert.equal(reflector.get(PLATFORM_OPERATOR_ROUTE,MetaDeletionReviewController),true);
  class ReviewModule {}
  // The decorator enhancer constructs the actual guard; its verifier dependency
  // is the only double. A guard providers override would not replace it.
  Module({controllers:[MetaDeletionReviewController],providers:[Reflector,{provide:PlatformOperationsRepository,useValue:{metaDeletionReceipts:async()=>{writes++;return{items:[]};}}},{provide:PlatformOperatorAuthService,useValue:verifier}]})(ReviewModule);
  const adapter=new FastifyAdapter(),application=await NestFactory.create(ReviewModule,adapter,{logger:false});
  try{await application.init();await adapter.getInstance().ready();
    for(const [authorization,extra] of [["Bearer tenant",{}],["Bearer no-mfa",{}],["Bearer stale",{}],["Bearer valid",{"x-wasalx-tenant-id":"foreign"}]]){
      const response=await adapter.getInstance().inject({method:"GET",url:"/platform/v1/meta-deletion",headers:{authorization,...extra}});assert.equal(response.statusCode,401);assert.equal(writes,0);
    }
    const accepted=await adapter.getInstance().inject({method:"GET",url:"/platform/v1/meta-deletion",headers:{authorization:"Bearer valid"}});assert.equal(accepted.statusCode,200);assert.equal(writes,1);
  }finally{await application.close();}
});
test("real callback service wiring preserves verification and shared status-limit denial",async()=>{
  const saved={...process.env};Object.assign(process.env,{META_APP_ID:app,META_APP_SECRET_REFERENCE:"secret://platform/meta-webhook",META_DELETION_STATUS_ORIGIN:"https://portal.example.invalid",META_DELETION_HELP_URL:"https://support.example.invalid/privacy",META_DELETION_MAX_REQUEST_AGE_SECONDS:"300",META_DELETION_RECEIPT_RETENTION_DAYS:"1"});
  let admitted=0;
  const service=new MetaDeletionService({receiveMetaDeletionReceipt:async input=>{admitted++;assert.match(input.verificationKeyFingerprint,/^[0-9a-f]{64}$/);return{locator:"a".repeat(64)};},metaDeletionReceiptStatus:async()=>{throw Object.assign(new Error("RAW_CAPABILITY_DETAIL"),{code:"54000"});}},{resolveHmac:async()=>secret});
  class CallbackModule {}Module({controllers:[MetaDeletionCallbackController],providers:[{provide:MetaDeletionService,useValue:service}]})(CallbackModule);
  const adapter=new FastifyAdapter();registerMetaDeletionForm(adapter);const application=await NestFactory.create(CallbackModule,adapter,{logger:false,rawBody:true});
  try{await application.init();await adapter.getInstance().ready();
    const wire=value=>({method:"POST",url:"/webhooks/meta/data-deletion",headers:{"content-type":"application/x-www-form-urlencoded"},payload:new URLSearchParams({signed_request:value}).toString()});
    assert.equal((await adapter.getInstance().inject(wire(signed(payload)))).statusCode,200);assert.equal(admitted,1);
    assert.equal((await adapter.getInstance().inject(wire(signed(payload,"wrong-key-synthetic")))).statusCode,400);assert.equal(admitted,1);
    const denied=await adapter.getInstance().inject({method:"POST",url:"/webhooks/meta/data-deletion/status",payload:{code:"a".repeat(64)}});assert.equal(denied.statusCode,429);assert.equal(denied.headers["retry-after"],"60");assert.doesNotMatch(denied.body,/RAW_CAPABILITY_DETAIL|aaaaaa/);
  }finally{await application.close();for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
});
test("new platform BFF route allowlist composes existing origin and CSRF admission",async()=>{
  const routes=await readFile(new URL("../lib/platform-proxy-routes.ts",import.meta.url),"utf8"),bff=await readFile(new URL("../app/api/platform-console/[...path]/route.ts",import.meta.url),"utf8");
  assert.match(routes,/meta-deletion/);assert.match(routes,/lookup/);assert.match(routes,/review/);
  assert.match(bff,/authenticatePlatformPortalRequest/);assert.match(bff,/allowedPlatformProxyRoute/);
  const {allowedPlatformProxyRoute}=await import("../lib/platform-proxy-routes.ts");
  assert.equal(allowedPlatformProxyRoute("GET","meta-deletion"),true);assert.equal(allowedPlatformProxyRoute("POST","meta-deletion/lookup"),true);assert.equal(allowedPlatformProxyRoute("POST","meta-deletion/10000000-0000-4000-8000-000000000001/review"),true);
  for(const [method,path] of [["DELETE","meta-deletion"],["POST","meta-deletion"],["GET","meta-deletion/lookup"],["POST","meta-deletion/foreign/review"]])assert.equal(allowedPlatformProxyRoute(method,path),false);
  const admission=await readFile(new URL("../lib/platform-request-auth.ts",import.meta.url),"utf8");assert.match(admission,/enforceMutationSecurity\(request, session\.csrfToken, allowedMimeTypes\)/);
});
