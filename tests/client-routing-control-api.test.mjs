import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BotFlowsService } from "../services/control-api/dist/bot-flows.service.js";
import { ZammadInternalController } from "../services/control-api/dist/zammad-internal.controller.js";

const tenantId="10000000-0000-4000-8000-000000000001";const userId="10100000-0000-4000-8000-000000000001";
const admittedAt="2026-08-09T12:00:00.123456Z";
const principal={subject:"owner",userId,tenantId,email:"owner@example.invalid",displayName:"Owner",role:"tenant_owner",authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:["mfa"]};
const definition={schemaVersion:1,name:"Client routing",supportGroupIds:["2"],fallback:{zammadGroupId:"2"},sources:[
  {id:"manual",name:"Manual",kind:"MANUAL",syncMode:"MANUAL",fieldMapping:{}},
],clients:[{id:"acme",name:"Acme",routeSourceId:"manual",zammadGroupId:"2",matchers:[{kind:"DOMAIN",sourceId:"manual",value:"acme.example"}]}]};

test("routing catalog uses bounded keyset summaries and loads definitions by tenant-scoped ID",async()=>{
  const rows=[3,2,1].map(version=>({id:`52000000-0000-4000-8000-00000000000${version}`,version,state:"DRAFT",revision:1,snapshot_sha256:"a".repeat(64)}));
  const calls=[];const service=new BotFlowsService({rows:async(_tenant,sql,values)=>{calls.push({sql,values});return sql.includes("definition")?[{...rows[0],definition}]:rows}});
  const page=await service.routingCatalog(principal,{limit:"2"});assert.equal(page.items.length,2);assert.ok(page.next_cursor);assert.equal("definition" in page.items[0],false);
  await service.routingCatalog(principal,{limit:"2",cursor:page.next_cursor});assert.equal(calls.at(-1).values[3],3);
  assert.deepEqual((await service.routingDetail(principal,rows[0].id)).definition,definition);
  await assert.rejects(()=>service.routingCatalog({...principal,tenantId:"20000000-0000-4000-8000-000000000002"},{limit:"2",cursor:page.next_cursor}),/Catalog cursor is invalid/);
});

test("creates and idempotently replays an immutable routing version",async()=>{
  let operation;let audits=0;
  const client={query:async(sql,values=[])=>{
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_flow_operations"))return{rows:operation?[operation]:[]};
    if(sql.includes("app.create_client_routing_version"))return{rows:[{id:"52000000-0000-4000-8000-000000000001",version:1,state:"DRAFT",revision:1,snapshot_sha256:"a".repeat(64)}]};
    if(sql.includes("INSERT INTO audit_events")){audits+=1;return{rows:[]}};
    if(sql.includes("INSERT INTO bot_flow_operations")){operation={action:values[1],request_sha256:values[3],result:values[4]};return{rows:[]}};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)},null,null);
  const first=await service.createRouting(principal,"routing-v1","request-1",definition);
  const replay=await service.createRouting(principal,"routing-v1","request-2",definition);
  assert.equal(first.version,1);assert.equal(first.duplicate,false);assert.equal(replay.duplicate,true);assert.equal(audits,1);
});

test("simulates active routing without touching a connector",async()=>{
  const service=new BotFlowsService({rows:async()=>[{id:"52000000-0000-4000-8000-000000000001",version:1,definition}]},null,null);
  const result=await service.simulateRouting(principal,{match:{email:"agent@acme.example",entryGroupId:"2"}});
  assert.equal(result.status,"MATCHED");assert.equal(result.matchedBy,"DOMAIN");assert.equal(result.client.id,"acme");
  for(const entryGroupId of [undefined,"7"]){
    const department=await service.simulateRouting(principal,{match:{email:"agent@acme.example",entryGroupId}});
    assert.equal(department.status,"DEPARTMENT");assert.equal(department.client,null);
  }
});

test("pins one body-free email decision and replays the same Zammad route",async()=>{
  const emailDefinition={...definition,clients:[{...definition.clients[0],ownerId:"8",matchers:[
    {kind:"DOMAIN",sourceId:"manual",value:"acme.example"},
    {kind:"EMAIL",sourceId:"manual",value:"vip@acme.example"},
  ]}]};const instanceId="11000000-0000-4000-8000-000000000001";const routeId="51000000-0000-4000-8000-000000000001";let pinned=null;let receipt=null;let audits=0;const client={query:async(sql,values=[])=>{
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM zammad_email_routes pinned"))return{rows:pinned?[pinned]:[]};
    if(sql.includes("FROM client_routing_versions"))return{rows:[{id:"52000000-0000-4000-8000-000000000001",definition:emailDefinition}]};
    if(sql.includes("INSERT INTO zammad_email_routes")){pinned={id:routeId,zammad_instance_id:values[2],source_article_id:values[3],request_sha256:values[4],client_routing_version_id:values[5],client_route_status:values[6],client_id:values[7],client_route_matched_by:values[8],definition:emailDefinition};return{rows:[pinned]}}
    if(sql.includes("SELECT id FROM zammad_email_routes"))return{rows:pinned&&values[1]===routeId&&values[2]===instanceId&&values[3]==="42"&&values[4]==="9"?[{id:routeId}]:[]};
    if(sql.includes("FROM zammad_email_route_applications"))return{rows:receipt?[receipt]:[]};
    if(sql.includes("INSERT INTO zammad_email_route_applications")){receipt={route_id:values[1],idempotency_key:values[3],request_sha256:values[4],application_status:values[5],observed_group_id:values[6],observed_owner_id:values[7]};return{rows:[receipt]}}
    if(sql.includes("INSERT INTO audit_events")){audits+=1;return{rows:[]}};
    throw new Error(`Unexpected query: ${sql}`);
  }};const database={rows:async()=>[{id:"11000000-0000-4000-8000-000000000001"}],withTenant:async(_tenant,operation)=>operation(client)};
  const auth={verify:async(_authorization,scope)=>{assert.equal(scope,"zammad:routing");return{tenantId,instanceId,subject:"instance"}}};
  const controller=new ZammadInternalController(database,auth,{wake:async()=>{}});const body={tenant_id:tenantId,instance_id:instanceId,ticket_id:42,article_id:9,ticket_number:"10042",sender_email:"VIP@ACME.EXAMPLE",admitted_at:admittedAt,entry_group_id:2};
  const first=await controller.emailRouting("Bearer service",body);const replay=await controller.emailRouting("Bearer service",body);
  assert.deepEqual(first,{route_id:routeId,ticket_id:"42",source_article_id:"9",routed:true,status:"MATCHED",duplicate:false,routing_version_id:"52000000-0000-4000-8000-000000000001",client_id:"acme",matched_by:"EMAIL",zammad_group_id:"2",owner_id:"8"});
  assert.equal(replay.duplicate,true);assert.equal(replay.matched_by,"EMAIL");
  await assert.rejects(()=>controller.emailRouting("Bearer service",{...body,article_id:10}),/different native-email provenance/);
  await assert.rejects(()=>controller.emailRouting("Bearer service",{...body,entry_group_id:7}),/different native-email provenance/);
  const acknowledgement={tenant_id:tenantId,instance_id:instanceId,route_id:routeId,ticket_id:42,article_id:9,idempotency_key:`wasalx-routing-ack:${routeId}`,application_status:"APPLIED",observed_group_id:2,observed_owner_id:8};
  const applied=await controller.emailRoutingAcknowledgement("Bearer service",acknowledgement);const appliedReplay=await controller.emailRoutingAcknowledgement("Bearer service",acknowledgement);
  assert.equal(applied.application_status,"APPLIED");assert.equal(applied.duplicate,false);assert.equal(appliedReplay.duplicate,true);
  await assert.rejects(()=>controller.emailRoutingAcknowledgement("Bearer service",{...acknowledgement,application_status:"MANUAL_OVERRIDE"}),/conflicts with an existing receipt/);
  assert.equal(audits,2);
});

