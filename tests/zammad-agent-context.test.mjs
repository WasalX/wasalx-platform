import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from "../services/control-api/node_modules/@nestjs/common/index.js";
import { SignJWT } from "jose";
import { ServiceAuthService } from "../services/control-api/dist/service-auth.service.js";
import { ZammadInternalController } from "../services/control-api/dist/zammad-internal.controller.js";
import { ZammadGroupWorkspaceController } from "../services/control-api/dist/group-workspace.controller.js";
import { ZammadTicketStateController } from "../services/control-api/dist/zammad-ticket-state.controller.js";
import { ZammadServiceSecretService } from "../services/control-api/dist/zammad-service-secret.service.js";
import { executeMigrationSql, parseMigrationSql } from "../services/control-api/dist/migrate.js";

const tenantA = "10000000-0000-4000-8000-000000000001";
const tenantB = "20000000-0000-4000-8000-000000000002";
const instanceA = "11000000-0000-4000-8000-000000000001";
const instanceB = "22000000-0000-4000-8000-000000000002";
const secretA = "zammad-agent-context-secret-a-at-least-32-bytes";
const secretB = "zammad-agent-context-secret-b-at-least-32-bytes";
const referenceA = `secret://tenants/${tenantA}/zammad/service`;
const referenceB = `secret://tenants/${tenantB}/zammad/service`;

async function serviceToken({ tenantId = tenantA, instanceId = instanceA, scope = "zammad:context", signingSecret = secretA, subject = instanceId,
  claims = {}, jti = crypto.randomUUID(), issuedAt, expiresAt } = {}) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ tenant_id: tenantId, instance_id: instanceId, scope, ...claims })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("wasalx-zammad")
    .setAudience("wasalx-control")
    .setSubject(subject)
    .setIssuedAt(issuedAt ?? now)
    .setExpirationTime(expiresAt ?? now + 120)
    .setJti(jti)
    .sign(new TextEncoder().encode(signingSecret));
}

