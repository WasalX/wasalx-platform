import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from "../services/control-api/node_modules/@nestjs/common/index.js";
import { ZammadGroupWorkspaceController } from "../services/control-api/dist/group-workspace.controller.js";
import { canonicalGroupWorkspaceSubmissionKey, groupWorkspaceOperationKey } from "../services/control-api/dist/group-workspace-operation.js";
import { parseMigrationSql } from "../services/control-api/dist/migrate.js";

const tenantId="10000000-0000-4000-8000-000000000001",instanceId="11000000-0000-4000-8000-000000000001";
const groupId="a3000000-0000-4000-8000-000000000001",messageId="b4000000-0000-4000-8000-000000000001";
const baseClaims={tenantId,instanceId,userId:"77",subject:instanceId,groupIds:["4"],groupAdmin:false};

function fixture(){
  const f={claims:{...baseClaims},access:true,membership:null,receipts:new Map(),outbox:new Map(),media:new Map(),calls:[],wakes:0,placement:"OFF",
    failReceipt:false,failQueue:false,historicalBound:false};
  const query=async(sql,v=[])=>{
    f.calls.push({sql,v});
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("SELECT g.id FROM whatsapp_groups g"))return{rows:f.access?[{id:groupId}]:[]};
    if(sql.includes("FROM native_membership_projections p"))return{rows:f.membership?[f.membership]:[]};
    if(sql.includes("FROM group_workspace_operation_receipts receipt")){
      const rows=sql.includes("lower(receipt.idempotency_key)")?[...f.receipts.values()].filter(row=>row.tenant_id===v[0]
        &&canonicalGroupWorkspaceSubmissionKey(row.kind,row.zammad_user_id,row.idempotency_key)===v[1]):[f.receipts.get(`${v[0]}:${v[1]}`)].filter(Boolean);
      return{rows:rows.slice(0,2).map(row=>({...row,state:[...f.outbox.values()].find(delivery=>delivery.id===row.delivery_id)?.state??null}))};
    }
    if(sql.includes("SELECT id,idempotency_key FROM delivery_outbox")){
      const prefix=v[1].startsWith("group-workspace-reaction:")?"group-workspace-reaction:":"group-workspace:";
      return{rows:[...f.outbox.values()].filter(row=>row.idempotency_key.startsWith(prefix)
        &&canonicalGroupWorkspaceSubmissionKey(row.idempotency_key.startsWith("group-workspace-reaction:")?"REACTION":"SEND",f.claims.userId,row.idempotency_key)===v[1]).slice(0,2)};
    }
    if(sql.includes("FROM delivery_outbox delivery JOIN zammad_instances instance")){
      const row=f.outbox.get(v[1]);return{rows:row?[{...row,bound:f.historicalBound}]:[]};
    }
    if(sql.includes("INSERT INTO group_workspace_operation_receipts")){
      if(f.failReceipt)throw new Error("Injected receipt failure");
      const [tenant_id,zammad_instance_id,zammad_user_id,whatsapp_group_id,kind,idempotency_key,target_message_id,request_sha256,disposition,delivery_id]=v;
      const index=`${tenant_id}:${idempotency_key}`;assert(!f.receipts.has(index));
      f.receipts.set(index,{tenant_id,zammad_instance_id,zammad_user_id,whatsapp_group_id:whatsapp_group_id.toLowerCase(),kind,idempotency_key,target_message_id:target_message_id?.toLowerCase()??null,request_sha256,disposition,delivery_id,created_at:new Date().toISOString()});
      return{rows:[]};
    }
    if(sql.includes("SELECT g.connection_id"))return{rows:[{connection_id:groupId,provider:"WAHA",phone_e164:"12025550120",external_message_id:"external-target",agent_prefix:"Agent:",agent_identity_placement:f.placement}]};
    if(sql.includes("INSERT INTO delivery_outbox")){
      if(f.failQueue)throw new Error("Injected queue failure");
      if(f.outbox.has(v[11]))return{rows:[]};
      const row={id:randomUUID(),idempotency_key:v[11],batch_id:v[15],state:"QUEUED",request_sha256:v[12],message_text:v[8],participant_name:v[13],provider_timestamp:new Date().toISOString(),created_at:new Date().toISOString()};
      f.outbox.set(v[11],row);return{rows:[row]};
    }
    if(sql.includes("FROM delivery_outbox delivery LEFT JOIN delivery_media media")){
      const row=sql.includes("delivery.idempotency_key=$2")?f.outbox.get(v[1]):[...f.outbox.values()].find(row=>row.id===v[1]);
      return{rows:row&&!row.content_redacted_at?[{...row,...f.media.get(row.id)}]:[]};
    }
    if(sql.includes("FROM delivery_outbox root JOIN delivery_outbox delivery")){
      const root=[...f.outbox.values()].find(row=>row.id===v[1]);
      const part=[...f.outbox.values()].find(row=>root?.batch_id&&row.batch_id===root.batch_id&&f.media.has(row.id));
      return{rows:part?[{...part,...f.media.get(part.id)}]:[]};
    }
    if(sql.includes("INSERT INTO delivery_media")){f.media.set(v[1],{media_filename:v[5],media_mime_type:v[6],media_available:false});return{rows:[]};}
    if(sql.includes("INSERT INTO audit_events"))return{rows:[]};
    throw new Error(`Unexpected SQL ${sql}`);
  };
  f.controller=new ZammadGroupWorkspaceController({withTenant:async(scope,fn)=>{
    assert.equal(scope,f.claims.tenantId);
    const before={receipts:structuredClone(f.receipts),outbox:structuredClone(f.outbox),media:structuredClone(f.media)};
    try{return await fn({query});}catch(error){f.receipts=before.receipts;f.outbox=before.outbox;f.media=before.media;throw error;}
  }},{verify:async()=>f.claims},{wake:async()=>{f.wakes++;}});
  f.receipt=(kind,requestId,action="LOOKUP",targetMessageId=kind==="REACTION"?messageId:undefined)=>f.controller.operationReceipt("signed",groupId,{kind,requestId,action,...(targetMessageId?{targetMessageId}:{})});
  f.submit=(kind,requestId,message="Hello")=>kind==="SEND"
    ?f.controller.send("signed",groupWorkspaceOperationKey(kind,f.claims.userId,requestId),groupId,{message,agentDisplayName:"Agent"})
    :f.controller.react("signed",groupWorkspaceOperationKey(kind,f.claims.userId,requestId),groupId,messageId,{emoji:message==="Hello"?"✅":message});
  return f;
}