test("email routing rejects invalid identity data before pinning",async()=>{
  const database={rows:async()=>[{id:"11000000-0000-4000-8000-000000000001"}],withTenant:async()=>assert.fail("routing transaction must not begin")};
  const auth={verify:async()=>({tenantId,instanceId:"11000000-0000-4000-8000-000000000001",subject:"instance"})};
  const controller=new ZammadInternalController(database,auth,{wake:async()=>{}});
  await assert.rejects(()=>controller.emailRouting("Bearer service",{tenant_id:tenantId,instance_id:"11000000-0000-4000-8000-000000000001",ticket_id:42,article_id:9,sender_email:"not-an-email",admitted_at:admittedAt}),/Sender email is invalid/);
  await assert.rejects(()=>controller.emailRouting("Bearer service",{tenant_id:tenantId,instance_id:"11000000-0000-4000-8000-000000000001",ticket_id:42,article_id:9,sender_email:"foo bar@example.com",admitted_at:admittedAt}),/Sender email is invalid/);
  await assert.rejects(()=>controller.emailRouting("Bearer service",{tenant_id:tenantId,instance_id:"11000000-0000-4000-8000-000000000001",ticket_id:42,article_id:9,sender_email:"owner@127.0.0.1",admitted_at:admittedAt}),/Sender email is invalid/);
  await assert.rejects(()=>controller.emailRouting("Bearer service",{tenant_id:"20000000-0000-4000-8000-000000000002",instance_id:"11000000-0000-4000-8000-000000000001",ticket_id:42,article_id:9,sender_email:"agent@acme.example",admitted_at:admittedAt}),/mismatch/);
});

test("native department entry wins over same-client matches and unmatched support fallback",async()=>{
  const instanceId="11000000-0000-4000-8000-000000000001",routingId="52000000-0000-4000-8000-000000000001";
  for(const [sender,entry,scoped,expected] of [
    ["staff@acme.example",7,true,"UNCONFIGURED"], // Finance, even for a known client.
    ["unknown@example.invalid",7,true,"UNCONFIGURED"], // Finance must not route through the support entry.
    ["staff@acme.example",2,true,"MATCHED"], // Explicit support entry.
    ["unknown@example.invalid",2,true,"FALLBACK"],
    ["staff@acme.example",undefined,true,"UNCONFIGURED"], // Old pending native payload.
    ["staff@acme.example",2,false,"UNCONFIGURED"], // Historical version without scope.
  ]){
    const active={...definition};if(!scoped)delete active.supportGroupIds;
    let saved;const client={query:async(sql,values=[])=>{
      if(sql.includes("FROM zammad_email_routes pinned"))return{rows:[]};
      if(sql.includes("FROM client_routing_versions")){assert.match(sql,/activated_at<=\$2::timestamptz/);assert.equal(values[1],admittedAt);return{rows:[{id:routingId,definition:active}]};}
      if(sql.includes("INSERT INTO zammad_email_routes")){saved={id:"51000000-0000-4000-8000-000000000001",zammad_instance_id:values[2],source_article_id:values[3],request_sha256:values[4],client_routing_version_id:values[5]??null,client_route_status:values[6]??"UNCONFIGURED",client_id:values[7]??null,client_route_matched_by:values[8]??null,definition:values[9]?JSON.parse(values[9]):null};return{rows:[saved]};}
      return{rows:[]};
    }};
    const controller=new ZammadInternalController({rows:async()=>[{id:instanceId}],withTenant:async(_id,fn)=>fn(client)},{verify:async()=>({tenantId,instanceId})},{wake:async()=>{}});
    const result=await controller.emailRouting("signed",{tenant_id:tenantId,instance_id:instanceId,ticket_id:42,article_id:9,sender_email:sender,admitted_at:admittedAt,...(entry?{entry_group_id:entry}:{})});
    assert.equal(result.status,expected);assert.equal(result.routed,expected!=="UNCONFIGURED");
    if(expected==="UNCONFIGURED")assert.equal(result.owner_id,undefined);
  }
});

test("historical pinned email decisions retain original provenance even without support scope",async()=>{
  const instanceId="11000000-0000-4000-8000-000000000001";
  const historical={...definition};delete historical.supportGroupIds;
  const pinned={id:"51000000-0000-4000-8000-000000000001",zammad_instance_id:instanceId,source_article_id:"9",request_sha256:createHash("sha256").update(JSON.stringify([tenantId,instanceId,"42","9","staff@acme.example",admittedAt])).digest("hex"),client_routing_version_id:"52000000-0000-4000-8000-000000000001",client_route_status:"MATCHED",client_id:"acme",client_route_matched_by:"DOMAIN",definition:historical};
  const client={query:async(sql)=>{if(sql.includes("pg_advisory"))return{rows:[]};assert.ok(sql.includes("FROM zammad_email_routes pinned"),"Pinned replay must not consult or rewrite current routing");return{rows:[pinned]};}};
  const controller=new ZammadInternalController({rows:async()=>[{id:instanceId}],withTenant:async(_id,fn)=>fn(client)},{verify:async()=>({tenantId,instanceId})},{wake:async()=>{}});
  const replay=await controller.emailRouting("signed",{tenant_id:tenantId,instance_id:instanceId,ticket_id:42,article_id:9,sender_email:"staff@acme.example",admitted_at:admittedAt});
  assert.equal(replay.duplicate,true);assert.equal(replay.routed,true);assert.equal(replay.zammad_group_id,"2");
});

test("rejects connector secrets outside the tenant routing namespace",()=>{
  const service=new BotFlowsService({withTenant:async()=>assert.fail("database must not be reached")},null,null);
  const external={...definition,sources:[...definition.sources,{id:"notion",name:"Notion",kind:"NOTION",syncMode:"WEBHOOK",secretReference:"secret://tenants/another/routing/notion",endpointUrl:"https://api.notion.com/v1/data_sources/d9824bdc-8445-4327-be8b-5b47500af6ce/query",fieldMapping:{}}]};
  assert.throws(()=>service.createRouting(principal,"routing","request",external),/must belong to this tenant's routing namespace/);
});

test("external routing connectors default closed while manual drafts remain available",async()=>{
  const external={...definition,sources:[...definition.sources,{id:"notion",name:"Notion",kind:"NOTION",syncMode:"WEBHOOK",secretReference:`secret://tenants/${tenantId}/routing/notion`,endpointUrl:"https://api.notion.com/v1/data_sources/d9824bdc-8445-4327-be8b-5b47500af6ce/query",fieldMapping:{}}]};
  const disabled=new BotFlowsService({withTenant:async()=>assert.fail("database must not be reached")},null,null);
  assert.throws(()=>disabled.createRouting(principal,"routing","request",external),/not enabled in this deployment/);
  assert.deepEqual(disabled.routingCapabilities(),{externalConnectorsEnabled:false,notionOAuthEnabled:false});
  const enabled=new BotFlowsService({withTenant:async(_tenant,callback)=>callback({query:async sql=>sql.includes("SELECT privileged_reauth_minutes")?{rows:[{privileged_reauth_minutes:15}]}:sql.includes("app.create_client_routing_version")?{rows:[{id:"52000000-0000-4000-8000-000000000001",version:1,state:"DRAFT",revision:1,snapshot_sha256:"a".repeat(64)}]}:sql.includes("FROM client_routing_integrations")?{rows:[{secret_reference:`secret://tenants/${tenantId}/routing/notion`,provider:"NOTION",state:"CONNECTED"}]}:{rows:[]}})},null,null,undefined,{externalConnectorsEnabled:true});
  assert.equal((await enabled.createRouting(principal,"routing","request",external)).state,"DRAFT");
});

test("rejects cross-provider connection reuse when creating or activating routing",async()=>{
  const reference=`secret://tenants/${tenantId}/routing/integrations/87000000-0000-4000-8000-000000000030`;const external={...definition,sources:[...definition.sources,{id:"crm",name:"Shipment directory",kind:"HTTP_JSON",syncMode:"SCHEDULED",secretReference:reference,endpointUrl:"https://attacker.example/routes",scheduleMinutes:60,fieldMapping:{}}]};let mutations=0;
  const client={query:async sql=>{
    if(sql.includes("pg_advisory_xact_lock")||sql.includes("FROM bot_flow_operations"))return{rows:[]};
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}]};
    if(sql.includes("FROM client_routing_integrations"))return{rows:[{secret_reference:reference,provider:"NOTION",state:"CONNECTED"}]};
    mutations+=1;throw new Error(`Unexpected mutation: ${sql}`);
  }};const database={rows:async()=>[{definition:external}],withTenant:async(_tenant,operation)=>operation(client)};const catalogs={get:async()=>({groups:[{id:"2",name:"Support",active:true,serviceIdentityCanCreate:true}],owners:[],slas:[],calendars:[]})};const service=new BotFlowsService(database,null,catalogs,undefined,{externalConnectorsEnabled:true});
  await assert.rejects(()=>service.createRouting(principal,"provider-create","request",external),/connected HTTPS connection/u);
  await assert.rejects(()=>service.activateRouting(principal,"52000000-0000-4000-8000-000000000001","provider-activate","request",{expectedRevision:1,expectedActiveRoutingVersionId:null}),/connected HTTPS connection/u);
  assert.equal(mutations,0);
});