test("Zammad agent assertions bind the exact request and carry a detached exact group set beyond 100 groups",async()=>{
  const groupIds=Array.from({length:101},(_,index)=>String(index+1));
  const groups=deflateSync(JSON.stringify(groupIds),{level:1}).toString("base64url");
  const body=Buffer.from('{"message":"bound request","idempotency_key":"group-workspace:17:request-1"}',"utf8");
  const target="/internal/v1/zammad/group-workspace/groups/12000000-0000-4000-8000-000000000001/send";
  const claims={
    zammad_user_id:"17",zammad_group_ids_sha256:createHash("sha256").update(groups,"utf8").digest("hex"),zammad_group_admin:false,
    http_method:"POST",http_target:target,http_body_sha256:createHash("sha256").update(body).digest("hex"),
  };
  const mutationJti=crypto.randomUUID();
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims,jti:mutationJti})}`;
  const request={method:"POST",url:target,rawBody:body,headers:{"x-wasalx-zammad-groups":groups}};
  const auth=serviceAuth();
  const verified=await auth.verify(authorization,"zammad:groups",request);
  assert(Number.isSafeInteger(verified.expiresAt));
  assert.deepEqual(verified,{
    tenantId:tenantA,instanceId:instanceA,subject:instanceA,userId:"17",groupIds,groupAdmin:false,expiresAt:verified.expiresAt,
  });
  await assert.rejects(()=>auth.verify(authorization,"zammad:groups",request),UnauthorizedException);
  await assert.rejects(()=>auth.verify(authorization,"zammad:groups",{...request,method:"GET"}),UnauthorizedException);
  await assert.rejects(()=>auth.verify(authorization,"zammad:groups",{...request,url:`${target}/other`}),UnauthorizedException);
  await assert.rejects(()=>auth.verify(authorization,"zammad:groups",{...request,
    rawBody:Buffer.from('{"message":"bound request","idempotency_key":"group-workspace:17:request-2"}')}),UnauthorizedException);
  const changedBody=Buffer.from('{"message":"bound request","idempotency_key":"group-workspace:17:request-2"}');
  const changedClaims={...claims,http_body_sha256:createHash("sha256").update(changedBody).digest("hex")};
  const sameJtiChangedRequest=`Bearer ${await serviceToken({scope:"zammad:groups",claims:changedClaims,jti:mutationJti})}`;
  await assert.rejects(()=>auth.verify(sameJtiChangedRequest,"zammad:groups",{...request,rawBody:changedBody}),UnauthorizedException);
  const changedGroups=deflateSync(JSON.stringify([...groupIds,"102"]),{level:1}).toString("base64url");
  await assert.rejects(()=>auth.verify(authorization,"zammad:groups",{...request,headers:{"x-wasalx-zammad-groups":changedGroups}}),UnauthorizedException);

  const retryAuthorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims})}`;
  await auth.verify(retryAuthorization,"zammad:groups",request);

  const sharedJti=crypto.randomUUID();
  const tenantAToken=`Bearer ${await serviceToken({scope:"zammad:groups",claims,jti:sharedJti})}`;
  const tenantBToken=`Bearer ${await serviceToken({tenantId:tenantB,instanceId:instanceB,subject:instanceB,signingSecret:secretB,
    scope:"zammad:groups",claims,jti:sharedJti})}`;
  await auth.verify(tenantAToken,"zammad:groups",request);
  await auth.verify(tenantBToken,"zammad:groups",request);

  const now=Math.floor(Date.now()/1_000);
  const expired=`Bearer ${await serviceToken({scope:"zammad:groups",claims,issuedAt:now-180,expiresAt:now-60})}`;
  await assert.rejects(()=>auth.verify(expired,"zammad:groups",request),UnauthorizedException);

  const readTarget="/internal/v1/zammad/group-workspace/groups?limit=50";
  const readClaims={...claims,http_method:"GET",http_target:readTarget,
    http_body_sha256:createHash("sha256").update(new Uint8Array()).digest("hex")};
  const readAuthorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:readClaims})}`;
  const readRequest={method:"GET",url:readTarget,headers:{"x-wasalx-zammad-groups":groups}};
  await auth.verify(readAuthorization,"zammad:groups",readRequest);
  await auth.verify(readAuthorization,"zammad:groups",readRequest);
});

test("a mutation controller consumes one bound JWT while a fresh-JTI exact retry returns the durable original",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001";
  const key="group-workspace:17:15000000-0000-4000-8000-000000000099";
  const body={message:"Bound once",replyToMessageId:null,agentDisplayName:"Agent One",idempotency_key:key};
  const rawBody=Buffer.from(JSON.stringify(body));
  const target=`/internal/v1/zammad/group-workspace/groups/${groupId}/send`;
  const groups=deflateSync(JSON.stringify(["4"]),{level:1}).toString("base64url");
  const claims={zammad_user_id:"17",zammad_group_ids_sha256:createHash("sha256").update(groups).digest("hex"),zammad_group_admin:false,
    http_method:"POST",http_target:target,http_body_sha256:createHash("sha256").update(rawBody).digest("hex")};
  const request={method:"POST",url:target,rawBody,headers:{"x-wasalx-zammad-groups":groups}};
  const consumed=new Set();let stored;let inserts=0;let audits=0;
  const client={query:async(sql,values=[])=>{
    const admission=groupAdmissionPrerequisite(sql);if(admission)return admission;
    if(sql.includes("SELECT g.connection_id"))return{rows:[{connection_id:groupId,provider:"WAHA",phone_e164:"+12125550100",external_message_id:null,agent_prefix:"Agent:",agent_identity_placement:"OFF"}]};
    if(sql.includes("INSERT INTO delivery_outbox")){
      if(stored)return{rows:[]};
      inserts+=1;stored={id:"14000000-0000-4000-8000-000000000099",state:"QUEUED",request_sha256:values[12],
        message_text:"Bound once",participant_name:"Agent One",provider_timestamp:"2026-08-24T12:00:00.000Z"};
      return{rows:[{id:stored.id,state:stored.state,message_text:stored.message_text,participant_name:stored.participant_name,provider_timestamp:stored.provider_timestamp}]};
    }
    if(sql.includes("delivery.request_sha256")&&sql.includes("FROM delivery_outbox"))return{rows:[stored]};
    if(sql.includes("INSERT INTO audit_events")){audits+=1;return{rows:[]};}
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const database={
    rows:async(tenantId,sql,values=[])=>{
      assert.equal(tenantId,tenantA);
      if(sql.includes("SELECT id,tenant_id,service_secret_reference"))return[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}];
      if(sql.includes("INSERT INTO zammad_service_assertion_jtis")){
        const jti=String(values[2]);if(consumed.has(jti))return[];consumed.add(jti);return[{jti}];
      }
      throw new Error(`Unexpected rows SQL ${sql}`);
    },
    withTenant:async(_tenant,operation)=>operation(client),
  };
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}),{wake:async()=>{}});
  const firstAuthorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims})}`;
  const first=await controller.send(firstAuthorization,key,groupId,body,request);
  await assert.rejects(()=>controller.send(firstAuthorization,key,groupId,body,request),UnauthorizedException);
  const retryAuthorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims})}`;
  const retry=await controller.send(retryAuthorization,key,groupId,body,request);
  assert.equal(first.id,retry.id);assert.equal(first.duplicate,false);assert.equal(retry.duplicate,true);
  assert.equal(inserts,1);assert.equal(audits,1);
});

test("every Ruby-signed Zammad service route forwards its exact request to shared authorization",async()=>{
  const request={method:"POST",url:"/bound",rawBody:Buffer.from("{}"),headers:{}};
  const calls=[];
  const stop=new Error("authorization stop");
  const auth={verify:async(_authorization,scope,received)=>{calls.push([scope,received]);throw stop;}};
  const internal=new ZammadInternalController({},auth,{wake:async()=>{}});
  const ticketState=new ZammadTicketStateController({},auth);
  const attempts=[
    ()=>internal.health("Bearer bound",request),
    ()=>internal.emailRouting("Bearer bound",{},request),
    ()=>internal.ticketContext("Bearer bound","42",request),
    ()=>internal.outbound("Bearer bound",{},request),
    ()=>internal.retry("Bearer bound",{},request),
    ()=>ticketState.ticketState("Bearer bound",undefined,undefined,{},request),
  ];
  for(const attempt of attempts)await assert.rejects(attempt,error=>error===stop);
  assert.deepEqual(calls.map(([scope])=>scope),[
    "zammad:health","zammad:routing","zammad:context","zammad:outbound","zammad:retry","zammad:ticket-state",
  ]);
  assert.ok(calls.every(([,received])=>received===request));
});

test("ticket outbound requires the signed article agent and an independent ticket queue or workspace grant before mutation",async()=>{
  const body={tenant_id:tenantA,connection_id:"12000000-0000-4000-8000-000000000001",group_id:"fixture-0042@example.test",
    ticket_id:42,article_id:9,body:"Authorized update",content_type:"text/plain",idempotency_key:"zammad:42:9",internal:false,
    agent:{id:17,display_name:"Agent One"}};
  let transactions=0;let outbox=0;let audits=0;let wakes=0;
  const client={query:async(sql,values=[])=>{
    if(sql.includes("JOIN group_bindings")){
      assert.match(sql,/group_workspace_grants[\s\S]*subject_type='USER'[\s\S]*subject_type='TEAM'/u);
      assert.match(sql,/reply_case\.tenant_id=b\.tenant_id[\s\S]*reply_case\.group_binding_id=b\.id[\s\S]*reply_case\.zammad_ticket_id=\$7/u);
      assert.match(sql,/END\)=ANY\(\$5::text\[\]\)/u);
      assert.deepEqual(values,[tenantA,body.connection_id,body.group_id,"17",["4"],false,"42"]);
      return{rows:[]};
    }
    if(sql.includes("JOIN group_workspace_settings workspace")){
      assert.match(sql,/group_workspace_grants[\s\S]*subject_external_id=\$4[\s\S]*ANY\(\$5::text\[\]\)/u);
      assert.deepEqual(values,[tenantA,body.connection_id,body.group_id,"17",["4"],false]);
      return{rows:[]};
    }
    if(sql.includes("FROM bot_conversations conversation")){
      assert.match(sql,/NOT EXISTS \(SELECT 1 FROM whatsapp_groups group_record/u);
      return{rows:[]};
    }
    if(sql.includes("INSERT INTO delivery_outbox")){outbox+=1;return{rows:[]};}
    if(sql.includes("INSERT INTO audit_events")){audits+=1;return{rows:[]};}
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const database={
    rows:async(_tenant,sql)=>sql.includes("FROM zammad_instances")?[{id:instanceA}]:[],
    withTenant:async(_tenant,operation)=>{transactions+=1;return operation(client);},
  };
  const controller=new ZammadInternalController(database,serviceAuth(),{wake:async()=>{wakes+=1;}});

  const anonymous=`Bearer ${await serviceToken({scope:"zammad:outbound"})}`;
  await assert.rejects(()=>controller.outbound(anonymous,body),
    error=>error instanceof UnauthorizedException&&error.message==="A Zammad agent identity is required");
  const mismatched=`Bearer ${await serviceToken({scope:"zammad:outbound",claims:{zammad_user_id:"18",zammad_group_ids:["4"]}})}`;
  await assert.rejects(()=>controller.outbound(mismatched,body),
    error=>error instanceof UnauthorizedException&&error.message==="Zammad agent identity does not match the article author");

  const revoked=`Bearer ${await serviceToken({scope:"zammad:outbound",claims:{zammad_user_id:"17",zammad_group_ids:["4"],zammad_group_admin:false}})}`;
  await assert.rejects(()=>controller.outbound(revoked,body),
    error=>error instanceof NotFoundException&&error.message==="WhatsApp destination was not found");
  assert.equal(transactions,1);assert.equal(outbox,0);assert.equal(audits,0);assert.equal(wakes,0);
});

test("all non-group Zammad mutations reject one exact JWT replay and accept a fresh JTI",async()=>{
  const auth=serviceAuth();
  for(const [scope,target] of [
    ["zammad:routing","/internal/v1/zammad/routing"],
    ["zammad:outbound","/internal/v1/zammad/outbound"],
    ["zammad:retry","/internal/v1/zammad/retry"],
    ["zammad:ticket-state","/internal/v1/zammad/ticket-state"],
  ]){
    const rawBody=Buffer.from("{}","utf8");
    const claims={http_method:"POST",http_target:target,http_body_sha256:createHash("sha256").update(rawBody).digest("hex")};
    const request={method:"POST",url:target,rawBody,headers:{}};
    const authorization=`Bearer ${await serviceToken({scope,claims})}`;
    await auth.verify(authorization,scope,request);
    await assert.rejects(()=>auth.verify(authorization,scope,request),UnauthorizedException);
    await auth.verify(`Bearer ${await serviceToken({scope,claims})}`,scope,request);
  }
});

test("large group histories keep exact ticket jumps and mention lookup index-backed",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0102_group_history_lookup_indexes.sql",import.meta.url),"utf8");
  const plan=parseMigrationSql(sql);
  assert.equal(plan.transactional,false);
  assert.equal(plan.statements.length,3);
  assert.equal((sql.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/gu)??[]).length,3);
  assert.match(sql,/message_links \(tenant_id,zammad_ticket_id,created_at,id\)/u);
  assert.match(sql,/message_links \(tenant_id,connection_id,created_at DESC,id DESC\)[\s\S]*INCLUDE \(external_message_id,zammad_ticket_id,zammad_article_id\)/u);
  assert.match(sql,/normalized_messages \([\s\S]*tenant_id,connection_id,external_group_id,external_participant_id,[\s\S]*provider_timestamp DESC,id DESC[\s\S]*WHERE history_captured_at IS NOT NULL AND NOT from_me/u);
});

test("group participant rosters are tenant-bound and capture-scoped",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0125_group_workspace_participants.sql",import.meta.url),"utf8");
  const controller=await readFile(new URL("../services/control-api/src/group-workspace.controller.ts",import.meta.url),"utf8");
  assert.match(sql,/CREATE TABLE group_workspace_participants/u);
  assert.match(sql,/FOREIGN KEY \(tenant_id,whatsapp_group_id\)[\s\S]*REFERENCES whatsapp_groups\(tenant_id,id\) ON DELETE CASCADE/u);
  assert.match(sql,/FORCE ROW LEVEL SECURITY/u);assert.match(sql,/CREATE POLICY tenant_isolation/u);
  assert.match(sql,/external_participant_id~'\^\[1-9\]/u);assert.match(sql,/normalized_phone~'\^\\\+/u);
  assert.equal((controller.match(/group-workspace-consent:/gu)??[]).length,2);
  assert.match(controller,/if\(!enabled\)await client\.query\("DELETE FROM group_workspace_participants WHERE tenant_id=\$1"/u);
  assert.match(controller,/if\(!captureEnabled\)await client\.query\("DELETE FROM group_workspace_participants WHERE tenant_id=\$1 AND whatsapp_group_id=\$2"/u);
});

test("group ticket receipts are tenant-bound, write-once to the app, and do not enable capture",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0107_group_workspace_ticket_receipts.sql",import.meta.url),"utf8");
  assert.doesNotMatch(sql,/ALTER COLUMN group_workspace_enabled SET DEFAULT true/u);
  assert.doesNotMatch(sql,/UPDATE tenant_settings/u);
  assert.match(sql,/CREATE TABLE group_workspace_ticket_receipts/u);
  assert.match(sql,/UNIQUE \(tenant_id,idempotency_key\)/u);
  assert.match(sql,/FOREIGN KEY \(tenant_id,zammad_instance_id\)/u);
  assert.match(sql,/FOREIGN KEY \(tenant_id,whatsapp_group_id\)/u);
  assert.match(sql,/FOREIGN KEY \(tenant_id,normalized_message_id\)/u);
  assert.match(sql,/FOREIGN KEY \(tenant_id,message_link_id\)/u);
  assert.match(sql,/ENABLE ROW LEVEL SECURITY/u);
  assert.match(sql,/FORCE ROW LEVEL SECURITY/u);
  assert.match(sql,/GRANT SELECT,INSERT ON group_workspace_ticket_receipts TO wasalx_app/u);
  assert.match(sql,/REVOKE UPDATE,DELETE,TRUNCATE ON group_workspace_ticket_receipts FROM PUBLIC,wasalx_app/u);
  assert.doesNotMatch(sql,/capture_enabled\s*=\s*true/u);
});

test("mutation assertion replay receipts are tenant-isolated, short-lived, and atomically write-once",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0109_zammad_service_assertion_replay.sql",import.meta.url),"utf8");
  assert.match(sql,/PRIMARY KEY \(tenant_id,jti\)/u);
  assert.match(sql,/FOREIGN KEY \(tenant_id,zammad_instance_id\)[\s\S]*REFERENCES zammad_instances\(tenant_id,id\)/u);
  assert.match(sql,/expires_at <= created_at \+ interval '5 minutes 5 seconds'/u);
  assert.match(sql,/ENABLE ROW LEVEL SECURITY/u);assert.match(sql,/FORCE ROW LEVEL SECURITY/u);
  assert.match(sql,/REVOKE ALL ON zammad_service_assertion_jtis FROM PUBLIC/u);
  assert.match(sql,/GRANT SELECT,INSERT,DELETE ON zammad_service_assertion_jtis TO wasalx_app/u);
  assert.match(sql,/REVOKE UPDATE,TRUNCATE ON zammad_service_assertion_jtis FROM wasalx_app/u);
  const source=await readFile(new URL("../services/control-api/src/service-auth.service.ts",import.meta.url),"utf8");
  assert.match(source,/DELETE FROM zammad_service_assertion_jtis WHERE tenant_id=\$1 AND expires_at<now\(\)-interval '5 seconds'/u);
  assert.match(source,/ON CONFLICT \(tenant_id,jti\) DO NOTHING RETURNING jti/u);
  assert.match(source,/request\.method\?\.toUpperCase\(\)!=="GET"/u);
});

test("non-transactional migrations recover a failed concurrent index before retrying",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0102_group_history_lookup_indexes.sql",import.meta.url),"utf8");
  const indexes=new Map([["message_links_ticket_context_idx",{indisvalid:false,indisready:false}]]);
  const calls=[];
  let fail="message_links_group_timeline_idx";
  const client={query:async(statement,values=[])=>{
    calls.push(statement);
    if(statement.includes("FROM pg_class index_class"))return{rows:indexes.has(values[0])?[indexes.get(values[0])]:[]};
    if(statement.startsWith("DROP INDEX CONCURRENTLY")){indexes.delete(statement.match(/"([^"]+)"$/u)?.[1]);return{rows:[]}}
    const name=statement.match(/CREATE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z0-9_]+)/iu)?.[1];
    if(name){
      if(name===fail){indexes.set(name,{indisvalid:false,indisready:false});fail="";throw new Error("interrupted build")}
      if(!indexes.has(name))indexes.set(name,{indisvalid:true,indisready:true});
    }
    return{rows:[]};
  }};
  await assert.rejects(()=>executeMigrationSql(client,sql),/interrupted build/u);
  await executeMigrationSql(client,sql);
  assert.ok([...indexes.values()].every(index=>index.indisvalid&&index.indisready));
  assert.equal(calls.filter(statement=>statement.startsWith("DROP INDEX CONCURRENTLY")).length,2);
  assert.equal(calls.some(statement=>statement==="BEGIN"||statement==="COMMIT"),false);
  assert.throws(()=>parseMigrationSql("-- wasalx:non-transactional\nDROP TABLE tenants;"),/only one idempotent concurrent index/u);
});

test("re-enabling capture cannot resurface messages or actions from an earlier capture window",async()=>{
  const source=await readFile(new URL("../services/control-api/src/group-workspace.controller.ts",import.meta.url),"utf8");
  assert.match(source,/message\.provider_timestamp>=workspace\.enabled_at/u);
  assert.match(source,/message\.provider_timestamp>=cursor_group\.enabled_at/u);
  assert.match(source,/message\.provider_timestamp>=group_record\.enabled_at/u);
  assert.match(source,/message\.provider_timestamp>=g\.enabled_at/u);
  assert.match(source,/quoted\.provider_timestamp>=workspace\.enabled_at/u);
});

test("a revoke remains terminal when a delayed edit is recorded afterwards",async()=>{
  const source=await readFile(new URL("../services/control-api/src/group-workspace.controller.ts",import.meta.url),"utf8");
  assert.match(source,/const messageRevokedSql=[\s\S]*@> '\[\{"kind":"REVOKED"\}\]'::jsonb/u);
  assert.match(source,/CASE WHEN \$\{GROUP_MESSAGE_REVOKED_SQL\} THEN 'Message deleted'/u);
  assert.match(source,/CASE WHEN \$\{GROUP_MESSAGE_REVOKED_SQL\} THEN 'REVOKED'/u);
  assert.match(source,/AND NOT \(\$\{GROUP_MESSAGE_REVOKED_SQL\}\)\) AS quote_allowed/u);
  assert.match(source,/AND NOT \(\$\{messageRevokedSql\("quoted"\)\}\)/u);
});

test("Zammad group workspace derives access only from a bounded signed agent identity",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001";
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4","9","4"],zammad_group_admin:false}})}`;
  const queries=[];
  const database={rows:async(tenantId,sql,values)=>{assert.equal(tenantId,tenantA);queries.push({sql,values});if(sql.includes("SELECT id,tenant_id,service_secret_reference"))return[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}];if(sql.includes("SELECT EXISTS"))return[{allowed:true}];if(sql.includes("routed_deliveries")||sql.includes("WITH cursor"))return[];if(sql.includes("latest AS"))return[{id:"12025550102@lid",name:"Customer One",phone:"12025550102"}];if(sql.includes("COALESCE(unread.unread_count"))return[{id:groupId,name:"Operations",access_scope:"TEAM",unread_count:2,media_provider:"WAHA"},{id:"12000000-0000-4000-8000-000000000002",name:"Official Operations",access_scope:"ALL",unread_count:0,media_provider:"META"}];return[{id:groupId,name:"Operations",access_scope:"TEAM",unread_count:2}]}};
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}));
  const page=await controller.groups(authorization);
  const groups=page.items;
  assert.equal(page.next_cursor,null);assert.equal(groups[0].access_scope,"TEAM");
  assert.equal(groups[0].media_provider,undefined);assert.equal(groups[1].media_provider,undefined);
  assert.equal(groups[0].media_capabilities.voice_recording,true);assert.equal(groups[1].media_capabilities.voice_recording,false);
  assert.equal(groups[0].media_capabilities.maximum_files,10);assert.equal(groups[0].media_capabilities.maximum_total_bytes,250_000_000);
  assert.deepEqual(groups[0].media_capabilities.accepted.find(item=>item.mime_type==="image/png"),{mime_type:"image/png",maximum_bytes:15_000_000});
  assert.deepEqual(groups[1].media_capabilities.accepted.find(item=>item.mime_type==="image/png"),{mime_type:"image/png",maximum_bytes:5*1024*1024});
  assert.equal(groups[1].media_capabilities.accepted.some(item=>item.mime_type==="audio/webm"),false);
  await controller.messages(authorization,groupId,undefined,"50");
  assert.deepEqual(await controller.participants(authorization,groupId,"Customer"),[{id:"12025550102@lid",name:"Customer One",phone:"12025550102"}]);
  const participants=queries.find(entry=>entry.sql.includes("group_workspace_participants participant"));
  assert.match(participants.sql,/JOIN accessible_group/);assert.match(participants.sql,/UNION ALL/);assert.match(participants.sql,/normalized_phone/);
  await controller.tickets(authorization,groupId);
  const list=queries.find(entry=>entry.sql.includes("COALESCE(unread.unread_count"));
  assert.deepEqual(list.values,[tenantA,"17",["4","9"],instanceA,false,"ALL",null,null,51]);
  assert.match(list.sql,/tenant\.group_workspace_enabled AND workspace\.capture_enabled/);
  assert.match(list.sql,/AS send_available/);assert.match(list.sql,/session\.ownership_state='ACTIVE'/);
  assert.match(list.sql,/connection\.provider AS media_provider/);assert.doesNotMatch(list.sql,/bool_or|count\(DISTINCT message\.id\)/u);
  assert.match(list.sql,/LEFT JOIN LATERAL[\s\S]*count\(\*\)::integer AS unread_count[\s\S]*LIMIT 100/u);
  assert.match(list.sql,/LIMIT \$9/u);
  assert.match(list.sql,/message\.history_captured_at>cursor_record\.read_at/u);
  assert.match(list.sql,/AND NOT message\.from_me AND message\.provider_timestamp>=page\.enabled_at/u);
  assert.match(list.sql,/subject_type='USER'/);assert.match(list.sql,/subject_type='TEAM'/);
  const messages=queries.find(entry=>entry.sql.includes("routed_deliveries"));
  assert.match(messages.sql,/history_captured_at IS NOT NULL/);assert.match(messages.sql,/THEN 'Message deleted'/);assert.match(messages.sql,/quote_allowed/);assert.match(messages.sql,/external_participant_id<>''[\s\S]*AS ticket_creatable/);assert.match(messages.sql,/AS linked_to_ticket/);assert.doesNotMatch(messages.sql,/provider_metadata\s+AS/);
  assert.match(messages.sql,/connection\.phone_e164[\s\S]*AS sender_phone/);
  assert.match(messages.sql,/participant\.normalized_phone[\s\S]*AS sender_phone/);
  assert.doesNotMatch(messages.sql,/sender_identifier/);
  assert.match(messages.sql,/participant\.tenant_id=message\.tenant_id AND participant\.whatsapp_group_id=g\.id/);
  assert.match(messages.sql,/split_part\(message\.external_participant_id,'@',1\)/);
  assert.match(messages.sql,/COALESCE\(sent_delivery\.agent_display_name,message\.participant_name,connection\.name\)/);
  assert.match(messages.sql,/sent_delivery\.external_message_id=message\.external_message_id/);
  assert.match(messages.sql,/sent_delivery\.id AS delivery_id/);
  assert.match(messages.sql,/delivery\.id AS delivery_id/);
  assert.match(messages.sql,/reaction_state\.active_emoji AS reaction_active_emoji/);
  assert.match(messages.sql,/latest\.message_body AS requested_emoji,latest\.state AS delivery_state/);
  assert.match(messages.sql,/applied\.state IN \('SENT','DELIVERED','READ'\)/);
  assert.match(messages.sql,/applied\.reply_to_message_id=message\.external_message_id/);
  assert.match(messages.sql,/delivery\.state<>'QUEUED'[\s\S]*WAITING_FOR_INBOUND/);assert.match(messages.sql,/delivery\.available_at/);
  assert.match(messages.sql,/make_interval\(secs=>policy\.response_window_seconds\)/);
  assert.match(messages.sql,/LEFT JOIN waha_outbound_connection_policies policy/);
  assert.match(messages.sql,/LEFT JOIN group_bindings binding/);
  assert.match(messages.sql,/delivery\.group_workspace_group_id=cursor_group\.id OR binding\.whatsapp_group_id=cursor_group\.id/);
  assert.match(messages.sql,/tenant\.group_workspace_enabled AND workspace\.capture_enabled/);
  assert.match(messages.sql,/delivery\.created_at>=route_group\.enabled_at/);
  assert.match(messages.sql,/message\.provider_timestamp>=g\.enabled_at/);
  assert.match(messages.sql,/JOIN accessible_group route_group/);
  assert.equal((messages.sql.match(/ORDER BY delivery\.created_at DESC,delivery\.id DESC LIMIT \$4/gu)??[]).length,2);
  assert.match(messages.sql,/\(delivery\.created_at,delivery\.id\)<\(SELECT provider_timestamp,id FROM cursor\)/);
  assert.match(messages.sql,/btrim\(delivery\.message_body\)<>'' OR EXISTS \(SELECT 1 FROM delivery_media visible_media/);
  assert.match(messages.sql,/NOT EXISTS \(SELECT 1 FROM normalized_messages echo/);
  assert.match(messages.sql,/echo\.history_captured_at IS NOT NULL/);
  assert.doesNotMatch(messages.sql,/link\.zammad_ticket_id AS|link\.zammad_article_id AS/);
  const tickets=queries.find(entry=>entry.sql.includes("FROM message_links link")&&entry.sql.includes("linked_at"));
  assert.deepEqual(tickets.values,[tenantA,groupId,null,101,"17",["4","9"],false]);assert.match(tickets.sql,/LIMIT \$4/);
  assert.match(tickets.sql,/SELECT DISTINCT ON \(ticket_id\)/);
  assert.match(tickets.sql,/\(latest\.linked_at,latest\.link_id\)<\(SELECT created_at,id FROM cursor\)/);
  assert.match(tickets.sql,/link\.zammad_article_id AS article_id/);assert.match(tickets.sql,/message\.history_captured_at IS NOT NULL/);
  const source=await readFile(new URL("../services/control-api/src/group-workspace.controller.ts",import.meta.url),"utf8");
  assert.ok(source.includes("s\\\\.whatsapp\\\\.net|lid"));
  assert.match(source,/g\.id=\$2/);assert.match(source,/group_workspace_read_cursors\.last_message_id IS NULL/);
  assert.match(source,/\(provider_timestamp,id\)<=\(SELECT provider_timestamp,id FROM selected\)/);
  assert.match(source,/\(message\.provider_timestamp,message\.id\)>\(cursor_message\.provider_timestamp,cursor_message\.id\)/);
  assert.match(source,/AS participant_identity_key/);
  assert.doesNotMatch(source,/SELECT message\.id,message\.external_message_id,message\.external_participant_id/);
  assert.equal((source.match(/THEN 'Message deleted'/gu)??[]).length,3);
  assert.equal((source.match(/WITH accessible_group AS/gu)??[]).length,7);
  assert.equal((source.match(/\$\{groupWorkspaceAccessSql\(/gu)??[]).length,14);
  assert.equal((source.match(/\$\{GROUP_MESSAGE_IDENTITY_KEY_SQL\}/gu)??[]).length,3);
  const claims=await serviceAuth().verify(authorization,"zammad:groups");
  assert(Number.isSafeInteger(claims.expiresAt));
  assert.deepEqual(claims,{tenantId:tenantA,instanceId:instanceA,subject:instanceA,userId:"17",groupIds:["4","9"],groupAdmin:false,expiresAt:claims.expiresAt});
  const invalid=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["bad"]}})}`;
  await assert.rejects(()=>serviceAuth().verify(invalid,"zammad:groups"),UnauthorizedException);
});

test("Zammad group list pages by an authorized cursor and caps per-group unread work",async()=>{
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"],zammad_group_admin:false}})}`;
  const ids=[1,2,3].map(value=>`12000000-0000-4000-8000-${String(value).padStart(12,"0")}`);
  let list;
  const database={rows:async(_tenant,sql,values)=>{
    if(sql.includes("SELECT id,tenant_id,service_secret_reference"))return[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}];
    list={sql,values};
    return ids.map((id,index)=>({id,name:`Group ${index+1}`,access_scope:"TEAM",unread_count:100,media_provider:"WAHA"}));
  }};
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}));
  const page=await controller.groups(authorization,undefined,ids[0],"2","TEAM",ids[2]);
  assert.equal(page.items.length,2);assert.equal(page.next_cursor,ids[1]);
  assert.deepEqual(list.values,[tenantA,"17",["4"],instanceA,false,"TEAM",ids[2],ids[0],3]);
  assert.match(list.sql,/\(name,id\)>\(SELECT name,id FROM cursor\)/u);
  assert.match(list.sql,/\$8::uuid IS NULL OR \$7::uuid IS NULL OR id<>\$7/u);
  const unprioritizedPage=await controller.groups(authorization,undefined,ids[0],"2","TEAM");
  assert.equal(unprioritizedPage.items.length,2);
  assert.deepEqual(list.values,[tenantA,"17",["4"],instanceA,false,"TEAM",null,ids[0],3]);
  assert.ok(list.sql.indexOf("LIMIT $9")<list.sql.indexOf("LIMIT 100"));
  assert.match(list.sql,/paged_groups[\s\S]*LEFT JOIN LATERAL/u);
  await assert.rejects(()=>controller.groups(authorization,undefined,undefined,"101","ALL"),BadRequestException);
  await assert.rejects(()=>controller.groups(authorization,undefined,undefined,"50","OTHER"),BadRequestException);
  await assert.rejects(()=>controller.groups(authorization,undefined,"not-a-cursor","50","ALL"),BadRequestException);
  const proxy=await readFile(new URL("../zammad-package/app/controllers/api/v1/wasalx_controller.rb",import.meta.url),"utf8");
  assert.match(proxy,/def group_workspace_groups[\s\S]*group_workspace_service\.groups\(limit: params\[:limit\], after: params\[:after\]/u);
  const shared=await readFile(new URL("../zammad-package/lib/wasalx/group_workspace.rb",import.meta.url),"utf8");
  assert.match(shared,/def groups[\s\S]*bounded_limit!\(limit\)[\s\S]*uuid!\(after, 'group cursor'\)[\s\S]*%w\[MY TEAM UNASSIGNED ALL\][\s\S]*\.compact\.to_query/u);
});