test("passive misses stay unknown; committed cancellation fences both delayed producers",async()=>{
  for(const kind of ["SEND","REACTION"]){
    const f=fixture(),requestId=randomUUID();
    assert.deepEqual(await f.receipt(kind,requestId),{outcome:"UNKNOWN",terminal:false});assert.equal(f.receipts.size,0);
    assert.deepEqual(await f.receipt(kind,requestId,"CANCEL_IF_UNADMITTED"),{outcome:"NOT_APPLIED",terminal:true});
    assert.deepEqual(await f.receipt(kind,requestId),{outcome:"NOT_APPLIED",terminal:true});
    await assert.rejects(()=>f.submit(kind,requestId),error=>error instanceof ConflictException&&error.getResponse().code==="GROUP_OPERATION_CANCELLED");
    assert.equal(f.outbox.size,0);assert.equal(f.wakes,0);
    assert(f.calls.filter(({sql})=>sql.includes("pg_advisory_xact_lock")).every(({v})=>v[0]===`group-workspace-operation:${tenantId}:${groupWorkspaceOperationKey(kind,"77",requestId)}`));
  }
});

test("admission recovery never claims delivery; exact replay and changed payload share one receipt",async()=>{
  for(const kind of ["SEND","REACTION"]){
    const f=fixture(),requestId=randomUUID(),first=await f.submit(kind,requestId);
    assert.equal(first.duplicate,false);assert.equal(f.receipts.size,1);assert.equal(f.outbox.size,1);
    assert.deepEqual(await f.receipt(kind,requestId),{outcome:"ADMITTED",terminal:true,deliveryId:first.id,state:"QUEUED"});
    assert.equal((await f.submit(kind,requestId)).id,first.id);assert.equal(f.outbox.size,1);
    await assert.rejects(()=>f.submit(kind,requestId,kind==="SEND"?"Changed":"👍"),ConflictException);
    assert.equal((await f.receipt(kind,requestId,"CANCEL_IF_UNADMITTED")).outcome,"ADMITTED");
  }
});