test("external routing create and activation require recent MFA before mutation",async()=>{
  const reference=`secret://tenants/${tenantId}/routing/integrations/87000000-0000-4000-8000-000000000031`;
  const external={...definition,sources:[...definition.sources,{id:"crm",name:"Shipment directory",kind:"HTTP_JSON",syncMode:"SCHEDULED",secretReference:reference,endpointUrl:"https://api.example.invalid/routes",scheduleMinutes:60,fieldMapping:{}}]};
  let mutations=0;
  const client={query:async sql=>{
    if(sql.includes("pg_advisory_xact_lock")||sql.includes("FROM bot_flow_operations"))return{rows:[]};
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}]};
    mutations+=1;throw new Error(`Unexpected mutation: ${sql}`);
  }};
  const stale={...principal,authenticatedAt:principal.authenticatedAt-16*60};
  const database={rows:async()=>[{definition:external}],withTenant:async(_tenant,operation)=>operation(client)};
  const catalogs={get:async()=>({groups:[{id:"2",name:"Support",active:true,serviceIdentityCanCreate:true}],owners:[],slas:[],calendars:[]})};
  const service=new BotFlowsService(database,null,catalogs,undefined,{externalConnectorsEnabled:true,notionOAuthEnabled:true,notionOAuthRedirectUri:"http://localhost:3000/api/client-routing/oauth/notion/callback",notionOAuthClientId:"client"});
  await assert.rejects(()=>service.createRouting(stale,"stale-create","request",external),error=>error?.getResponse?.().code==="REAUTHENTICATION_REQUIRED");
  await assert.rejects(()=>service.activateRouting(stale,"52000000-0000-4000-8000-000000000001","stale-activate","request",{expectedRevision:1,expectedActiveRoutingVersionId:null}),error=>error?.getResponse?.().code==="REAUTHENTICATION_REQUIRED");
  await assert.rejects(()=>service.startNotionRoutingOAuth(stale,"request"),error=>error?.getResponse?.().code==="REAUTHENTICATION_REQUIRED");
  assert.equal(mutations,0);
});

test("keeps read-only external routing definitions parseable without exposing secrets",async()=>{
  const external={...definition,sources:[...definition.sources,{id:"notion",name:"Notion",kind:"NOTION",syncMode:"WEBHOOK",secretReference:`secret://tenants/${tenantId}/routing/notion`,endpointUrl:"https://api.notion.com/v1/data_sources/d9824bdc-8445-4327-be8b-5b47500af6ce/query",fieldMapping:{}},{id:"crm",name:"CRM",kind:"HTTP_JSON",syncMode:"WEBHOOK",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl:"https://crm.example/routes?tenant=northstar",fieldMapping:{}}]};
  const service=new BotFlowsService({rows:async()=>[{definition:external}]},null,null);
  const [row]=await service.listRouting({...principal,role:"auditor"});
  assert.equal(row.definition.sources[1].secretReference,"secret://redacted/routing/configured");
  assert.equal(row.definition.sources[2].endpointUrl,"https://crm.example/routes");
  assert.equal((await service.listRouting(principal))[0].definition.sources[2].endpointUrl,"https://crm.example/routes?tenant=northstar");
  assert.equal(JSON.stringify(row).includes(tenantId),false);
});

test("lists connector health without secrets and exposes enabled webhook routes only to administrators",async()=>{const row={source_id:"notion",kind:"NOTION",sync_mode:"HYBRID",state:"ACTIVE",snapshot_revision:2,secret_reference:`secret://tenants/${tenantId}/routing/notion`};const database={rows:async()=>[row]};const secrets={routingRouteToken:async()=>"r".repeat(43)};const ownerService=new BotFlowsService(database,null,null,secrets,{externalConnectorsEnabled:true});const [owner]=await ownerService.listRoutingSources(principal);assert.equal(owner.secret_reference,undefined);assert.equal(owner.webhook_path,`/webhooks/routing/${"r".repeat(43)}`);const [auditor]=await ownerService.listRoutingSources({...principal,role:"auditor"});assert.equal(auditor.secret_reference,undefined);assert.equal(auditor.webhook_path,null);const disabled=new BotFlowsService(database,null,null,{routingRouteToken:async()=>assert.fail("route token must remain hidden")});const [closed]=await disabled.listRoutingSources(principal);assert.equal(closed.webhook_path,null)});

test("lists every data-service health state while exposing only usable bindings to administrators",async()=>{
  const secret=(id)=>`secret://tenants/${tenantId}/routing/integrations/${id}`;
  const rows=[
    {id:"87000000-0000-4000-8000-000000000001",provider:"NOTION",display_name:"Ready",external_account_id:"workspace-private-1",state:"CONNECTED",secret_reference:secret("87000000-0000-4000-8000-000000000001")},
    {id:"87000000-0000-4000-8000-000000000004",provider:"NOTION",display_name:"Also ready",external_account_id:"workspace-private-2",state:"CONNECTED",secret_reference:secret("87000000-0000-4000-8000-000000000004")},
    {id:"87000000-0000-4000-8000-000000000002",provider:"NOTION",display_name:"In progress",external_account_id:null,state:"CONNECTING",secret_reference:secret("87000000-0000-4000-8000-000000000002")},
    {id:"87000000-0000-4000-8000-000000000003",provider:"NOTION",display_name:"Needs recovery",external_account_id:null,state:"REVOKED",secret_reference:secret("87000000-0000-4000-8000-000000000003")},
  ];
  let statement="";
  const service=new BotFlowsService({rows:async(_tenant,sql)=>{statement=sql;return rows}},null,null);
  const owner=await service.listRoutingIntegrations(principal);
  assert.deepEqual(owner.map(row=>row.state),["CONNECTED","CONNECTED","CONNECTING","REVOKED"]);
  assert.equal(owner[0].binding_reference,rows[0].secret_reference);
  assert.equal(owner[1].binding_reference,rows[1].secret_reference);
  assert.equal(owner[2].binding_reference,null);assert.equal(owner[3].binding_reference,null);
  assert.equal(owner.every(row=>!Object.hasOwn(row,"secret_reference")&&!Object.hasOwn(row,"external_account_id")),true);
  assert.match(statement,/app\.list_client_routing_integrations\(\)/u);
  assert.doesNotMatch(statement,/external_account_id/u);
  const auditor=await service.listRoutingIntegrations({...principal,role:"auditor"});
  assert.equal(auditor.every(row=>row.binding_reference===null&&!Object.hasOwn(row,"secret_reference")&&!Object.hasOwn(row,"external_account_id")),true);
});

test("provisions a versioned Zoho connection without returning or auditing its write-only credential",async()=>{
  const integrationId="87000000-0000-4000-8000-000000000020";const reference=`secret://tenants/${tenantId}/routing/integrations/${integrationId}`;const credential="zoho-access-token-value-123";const stored=[];const audits=[];const databaseValues=[];
  const client={query:async(sql,values=[])=>{
    databaseValues.push(values);
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}]};
    if(sql.includes("begin_client_routing_credential"))return{rows:[{integration_id:integrationId,secret_reference:reference,provider:"ZOHO",display_name:"Zoho CRM",auth_scheme:"BEARER",state:"CONNECTING",revision:1,duplicate:false}]};
    if(sql.includes("SELECT state FROM client_routing_integrations"))return{rows:[{state:"CONNECTING"}]};
    if(sql.includes("complete_client_routing_credential"))return{rows:[{integration_id:integrationId,provider:"ZOHO",display_name:"Zoho CRM",auth_scheme:"BEARER",secret_reference:reference,revision:2,changed:true}]};
    if(sql.includes("INSERT INTO audit_events")){audits.push(values);return{rows:[]}};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const secrets={storeRoutingCredential:async(secretReference,value)=>stored.push({secretReference,value}),deleteSecret:async()=>assert.fail("completed credential must not be deleted")};
  const service=new BotFlowsService({withTenant:async(_tenant,operation)=>operation(client)},null,null,undefined,{externalConnectorsEnabled:true},secrets);
  const result=await service.storeRoutingCredential(principal,"credential-request","request",{provider:"ZOHO",displayName:"Zoho CRM",authScheme:"BEARER",credential,integrationId:null,expectedRevision:null});
  assert.deepEqual({...result,bindingReference:"redacted"},{integrationId,provider:"ZOHO",displayName:"Zoho CRM",authScheme:"BEARER",bindingReference:"redacted",revision:2,duplicate:false});
  assert.equal(stored[0].secretReference,reference);assert.equal(stored[0].value.accessToken,credential);assert.match(stored[0].value.hmacKey,/^[A-Za-z0-9_-]{43}$/u);
  assert.equal(JSON.stringify(result).includes(credential),false);assert.equal(JSON.stringify(audits).includes(credential),false);assert.equal(JSON.stringify(databaseValues).includes(credential),false);assert.match(JSON.stringify(audits),/client_routing\.integration_connected/u);
});