test("Zammad group message lists and both context halves share tenant-bound roster identity projections",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001";
  const messageId="13000000-0000-4000-8000-000000000001";
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"],zammad_group_admin:false}})}`;
  const queries=[];
  const database={rows:async(tenantId,sql,values)=>{
    assert.equal(tenantId,tenantA);queries.push({sql,values});
    if(sql.includes("SELECT id,tenant_id,service_secret_reference"))return[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}];
    if(sql.includes("SELECT EXISTS"))return[{allowed:true}];
    if(sql.includes("routed_deliveries AS"))return[];
    if(sql.includes("selected AS"))return[{id:messageId}];
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}));
  await controller.messages(authorization,groupId,undefined,"50");
  await controller.context(authorization,groupId,messageId);

  const list=queries.find(entry=>entry.sql.includes("routed_deliveries AS"));
  const context=queries.find(entry=>entry.sql.includes("selected AS"));
  assert.ok(list);assert.ok(context);
  const projectionPattern=/CASE WHEN message\.from_me THEN connection\.phone_e164\s+WHEN participant\.normalized_phone[\s\S]*?END AS sender_phone/gu;
  const listProjections=list.sql.match(projectionPattern)??[];
  const contextProjections=context.sql.match(projectionPattern)??[];
  assert.equal(listProjections.length,1);assert.equal(contextProjections.length,1);
  assert.match(context.sql,/SELECT delivery\.id,delivery\.external_message_id,delivery\.id,delivery\.agent_display_name/);
  for (const sql of [list.sql, context.sql]) assert.equal((sql.match(/COALESCE\(quote_target\.external_id,message\.quoted_external_message_id\) AS quoted_external_message_id,message\.from_me/gu)??[]).length,1);
  const compact=value=>value.replace(/\s+/gu," ").trim();
  assert.deepEqual(contextProjections.map(compact),[compact(listProjections[0])]);

  const projection=listProjections[0];
  assert.match(projection,/participant\.normalized_phone/u);
  assert.match(projection,/connection\.provider='META' AND message\.external_participant_id~'\^\[1-9\]\[0-9\]\{5,14\}\$'/u);
  assert.match(projection,/connection\.provider='WAHA' AND message\.external_participant_id~'\^\[1-9\]\[0-9\]\{5,14\}@\(c\\\.us\|s\\\.whatsapp\\\.net\)\$'/u);
  assert.doesNotMatch(list.sql,/sender_identifier|AS sender_identifier/u);
  assert.match(list.sql,/participant\.tenant_id=message\.tenant_id AND participant\.whatsapp_group_id=g\.id/u);
  assert.match(list.sql,/participant\.external_participant_id=message\.external_participant_id/u);
  assert.match(list.sql,/participant\.display_name[\s\S]*WhatsApp participant/u);
  assert.match(list.sql,/sent_delivery\.content_type<>'application\/vnd\.wasalx\.whatsapp-reaction'/u);
  assert.equal((context.sql.match(/participant\.tenant_id=message\.tenant_id AND participant\.whatsapp_group_id=g\.id/gu)??[]).length,1);
  assert.equal((list.sql.match(/JOIN connections connection ON connection\.tenant_id=g\.tenant_id AND connection\.id=g\.connection_id/gu)??[]).length,2);
  assert.equal((context.sql.match(/JOIN connections connection ON connection\.tenant_id=g\.tenant_id AND connection\.id=g\.connection_id/gu)??[]).length,2);
  assert.deepEqual(list.values,[tenantA,groupId,null,50,"17",["4"],false]);
  assert.deepEqual(context.values,[tenantA,groupId,messageId,"17",["4"],false]);

  const source=await readFile(new URL("../services/control-api/src/group-workspace.controller.ts",import.meta.url),"utf8");
  assert.equal((source.match(/const GROUP_MESSAGE_SENDER_PHONE_SQL=/gu)??[]).length,1);
  assert.equal((source.match(/\$\{GROUP_MESSAGE_SENDER_PHONE_SQL\}/gu)??[]).length,4);
  assert.doesNotMatch(source,/GROUP_MESSAGE_SENDER_IDENTIFIER_SQL/u);

  const safeDigits=/^[1-9][0-9]{5,14}$/u;
  const safeWaha=/^([1-9][0-9]{5,14})@(c\.us|s\.whatsapp\.net)$/u;
  const expectedPhone=({provider,participant,rosterPhone,fromMe=false,connectionPhone="+12025550100"})=>{if(fromMe)return connectionPhone;if(rosterPhone)return rosterPhone;if(provider==="META"&&safeDigits.test(participant))return "+"+participant;const jid=provider==="WAHA"?participant.match(safeWaha):null;return jid?"+"+jid[1]:null;};
  const cases=[[{"provider":"META","participant":"12025550100"},"+12025550100"],[{"provider":"WAHA","participant":"12025550101@c.us"},"+12025550101"],[{"provider":"WAHA","participant":"12025550102@s.whatsapp.net"},"+12025550102"],[{"provider":"WAHA","participant":"synthetic-opaque@lid"},null],[{"provider":"WAHA","participant":"synthetic-opaque@lid","rosterPhone":"+12025550103"},"+12025550103"],[{"provider":"WAHA","participant":"synthetic-group@g.us"},null],[{"provider":"WAHA","participant":"not-a-phone@c.us"},null],[{"provider":"WAHA","participant":"invalid"},null],[{"provider":"META","participant":"invalid"},null],[{"provider":"WAHA","participant":"synthetic-opaque@lid","fromMe":true},"+12025550100"]];
  for(const[input,expected]of cases)assert.equal(expectedPhone(input),expected,JSON.stringify(input));
});