test("queue or receipt failure rolls back both records before any worker wake",async()=>{
  for(const kind of ["SEND","REACTION"])for(const failed of ["failReceipt","failQueue"]){
    const f=fixture(),requestId=randomUUID();f[failed]=true;
    await assert.rejects(()=>f.submit(kind,requestId),/Injected/);
    assert.equal(f.outbox.size,0);assert.equal(f.receipts.size,0);assert.equal(f.wakes,0);
    f[failed]=false;await f.submit(kind,requestId);assert.equal(f.outbox.size,1);
  }
});

test("receipt bindings reject instance, human, group, kind and reaction-target substitution",async()=>{
  for(const [field,value]of [["zammad_instance_id",randomUUID()],["zammad_user_id","88"],["whatsapp_group_id",randomUUID()],["kind","SEND"],["target_message_id",randomUUID()]]){
    const f=fixture(),requestId=randomUUID();await f.submit("REACTION",requestId);
    [...f.receipts.values()][0][field]=value;
    await assert.rejects(()=>f.receipt("REACTION",requestId),ConflictException);
    assert.equal(f.outbox.size,1);
  }
  const f=fixture();
  for(const body of [{kind:"SEND",requestId:randomUUID(),action:"LOOKUP",nativeUserId:"88"},{kind:"SEND",requestId:randomUUID(),targetMessageId:messageId,action:"LOOKUP"},{kind:"REACTION",requestId:randomUUID(),action:"LOOKUP"},{kind:"SEND",requestId:"bad",action:"CANCEL_IF_UNADMITTED"}])
    await assert.rejects(()=>f.controller.operationReceipt("signed",groupId,body),BadRequestException);
});

test("current grant, managed revision and assertion expiry are rechecked after the shared lock",async()=>{
  for(const configure of [f=>{f.access=false;},f=>{f.claims.expiresAt=Math.floor(Date.now()/1000)-1;},f=>{f.membership={allowed:false,revision:4,role:"agent"};f.claims.membershipRevision=4;},f=>{f.membership={allowed:true,revision:5,role:"agent"};f.claims.membershipRevision=4;},f=>{f.claims.membershipRevision=4;}]){
    const f=fixture();configure(f);
    await assert.rejects(()=>f.receipt("SEND",randomUUID(),"CANCEL_IF_UNADMITTED"),error=>error instanceof UnauthorizedException||error instanceof NotFoundException);
    assert(f.calls[0].sql.includes("pg_advisory_xact_lock"));assert.equal(f.receipts.size,0);
  }
  const f=fixture();f.membership={allowed:true,revision:4,role:"agent"};f.claims.membershipRevision=4;
  assert.equal((await f.receipt("SEND",randomUUID())).outcome,"UNKNOWN");
  const membershipSql=f.calls.find(({sql})=>sql.includes("FROM native_membership_projections p")).sql;
  assert.match(membershipSql,/u\.oidc_subject=p\.oidc_subject AND p\.email=u\.email AND settings\.native_membership_sync_enabled/u);
});