test("provisions generic HTTPS request signing without copying its secret into configuration",async()=>{
  const integrationId="87000000-0000-4000-8000-000000000022";const reference=`secret://tenants/${tenantId}/routing/integrations/${integrationId}`;const credential="generic-routing-signing-secret";let stored;
  const client={query:async(sql)=>{
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}]};
    if(sql.includes("begin_client_routing_credential"))return{rows:[{integration_id:integrationId,secret_reference:reference,provider:"HTTP_JSON",display_name:"Shipment directory",auth_scheme:"HMAC",state:"CONNECTING",revision:1,duplicate:false}]};
    if(sql.includes("SELECT state FROM client_routing_integrations"))return{rows:[{state:"CONNECTING"}]};
    if(sql.includes("complete_client_routing_credential"))return{rows:[{integration_id:integrationId,provider:"HTTP_JSON",display_name:"Shipment directory",auth_scheme:"HMAC",secret_reference:reference,revision:2,changed:true}]};
    if(sql.includes("INSERT INTO audit_events"))return{rows:[]};throw new Error(`Unexpected query: ${sql}`);
  }};const service=new BotFlowsService({withTenant:async(_tenant,operation)=>operation(client)},null,null,undefined,{externalConnectorsEnabled:true},{storeRoutingCredential:async(_reference,value)=>{stored=value},deleteSecret:async()=>assert.fail("completed credential must not be deleted")});
  const result=await service.storeRoutingCredential(principal,"https-credential-request","request",{provider:"HTTP_JSON",displayName:"Shipment directory",authScheme:"HMAC",credential,integrationId:null,expectedRevision:null});
  assert.deepEqual(stored,{hmacKey:credential});assert.equal(JSON.stringify(result).includes(credential),false);assert.equal(result.bindingReference,reference);
});

test("requires recent MFA before storing or rotating a routing credential",async()=>{
  let writes=0;const client={query:async sql=>{
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}]};
    writes+=1;throw new Error(`Unexpected write: ${sql}`);
  }};const secrets={storeRoutingCredential:async()=>{writes+=1}};
  const service=new BotFlowsService({withTenant:async(_tenant,operation)=>operation(client)},null,null,undefined,{externalConnectorsEnabled:true},secrets);
  const request={provider:"ZOHO",displayName:"Zoho CRM",authScheme:"BEARER",credential:"zoho-access-token-value-123",integrationId:null,expectedRevision:null};
  await assert.rejects(
    ()=>service.storeRoutingCredential({...principal,authenticatedAt:Math.floor(Date.now()/1000)-16*60},"credential-step-up-stale","request",request),
    error=>error?.getResponse?.().code==="REAUTHENTICATION_REQUIRED",
  );
  await assert.rejects(
    ()=>service.storeRoutingCredential({...principal,authenticationMethods:[]},"credential-step-up-no-mfa","request",request),
    error=>error?.getResponse?.().code==="REAUTHENTICATION_REQUIRED",
  );
  assert.equal(writes,0);
});

test("credential idempotency fingerprints the write-only credential without persisting it",async()=>{
  const payloads=[];const integrationId="87000000-0000-4000-8000-000000000023";const reference=`secret://tenants/${tenantId}/routing/integrations/${integrationId}`;const client={query:async(sql,values=[])=>{
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}]};
    if(sql.includes("begin_client_routing_credential")){payloads.push(values[7]);return{rows:[{integration_id:integrationId,secret_reference:reference,provider:"ZOHO",display_name:"Zoho CRM",auth_scheme:"BEARER",state:"CONNECTED",revision:2,duplicate:true}]}}
    throw new Error(`Unexpected query: ${sql}`);
  }};const service=new BotFlowsService({withTenant:async(_tenant,operation)=>operation(client)},null,null,undefined,{externalConnectorsEnabled:true},{storeRoutingCredential:async()=>assert.fail("a completed replay must not store a secret")});
  const base={provider:"ZOHO",displayName:"Zoho CRM",authScheme:"BEARER",integrationId:null,expectedRevision:null};
  await service.storeRoutingCredential(principal,"same-key","request",{...base,credential:"zoho-access-token-value-123"});
  await service.storeRoutingCredential(principal,"same-key","request",{...base,credential:"different-access-token-456"});
  assert.equal(payloads.length,2);assert.notEqual(payloads[0],payloads[1]);assert.equal(JSON.stringify(payloads).includes("access-token"),false);
});

test("a CONNECTING credential replay repairs the durable stage at the same secret reference",async()=>{
  const integrationId="87000000-0000-4000-8000-000000000024";const reference=`secret://tenants/${tenantId}/routing/integrations/${integrationId}`;let writes=0;
  const client={query:async(sql)=>{
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}]};
    if(sql.includes("begin_client_routing_credential"))return{rows:[{integration_id:integrationId,secret_reference:reference,provider:"ZOHO",display_name:"Zoho CRM",auth_scheme:"BEARER",state:"CONNECTING",revision:1,duplicate:true}]};
    if(sql.includes("SELECT state FROM client_routing_integrations"))return{rows:[{state:"CONNECTING"}]};
    if(sql.includes("complete_client_routing_credential"))return{rows:[{integration_id:integrationId,provider:"ZOHO",display_name:"Zoho CRM",auth_scheme:"BEARER",secret_reference:reference,revision:2,changed:true}]};
    if(sql.includes("INSERT INTO audit_events"))return{rows:[]};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,operation)=>operation(client)},null,null,undefined,{externalConnectorsEnabled:true},{storeRoutingCredential:async()=>{writes+=1}});
  const result=await service.storeRoutingCredential(principal,"same-in-flight-key","request",{provider:"ZOHO",displayName:"Zoho CRM",authScheme:"BEARER",credential:"zoho-access-token-value-123",integrationId:null,expectedRevision:null});
  assert.equal(result.integrationId,integrationId);assert.equal(result.bindingReference,reference);assert.equal(result.duplicate,true);assert.equal(writes,1);
});

test("tests a connected credential only through its revision-fenced active routing source",async()=>{
  const integrationId="87000000-0000-4000-8000-000000000021";let wakeups=0;const audits=[];const client={query:async(sql,values=[])=>{
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_flow_operations"))return{rows:[]};
    if(sql.includes("request_client_routing_source_sync"))return{rows:[{job_id:"89000000-0000-4000-8000-000000000001",snapshot_revision:4,duplicate:false}]};
    if(sql.includes("INSERT INTO audit_events")){audits.push(values);return{rows:[]}};
    if(sql.includes("INSERT INTO bot_flow_operations"))return{rows:[]};
    throw new Error(`Unexpected query: ${sql}`);
  }};const database={rows:async()=>[{provider:"HTTP_JSON",state:"CONNECTED",revision:3,source_id:"crm",snapshot_revision:4}],withTenant:async(_tenant,operation)=>operation(client)};
  const service=new BotFlowsService(database,{wakeRouting:async()=>{wakeups++}},null,undefined,{externalConnectorsEnabled:true});
  const result=await service.testRoutingCredential(principal,integrationId,"test-request","request",{expectedRevision:3});
  assert.equal(result.integrationId,integrationId);assert.equal(result.sourceId,"crm");assert.equal(result.snapshotRevision,4);assert.equal(wakeups,1);assert.match(JSON.stringify(audits),/client_routing\.sync_requested/u);
  const unbound=new BotFlowsService({rows:async()=>[{provider:"ZOHO",state:"CONNECTED",revision:2,source_id:null,snapshot_revision:null}]},null,null,undefined,{externalConnectorsEnabled:true});
  await assert.rejects(()=>unbound.testRoutingCredential(principal,integrationId,"test-request","request",{expectedRevision:2}),/active routing version/);
});