test("group history projects canonical media metadata while revoked and expired objects stay unavailable",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001";
  const messageId="13000000-0000-4000-8000-000000000001";
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"]}})}`;
  const rows=[
    {id:messageId,latest_mutation:null,media_filename:null,media_mime_type:"image/png",media_kind:"image",media_available:true,reaction_active_emoji:"✅",reaction_requested_emoji:"✅",reaction_delivery_state:"SENT"},
    {id:"13000000-0000-4000-8000-000000000002",latest_mutation:null,media_filename:null,media_mime_type:"audio/ogg",media_kind:"audio",media_available:false},
    {id:"13000000-0000-4000-8000-000000000003",latest_mutation:null,media_filename:null,media_mime_type:"application/pdf",media_kind:"document",media_available:true},
    {id:"13000000-0000-4000-8000-000000000004",latest_mutation:"REVOKED",media_filename:"../../private.pdf",media_mime_type:"application/pdf",media_kind:"document",media_available:true},
    {id:"13000000-0000-4000-8000-000000000005",latest_mutation:null,media_filename:"../expired.jpg",media_mime_type:"IMAGE/JPEG; charset=binary",media_kind:"image",media_available:false},
  ];
  const queries=[];
  const database={rows:async(tenantId,sql,values)=>{
    assert.equal(tenantId,tenantA);queries.push({sql,values});
    if(sql.includes("SELECT id,tenant_id,service_secret_reference"))return[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}];
    if(sql.includes("SELECT EXISTS"))return[{allowed:true}];
    if(sql.includes("routed_deliveries AS")||sql.includes("selected AS"))return rows;
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}));
  const listed=await controller.messages(authorization,groupId,undefined,"50");
  const context=await controller.context(authorization,groupId,messageId);
  assert.deepEqual(context,listed);
  assert.deepEqual([listed[0].reaction_active_emoji,listed[0].reaction_requested_emoji,listed[0].reaction_delivery_state],["✅","✅","SENT"]);
  assert.deepEqual(listed.slice(0,3).map(row=>[row.media_filename,row.media_mime_type,row.media_kind,row.media_available]),[
    [null,"image/png","image",true],[null,"audio/ogg","audio",false],[null,"application/pdf","document",true],
  ]);
  assert.deepEqual(listed[3],{...rows[3],media_filename:null,media_mime_type:null,media_kind:null,media_available:false});
  assert.doesNotMatch(listed[4].media_filename,/\.\.|[/\\]/u);assert.equal(listed[4].media_mime_type,"image/jpeg");assert.equal(listed[4].media_available,false);
  const listQuery=queries.find(entry=>entry.sql.includes("routed_deliveries AS"));
  const contextQuery=queries.find(entry=>entry.sql.includes("selected AS"));
  assert.equal((listQuery.sql.match(/LEFT JOIN media_objects media_object/gu)??[]).length,1);
  assert.equal((contextQuery.sql.match(/LEFT JOIN media_objects media_object/gu)??[]).length,1);
  assert.match(listQuery.sql,/media_object\.mime_type/);assert.match(listQuery.sql,/media_object\.expires_at>now\(\)/);
  assert.match(listQuery.sql,/delivery_object\.expires_at>now\(\)/);
});

test("group history media stays hidden when the signed agent loses the group grant",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001";
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"]}})}`;
  let historyQueries=0;
  const database={rows:async(tenantId,sql)=>{
    assert.equal(tenantId,tenantA);
    if(sql.includes("SELECT id,tenant_id,service_secret_reference"))return[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}];
    if(sql.includes("SELECT EXISTS"))return[{allowed:false}];
    historyQueries+=1;return[];
  }};
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}));
  await assert.rejects(()=>controller.messages(authorization,groupId,undefined,"50"),NotFoundException);
  await assert.rejects(()=>controller.media(authorization,groupId,"13000000-0000-4000-8000-000000000001"),NotFoundException);
  assert.equal(historyQueries,0);
});

test("Zammad group reads advance and audit once for the same latest message",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001";
  const messageId="13000000-0000-4000-8000-000000000001";
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"]}})}`;
  let cursorAdvanced=false;let audits=0;const queries=[];
  const client={query:async(sql,values)=>{
    queries.push({sql,values});
    if(sql.includes("SELECT message.id FROM normalized_messages"))return{rows:[{id:messageId}],rowCount:1};
    if(sql.includes("INSERT INTO group_workspace_read_cursors")){
      if(cursorAdvanced)return{rows:[],rowCount:0};
      cursorAdvanced=true;return{rows:[{last_message_id:messageId}],rowCount:1};
    }
    if(sql.includes("INSERT INTO audit_events")){audits+=1;return{rows:[],rowCount:1};}
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const database={
    rows:async(tenantId,sql)=>{assert.equal(tenantId,tenantA);if(sql.includes("SELECT id,tenant_id,service_secret_reference"))return[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}];if(sql.includes("SELECT EXISTS"))return[{allowed:true}];throw new Error(`Unexpected rows SQL ${sql}`)},
    withTenant:async(tenantId,operation)=>{assert.equal(tenantId,tenantA);return operation(client)},
  };
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}),{wake:async()=>{}});
  assert.deepEqual(await controller.markRead(authorization,groupId,{messageId}),{read:true});
  assert.deepEqual(await controller.markRead(authorization,groupId,{messageId}),{read:true});
  assert.equal(audits,1);
  const cursor=queries.find(entry=>entry.sql.includes("INSERT INTO group_workspace_read_cursors"));
  assert.match(cursor.sql,/\(current_message\.provider_timestamp,current_message\.id\)<\(next_message\.provider_timestamp,next_message\.id\)/);
  assert.match(cursor.sql,/RETURNING last_message_id/);
  assert.doesNotMatch(cursor.sql,/<=/);
});

test("Zammad ticket message context returns every bounded captured message in accessible groups",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001";
  const messageId="13000000-0000-4000-8000-000000000001";
  const secondMessageId="13000000-0000-4000-8000-000000000002";
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"]}})}`;
  const queries=[];let allowed=true;
  const database={rows:async(tenantId,sql,values)=>{
    assert.equal(tenantId,tenantA);queries.push({sql,values});
    if(sql.includes("SELECT id,tenant_id,service_secret_reference"))return[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}];
    if(sql.includes("AS group_id"))return allowed?[{group_id:groupId,message_id:messageId,sender_name:"Customer One",sender_phone:"+12025550120",from_me:false},{group_id:groupId,message_id:secondMessageId,sender_name:"Operations line",sender_phone:"+12025550133",from_me:true}]:[];
    if(sql.includes("SELECT EXISTS"))return[{allowed}];
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}));
  assert.deepEqual(await controller.ticketMessageContext(authorization,"42"),{
    group_id:groupId,message_id:messageId,sender_name:"Customer One",sender_phone:"+12025550120",from_me:false,
    items:[{group_id:groupId,message_id:messageId,sender_name:"Customer One",sender_phone:"+12025550120",from_me:false},{group_id:groupId,message_id:secondMessageId,sender_name:"Operations line",sender_phone:"+12025550133",from_me:true}],truncated:false,
  });
  const lookup=queries.find(entry=>entry.sql.includes("AS group_id"));
  assert.deepEqual(lookup.values,[tenantA,"42","17",["4"],false,null]);
  assert.match(lookup.sql,/message\.history_captured_at IS NOT NULL/);
  assert.match(lookup.sql,/tenant\.group_workspace_enabled AND workspace\.capture_enabled/);
  assert.match(lookup.sql,/message\.provider_timestamp>=workspace\.enabled_at/);
  assert.match(lookup.sql,/sent_delivery\.agent_display_name[\s\S]*connection\.name[\s\S]*AS sender_name/);
  assert.match(lookup.sql,/connection\.phone_e164[\s\S]*AS sender_phone/);
  assert.match(lookup.sql,/access_grant\.subject_external_id=\$3/);
  assert.match(lookup.sql,/FROM delivery_outbox delivery/);
  assert.match(lookup.sql,/ORDER BY created_at,link_id LIMIT 101/);
  allowed=false;
  await assert.rejects(()=>controller.ticketMessageContext(authorization,"42"),NotFoundException);
});

test("ticket source context filters exact article mappings without losing the current group grant gates",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001",messageId="13000000-0000-4000-8000-000000000001";
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"]}})}`;
  const queries=[];let visible=true;
  const database={rows:async(tenantId,sql,values)=>{
    assert.equal(tenantId,tenantA);
    if(sql.includes("SELECT id,tenant_id,service_secret_reference"))return[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}];
    if(sql.includes("AS group_id")){queries.push({sql,values});return visible?[{group_id:groupId,message_id:messageId,article_id:"901",sender_name:null,sender_phone:null,from_me:false}]:[];}
    throw new Error("Unexpected query");
  }};
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}));
  const result=await controller.ticketMessageContext(authorization,"42",undefined,"901,902");
  assert.equal(result.items[0].article_id,"901");
  assert.deepEqual(queries[0].values,[tenantA,"42","17",["4"],false,["901","902"]]);
  for(const gate of ["link.zammad_article_id=ANY($6::text[])","delivery.zammad_ticket_id=$2 AND delivery.zammad_article_id=ANY($6::text[])",
    "link.zammad_ticket_id=$2","message.history_captured_at IS NOT NULL","workspace.capture_enabled","access_grant.subject_external_id=$3","delivery.content_redacted_at IS NULL"])
    assert.ok(queries[0].sql.includes(gate),gate);
  for(const invalid of ["", "901,901", "0", "1 OR 1=1",Array.from({length:21},(_,i)=>String(i+1)).join(",")])
    await assert.rejects(()=>controller.ticketMessageContext(authorization,"42",undefined,invalid),BadRequestException);
  visible=false;
  assert.deepEqual((await controller.ticketMessageContext(authorization,"42",undefined,"901")).items,[]);
  await assert.rejects(()=>controller.ticketMessageContext(authorization,"42"),NotFoundException);
});

test("Zammad group workspace links one exact captured message to one ticket article",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001";
  const messageId="13000000-0000-4000-8000-000000000001";
  const linkId="14000000-0000-4000-8000-000000000001";
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"]}})}`;
  const queries=[];const audits=[];let stored;const receipts=new Map();let fromMe=false;
  const client={query:async(sql,values)=>{
    queries.push({sql,values});
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:1};
    if(sql.includes("FROM group_workspace_ticket_receipts")){const receipt=receipts.get(values[1]);return{rows:receipt?[receipt]:[],rowCount:receipt?1:0};}
    if(sql.includes("SELECT message.connection_id"))return{rows:[{connection_id:groupId,external_message_id:"provider-message-1",from_me:fromMe,quoted_external_message_id:null}],rowCount:1};
    if(sql.includes("INSERT INTO message_links")){
      if(stored)return{rows:[],rowCount:0};
      stored={id:linkId,zammad_article_id:"91"};return{rows:[{id:linkId}],rowCount:1};
    }
    if(sql.includes("SELECT id,zammad_article_id FROM message_links"))return{rows:[stored],rowCount:1};
    if(sql.includes("INSERT INTO audit_events")){audits.push(values);return{rows:[],rowCount:1};}
    if(sql.includes("INSERT INTO group_workspace_ticket_receipts")){receipts.set(values[5],{request_sha256:values[6],message_link_id:values[7],zammad_article_id:values[9]});return{rows:[],rowCount:1};}
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const database={
    rows:async(tenantId,sql)=>{assert.equal(tenantId,tenantA);if(sql.includes("SELECT id,tenant_id,service_secret_reference"))return[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}];if(sql.includes("SELECT EXISTS"))return[{allowed:true}];throw new Error(`Unexpected rows SQL ${sql}`)},
    withTenant:async(tenantId,operation)=>{assert.equal(tenantId,tenantA);return operation(client)},
  };
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}),{wake:async()=>{}});
  const key="group-link:42:13000000-0000-4000-8000-000000000001";
  assert.deepEqual(await controller.linkTicket(authorization,key,groupId,messageId,{ticketId:"42",articleId:"91"}),{id:linkId,zammad_article_id:"91",duplicate:false});
  assert.deepEqual(await controller.linkTicket(authorization,key,groupId,messageId,{ticketId:"42",articleId:"91"}),{...stored,duplicate:true});
  assert.equal(audits.length,1);assert.deepEqual(audits[0][3],{message_id:messageId,ticket_id:"42",article_id:"91"});
  assert.equal(queries.filter(entry=>entry.sql.includes("INSERT INTO message_links")).length,1);
  assert.equal(queries.filter(entry=>entry.sql.includes("INSERT INTO group_workspace_ticket_receipts")).length,1);
  const sourceQuery=queries.find(entry=>entry.sql.includes("SELECT message.connection_id"));
  assert.match(sourceQuery.sql,/tenant\.group_workspace_enabled AND workspace\.capture_enabled/);
  assert.match(sourceQuery.sql,/COALESCE\(message\.provider_metadata->'mutations','\[\]'::jsonb\)[\s\S]*@> '\[\{"kind":"REVOKED"\}\]'::jsonb/u);
  assert.match(sourceQuery.sql,/subject_type='USER'/);assert.match(sourceQuery.sql,/FOR SHARE OF message,g,workspace/);
  await assert.rejects(()=>controller.linkTicket(authorization,key,groupId,messageId,{ticketId:"42",articleId:"92"}),ConflictException);
  fromMe=true;
  await assert.rejects(()=>controller.linkTicket(authorization,"group-link:43:13000000-0000-4000-8000-000000000001",groupId,messageId,{ticketId:"43",articleId:"93"}),BadRequestException);
});

