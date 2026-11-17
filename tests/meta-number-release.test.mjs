import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readMetaNumberRelease, releaseMetaNumber } from "../services/control-api/dist/meta-number-release.js";
import { ConnectionsController } from "../services/control-api/dist/connections.controller.js";

const tenantId=randomUUID(),connectionId=randomUUID(),actorId=randomUUID();
const body={routeId:randomUUID(),disconnectOperationId:randomUUID(),phoneNumberId:"12025550172"};
const request={id:"release-request",principal:{tenantId,userId:actorId,role:"tenant_owner",
  authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:["mfa"]}};
function clientFor(work){return {query:async(sql,args)=>sql.includes("privileged_reauth_minutes")
  ? {rows:[{privileged_reauth_minutes:15}]} : work(sql,args)};}

test("explicit number release binds the exact disconnected route and authenticated actor",async()=>{
  const result={id:randomUUID(),released:true,duplicate:false,reconnectRequiresNewConnection:true};
  const client=clientFor(async(sql,args)=>{
    assert.equal(sql,"SELECT app.release_meta_number($1,$2,$3,$4,$5,$6,$7) AS result");
    assert.deepEqual(args,[connectionId,body.routeId,body.disconnectOperationId,body.phoneNumberId,"release-key",actorId,request.id]);
    return {rows:[{result}]};
  });
  assert.deepEqual(await releaseMetaNumber(client,request,connectionId,"release-key",body),result);
});

test("number release rejects malformed and extra client authority before SQL",async()=>{
  const client={query:()=>assert.fail("Invalid release must not query or mutate")};
  for(const invalid of [null,[],{}, {...body,routeId:"not-a-route"},{...body,disconnectOperationId:"x"},
    {...body,phoneNumberId:"invalid-phone-id"},{...body,phoneNumberId:"999999999999999999999999999999999"},
    {...body,routeId:body.routeId+"\n"},{...body,disconnectOperationId:body.disconnectOperationId+"\n"},{...body,tenantId},{...body,force:true},{...body,releaseId:randomUUID()}]){
    await assert.rejects(()=>releaseMetaNumber(client,request,connectionId,"key",invalid),
      error=>error.getStatus()===400 && error.getResponse().code==="META_NUMBER_RELEASE_INVALID");
  }
  await assert.rejects(()=>releaseMetaNumber(client,request,"invalid","key",body),error=>error.getStatus()===400);
});

test("number release requires fresh authoritative MFA before the sealed mutation",async()=>{
  const client=clientFor(()=>assert.fail("No mutation without recent MFA"));
  for(const principal of [{...request.principal,authenticationMethods:[]},
    {...request.principal,authenticatedAt:1}]){
    await assert.rejects(()=>releaseMetaNumber(client,{...request,principal},connectionId,"key",body),
      error=>error.getStatus()===403 && error.getResponse().code==="REAUTHENTICATION_REQUIRED");
  }
});

test("number release maps database denials to stable redacted responses",async()=>{
  for(const [code,status,safeCode] of [["42501",403,"META_NUMBER_RELEASE_FORBIDDEN"],
    ["P0002",404,undefined],["22023",400,"META_NUMBER_RELEASE_INVALID"],
    ...["55000","23505","23514","55P03"].map(code=>[code,409,"META_NUMBER_RELEASE_NOT_READY"])]){
    const client=clientFor(()=>{throw Object.assign(new Error("private database detail / secret-reference"),{code})});
    await assert.rejects(()=>releaseMetaNumber(client,request,connectionId,"key",body),error=>{
      assert.equal(error.getStatus(),status);assert.equal(error.getResponse().code,safeCode);
      assert.doesNotMatch(JSON.stringify(error.getResponse()),/private database|secret-reference/);return true;
    });
  }
  const unexpected=new Error("unexpected failure");
  await assert.rejects(()=>releaseMetaNumber(clientFor(()=>{throw unexpected}),request,connectionId,"key",body),error=>error===unexpected);
});

test("number release readback stays tenant-scoped and never exposes credentials",async()=>{
  const row={routeId:body.routeId,phoneNumberId:body.phoneNumberId,releaseId:null,state:"REVOKED",disconnectOperationId:body.disconnectOperationId};
  assert.deepEqual(await readMetaNumberRelease({query:async(sql,args)=>{
    assert.deepEqual(args,[tenantId,connectionId]);assert.match(sql,/connection\.tenant_id=\$1 AND connection\.id=\$2/);
    assert.doesNotMatch(sql,/secret_reference|access_token/);return {rows:[row]};
  }},tenantId,connectionId),{...row,reconnectRequiresNewConnection:true});
  await assert.rejects(()=>readMetaNumberRelease({query:async()=>({rows:[]})},tenantId,connectionId),error=>error.getStatus()===404);
});

test("release controller requires disconnect permission and idempotency",async()=>{
  const method=ConnectionsController.prototype.releaseMetaNumber;
  assert.equal(Reflect.getMetadata("wasalx:permission",method),"connection:disconnect");
  let calls=0;
  const controller=new ConnectionsController({withTenant:async(tenant,work)=>{
    calls++;assert.equal(tenant,tenantId);return work(clientFor(async()=>({rows:[{result:{released:true}}]})));
  }});
  await assert.rejects(()=>controller.releaseMetaNumber(request,connectionId,undefined,body),error=>error.getStatus()===400);
  assert.equal(calls,0);
  assert.deepEqual(await controller.releaseMetaNumber(request,connectionId,"key",body),{released:true});
  assert.equal(calls,1);
});