test("qualifies a draft routing source through one revision-fenced non-mutating worker job",async()=>{
  const versionId="52000000-0000-4000-8000-000000000041";const integrationId="87000000-0000-4000-8000-000000000041";
  const calls=[];const audits=[];let wakeups=0;const client={query:async(sql,values=[])=>{
    calls.push({sql,values});
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_flow_operations"))return{rows:[]};
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}]};
    if(sql.includes("request_client_routing_source_qualification"))return{rows:[{job_id:"89000000-0000-4000-8000-000000000041",qualification_id:"89100000-0000-4000-8000-000000000041",duplicate:false}]};
    if(sql.includes("INSERT INTO audit_events")){audits.push(values);return{rows:[]}};
    if(sql.includes("INSERT INTO bot_flow_operations"))return{rows:[]};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,operation)=>operation(client)},{wakeRouting:async()=>{wakeups++}},null,undefined,{externalConnectorsEnabled:true});
  const result=await service.qualifyRoutingSource(principal,versionId,"crm","qualify-draft","request-qualification",{integrationId,expectedIntegrationRevision:4,expectedRoutingRevision:2});
  assert.deepEqual(result,{jobId:"89000000-0000-4000-8000-000000000041",qualificationId:"89100000-0000-4000-8000-000000000041",routingVersionId:versionId,sourceId:"crm",duplicate:false});
  const qualification=calls.find(call=>call.sql.includes("request_client_routing_source_qualification"));
  assert.deepEqual(qualification.values.slice(0,6),[versionId,2,"crm",integrationId,4,userId]);
  assert.match(qualification.values[6],/^[0-9a-f]{64}$/u);assert.equal(wakeups,1);
  assert.match(JSON.stringify(audits),/client_routing\.qualification_requested/u);
  assert.equal(calls.some(call=>call.sql.includes("activate_client_routing_version")||call.sql.includes("client_routing_source_state")),false);
});

test("a failed Notion exchange revokes its claimed tenant and user-bound connection",async()=>{
  const state="s".repeat(43);let aborted=false;let abortAudit=null;const client={query:async(sql,values=[])=>{
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}]};
    if(sql.includes("claim_client_routing_notion_oauth"))return{rows:[{integration_id:"87000000-0000-4000-8000-000000000001",secret_reference:`secret://tenants/${tenantId}/routing/integrations/87000000-0000-4000-8000-000000000001`,redirect_uri:"http://localhost:3000/api/client-routing/oauth/notion/callback"}]};
    if(sql.includes("abort_client_routing_notion_oauth")){assert.equal(values[1],userId);aborted=true;return{rows:[{integration_id:"87000000-0000-4000-8000-000000000001"}]}}
    if(sql.includes("INSERT INTO audit_events")){abortAudit=values[6];return{rows:[]}}
    throw new Error(`Unexpected query: ${sql}`);
  }};const service=new BotFlowsService({withTenant:async(_tenant,operation)=>operation(client)},null,null,{resolveHmac:async()=>{throw new Error("secret unavailable")}},{notionOAuthEnabled:true,notionOAuthRedirectUri:"http://localhost:3000/api/client-routing/oauth/notion/callback",notionOAuthClientId:"client"},{storeRoutingCredential:async()=>assert.fail("credential must not be stored")});
  await assert.rejects(()=>service.completeNotionRoutingOAuth(principal,"request",{state,code:"temporary-code"}),/secret unavailable/);
  assert.equal(aborted,true);assert.deepEqual(abortAudit,{provider:"NOTION",reason:"FAILED"});
});

test("a duplicate Notion workspace deletes the new secret and revokes the connecting record",{concurrency:false},async()=>{
  const previousFetch=globalThis.fetch;const state="d".repeat(43);let stored=false;let deleted=false;let aborted=false;const client={query:async(sql)=>{
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}]};
    if(sql.includes("claim_client_routing_notion_oauth"))return{rows:[{integration_id:"87000000-0000-4000-8000-000000000002",secret_reference:`secret://tenants/${tenantId}/routing/integrations/87000000-0000-4000-8000-000000000002`,redirect_uri:"http://localhost:3000/api/client-routing/oauth/notion/callback"}]};
    if(sql.includes("complete_client_routing_notion_oauth"))throw Object.assign(new Error("duplicate workspace"),{code:"23505"});
    if(sql.includes("abort_client_routing_notion_oauth")){aborted=true;return{rows:[{integration_id:"87000000-0000-4000-8000-000000000002"}]}}
    if(sql.includes("INSERT INTO audit_events"))return{rows:[]};throw new Error(`Unexpected query: ${sql}`);
  }};try{globalThis.fetch=async()=>new Response(JSON.stringify({access_token:"notion-access-token-value",workspace_id:"88000000-0000-4000-8000-000000000001",workspace_name:"Northstar workspace"}),{status:200,headers:{"content-type":"application/json"}});const service=new BotFlowsService({withTenant:async(_tenant,operation)=>operation(client)},null,null,{resolveHmac:async()=>"notion-client-secret-value"},{notionOAuthEnabled:true,notionOAuthRedirectUri:"http://localhost:3000/api/client-routing/oauth/notion/callback",notionOAuthClientId:"client"},{storeRoutingCredential:async()=>{stored=true},deleteSecret:async()=>{deleted=true}});await assert.rejects(()=>service.completeNotionRoutingOAuth(principal,"request",{state,code:"temporary-code"}),/already connected/)}finally{globalThis.fetch=previousFetch}
  assert.equal(stored,true);assert.equal(deleted,true);assert.equal(aborted,true);
});

test("activation rejects a stale Zammad routing target before mutation",async()=>{
  const database={rows:async()=>[{definition}],withTenant:async()=>assert.fail("activation transaction must not begin")};
  const catalogs={get:async()=>({groups:[],owners:[],slas:[],calendars:[]})};
  const service=new BotFlowsService(database,null,catalogs);
  await assert.rejects(()=>service.activateRouting(principal,"52000000-0000-4000-8000-000000000001","activate","request",{expectedRevision:1,expectedActiveRoutingVersionId:null}),error=>JSON.stringify(error.getResponse()).includes("Zammad group 2 does not exist"));
});

test("activation rejects external routing while the deployment gate is closed",async()=>{
  const external={...definition,sources:[...definition.sources,{id:"notion",name:"Notion",kind:"NOTION",syncMode:"WEBHOOK",secretReference:`secret://tenants/${tenantId}/routing/notion`,endpointUrl:"https://api.notion.com/v1/data_sources/d9824bdc-8445-4327-be8b-5b47500af6ce/query",fieldMapping:{}}]};
  const database={rows:async()=>[{definition:external}],withTenant:async()=>assert.fail("activation transaction must not begin")};
  const catalogs={get:async()=>assert.fail("Zammad must not be contacted")};
  const service=new BotFlowsService(database,null,catalogs);
  await assert.rejects(()=>service.activateRouting(principal,"52000000-0000-4000-8000-000000000001","activate","request",{expectedRevision:1,expectedActiveRoutingVersionId:null}),/not enabled in this deployment/);
});

test("routing migration is immutable, tenant-isolated, indexed, and sealed",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0052_client_routing_versions.sql",import.meta.url),"utf8");
  for(const table of ["client_routing_versions","client_routing_matchers"])assert.match(sql,new RegExp(`CREATE TABLE ${table}`));
  assert.match(sql,/CREATE UNIQUE INDEX client_routing_versions_one_active/);
  assert.match(sql,/CREATE UNIQUE INDEX client_routing_matchers_one_owner/);
  assert.match(sql,/CREATE TRIGGER client_routing_versions_immutable/);
  assert.match(sql,/FORCE ROW LEVEL SECURITY/g);
  assert.match(sql,/REVOKE INSERT,UPDATE,DELETE ON client_routing_versions,client_routing_matchers FROM wasalx_app/);
  assert.match(sql,/REVOKE ALL ON FUNCTION app\.activate_client_routing_version\(uuid,bigint,uuid,uuid\) FROM PUBLIC/);
});