test("Zammad group workspace queues an authorized ticketless quote once without auditing message content",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001";
  const messageId="13000000-0000-4000-8000-000000000001";
  const deliveryId="14000000-0000-4000-8000-000000000001";
  const key="group-workspace:17:15000000-0000-4000-8000-000000000001";
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"],zammad_group_admin:false}})}`;
  const queries=[];
  const audits=[];
  let stored;
  const client={query:async(sql,values)=>{
    const admission=groupAdmissionPrerequisite(sql);if(admission)return admission;
    queries.push({sql,values});
    if(sql.includes("SELECT g.connection_id"))return{rows:[{connection_id:groupId,provider:"WAHA",phone_e164:"+12125550100",external_message_id:"provider-message-1",agent_prefix:"Support:",agent_identity_placement:"FOOTER"}],rowCount:1};
    if(sql.includes("SELECT DISTINCT message.external_participant_id"))return{rows:values[2].map(external_participant_id=>({external_participant_id,normalized_phone:external_participant_id.endsWith("@lid")?"+12025550120":null})),rowCount:values[2].length};
    if(sql.includes("INSERT INTO delivery_outbox")){
      if(stored)return{rows:[],rowCount:0};
      stored={id:deliveryId,state:"QUEUED",request_sha256:values[12],message_text:"Shipment is ready.",participant_name:"Agent One",provider_timestamp:"2026-08-20T10:00:00.000Z"};
      return{rows:[{id:stored.id,state:stored.state,message_text:stored.message_text,
        participant_name:stored.participant_name,provider_timestamp:stored.provider_timestamp}],rowCount:1};
    }
    if(sql.includes("delivery.request_sha256")&&sql.includes("FROM delivery_outbox"))return{rows:[stored],rowCount:1};
    if(sql.includes("INSERT INTO audit_events")){audits.push(values);return{rows:[],rowCount:1};}
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const database={
    rows:async(tenantId,sql,values)=>{
      assert.equal(tenantId,tenantA);assert.match(sql,/SELECT id,tenant_id,service_secret_reference/);
      return values[1]===instanceA?[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}]:[];
    },
    withTenant:async(tenantId,operation)=>{assert.equal(tenantId,tenantA);return operation(client)},
  };
  const wakes=[];
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}),{wake:async tenantId=>wakes.push(tenantId)});
  const body={message:"  Shipment is ready.\r\n  ",replyToMessageId:messageId,agentDisplayName:" Agent  One "};
  const projection={sender_phone:"+12125550100",external_message_id:null,from_me:true,latest_mutation:null,quote_allowed:false,ticket_creatable:false,linked_to_ticket:false,source_kind:"DELIVERY",delivery_state:"QUEUED",delivery_hold_reason:null,delivery_next_attempt_at:null,delivery_hold_expires_at:null};
  const first=await controller.send(authorization,key,groupId,body);
  const queued={id:stored.id,state:stored.state,message_text:stored.message_text,
    participant_name:stored.participant_name,provider_timestamp:stored.provider_timestamp};
  assert.deepEqual(first,{...queued,duplicate:false,...projection});
  assert.deepEqual(await controller.send(authorization,key,groupId,body),{...queued,duplicate:true,...projection});
  assert.equal(audits.length,1);assert.equal(JSON.stringify(audits).includes("Shipment is ready"),false);
  assert.deepEqual(audits[0][3],{delivery_id:deliveryId,quoted_message:true,attachment_count:0,mention_count:0});
  assert.deepEqual(wakes,[tenantA,tenantA]);
  const insert=queries.find(entry=>entry.sql.includes("INSERT INTO delivery_outbox"));
  const route=queries.find(entry=>entry.sql.includes("SELECT g.connection_id"));
  assert.match(route.sql,/connection\.tenant_id=g\.tenant_id/);assert.match(route.sql,/connection\.state='WORKING'/);
  assert.match(route.sql,/session\.ownership_state='ACTIVE'/);
  assert.match(route.sql,/FOR SHARE OF g,workspace/);assert.doesNotMatch(route.sql,/FOR SHARE OF [^`]*tenant/);
  assert.match(insert.sql,/delivery_origin/);assert.equal(insert.values[19],"GROUP_WORKSPACE");
  assert.equal(insert.values[21],"FOOTER");
  assert.deepEqual([insert.values[0],insert.values[1],insert.values[3],insert.values[8],insert.values[10],insert.values[11]],[tenantA,groupId,groupId,"Shipment is ready.","provider-message-1",key]);
  await assert.rejects(()=>controller.send(authorization,key,groupId,{...body,message:"Changed"}),ConflictException);
  stored=undefined;
  const unquotedKey="group-workspace:17:15000000-0000-4000-8000-000000000002";
  assert.equal((await controller.send(authorization,unquotedKey,groupId,{message:"General notice",replyToMessageId:null,agentDisplayName:"Agent One"})).duplicate,false);
  assert.equal(queries.filter(entry=>entry.sql.includes("SELECT g.connection_id")).at(-1).values[5],null);
  stored=undefined;
  const mentionKey="group-workspace:17:15000000-0000-4000-8000-000000000003";
  await controller.send(authorization,mentionKey,groupId,{message:"Fixture message @12025550120",agentDisplayName:"Agent One",mentions:["12025550130@lid"]});
  assert.match(queries.find(entry=>entry.sql.includes("group_workspace_participants participant")&&entry.sql.includes("SELECT DISTINCT message.external_participant_id")).sql,/participant\.whatsapp_group_id=\$2/);
  assert.deepEqual(queries.filter(entry=>entry.sql.includes("INSERT INTO delivery_outbox")).at(-1).values[20],["12025550130@lid"]);
  await assert.rejects(()=>controller.send(authorization,"group-workspace:17:15000000-0000-4000-8000-000000000004",groupId,{message:"Please review @123456789012345",agentDisplayName:"Agent One",mentions:["12025550130@lid"]}),BadRequestException);
});

test("Zammad group reactions are tenant-scoped, authorized, audited, and replay-safe",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001";const messageId="13000000-0000-4000-8000-000000000001";
  const deliveryId="14000000-0000-4000-8000-000000000001";const key="group-workspace-reaction:17:15000000-0000-4000-8000-000000000001";
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"]}})}`;
  const queries=[];let stored;let audits=0;let provider="WAHA";
  const client={query:async(sql,values=[])=>{
    const admission=groupAdmissionPrerequisite(sql);if(admission)return admission;
    queries.push({sql,values});
    if(sql.includes("SELECT g.connection_id")&&sql.includes("normalized_messages message"))return{rows:[{connection_id:groupId,external_message_id:"provider-message-1",provider}]};
    if(sql.includes("INSERT INTO delivery_outbox")){
      if(stored)return{rows:[]};
      stored={id:deliveryId,state:"QUEUED",request_sha256:values[12],message_text:values[8],participant_name:null,provider_timestamp:"2026-08-31T10:00:00.000Z"};
      return{rows:[{id:stored.id,state:stored.state,message_text:stored.message_text,participant_name:null,provider_timestamp:stored.provider_timestamp}]};
    }
    if(sql.includes("delivery.request_sha256")&&sql.includes("FROM delivery_outbox"))return{rows:[stored]};
    if(sql.includes("INSERT INTO audit_events")){audits+=1;return{rows:[]};}
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const database={rows:async(_tenant,sql,values)=>sql.includes("service_secret_reference")&&values[1]===instanceA?[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}]:[],withTenant:async(tenant,operation)=>{assert.equal(tenant,tenantA);return operation(client)}};
  const wakes=[];const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}),{wake:async tenant=>wakes.push(tenant)});
  assert.deepEqual(await controller.react(authorization,key,groupId,messageId,{emoji:"✅"}),{id:deliveryId,state:"QUEUED",duplicate:false});
  assert.deepEqual(await controller.react(authorization,key,groupId,messageId,{emoji:"✅"}),{id:deliveryId,state:"QUEUED",duplicate:true});
  assert.equal(audits,1);assert.deepEqual(wakes,[tenantA,tenantA]);
  const route=queries.find(entry=>entry.sql.includes("normalized_messages message"));
  assert.match(route.sql,/message\.tenant_id=\$1 AND message\.id=\$3/);assert.match(route.sql,/groupWorkspace|access_grant/);
  assert.match(route.sql,/connection\.tenant_id=g\.tenant_id/);assert.match(route.sql,/session\.tenant_id=g\.tenant_id/);
  const insert=queries.find(entry=>entry.sql.includes("INSERT INTO delivery_outbox"));
  assert.equal(insert.values[9],"application/vnd.wasalx.whatsapp-reaction");assert.equal(insert.values[10],"provider-message-1");assert.equal(insert.values[8],"✅");
  stored=undefined;
  const removalKey="group-workspace-reaction:17:15000000-0000-4000-8000-000000000003";
  assert.deepEqual(await controller.react(authorization,removalKey,groupId,messageId,{removed:true}),{id:deliveryId,state:"QUEUED",duplicate:false});
  const removalInsert=queries.filter(entry=>entry.sql.includes("INSERT INTO delivery_outbox")).at(-1);
  assert.equal(removalInsert.values[8],"");assert.equal(removalInsert.values[9],"application/vnd.wasalx.whatsapp-reaction");assert.equal(removalInsert.values[10],"provider-message-1");
  assert.equal(queries.filter(entry=>entry.sql.includes("INSERT INTO audit_events")).at(-1).values[2],"group_workspace.reaction_removal_queued");
  await assert.rejects(()=>controller.react(authorization,key,groupId,messageId,{emoji:"not-an-emoji"}),BadRequestException);
  await assert.rejects(()=>controller.react(authorization,"group-workspace-reaction:17:15000000-0000-4000-8000-000000000004",groupId,messageId,{emoji:"✅",removed:true}),BadRequestException);
  await assert.rejects(()=>controller.react(authorization,"group-workspace-reaction:17:15000000-0000-4000-8000-000000000005",groupId,messageId,{removed:"yes"}),BadRequestException);
  const proxy=await readFile(new URL("../zammad-package/app/controllers/api/v1/wasalx_controller.rb",import.meta.url),"utf8");
  assert.match(proxy,/def group_workspace_reaction[\s\S]*group_workspace_service\.reaction/u);
  const shared=await readFile(new URL("../zammad-package/lib/wasalx/group_workspace.rb",import.meta.url),"utf8");
  assert.match(shared,/def reaction[\s\S]*removed = removed_value == true[\s\S]*\{ emoji: emoji, removed: removed,/u);
  provider="META";stored=undefined;
  await assert.rejects(()=>controller.react(authorization,"group-workspace-reaction:17:15000000-0000-4000-8000-000000000002",groupId,messageId,{emoji:"👍"}),BadRequestException);
});