test("old unproven roots stay unknown and cannot be cancelled; proven historical roots are adopted",async()=>{
  for(const proven of [false,true]){
    const f=fixture(),requestId=randomUUID();await f.submit("SEND",requestId);f.receipts.clear();f.historicalBound=proven;
    const result=await f.receipt("SEND",requestId,"CANCEL_IF_UNADMITTED");
    assert.equal(result.outcome,proven?"ADMITTED":"UNKNOWN");assert.equal(f.receipts.size,proven?1:0);assert.equal(f.outbox.size,1);
    if(proven)assert.equal((await f.submit("SEND",requestId)).duplicate,true);
    else await assert.rejects(()=>f.submit("SEND",requestId),error=>error instanceof ConflictException&&error.getResponse().code==="GROUP_OPERATION_SCOPE_UNKNOWN");
    assert.equal(f.outbox.size,1);
  }
  const f=fixture(),key="legacy-native-arbitrary-key";
  const first=await f.controller.send("signed",key,groupId,{message:"Legacy",agentDisplayName:"Agent"});
  assert.equal(first.duplicate,false);assert.equal((await f.controller.send("signed",key,groupId,{message:"Legacy",agentDisplayName:"Agent"})).duplicate,true);
  assert.equal(f.receipts.size,1);assert.equal(f.outbox.size,1);
});

test("unproven historical SEND and REACTION collisions stop before queue admission or content replay",async()=>{
  for(const kind of ["SEND","REACTION"]){
    const f=fixture(),requestId=randomUUID();await f.submit(kind,requestId);f.receipts.clear();
    const before=f.calls.length;
    await assert.rejects(()=>f.submit(kind,requestId),error=>error instanceof ConflictException&&error.getResponse().code==="GROUP_OPERATION_SCOPE_UNKNOWN");
    assert(!f.calls.slice(before).some(({sql})=>sql.includes("INSERT INTO delivery_outbox")||sql.includes("delivery.message_body AS message_text")));
    assert.equal((await f.receipt(kind,requestId)).outcome,"UNKNOWN");assert.equal(f.outbox.size,1);assert.equal(f.receipts.size,0);
  }
});

test("content retention preserves the admitted receipt and never manufactures NOT_APPLIED",async()=>{
  const f=fixture(),requestId=randomUUID(),first=await f.submit("SEND",requestId),row=[...f.outbox.values()][0];
  Object.assign(row,{state:"PRIVACY_CANCELLED",content_redacted_at:true,message_text:""});
  assert.deepEqual(await f.receipt("SEND",requestId,"CANCEL_IF_UNADMITTED"),{outcome:"ADMITTED",terminal:true,deliveryId:first.id,state:"PRIVACY_CANCELLED"});
  const before=f.calls.filter(({sql})=>sql.includes("INSERT INTO delivery_outbox")).length;
  assert.equal((await f.submit("SEND",requestId)).duplicate,true);
  assert.equal(f.calls.filter(({sql})=>sql.includes("INSERT INTO delivery_outbox")).length,before);
  assert.equal(f.outbox.size,1);assert.equal(f.receipts.size,1);
});

test("uppercase UUID scope roundtrips while exact opaque request keys remain unchanged",async()=>{
  const f=fixture(),requestId=randomUUID(),key=groupWorkspaceOperationKey("REACTION","77",requestId);
  await f.controller.react("signed",key,groupId.toUpperCase(),messageId.toUpperCase(),{emoji:"✅"});
  assert.equal((await f.controller.react("signed",key,groupId.toUpperCase(),messageId.toUpperCase(),{emoji:"✅"})).duplicate,true);
  assert.equal((await f.controller.operationReceipt("signed",groupId.toUpperCase(),{kind:"REACTION",requestId,targetMessageId:messageId.toUpperCase(),action:"LOOKUP"})).outcome,"ADMITTED");
  assert.equal(f.outbox.size,1);
});