test("routing sync runtime is durable, fenced, tenant-bound, and system-attributed",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0053_client_routing_sync_runtime.sql",import.meta.url),"utf8");
  for(const table of ["client_routing_source_state","client_routing_sync_jobs"])assert.match(sql,new RegExp(`CREATE TABLE ${table}`));
  assert.match(sql,/client_routing_source_state_one_active/);
  assert.match(sql,/expected_snapshot_revision bigint NOT NULL/);
  assert.match(sql,/lease_id uuid[\s\S]*lease_expires_at timestamptz[\s\S]*fencing_token bigint/);
  assert.match(sql,/secret_reference text NOT NULL CHECK[\s\S]*secret:\/\/tenants\/[\s\S]*\/routing\//);
  assert.match(sql,/created_actor_type text NOT NULL DEFAULT 'USER'/);
  assert.match(sql,/created_sync_job_id uuid/);
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.claim_client_routing_sync_jobs/);
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.fail_client_routing_sync_job/);
  assert.match(sql,/FOR UPDATE OF candidate SKIP LOCKED/);
  assert.match(sql,/FORCE ROW LEVEL SECURITY/g);
  assert.match(sql,/REVOKE INSERT,UPDATE,DELETE ON client_routing_source_state,client_routing_sync_jobs FROM wasalx_app/);
});

test("draft routing qualification is immutable, tenant-bound, non-activating, and auth-revocation aware",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0122_plugin_routing_release_blockers.sql",import.meta.url),"utf8");
  assert.match(sql,/CREATE TABLE client_routing_source_qualifications/u);
  assert.match(sql,/FOREIGN KEY \(tenant_id,routing_version_id\)[\s\S]*FOREIGN KEY \(tenant_id,integration_id\)/u);
  assert.match(sql,/ENABLE ROW LEVEL SECURITY[\s\S]*FORCE ROW LEVEL SECURITY/u);
  assert.match(sql,/state='DRAFT' AND revision=expected_version_revision/u);
  assert.match(sql,/state='CONNECTED'[\s\S]*revision=expected_integration_revision[\s\S]*provider=source->>'kind'[\s\S]*secret_reference=source->>'secretReference'/u);
  assert.match(sql,/trigger_kind='QUALIFICATION' AND source_state_id IS NULL AND qualification_id IS NOT NULL/u);
  assert.match(sql,/CASE WHEN qualification\.id IS NOT NULL THEN 'QUALIFICATION' ELSE state\.sync_mode END/u);
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.complete_client_routing_source_qualification/u);
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.revoke_client_routing_integration_for_sync/u);
  assert.match(sql,/job\.lease_id=worker_lease AND job\.fencing_token=expected_fence AND job\.lease_expires_at>=now\(\)/u);
  assert.match(sql,/SET state='REVOKED',revision=revision\+1/u);
  assert.doesNotMatch(sql,/activate_client_routing_version|INSERT INTO client_routing_source_state/u);
});

test("routing sync completion atomically activates a system-attributed immutable version",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0054_client_routing_sync_completion.sql",import.meta.url),"utf8");
  assert.match(sql,/route_source_id text/);
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.complete_client_routing_sync_job/);
  assert.match(sql,/routing source snapshots changed/);
  assert.match(sql,/created_actor_type,created_sync_job_id/);
  assert.match(sql,/activated_actor_type='SYSTEM'/);
  assert.match(sql,/retired_actor_type='SYSTEM'/);
  assert.match(sql,/client_routing\.synced/);
  assert.match(sql,/SECURITY DEFINER[\s\S]*SET row_security=off/);
});

test("routing activation pins one full-precision boundary with valid lifecycle attribution",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0139_email_routing_admission_clock.sql",import.meta.url),"utf8");
  assert.match(sql,/SECURITY DEFINER[\s\S]*SET row_security=off/u);
  assert.match(sql,/transition_time:=clock_timestamp\(\)/u);
  assert.match(sql,/retired_at=transition_time,retired_by=requested_by,[\s\S]*retired_actor_type='USER',retired_sync_job_id=NULL/u);
  assert.match(sql,/activated_at=transition_time,activated_by=requested_by,[\s\S]*activated_actor_type='USER',activated_sync_job_id=NULL/u);
  assert.match(sql,/NEW\.retired_at:=clock_timestamp\(\)/u);
  assert.match(sql,/NEW\.activated_at:=shared_transition_time/u);
  assert.match(sql,/client_routing_versions_pin_automatic_transition_clock/u);
});

test("routing history uses bounded keyset pages and preserves access to every immutable version",async()=>{
  const source=await readFile(new URL("../app/ClientRouting.tsx",import.meta.url),"utf8");
  assert.match(source,/\/api\/client-routing\/catalog\$\{query\}/u);
  assert.match(source,/cursor=\$\{encodeURIComponent\(cursor\)\}/u);
  assert.match(source,/routing\.versions\.loadMore/u);
  assert.match(source,/\/api\/client-routing\/\$\{encodeURIComponent\(selectedId\)\}/u);
});

test("routing sync waits for every first snapshot and renews a fenced lease",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0059_client_routing_sync_safety.sql",import.meta.url),"utf8");
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.renew_client_routing_sync_job/);
  assert.match(sql,/lease_expires_at=now\(\)\+lease_for/);
  assert.match(sql,/snapshot_revision=0[\s\S]*activation_deferred/);
  assert.match(sql,/RETURN QUERY SELECT NULL::uuid,NULL::integer/);
  assert.match(sql,/REVOKE ALL ON FUNCTION app\.renew_client_routing_sync_job/);
});

test("a fenced stale same-source sync is terminally superseded without mutating routing",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0068_client_routing_sync_supersession.sql",import.meta.url),"utf8");
  const branch=sql.match(/IF source\.snapshot_revision>job\.expected_snapshot_revision THEN([\s\S]*?)END IF;/)?.[1]??"";
  assert.match(branch,/UPDATE client_routing_sync_jobs SET state='DISCARDED'[\s\S]*result_routing_version_id=source\.routing_version_id/);
  assert.match(branch,/WHERE tenant_id=current_tenant AND id=job\.id/);
  assert.match(branch,/client_routing\.sync_superseded/);
  assert.match(branch,/RETURN QUERY SELECT routing\.id,routing\.version/);
  assert.doesNotMatch(branch,/UPDATE client_routing_source_state|INSERT INTO client_routing_versions/);
  assert.match(sql,/job\.state<>'RUNNING'[\s\S]*job\.lease_id<>worker_lease[\s\S]*job\.fencing_token<>expected_fence/);
  assert.match(sql,/source\.state<>'ACTIVE'[\s\S]*source\.config_sha256<>job\.config_sha256/);
});

test("an unchanged routing sync records liveness without cloning an immutable version",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0095_client_routing_sync_noop.sql",import.meta.url),"utf8");
  const branch=sql.match(/IF requested_snapshot_sha256=source\.snapshot_sha256 AND requested_definition_sha256=active\.snapshot_sha256 THEN([\s\S]*?)END IF;/)?.[1]??"";
  assert.match(sql,/requested_snapshot_sha256:=encode\(digest\(requested_snapshot::text,'sha256'\),'hex'\)/);
  assert.match(sql,/requested_definition_sha256:=encode\(digest\(requested_definition::text,'sha256'\),'hex'\)/);
  assert.match(branch,/observed_snapshot_revision:=CASE WHEN source\.snapshot_revision=0 THEN 1 ELSE source\.snapshot_revision END/);
  assert.match(branch,/snapshot_revision=observed_snapshot_revision[\s\S]*last_success_at=now\(\)[\s\S]*next_due_at=/);
  assert.match(branch,/state='SUCCEEDED'[\s\S]*result_routing_version_id=active\.id/);
  assert.match(branch,/'changed',false/);
  assert.match(branch,/RETURN QUERY SELECT active\.id,active\.version/);
  assert.doesNotMatch(branch,/INSERT INTO client_routing_versions|INSERT INTO client_routing_matchers/);
  assert.match(sql,/snapshot=requested_snapshot,snapshot_sha256=requested_snapshot_sha256[\s\S]*snapshot_revision=snapshot_revision\+1/);
  assert.match(sql,/VALUES\(current_tenant,next_version,'DRAFT',requested_definition,requested_definition_sha256/);
});