test("Zammad group workspace queues media-only with attribution off without an empty text delivery",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001";const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"],zammad_group_admin:false}})}`;
  const deliveries=[];const media=[];
  const client={query:async(sql,values=[])=>{
    const admission=groupAdmissionPrerequisite(sql);if(admission)return admission;
    if(sql.includes("SELECT g.connection_id"))return{rows:[{connection_id:"12000000-0000-4000-8000-000000000099",provider:"WAHA",phone_e164:"+12125550100",external_message_id:null,agent_prefix:"Agent:",agent_identity_placement:"OFF"}]};
    if(sql.includes("FROM delivery_outbox delivery LEFT JOIN delivery_media"))return{rows:[],rowCount:0};
    if(sql.includes("INSERT INTO delivery_outbox")){deliveries.push(values);return{rows:[{id:`24000000-0000-4000-8000-00000000000${deliveries.length}`,state:"QUEUED",message_text:values[8],participant_name:values[13],provider_timestamp:"2026-08-21T10:00:00.000Z"}]};}
    if(sql.includes("INSERT INTO delivery_media")){media.push(values);return{rows:[]};}
    if(sql.includes("INSERT INTO audit_events"))return{rows:[]};
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const database={rows:async(_tenant,sql,values)=>sql.includes("service_secret_reference")&&values[1]===instanceA?[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}]:[],withTenant:async(_tenant,operation)=>operation(client)};
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}),{wake:async()=>{}});
  const result=await controller.send(authorization,"group-workspace:17:25000000-0000-4000-8000-000000000001",groupId,{message:"",agentDisplayName:"Agent One",attachments:[{upload_id:"26000000-0000-4000-8000-000000000001",store_id:19,filename:"voice.webm",mimeType:"audio/webm",byteSize:12}]});
  assert.equal(result.delivery_state,"QUEUED");assert.equal(deliveries.length,1);assert.equal(media.length,1);
  assert.equal(result.media_filename,"voice.webm");assert.equal(result.media_mime_type,"audio/webm");assert.equal(result.media_available,false);
  assert.equal(media[0][2],null);assert.equal(media[0][3],"26000000-0000-4000-8000-000000000001");assert.equal(media[0][4],19);
  assert.equal(deliveries[0][8],"");assert.equal(deliveries[0][9],"audio/webm");
  assert.deepEqual(deliveries.map(values=>values[13]),["Agent One"]);
  assert.deepEqual(deliveries.map(values=>values[21]),["OFF"]);
});

test("Zammad group workspace rejects provider-incompatible media after authorization and before queueing",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001";
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"],zammad_group_admin:false}})}`;
  let provider="WAHA";let routeLookups=0;let queued=0;let audited=0;
  const client={query:async(sql)=>{
    const admission=groupAdmissionPrerequisite(sql);if(admission)return admission;
    if(sql.includes("SELECT g.connection_id")){routeLookups+=1;return{rows:[{connection_id:"12000000-0000-4000-8000-000000000099",provider,phone_e164:"+12125550100",external_message_id:null,agent_prefix:"Agent:",agent_identity_placement:"OFF"}]};}
    if(sql.includes("INSERT INTO delivery_outbox")){queued+=1;return{rows:[]};}
    if(sql.includes("INSERT INTO audit_events")){audited+=1;return{rows:[]};}
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const database={rows:async(_tenant,sql,values)=>sql.includes("service_secret_reference")&&values[1]===instanceA?[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}]:[],withTenant:async(_tenant,operation)=>operation(client)};
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}),{wake:async()=>{throw new Error("Rejected media must not wake the worker");}});
  const cases=[
    {provider:"META",mimeType:"audio/webm",byteSize:12,filename:"voice.webm"},
    {provider:"META",mimeType:"image/png",byteSize:5*1024*1024+1,filename:"oversized.png"},
    {provider:"WAHA",mimeType:"application/msword",byteSize:12,filename:"legacy.doc"},
    {provider:"WAHA",mimeType:"video/mp4",byteSize:50_000_001,filename:"oversized.mp4"},
  ];
  for(const [index,item] of cases.entries()){
    provider=item.provider;
    await assert.rejects(()=>controller.send(authorization,`group-workspace:17:27000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`,groupId,{message:"",agentDisplayName:"Agent One",attachments:[{upload_id:`28000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`,store_id:19,filename:item.filename,mimeType:item.mimeType,byteSize:item.byteSize}]}),error=>error instanceof BadRequestException&&error.message==="This attachment type or size is unavailable for this group");
  }
  assert.equal(routeLookups,cases.length);assert.equal(queued,0);assert.equal(audited,0);
});

test("Zammad group workspace projects the media row while retaining one header identity delivery",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001";const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"],zammad_group_admin:false}})}`;
  const primaryId="24000000-0000-4000-8000-000000000011",mediaId="24000000-0000-4000-8000-000000000012";
  const deliveries=[];let replay=false;let requestSha256;
  const client={query:async(sql,values=[])=>{
    const admission=groupAdmissionPrerequisite(sql);if(admission)return admission;
    if(sql.includes("SELECT g.connection_id"))return{rows:[{connection_id:"12000000-0000-4000-8000-000000000099",provider:"WAHA",phone_e164:"+12125550100",external_message_id:null,agent_prefix:"Agent:",agent_identity_placement:"HEADER"}]};
    if(sql.includes("INSERT INTO delivery_outbox")){
      if(replay)return{rows:[]};
      requestSha256??=values[12];deliveries.push(values);const id=deliveries.length===1?primaryId:mediaId;
      return{rows:[{id,state:"QUEUED",message_text:values[8],participant_name:values[13],provider_timestamp:"2026-08-21T10:00:00.000Z"}]};
    }
    if(sql.includes("INSERT INTO delivery_media")||sql.includes("INSERT INTO audit_events"))return{rows:[]};
    if(sql.includes("delivery.request_sha256"))return{rows:replay?[{id:primaryId,state:"QUEUED",request_sha256:requestSha256,message_text:"",participant_name:"Agent One",provider_timestamp:"2026-08-21T10:00:00.000Z",media_filename:null,media_mime_type:null,media_available:null}]:[]};
    if(sql.includes("FROM delivery_outbox root JOIN delivery_outbox delivery"))return{rows:[{id:mediaId,state:"QUEUED",message_text:"",participant_name:"Agent One",provider_timestamp:"2026-08-21T10:00:00.001Z",media_filename:"proof.png",media_mime_type:"image/png",media_available:false}]};
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const database={rows:async(_tenant,sql,values)=>sql.includes("service_secret_reference")&&values[1]===instanceA?[{id:instanceA,tenant_id:tenantA,service_secret_reference:referenceA}]:[],withTenant:async(_tenant,operation)=>operation(client)};
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth({database}),{wake:async()=>{}});
  const key="group-workspace:17:25000000-0000-4000-8000-000000000011";
  const body={message:"",agentDisplayName:"Agent One",attachments:[{upload_id:"26000000-0000-4000-8000-000000000011",store_id:19,
    upload_cache_id:"29000000-0000-4000-8000-000000000011",source_store_id:27,filename:"proof.png",mimeType:"image/png",byteSize:12}]};
  const first=await controller.send(authorization,key,groupId,body);
  assert.equal(first.id,mediaId);assert.equal(first.media_filename,"proof.png");assert.equal(first.duplicate,false);
  assert.equal(deliveries.length,2);assert.equal(deliveries[0][8],"");assert.equal(deliveries[0][21],"HEADER");assert.equal(deliveries[1][9],"image/png");
  replay=true;
  const restaged={...body,attachments:[{...body.attachments[0],upload_id:"26000000-0000-4000-8000-000000000012",store_id:20}]};
  const duplicate=await controller.send(authorization,key,groupId,restaged);
  assert.equal(duplicate.id,mediaId);assert.equal(duplicate.media_filename,"proof.png");assert.equal(duplicate.duplicate,true);
  await assert.rejects(()=>controller.send(authorization,key,groupId,{...restaged,attachments:[{...restaged.attachments[0],source_store_id:28}]}),ConflictException);
  assert.equal(deliveries.length,2);
});

test("Zammad group media access is grant-scoped and returns only a short-lived tenant object URL",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001",messageId="13000000-0000-4000-8000-000000000001";
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"],zammad_group_admin:false}})}`;
  let mimeType="Image/PNG; charset=binary",byteSize="12";
  const database={rows:async(_tenant,sql)=>sql.includes("AS allowed")?[{allowed:true}]:[{filename:"../../proof.png",mime_type:mimeType,byte_size:byteSize,object_key:`${tenantA}/sha256/aa/${"a".repeat(64)}`,sha256:"a".repeat(64)}]};
  const signed=[];const controller=new ZammadGroupWorkspaceController(database,serviceAuth(),{wake:async()=>{}},{signedMediaUrl:async(...values)=>{signed.push(values);return"https://media.example/signed"}});
  const result=await controller.media(authorization,groupId,messageId);
  assert.equal(result.url,"https://media.example/signed");assert.equal(result.mime_type,"image/png");assert.equal(result.byte_size,12);assert.equal(result.sha256,"a".repeat(64));
  assert.doesNotMatch(result.filename,/\.\.|[/\\]/u);
  assert.deepEqual(signed[0],[tenantA,`${tenantA}/sha256/aa/${"a".repeat(64)}`,"a".repeat(64),result.filename,"image/png",60]);
  mimeType="text/html";
  await assert.rejects(()=>controller.media(authorization,groupId,messageId),NotFoundException);
  mimeType="image/png";byteSize="15000001";
  await assert.rejects(()=>controller.media(authorization,groupId,messageId),NotFoundException);
  byteSize="not-a-number";
  await assert.rejects(()=>controller.media(authorization,groupId,messageId),NotFoundException);
  assert.equal(signed.length,1);
});

test("Zammad ticket actions receive canonical media state without exposing object storage",async()=>{
  const groupId="12000000-0000-4000-8000-000000000001",messageId="13000000-0000-4000-8000-000000000001";
  const authorization=`Bearer ${await serviceToken({scope:"zammad:groups",claims:{zammad_user_id:"17",zammad_group_ids:["4"],zammad_group_admin:false}})}`;
  let sourceSql="";
  const database={rows:async(_tenant,sql)=>{
    if(sql.includes("AS allowed"))return[{allowed:true}];
    sourceSql=sql;
    return[{id:messageId,group_id:groupId,message_text:null,latest_mutation:null,media_kind:"image",media_filename:"../../proof.png",media_mime_type:"image/png",media_available:true,links:[]}];
  }};
  const controller=new ZammadGroupWorkspaceController(database,serviceAuth(),{wake:async()=>{}});
  const result=await controller.source(authorization,groupId,messageId);
  assert.equal(result.group_id,groupId);assert.equal(result.media_kind,"image");assert.equal(result.media_available,true);
  assert.doesNotMatch(result.media_filename,/\.\.|[/\\]/u);
  assert.match(sourceSql,/media_objects media_object/u);assert.match(sourceSql,/latest_mutation/u);
  assert.match(sourceSql,/GROUP BY[\s\S]*retained_identity\.display_name,[\s\S]*retained_identity\.normalized_phone/u);
  assert.doesNotMatch(JSON.stringify(result),/object_key|secret|signed/u);
});

function serviceAuth({ database, resolveSigningSecret } = {}) {
  const consumedJtis=new Set();
  const authDatabase = database ?? {
    rows: async (tenantId, sql, values) => {
      if(sql.includes("INSERT INTO zammad_service_assertion_jtis")){
        const key=`${tenantId}:${values[2]}`;
        if(consumedJtis.has(key))return[];
        consumedJtis.add(key);return[{jti:values[2]}];
      }
      assert.match(sql, /SELECT id,tenant_id,service_secret_reference FROM zammad_instances/);
      const records = {
        [tenantA]: { id: instanceA, tenant_id: tenantA, service_secret_reference: referenceA },
        [tenantB]: { id: instanceB, tenant_id: tenantB, service_secret_reference: referenceB },
      };
      const record = records[tenantId];
      return record && values[1] === record.id ? [record] : [];
    },
  };
  const resolver = resolveSigningSecret ?? (async (reference, owner) => {
    assert.ok(owner.instanceId === instanceA || owner.instanceId === instanceB);
    assert.equal(owner.tenantId, reference === referenceA ? tenantA : tenantB);
    if (reference === referenceA) return secretA;
    if (reference === referenceB) return secretB;
    throw new Error("unavailable");
  });
  // These existing journeys exercise legacy identities with no managed binding.
  const legacyDatabase = {rows: (tenantId, sql, values) => sql.includes("FROM native_membership_projections") ? Promise.resolve([]) : authDatabase.rows(tenantId, sql, values)};
  return new ServiceAuthService(legacyDatabase, { resolveSigningSecret: resolver });
}

function contextRow(overrides = {}) {
  return {
    ticket_id: "42",
    connection_id: "12000000-0000-4000-8000-000000000001",
    provider: "WAHA",
    connection_state: "WORKING",
    binding_state: "ACTIVE",
    group_name: "Riyadh\u0000 Operations",
    correlation_state: "OPEN",
    last_heartbeat_at: "2026-08-09T20:00:00.000Z",
    last_provider_event_at: new Date("2026-08-09T20:01:00.000Z"),
    delivery_id: "30000000-0000-4000-8000-000000000003",
    zammad_article_id: "9",
    delivery_state: "DELIVERED",
    delivery_updated_at: "2026-08-09T20:02:00.000Z",
    manual_retry_allowed: false,
    ...overrides,
  };
}

test("Zammad ticket context is service-authenticated, tenant-scoped, minimal, and sanitized", async () => {
  const queries = [];
  const database = {
    rows: async (tenantId, sql, values) => {
      assert.equal(tenantId, tenantA);
      assert.deepEqual(values, [tenantA, instanceA]);
      assert.match(sql, /FROM zammad_instances/);
      return [{ id: instanceA }];
    },
    withTenant: async (tenantId, operation) => {
      assert.equal(tenantId, tenantA);
      return operation({
        query: async (sql, values) => {
          queries.push({ sql, values });
          assert.deepEqual(values, [tenantA, "42"]);
          return { rows: [contextRow({ provider: "META" })], rowCount: 1 };
        },
      });
    },
  };
  const controller = new ZammadInternalController(database, serviceAuth(), { wake: async () => {} });
  const result = await controller.ticketContext(`Bearer ${await serviceToken()}`, "42");

  assert.deepEqual(result, {
    ticket_id: "42",
    connection_id: "12000000-0000-4000-8000-000000000001",
    provider: "META",
    connection_state: "WORKING",
    binding_state: "ACTIVE",
    group_name: "Riyadh Operations",
    correlation_state: "OPEN",
    bot_state: null,
    last_heartbeat_at: "2026-08-09T20:00:00.000Z",
    last_provider_event_at: "2026-08-09T20:01:00.000Z",
    service_window_expires_at: null,
    delivery_id: "30000000-0000-4000-8000-000000000003",
    zammad_article_id: "9",
    delivery_state: "DELIVERED",
    delivery_updated_at: "2026-08-09T20:02:00.000Z",
    delivery_retry_allowed: false,
    delivery_retry_requires_confirmation: false,
  });
  const query = queries[0].sql;
  assert.match(query, /correlation\.tenant_id=\$1 AND correlation\.zammad_ticket_id=\$2/);
  for (const alias of ["binding", "group_record", "connection", "delivery"]) {
    assert.match(query, new RegExp(`${alias}\\.tenant_id=\\$1`));
  }
  assert.match(query, /delivery\.zammad_article_id ~ '\^\[1-9\]\[0-9\]\*\$'/);
  assert.match(query, /latest_delivery\.manual_retry_allowed/);
  assert.doesNotMatch(query, /message_body|payload|secret_reference|phone_e164/i);
  assert.doesNotMatch(JSON.stringify(result), /message_body|payload|secret|phone/i);
});