test("native UUID casing shares one key, receipt and cancellation fence in both case orders",async()=>{
  const requestId="abcdefab-0000-4000-8000-000000000001";
  for(const kind of ["SEND","REACTION"])for(const firstUpper of [false,true]){
    const f=fixture(),first=firstUpper?requestId.toUpperCase():requestId,second=firstUpper?requestId:requestId.toUpperCase();
    const prefix=kind==="SEND"?"group-workspace":"group-workspace-reaction";
    const submit=id=>kind==="SEND"?f.controller.send("signed",`${prefix}:77:${id}`,groupId,{message:"Hello",agentDisplayName:"Agent"})
      :f.controller.react("signed",`${prefix}:77:${id}`,groupId,messageId,{emoji:"✅"});
    assert.equal((await f.receipt(kind,first,"CANCEL_IF_UNADMITTED")).outcome,"NOT_APPLIED");
    await assert.rejects(()=>submit(second),error=>error.getResponse().code==="GROUP_OPERATION_CANCELLED");
    assert.equal(f.outbox.size,0);assert.equal(f.receipts.size,1);
    assert(f.calls.filter(({sql})=>sql.includes("pg_advisory_xact_lock")).every(({v})=>v[0]===`group-workspace-operation:${tenantId}:${prefix}:77:${requestId}`));
    const admitted=fixture();
    const firstKey=`${prefix}:77:${first}`,secondKey=`${prefix}:77:${second}`;
    const invoke=key=>kind==="SEND"?admitted.controller.send("signed",key,groupId,{message:"Hello",agentDisplayName:"Agent"})
      :admitted.controller.react("signed",key,groupId,messageId,{emoji:"✅"});
    const original=await invoke(firstKey);assert.equal((await invoke(secondKey)).id,original.id);
    assert.equal((await admitted.receipt(kind,second)).outcome,"ADMITTED");assert.equal(admitted.outbox.size,1);
  }
});

test("a single proven historical UUID case variant is adopted; ambiguous variants never queue or cancel",async()=>{
  const requestId="abcdefab-0000-4000-8000-000000000002";
  for(const kind of ["SEND","REACTION"]){
    const f=fixture(),first=await f.submit(kind,requestId),key=groupWorkspaceOperationKey(kind,"77",requestId);
    const row=f.outbox.get(key);f.outbox.delete(key);f.receipts.clear();
    const upperKey=key.slice(0,-36)+requestId.toUpperCase();row.idempotency_key=upperKey;f.outbox.set(upperKey,row);f.historicalBound=true;
    assert.equal((await f.receipt(kind,requestId)).deliveryId,first.id);
    assert.equal((await f.submit(kind,requestId)).id,first.id);assert.equal(f.outbox.size,1);
    f.outbox.set(key,{...row,id:randomUUID(),idempotency_key:key});
    assert.deepEqual(await f.receipt(kind,requestId,"CANCEL_IF_UNADMITTED"),{outcome:"UNKNOWN",terminal:false});
    await assert.rejects(()=>f.submit(kind,requestId),error=>error.getResponse().code==="GROUP_OPERATION_SCOPE_UNKNOWN");
    assert.equal(f.outbox.size,2);assert.equal(f.receipts.size,1);
  }
});

test("opaque legacy keys preserve case and never enter the native UUID alias lookup",async()=>{
  const f=fixture();
  const first=await f.controller.send("signed","Legacy-Opaque-ABC",groupId,{message:"Hello",agentDisplayName:"Agent"});
  const second=await f.controller.send("signed","legacy-opaque-abc",groupId,{message:"Hello",agentDisplayName:"Agent"});
  assert.notEqual(first.id,second.id);assert.equal(f.outbox.size,2);
  assert(!f.calls.some(({sql})=>sql.includes("SELECT id,idempotency_key FROM delivery_outbox")));
  assert.equal(canonicalGroupWorkspaceSubmissionKey("SEND","77","group-workspace:88:ABCDEFAB-0000-4000-8000-000000000001"),"group-workspace:88:ABCDEFAB-0000-4000-8000-000000000001");
});