test("routing webhook wakeups are opaque, replay-fenced, and enqueue only a complete pull",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0056_client_routing_webhooks.sql",import.meta.url),"utf8");
  assert.match(sql,/webhook_route_sha256 text/);
  assert.match(sql,/CREATE UNIQUE INDEX client_routing_source_webhook_route/);
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.resolve_client_routing_webhook_route/);
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.enqueue_client_routing_webhook_sync/);
  assert.match(sql,/'webhook:'\|\|event_sha256/);
  assert.match(sql,/trigger_kind,expected_snapshot_revision/);
  assert.match(sql,/REVOKE ALL ON FUNCTION app\.reconcile_client_routing_sources\(uuid,uuid\) FROM wasalx_app/);
});

test("operator sync is tenant-bound, revision-fenced, deduplicated, and recoverable",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0077_client_routing_operator_sync.sql",import.meta.url),"utf8");
  const operationSql=await readFile(new URL("../services/control-api/migrations/0080_client_routing_sync_operation.sql",import.meta.url),"utf8");
  const manualSql=await readFile(new URL("../services/control-api/migrations/0081_client_routing_manual_sync.sql",import.meta.url),"utf8");
  const serviceSource=await readFile(new URL("../services/control-api/src/bot-flows.service.ts",import.meta.url),"utf8");
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.request_client_routing_source_sync/);
  assert.match(sql,/role IN \('tenant_owner','tenant_admin'\)/);
  assert.match(sql,/source\.snapshot_revision<>expected_revision[\s\S]*ERRCODE='40001'/);
  assert.match(sql,/state IN \('ACTIVE','CONFLICT'\)[\s\S]*FOR UPDATE/);
  assert.match(sql,/job\.state IN \('QUEUED','RUNNING','FAILED_RETRYABLE'\)/);
  assert.match(sql,/trigger_kind,expected_snapshot_revision[\s\S]*'MANUAL'/);
  assert.match(sql,/REVOKE ALL ON FUNCTION app\.request_client_routing_source_sync/);
  assert.match(operationSql,/bot_flow_operations_action_check[\s\S]*'ROUTING_SYNC'/);
  assert.match(manualSql,/job\.trigger_kind='MANUAL'[\s\S]*job\.state IN \('QUEUED','RUNNING','FAILED_RETRYABLE'\)/);
  assert.match(serviceSource,/item\.trigger_kind<>'SCHEDULED' OR item\.available_at<=now\(\)/);
});

test("Notion routing OAuth stores only bindings with one-time tenant-bound state",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0079_client_routing_notion_oauth.sql",import.meta.url),"utf8");
  for(const table of ["client_routing_integrations","client_routing_oauth_states"])assert.match(sql,new RegExp(`CREATE TABLE ${table}`));
  assert.match(sql,/state_sha256 text NOT NULL/);assert.match(sql,/consumed_at timestamptz/);assert.match(sql,/expires_at>now\(\)/);
  assert.match(sql,/requested_by=claim_client_routing_notion_oauth\.requested_by/);assert.match(sql,/requested_by=abort_client_routing_notion_oauth\.requested_by/);assert.match(sql,/FORCE ROW LEVEL SECURITY/g);
  assert.match(sql,/CREATE UNIQUE INDEX client_routing_integrations_one_workspace[\s\S]*WHERE state='CONNECTED'/);
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.abort_client_routing_notion_oauth[\s\S]*state='REVOKED'/);
  assert.match(sql,/REVOKE INSERT,UPDATE,DELETE ON client_routing_integrations,client_routing_oauth_states FROM wasalx_app/);
  const callback=await readFile(new URL("../app/api/client-routing/oauth/notion/callback/route.ts",import.meta.url),"utf8");
  assert.match(callback,/authenticatePortalRequest\(request,"bot:write"\)/);assert.match(callback,/abortNotionRoutingOAuth\(\{state,reason:"DENIED"\}\)/);assert.match(callback,/if\(!code\)\{await abortNotionRoutingOAuth\(\{state,reason:"FAILED"\}\)/);assert.match(callback,/destination\.searchParams\.set\("view","connections"\)/);assert.match(callback,/destination\.searchParams\.set\("routingIntegration","refresh"\)/);
  assert.match(callback,/new URL\("\/app",portalPublicOrigin\(\)\)/u);
  assert.doesNotMatch(callback,/new URL\("\/app",current\)/u);
  const reconnect=await readFile(new URL("../services/control-api/migrations/0131_notion_oauth_reconnect_qualification.sql",import.meta.url),"utf8");
  assert.match(reconnect,/DELETE FROM public\.client_routing_oauth_states AS oauth[\s\S]*oauth\.tenant_id=current_tenant[\s\S]*oauth\.integration_id=selected\.id/u);
});

test("expired routing OAuth is projected truthfully and retired atomically on reconnect",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0099_client_routing_oauth_expiry.sql",import.meta.url),"utf8");
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.begin_client_routing_notion_oauth/u);
  assert.match(sql,/tenant_memberships[\s\S]*role IN \('tenant_owner','tenant_admin'\)[\s\S]*PERFORM oauth\.id/u);
  assert.match(sql,/oauth\.consumed_at IS NULL[\s\S]*oauth\.expires_at<=now\(\)[\s\S]*FOR UPDATE OF oauth/u);
  assert.match(sql,/UPDATE client_routing_integrations integration[\s\S]*SET state='REVOKED',revision=integration\.revision\+1/u);
  assert.match(sql,/NOT EXISTS \([\s\S]*pending\.expires_at>now\(\)[\s\S]*RETURNING integration\.id,integration\.revision/u);
  assert.match(sql,/client_routing\.integration_expired[\s\S]*AUTHORIZATION_EXPIRED/u);
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.list_client_routing_integrations\(\)/u);
  assert.match(sql,/CASE WHEN integration\.state='CONNECTING'[\s\S]*THEN 'REVOKED'/u);
  assert.match(sql,/row_number\(\) OVER[\s\S]*ranked\.state<>'REVOKED' OR ranked\.state_rank=1/u);
  assert.doesNotMatch(sql,/RETURNS TABLE\([\s\S]*external_account_id/u);
  assert.doesNotMatch(sql,/UPDATE client_routing_oauth_states[\s\S]*consumed_at/u);
  assert.match(sql,/REVOKE ALL ON FUNCTION[\s\S]*app\.list_client_routing_integrations\(\) FROM PUBLIC/u);
});

test("routing credential connections are tenant-bound, revisioned, idempotent, and write-only",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0101_routing_credential_connections.sql",import.meta.url),"utf8");
  const service=await readFile(new URL("../services/control-api/src/bot-flows.service.ts",import.meta.url),"utf8");
  assert.match(sql,/provider IN \('NOTION','ZOHO','HTTP_JSON'\)/u);assert.match(sql,/auth_scheme IN \('BEARER','HMAC'\)/u);
  assert.match(sql,/CREATE UNIQUE INDEX client_routing_integrations_request_key/u);assert.match(sql,/request_payload_sha256/u);
  assert.match(sql,/role IN \('tenant_owner','tenant_admin'\)/u);assert.match(sql,/pg_advisory_xact_lock\(hashtextextended/u);assert.match(sql,/FOR UPDATE/u);assert.match(sql,/replaces_revision/u);
  assert.match(sql,/state='REVOKED',revision=integration\.revision\+1/u);assert.match(sql,/state='CONNECTED',revision=integration\.revision\+1/u);
  assert.match(sql,/SECURITY DEFINER[\s\S]*SET search_path=pg_catalog,public,app SET row_security=off/u);
  assert.match(sql,/REVOKE ALL ON FUNCTION app\.begin_client_routing_credential/u);assert.doesNotMatch(sql,/credential text|access_token text|hmac_key text/iu);
  assert.match(sql,/integration\.provider=NEW\.kind[\s\S]*integration\.state='CONNECTED'[\s\S]*FOR SHARE/u);
  assert.match(sql,/CREATE TRIGGER client_routing_source_binding\s+BEFORE INSERT OR UPDATE ON client_routing_source_state/u);
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.claim_client_routing_sync_jobs[\s\S]*integration\.provider=state\.kind AND integration\.state='CONNECTED'/u);
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.resolve_client_routing_webhook_route[\s\S]*integration\.provider=source\.kind AND integration\.state='CONNECTED'/u);
  assert.match(service,/credentialSha256=hash\(input\.credential\)/u);
  assert.match(service,/payloadSha256=hash\(\{\.\.\.input,credential:credentialSha256\}\)/u);
  assert.match(service,/SELECT state FROM client_routing_integrations[\s\S]*FOR UPDATE/u);
  assert.doesNotMatch(service,/credential:[^"\n]*input\.credential|appendAudit\([^\n]*input\.credential/u);
});