test("direct ticket context returns the tenant's provider window expiry", async () => {
  const now = Date.parse("2026-08-10T20:00:00.000Z");
  const tickets = new Map([
    [tenantA, new Map([
      ["42", contextRow({ provider: "META", last_customer_message_at: new Date("2026-08-10T19:00:00.000Z") })],
      ["43", contextRow({ provider: "META", last_customer_message_at: null })],
      ["44", contextRow({ provider: "WAHA", last_customer_message_at: new Date(now) })],
    ])],
    [tenantB, new Map([
      ["42", contextRow({ provider: "META", last_customer_message_at: "2026-08-08T22:00:00+02:00" })],
      ["43", contextRow({ provider: "META", last_customer_message_at: new Date(NaN) })],
    ])],
  ]);
  const database = {
    rows: async (tenantId, _sql, [boundTenant, instanceId]) => {
      assert.equal(boundTenant, tenantId);
      assert.equal(instanceId, tenantId === tenantA ? instanceA : instanceB);
      return [{ id: instanceId }];
    },
    withTenant: async (tenantId, operation) => operation({ query: async (sql, [boundTenant, ticketId]) => {
      assert.equal(boundTenant, tenantId);
      if (!sql.includes("FROM bot_conversations conversation")) return { rows: [] };
      assert.match(sql, /conversation\.tenant_id=\$1 AND conversation\.zammad_ticket_id=\$2/);
      assert.match(sql, /message\.tenant_id=conversation\.tenant_id AND message\.connection_id=conversation\.connection_id/);
      assert.match(sql, /ownership\.tenant_id=conversation\.tenant_id AND ownership\.connection_id=conversation\.connection_id/);
      return { rows: [tickets.get(tenantId).get(ticketId)] };
    } }),
  };
  const controller = new ZammadInternalController(database, serviceAuth(), { wake: async () => assert.fail("context cannot wake workers") });
  const authorizationA = `Bearer ${await serviceToken()}`;
  const authorizationB = `Bearer ${await serviceToken({ tenantId: tenantB, instanceId: instanceB, signingSecret: secretB })}`;
  const open = await controller.ticketContext(authorizationA, "42");
  const closed = await controller.ticketContext(authorizationB, "42");
  assert.equal(open.service_window_expires_at, "2026-08-11T19:00:00.000Z");
  assert.equal(closed.service_window_expires_at, "2026-08-09T20:00:00.000Z");
  assert(Date.parse(open.service_window_expires_at) > now);
  assert(Date.parse(closed.service_window_expires_at) < now);
  assert.equal((await controller.ticketContext(authorizationA, "43")).service_window_expires_at, null);
  assert.equal((await controller.ticketContext(authorizationA, "44")).service_window_expires_at, null);
  assert.equal((await controller.ticketContext(authorizationB, "43")).service_window_expires_at, null);
});

test("ticket context derives tenant and instance only from the signed service identity", async () => {
  const observed = [];
  const database = {
    rows: async (tenantId, _sql, values) => {
      observed.push(["instance", tenantId, values]);
      return [{ id: instanceB }];
    },
    withTenant: async (tenantId, operation) => {
      observed.push(["tenant", tenantId]);
      return operation({ query: async (_sql, values) => ({ rows: [contextRow({ connection_id: "22000000-0000-4000-8000-000000000002" })], values }) });
    },
  };
  const controller = new ZammadInternalController(database, serviceAuth(), { wake: async () => {} });
  const result = await controller.ticketContext(
    `Bearer ${await serviceToken({ tenantId: tenantB, instanceId: instanceB, signingSecret: secretB })}`,
    "42",
  );
  assert.equal(result.connection_id, "22000000-0000-4000-8000-000000000002");
  assert.deepEqual(observed, [
    ["instance", tenantB, [tenantB, instanceB]],
    ["tenant", tenantB],
  ]);
});

test("ticket context resolves a group-workspace ticket without an automation correlation",async()=>{
  const queries=[];
  const database={
    rows:async()=>[{id:instanceA}],
    withTenant:async(_tenantId,operation)=>operation({query:async(sql)=>{
      queries.push(sql);
      if(sql.includes("WITH selected_correlation"))return{rows:[],rowCount:0};
      if(sql.includes("FROM message_links link"))return{rows:[contextRow({binding_state:"ACTIVE",group_name:"Workspace Operations"})],rowCount:1};
      throw new Error(`Unexpected SQL ${sql}`);
    }}),
  };
  const controller=new ZammadInternalController(database,serviceAuth(),{wake:async()=>{}});
  const result=await controller.ticketContext(`Bearer ${await serviceToken()}`,"42");
  assert.equal(result.group_name,"Workspace Operations");assert.equal(result.binding_state,"ACTIVE");
  assert.equal(result.service_window_expires_at,null);
  const workspace=queries.find(sql=>sql.includes("FROM message_links link"));
  assert.match(workspace,/message\.history_captured_at IS NOT NULL/);assert.match(workspace,/tenant\.group_workspace_enabled AND workspace\.capture_enabled/);
});

test("ticket context fails closed for wrong scope, malformed IDs, inactive instances, and missing correlations", async () => {
  let databaseTouched = false;
  const untouchedDatabase = {
    rows: async () => {
      databaseTouched = true;
      return [];
    },
  };
  const wrongScope = new ZammadInternalController(untouchedDatabase, serviceAuth(), { wake: async () => {} });
  const wrongScopeAuthorization = `Bearer ${await serviceToken({ scope: "zammad:outbound" })}`;
  await assert.rejects(
    () => wrongScope.ticketContext(wrongScopeAuthorization, "42"),
    UnauthorizedException,
  );
  assert.equal(databaseTouched, false);

  const inactive = new ZammadInternalController({ rows: async () => [] }, serviceAuth(), { wake: async () => {} });
  const contextAuthorization = `Bearer ${await serviceToken()}`;
  await assert.rejects(
    () => inactive.ticketContext(contextAuthorization, "42"),
    UnauthorizedException,
  );

  let tenantQuery = false;
  const activeDatabase = {
    rows: async () => [{ id: instanceA }],
    withTenant: async (_tenantId, operation) => {
      tenantQuery = true;
      return operation({ query: async () => ({ rows: [], rowCount: 0 }) });
    },
  };
  const active = new ZammadInternalController(activeDatabase, serviceAuth(), { wake: async () => {} });
  await assert.rejects(
    () => active.ticketContext(contextAuthorization, "42-not-valid"),
    BadRequestException,
  );
  assert.equal(tenantQuery, false);
  await assert.rejects(
    () => active.ticketContext(contextAuthorization, "42"),
    NotFoundException,
  );

  const invalidStateDatabase = {
    rows: async () => [{ id: instanceA }],
    withTenant: async (_tenantId, operation) => operation({
      query: async () => ({ rows: [contextRow({ delivery_state: "PROVIDER_UNKNOWN_STATE" })] }),
    }),
  };
  const invalidState = new ZammadInternalController(
    invalidStateDatabase,
    serviceAuth(),
    { wake: async () => {} },
  );
  await assert.rejects(
    () => invalidState.ticketContext(contextAuthorization, "42"),
    /Stored WasalX delivery state is invalid/,
  );
});

test("Zammad retry is instance-scoped, audited, and idempotent", async () => {
  const deliveryId = "30000000-0000-4000-8000-000000000003";
  const audit = [];
  const wakes = [];
  let deliveryState = "FAILED_RETRYABLE";
  const client = {
    query: async (sql, values) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT execution.id FROM ticket_event_executions execution"))return{rows:[],rowCount:0};
      if (sql.includes("FROM audit_events")) return { rows: audit, rowCount: audit.length };
      if (sql.includes("SELECT delivery.id,delivery.state,delivery.manual_retry_allowed")) {
        assert.match(sql,/group_workspace_grants[\s\S]*subject_type='USER'[\s\S]*subject_type='TEAM'/u);
        assert.deepEqual(values, [tenantA, deliveryId, "42", "9", "77", ["4"], false]);
        return { rows: [{ id: deliveryId, state: deliveryState, manual_retry_allowed: false, safe_error: "Provider outcome is unknown." }], rowCount: 1 };
      }
      if (sql.includes("FROM group_disclosure_deliveries")) return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE delivery_outbox")) {
        deliveryState = "QUEUED";
        return { rows: [{ id: deliveryId, state: deliveryState }], rowCount: 1 };
      }
      if (sql.includes("UPDATE group_disclosure_deliveries")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO audit_events")) {
        assert.equal(values[1], `${instanceA}:77`);
        assert.equal(values[2], deliveryId);
        assert.equal(values[4].zammad_instance_id, instanceA);
        assert.equal("unknown_outcome_confirmed" in values[4], false);
        audit.push({ target_id: deliveryId, new_value: values[4] });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const database = {
    rows: async () => [{ id: instanceA }],
    withTenant: async (tenantId, operation) => {
      assert.equal(tenantId, tenantA);
      return operation(client);
    },
  };
  const controller = new ZammadInternalController(database, serviceAuth(), { wake: async (tenantId) => wakes.push(tenantId) });
  const authorization = `Bearer ${await serviceToken({ scope: "zammad:retry",
    claims: { zammad_user_id: "77", zammad_group_ids: ["4"], zammad_group_admin: false } })}`;
  const body = {
    tenant_id: tenantA,
    instance_id: instanceA,
    ticket_id: 42,
    article_id: 9,
    delivery_id: deliveryId,
    actor_id: 77,
    idempotency_key: "retry:42:9:delivery:request",
  };
  assert.deepEqual(await controller.retry(authorization, body), { id: deliveryId, state: "QUEUED", duplicate: false });
  assert.deepEqual(await controller.retry(authorization, body), { id: deliveryId, state: "QUEUED", duplicate: true });
  assert.deepEqual(wakes, [tenantA]);
  assert.equal(audit.length, 1);

  await assert.rejects(
    () => controller.retry(authorization, { ...body, actor_id: 78 }),
    error=>error instanceof UnauthorizedException&&error.message==="Zammad agent identity does not match the retry requester",
  );

  await assert.rejects(
    () => controller.retry(authorization, { ...body, instance_id: instanceB, idempotency_key: "another-key" }),
    UnauthorizedException,
  );
});

test("Zammad group retry requires the signed current agent grant before receipts or mutation",async()=>{
  const deliveryId="30000000-0000-4000-8000-000000000003";
  const body={tenant_id:tenantA,instance_id:instanceA,ticket_id:42,article_id:9,delivery_id:deliveryId,
    actor_id:77,idempotency_key:"retry:revoked-agent",confirm_outcome_unknown:false};
  let transactions=0;let receiptReads=0;let outboxMutations=0;let audits=0;let wakes=0;
  const client={query:async(sql,values=[])=>{
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:1};
    if(sql.includes("SELECT delivery.id,delivery.state,delivery.manual_retry_allowed")){
      assert.match(sql,/group_workspace_grants[\s\S]*subject_external_id=\$5[\s\S]*ANY\(\$6::text\[\]\)/u);
      assert.deepEqual(values,[tenantA,deliveryId,"42","9","77",["4"],false]);
      return{rows:[],rowCount:0};
    }
    if(sql.includes("FROM audit_events")){receiptReads+=1;return{rows:[],rowCount:0};}
    if(sql.includes("UPDATE delivery_outbox")){outboxMutations+=1;return{rows:[],rowCount:0};}
    if(sql.includes("INSERT INTO audit_events")){audits+=1;return{rows:[],rowCount:0};}
    throw new Error(`Unexpected SQL: ${sql}`);
  }};
  const database={
    rows:async()=>[{id:instanceA}],
    withTenant:async(_tenantId,operation)=>{transactions+=1;return operation(client);},
  };
  const controller=new ZammadInternalController(database,serviceAuth(),{wake:async()=>{wakes+=1;}});

  const anonymous=`Bearer ${await serviceToken({scope:"zammad:retry"})}`;
  await assert.rejects(()=>controller.retry(anonymous,body),
    error=>error instanceof UnauthorizedException&&error.message==="A Zammad agent identity is required");
  const mismatched=`Bearer ${await serviceToken({scope:"zammad:retry",claims:{zammad_user_id:"78",zammad_group_ids:["4"]}})}`;
  await assert.rejects(()=>controller.retry(mismatched,body),
    error=>error instanceof UnauthorizedException&&error.message==="Zammad agent identity does not match the retry requester");
  const revoked=`Bearer ${await serviceToken({scope:"zammad:retry",claims:{zammad_user_id:"77",zammad_group_ids:["4"],zammad_group_admin:false}})}`;
  await assert.rejects(()=>controller.retry(revoked,body),
    error=>error instanceof NotFoundException&&error.message==="Retryable delivery was not found");
  assert.equal(transactions,1);assert.equal(receiptReads,0);assert.equal(outboxMutations,0);assert.equal(audits,0);assert.equal(wakes,0);
});