test("historic mixed-case receipt fences survive canonicalization; contradictory variants stay unknown",async()=>{
  const f=fixture(),requestId="abcdefab-0000-4000-8000-000000000003",key=groupWorkspaceOperationKey("SEND","77",requestId);
  await f.receipt("SEND",requestId,"CANCEL_IF_UNADMITTED");
  const row=f.receipts.get(`${tenantId}:${key}`);f.receipts.clear();
  const upperKey=key.slice(0,-36)+requestId.toUpperCase();row.idempotency_key=upperKey;f.receipts.set(`${tenantId}:${upperKey}`,row);
  await assert.rejects(()=>f.submit("SEND",requestId),error=>error.getResponse().code==="GROUP_OPERATION_CANCELLED");
  assert.deepEqual(await f.receipt("SEND",requestId),{outcome:"NOT_APPLIED",terminal:true});
  f.receipts.set(`${tenantId}:${key}`,{...row,idempotency_key:key});
  assert.deepEqual(await f.receipt("SEND",requestId),{outcome:"UNKNOWN",terminal:false});
  await assert.rejects(()=>f.submit("SEND",requestId),error=>error.getResponse().code==="GROUP_OPERATION_SCOPE_UNKNOWN");
  assert.equal(f.outbox.size,0);
});

test("historic native alias lookup uses a concurrent expression index covering every origin",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0197_group_workspace_uuid_key_lookup.sql",import.meta.url),"utf8");
  const plan=parseMigrationSql(sql);assert.equal(plan.transactional,false);
  assert.equal(plan.statements[0].indexName,"delivery_outbox_group_workspace_uuid_key_idx");
  assert.equal(plan.statements[1].indexName,"group_workspace_operation_receipts_uuid_key_idx");
  assert.match(sql,/\(tenant_id,lower\(idempotency_key\)\)/u);assert.doesNotMatch(sql,/delivery_origin/u);
});

test("media-only multipart replay preserves its visible media row and stable admission root",async()=>{
  const f=fixture();f.placement="HEADER";
  const requestId=randomUUID(),key=groupWorkspaceOperationKey("SEND","77",requestId),uploadId=randomUUID();
  const body={message:"",agentDisplayName:"Agent",attachments:[{uploadId,storeId:19,filename:"receipt.png",mimeType:"image/png",byteSize:12}]};
  const first=await f.controller.send("signed",key,groupId,body),again=await f.controller.send("signed",key,groupId,body);
  assert.equal(first.id,again.id);assert.equal(first.media_filename,"receipt.png");assert.equal(again.duplicate,true);
  assert.equal(f.outbox.size,2);assert.equal(f.receipts.size,1);
  assert.notEqual((await f.receipt("SEND",requestId)).deliveryId,first.id,"The receipt identifies batch admission, not the display part");
});

test("new receipts are append-only RLS metadata and are registered with the canonical gates",async()=>{
  const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");
  const [sql,unit,e2e,postgres]=await Promise.all([read("services/control-api/migrations/0196_group_workspace_admission_receipts.sql"),read("scripts/test-unit.mjs"),read("tests/application-e2e-harness.test.mjs"),read("scripts/test-postgres-integration.mjs")]);
  assert.match(sql,/FORCE ROW LEVEL SECURITY/u);assert.match(sql,/GRANT SELECT,INSERT/u);assert.match(sql,/REVOKE UPDATE,DELETE,TRUNCATE/u);
  assert.doesNotMatch(sql,/REFERENCES (users|normalized_messages)|REFERENCES delivery_outbox[^\n]*ON DELETE CASCADE/u);
  assert(unit.includes('"tests/application-e2e-harness.test.mjs"'));assert(e2e.includes('import "./group-workspace-receipts.test.mjs"'));
  assert(postgres.includes('await verifyGroupWorkspaceReceipts(quoteAdmin,appUrl)'));
});