test("pins one immutable routing decision across inbox, group, direct, and email work",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0057_client_routing_pins.sql",import.meta.url),"utf8");
  const repository=await readFile(new URL("../services/connector-worker/src/inbound-repository.ts",import.meta.url),"utf8");
  const quarantine=await readFile(new URL("../services/control-api/src/quarantine.controller.ts",import.meta.url),"utf8");
  assert.match(sql,/BEFORE INSERT ON event_inbox/);assert.match(sql,/event client routing version is immutable/);
  assert.match(sql,/ALTER TABLE case_correlations[\s\S]*client_routing_version_id/);
  assert.match(sql,/ALTER TABLE bot_conversations[\s\S]*client_routing_version_id/);
  assert.match(sql,/CREATE TABLE zammad_email_routes/);assert.match(sql,/UNIQUE \(tenant_id,zammad_ticket_id\)/);
  assert.match(repository,/resolveClientRoute\(routing,input\)/);assert.match(repository,/client_route_matched_by/);
  assert.match(repository,/existingConversation\?storedClientRoute/);assert.match(repository,/context\.assignmentZammadGroup/);
  assert.match(quarantine,/source\.governing_client_routing_version_id/);
});

test("portal routing routes are permissioned, idempotent, and no-store",async()=>{
  const base=await readFile(new URL("../app/api/client-routing/route.ts",import.meta.url),"utf8");
  const activate=await readFile(new URL("../app/api/client-routing/[id]/activate/route.ts",import.meta.url),"utf8");
  const simulate=await readFile(new URL("../app/api/client-routing/simulate/route.ts",import.meta.url),"utf8");
  const sources=await readFile(new URL("../app/api/client-routing/sources/route.ts",import.meta.url),"utf8");
  const capabilities=await readFile(new URL("../app/api/client-routing/capabilities/route.ts",import.meta.url),"utf8");
  const sync=await readFile(new URL("../app/api/client-routing/sources/[id]/sync/route.ts",import.meta.url),"utf8");
  const integrations=await readFile(new URL("../app/api/client-routing/integrations/route.ts",import.meta.url),"utf8");
  const integrationStart=await readFile(new URL("../app/api/client-routing/integrations/notion/start/route.ts",import.meta.url),"utf8");
  const credential=await readFile(new URL("../app/api/client-routing/integrations/credential/route.ts",import.meta.url),"utf8");
  const credentialTest=await readFile(new URL("../app/api/client-routing/integrations/[id]/test/route.ts",import.meta.url),"utf8");
  const qualifications=await readFile(new URL("../app/api/client-routing/[id]/qualifications/route.ts",import.meta.url),"utf8");
  const qualify=await readFile(new URL("../app/api/client-routing/[id]/sources/[sourceId]/qualify/route.ts",import.meta.url),"utf8");
  const editor=await readFile(new URL("../app/ClientRouting.tsx",import.meta.url),"utf8");
  const messages=await readFile(new URL("../lib/i18n/messages/en/automation.ts",import.meta.url),"utf8");
  assert.match(base,/bot:read/);assert.match(base,/bot:write/);assert.match(base,/idempotency-key/);assert.match(base,/private, no-store/);
  assert.match(activate,/bot:write/);assert.match(activate,/idempotency-key/);assert.match(activate,/private, no-store/);
  assert.match(simulate,/bot:read/);assert.match(simulate,/private, no-store/);
  assert.match(sources,/bot:read/);assert.match(sources,/private, no-store/);
  assert.match(capabilities,/bot:read/);assert.match(capabilities,/private, no-store/);
  assert.match(sync,/bot:write/);assert.match(sync,/idempotency-key/);assert.match(sync,/private, no-store/);
  assert.match(integrations,/bot:read/);assert.match(integrations,/private, no-store/);
  assert.match(integrationStart,/bot:write/);assert.match(integrationStart,/private, no-store/);
  assert.match(credential,/bot:write/);assert.match(credential,/idempotency-key/);assert.match(credential,/private, no-store/);
  assert.match(credentialTest,/bot:write/);assert.match(credentialTest,/idempotency-key/);assert.match(credentialTest,/private, no-store/);
  assert.match(qualifications,/bot:read/);assert.match(qualifications,/private, no-store/);
  assert.match(qualify,/bot:write/);assert.match(qualify,/idempotency-key/);assert.match(qualify,/private, no-store/);
  assert.match(editor,/externalConnectorsEnabled[\s\S]*<option value="NOTION">/);assert.match(editor,/routing\.errors\.externalDisabled/);assert.match(messages,/Data source connections are not enabled for this workspace/);
  assert.match(editor,/type="password"[\s\S]*autoComplete="new-password"/u);assert.match(editor,/routing\.integrations\.writeOnlyHelp/u);
  assert.match(editor,/step_up=privileged[\s\S]*routing\.integrations\.reauthenticate/u);
  assert.doesNotMatch(editor,/routing\.editor\.secretReference/u);
  assert.match(editor,/fetch\("\/api\/client-routing\/simulate"[\s\S]*headers: mutationHeaders/);assert.match(editor,/<button type="submit" className="button primary small"/);
  assert.match(editor,/versionState==="DRAFT"[\s\S]*routing\.sources\.qualification/u);
  assert.match(editor,/expectedIntegrationRevision:integration\.revision,expectedRoutingRevision:selected\.revision/u);
});

test("deployment configuration keeps external routing connectors explicitly default-off",async()=>{
  const environment=await readFile(new URL("../.env.example",import.meta.url),"utf8");
  const compose=await readFile(new URL("../compose.yaml",import.meta.url),"utf8");
  const helmConfig=await readFile(new URL("../infra/helm/wasalx/templates/config.yaml",import.meta.url),"utf8");
  const helmWorkloads=await readFile(new URL("../infra/helm/wasalx/templates/workloads.yaml",import.meta.url),"utf8");
  const helmValues=await readFile(new URL("../infra/helm/wasalx/values.yaml",import.meta.url),"utf8");
  assert.match(environment,/CLIENT_ROUTING_EXTERNAL_CONNECTORS_ENABLED=false/);
  assert.match(environment,/PUBLIC_PORTAL_BASE_URL=https:\/\/app\.example\.com/);assert.match(environment,/NOTION_OAUTH_CLIENT_ID=/);assert.match(environment,/NOTION_OAUTH_CLIENT_SECRET_REFERENCE=secret:\/\//);
  assert.match(compose,/CLIENT_ROUTING_EXTERNAL_CONNECTORS_ENABLED: \$\{CLIENT_ROUTING_EXTERNAL_CONNECTORS_ENABLED:-false\}/);
  assert.match(compose,/PUBLIC_PORTAL_BASE_URL: \$\{PUBLIC_PORTAL_BASE_URL:-http:\/\/localhost:3000\}/);assert.match(compose,/NOTION_OAUTH_CLIENT_SECRET_REFERENCE:/);
  assert.match(helmConfig,/CLIENT_ROUTING_EXTERNAL_CONNECTORS_ENABLED:[\s\S]*externalRoutingConnectorsEnabled/);
  assert.match(helmConfig,/PUBLIC_PORTAL_BASE_URL:[\s\S]*portalPublicOrigin/);assert.match(helmConfig,/NOTION_OAUTH_CLIENT_ID:[\s\S]*notionOAuthClientId/);
  assert.match(helmWorkloads,/or \(eq \$name "api"\) \(eq \$name "worker"\)[\s\S]*CLIENT_ROUTING_EXTERNAL_CONNECTORS_ENABLED[\s\S]*configMapKeyRef/);
  assert.match(helmValues,/externalRoutingConnectorsEnabled: false/);
  assert.match(helmValues,/notionOAuthClientId: ""/);assert.match(helmValues,/notionOAuthClientSecretReference: ""/);
});