test("Zammad retry leaves an unknown provider outcome in operator review", async () => {
  const deliveryId = "30000000-0000-4000-8000-000000000003";
  const client = { query: async (sql) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM audit_events")||sql.includes("SELECT execution.id FROM ticket_event_executions execution")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT delivery.id,delivery.state,delivery.manual_retry_allowed")) return { rows: [{ id: deliveryId, state: "OUTCOME_UNKNOWN", manual_retry_allowed: false, safe_error: null }], rowCount: 1 };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const controller = new ZammadInternalController(
    { rows: async () => [{ id: instanceA }], withTenant: async (_tenantId, operation) => operation(client) },
    serviceAuth(),
    { wake: async () => { throw new Error("must not wake") } },
  );
  const authorization = `Bearer ${await serviceToken({ scope: "zammad:retry",
    claims: { zammad_user_id: "77", zammad_group_ids: ["4"], zammad_group_admin: false } })}`;
  await assert.rejects(() => controller.retry(authorization, {
    tenant_id: tenantA, instance_id: instanceA, ticket_id: 42, article_id: 9,
    delivery_id: deliveryId, actor_id: 77, idempotency_key: "unconfirmed-retry",
  }), error=>error instanceof NotFoundException&&error.message==="Retryable delivery was not found");
});

test("Zammad refuses to retry a bot reply after human handoff", async () => {
  const deliveryId = "30000000-0000-4000-8000-000000000013";
  const conversationId = "40000000-0000-4000-8000-000000000013";
  const client = { query: async (sql,values=[]) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM audit_events")||sql.includes("SELECT execution.id FROM ticket_event_executions execution")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT delivery.id,delivery.state,delivery.manual_retry_allowed")) return { rows: [{ id: deliveryId, state: "FAILED_TERMINAL", manual_retry_allowed: true, safe_error: "Failed", bot_conversation_id: conversationId, direct_origin: "BOT" }], rowCount: 1 };
    if(sql.includes("version.definition->'keepOpenPolicy' AS keep_open_policy")){
      assert.deepEqual(values,[tenantA,conversationId,deliveryId]);
      assert.match(sql,/delivery\.bot_conversation_id=conversation\.id/u);
      return{rows:[{state:'HUMAN',resolution_kind:null,human_ownership_epoch:1,fencing_token:4,human_pause_started_at:null,
        customer_control:null,keep_open_policy:null,direct_origin:'BOT',direct_ownership_epoch:null,bot_content:null,content_redacted_at:null}],rowCount:1};
    }
    if (sql.includes("SELECT state,resolution_kind FROM bot_conversations")) return { rows: [{ state: "HUMAN", resolution_kind: null }], rowCount: 1 };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const controller = new ZammadInternalController(
    { rows: async () => [{ id: instanceA }], withTenant: async (_tenantId, operation) => operation(client) },
    serviceAuth(),
    { wake: async () => { throw new Error("must not wake") } },
  );
  const authorization = `Bearer ${await serviceToken({ scope: "zammad:retry",
    claims: { zammad_user_id: "77", zammad_group_ids: ["4"], zammad_group_admin: false } })}`;
  await assert.rejects(() => controller.retry(authorization, {
    tenant_id: tenantA, instance_id: instanceA, ticket_id: 42, article_id: 9,
    delivery_id: deliveryId, actor_id: 77, idempotency_key: "human-owned-bot-retry",
  }), /cannot be retried while a person owns/);
});

test("Zammad retry preserves newer-disclosure fencing", async () => {
  const deliveryId = "30000000-0000-4000-8000-000000000003";
  const client = { query: async (sql) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM audit_events")||sql.includes("SELECT execution.id FROM ticket_event_executions execution")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT delivery.id,delivery.state,delivery.manual_retry_allowed")) return { rows: [{ id: deliveryId, state: "FAILED_RETRYABLE", manual_retry_allowed: false, safe_error: null }], rowCount: 1 };
    if (sql.includes("FROM group_disclosure_deliveries") && sql.includes("FOR UPDATE")) return { rows: [{ group_binding_id: "binding-1", disclosure_sha256: "a".repeat(64) }], rowCount: 1 };
    if (sql.includes("FROM group_bindings")) return { rows: [{ id: "binding-1" }], rowCount: 1 };
    if (sql.includes("delivery_id<>")) return { rows: [{ exists: 1 }], rowCount: 1 };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const controller = new ZammadInternalController(
    { rows: async () => [{ id: instanceA }], withTenant: async (_tenantId, operation) => operation(client) },
    serviceAuth(),
    { wake: async () => { throw new Error("must not wake") } },
  );
  const authorization = `Bearer ${await serviceToken({ scope: "zammad:retry",
    claims: { zammad_user_id: "77", zammad_group_ids: ["4"], zammad_group_admin: false } })}`;
  await assert.rejects(() => controller.retry(authorization, {
    tenant_id: tenantA, instance_id: instanceA, ticket_id: 42, article_id: 9,
    delivery_id: deliveryId, actor_id: 77, idempotency_key: "fenced-disclosure-retry",
  }), /newer delivery already carries/);
});

test("per-instance signing keys reject cross-tenant forgery before ticket data is touched", async () => {
  const resolvedReferences = [];
  const authQueries = [];
  const instances = new Map([
    [`${tenantA}:${instanceA}`, { id: instanceA, tenant_id: tenantA, service_secret_reference: referenceA }],
    [`${tenantB}:${instanceB}`, { id: instanceB, tenant_id: tenantB, service_secret_reference: referenceB }],
  ]);
  const authDatabase = {
    rows: async (tenantId, sql, values) => {
      authQueries.push({ tenantId, sql, values });
      assert.equal(tenantId, values[0]);
      assert.match(sql, /tenant_id=\$1 AND id=\$2 AND state='WORKING'/);
      const row = instances.get(`${values[0]}:${values[1]}`);
      return row ? [row] : [];
    },
  };
  const auth = serviceAuth({
    database: authDatabase,
    resolveSigningSecret: async (reference, owner) => {
      resolvedReferences.push(reference);
      assert.deepEqual(owner, reference === referenceA ? { tenantId: tenantA, instanceId: instanceA } : { tenantId: tenantB, instanceId: instanceB });
      if (reference === referenceA) return secretA;
      if (reference === referenceB) return secretB;
      throw new Error("must not expose this resolution failure");
    },
  });
  let ticketDatabaseTouched = false;
  const controller = new ZammadInternalController({
    rows: async () => { ticketDatabaseTouched = true; return []; },
    withTenant: async () => { ticketDatabaseTouched = true; throw new Error("must not query ticket context"); },
  }, auth, { wake: async () => {} });

  const forgedForB = `Bearer ${await serviceToken({
    tenantId: tenantB,
    instanceId: instanceB,
    signingSecret: secretA,
  })}`;
  await assert.rejects(
    () => controller.ticketContext(forgedForB, "42"),
    (error) => error instanceof UnauthorizedException && error.message === "Invalid service token" &&
      !error.message.includes(referenceB) && !error.message.includes(secretA) && !error.message.includes(secretB),
  );
  assert.equal(ticketDatabaseTouched, false);
  assert.deepEqual(resolvedReferences, [referenceB]);

  const mismatchedSubject = `Bearer ${await serviceToken({
    tenantId: tenantB,
    instanceId: instanceB,
    signingSecret: secretB,
    subject: instanceA,
  })}`;
  await assert.rejects(() => auth.verify(mismatchedSubject, "zammad:context"), UnauthorizedException);
  assert.deepEqual(resolvedReferences, [referenceB]);

  const unknownInstance = "22000000-0000-4000-8000-000000000099";
  const unknown = `Bearer ${await serviceToken({
    tenantId: tenantB,
    instanceId: unknownInstance,
    signingSecret: secretB,
  })}`;
  await assert.rejects(() => auth.verify(unknown, "zammad:context"), UnauthorizedException);
  assert.deepEqual(resolvedReferences, [referenceB]);
  assert.equal(authQueries.length, 2);
});

test("Zammad JWT resolution uses a dedicated per-instance key, never the REST API token", async () => {
  const previousUrl = process.env.SECRET_SIDECAR_URL;
  const previousToken = process.env.SECRET_SIDECAR_TOKEN;
  const previousNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  process.env.SECRET_SIDECAR_URL = "http://secrets.internal";
  process.env.SECRET_SIDECAR_TOKEN = "read-only-sidecar-token";
  const restApiToken = "zammad-rest-api-token-that-must-not-sign-jwts";
  const jwtSecret = "fake-test-key-not-a-secret-00000000000000000000000000000000000000";
  const originalFetch = globalThis.fetch;
  let request;let fetches=0;
  globalThis.fetch = async (input, init) => {
    fetches++;
    request = { url: String(input), authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ token: restApiToken, jwt_secret: jwtSecret, instance_id: instanceA }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const resolver = new ZammadServiceSecretService();
  try {
    await assert.rejects(()=>resolver.resolveSigningSecret(referenceA,{tenantId:tenantB,instanceId:instanceA}));
    assert.equal(fetches,0);
    const ownerA={tenantId:tenantA,instanceId:instanceA};
    assert.equal(await resolver.resolveSigningSecret(referenceA, ownerA), jwtSecret);
    assert.equal(await resolver.resolveApiToken(referenceA, ownerA), restApiToken);
    assert.deepEqual(request, {
      url: "http://secrets.internal/v1/resolve",
      authorization: "Bearer read-only-sidecar-token",
      body: { reference: referenceA },
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ token: restApiToken }), { status: 200 });
    await assert.rejects(
      () => resolver.resolveSigningSecret(referenceA, ownerA),
      (error) => error.message === "Secure Zammad service credentials could not be resolved." &&
        !error.message.includes(restApiToken) && !error.message.includes(referenceA),
    );
    globalThis.fetch = async () => new Response(JSON.stringify({
      token: jwtSecret,
      jwt_secret: jwtSecret,
      instance_id: instanceA,
    }), { status: 200 });
    await assert.rejects(
      () => resolver.resolveSigningSecret(referenceA, ownerA),
      (error) => error.message === "Secure Zammad service credentials could not be resolved." &&
        !error.message.includes(jwtSecret) && !error.message.includes(referenceA),
    );
    globalThis.fetch = async () => new Response(JSON.stringify({
      token: restApiToken,
      jwt_secret: jwtSecret,
    }), { status: 200 });
    await assert.rejects(
      () => resolver.resolveSigningSecret(referenceA, ownerA),
      (error) => error.message === "Secure Zammad service credentials could not be resolved." &&
        !error.message.includes(instanceA) && !error.message.includes(referenceA),
    );
    globalThis.fetch = async () => new Response(JSON.stringify({
      token: restApiToken,
      jwt_secret: jwtSecret,
      instance_id: instanceB,
    }), { status: 200 });
    await assert.rejects(
      () => resolver.resolveSigningSecret(referenceA, ownerA),
      (error) => error.message === "Secure Zammad service credentials could not be resolved." &&
        !error.message.includes(instanceA) && !error.message.includes(instanceB),
    );
  } finally {
    resolver.onModuleDestroy();
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.SECRET_SIDECAR_URL; else process.env.SECRET_SIDECAR_URL = previousUrl;
    if (previousToken === undefined) delete process.env.SECRET_SIDECAR_TOKEN; else process.env.SECRET_SIDECAR_TOKEN = previousToken;
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnvironment;
  }
});

test('held quoted command blocks native delivery retry before update audit or worker wake',async()=>{
  let mutations=0,wakes=0;const queries=[];
  const deliveryId='30000000-0000-4000-8000-000000000003';
  const client={query:async(sql,values=[])=>{
    queries.push({sql,values});
    if(sql.includes('pg_advisory_xact_lock'))return{rows:[],rowCount:1};
    if(sql.includes('SELECT delivery.id,delivery.state,delivery.manual_retry_allowed'))return{rows:[{id:deliveryId,state:'FAILED_RETRYABLE',manual_retry_allowed:false,safe_error:null}],rowCount:1};
    if(sql.includes('FROM audit_events'))return{rows:[],rowCount:0};
    if(sql.includes('SELECT execution.id FROM ticket_event_executions execution')){assert.deepEqual(values,[tenantA,'42',null]);return{rows:[{id:'pending-command'}],rowCount:1};}
    if(/^(?:INSERT|UPDATE|DELETE)\b/u.test(sql.trim()))mutations++;
    throw Error('Unexpected post-command-fence retry query');
  }};
  const controller=new ZammadInternalController({rows:async()=>[{id:instanceA}],withTenant:async(scope,work)=>{assert.equal(scope,tenantA);return work(client)}},serviceAuth(),{wake:async()=>{wakes++}});
  const authorization=`Bearer ${await serviceToken({scope:'zammad:retry',claims:{zammad_user_id:'77',zammad_group_ids:['4'],zammad_group_admin:false}})}`;
  await assert.rejects(()=>controller.retry(authorization,{tenant_id:tenantA,instance_id:instanceA,ticket_id:42,article_id:9,delivery_id:deliveryId,actor_id:77,idempotency_key:'retry-command-held'}),/QUOTED_COMMAND_EFFECT_HOLD/);
  assert.equal(mutations,0);assert.equal(wakes,0);assert.equal(queries.some(q=>q.sql.includes('INSERT INTO audit_events')),false);
});

function groupAdmissionPrerequisite(sql){
  if(sql.includes("SELECT g.id FROM whatsapp_groups g"))return{rows:[{id:"12000000-0000-4000-8000-000000000001"}]};
  if(sql.includes("SELECT id,idempotency_key FROM delivery_outbox")||sql.includes("pg_advisory_xact_lock")||sql.includes("FROM native_membership_projections p")
    ||sql.includes("FROM group_workspace_operation_receipts receipt")||sql.includes("FROM delivery_outbox delivery JOIN zammad_instances instance")
    ||sql.includes("INSERT INTO group_workspace_operation_receipts"))return{rows:[]};
  return null;
}
