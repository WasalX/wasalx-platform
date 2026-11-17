import assert from "node:assert/strict";
import test from "node:test";
import {routingStarterSupportGroupIds} from '../packages/core/src/client-routing.ts';

test('starter routing preserves active scope and defaults only the sole first support queue',()=>{
  const active={supportGroupIds:['2','8']};
  const carried=routingStarterSupportGroupIds(active,['9']);
  assert.deepEqual(carried,['2','8']);carried.push('10');assert.deepEqual(active.supportGroupIds,['2','8']);
  assert.deepEqual(routingStarterSupportGroupIds({supportGroupIds:[]},['9']),[]);
  assert.deepEqual(routingStarterSupportGroupIds({},['9']),[]);
  assert.deepEqual(routingStarterSupportGroupIds(undefined,['9']),['9']);
  assert.deepEqual(routingStarterSupportGroupIds(undefined,[]),[]);
  assert.deepEqual(routingStarterSupportGroupIds(undefined,['9','10']),[]);
});
import { clientRoutingApplies, clientRoutingTargetBlockers, deriveClientRoutingFromSourceSnapshots, materializeClientRoutingSourceSnapshot, normalizeRoutingEmail, parseClientRouting, resolveClientRoute } from "../packages/core/src/client-routing.ts";

const definition={schemaVersion:1,name:"Client ownership",supportGroupIds:["2"],fallback:{zammadGroupId:"2"},sources:[
  {id:"manual",name:"Manual overrides",kind:"MANUAL",syncMode:"MANUAL",fieldMapping:{}},
  {id:"notion",name:"Notion clients",kind:"NOTION",syncMode:"HYBRID",secretReference:"secret://tenants/demo/notion",endpointUrl:"https://api.notion.com/v1/data_sources/d9824bdc-8445-4327-be8b-5b47500af6ce/query",scheduleMinutes:15,fieldMapping:{client_id:"Client ID"}},
],clients:[
  {id:"acme",name:"Acme",routeSourceId:"manual",zammadGroupId:"7",ownerId:"12",matchers:[
    {kind:"WHATSAPP_GROUP",sourceId:"manual",connectionId:"10000000-0000-4000-8000-000000000001",value:"120363000000@g.us"},
    {kind:"CLIENT_IDENTIFIER",sourceId:"notion",namespace:"crm",value:"ACME-42"},
    {kind:"EMAIL",sourceId:"notion",value:"support@acme.example"},
    {kind:"DOMAIN",sourceId:"notion",value:"acme.example"},
  ]},
]};

test("parses provider-neutral versioned routing sources",()=>{
  const parsed=parseClientRouting(definition);
  assert.deepEqual(parsed.sources.map(source=>source.kind),["MANUAL","NOTION"]);
  assert.equal(JSON.stringify(parsed).includes("secret-value"),false);
});

test("client routing is explicitly scoped to native support entry queues",()=>{
  const scoped=parseClientRouting(definition);
  assert.equal(clientRoutingApplies(scoped,"2"),true);
  assert.equal(clientRoutingApplies(scoped,"7"),false);
  assert.equal(clientRoutingApplies(scoped,undefined),false);
  const legacy: Omit<typeof definition,"supportGroupIds"> & {supportGroupIds?:string[]}={...definition};delete legacy.supportGroupIds;
  const parsedLegacy=parseClientRouting(legacy);
  assert.equal("supportGroupIds" in parsedLegacy,false,"historical definitions keep their original shape");
  assert.equal(clientRoutingApplies(parsedLegacy,"2"),false,"absence cannot enable new routing");
  assert.equal(clientRoutingApplies(parseClientRouting({...definition,supportGroupIds:[]}),"2"),false);
  for(const ids of [["2","2"],["0"],["2 OR true"],[2],null])assert.throws(()=>parseClientRouting({...definition,supportGroupIds:ids}),/Support entry groups/);
  assert.ok(clientRoutingTargetBlockers(parsedLegacy,{groups:[],owners:[]}).some(value=>value.includes("support entry queues")));
});

test("resolves exact match precedence and fallback deterministically",()=>{
  const parsed=parseClientRouting(definition);
  assert.equal(resolveClientRoute(parsed,{email:"other@acme.example"}).matchedBy,"DOMAIN");
  assert.equal(resolveClientRoute(parsed,{email:"support@acme.example"}).matchedBy,"EMAIL");
  assert.equal(resolveClientRoute(parsed,{identifierNamespace:"CRM",identifier:"ACME-42",email:"support@acme.example"}).matchedBy,"CLIENT_IDENTIFIER");
  assert.equal(resolveClientRoute(parsed,{connectionId:"10000000-0000-4000-8000-000000000001",whatsappGroupId:"120363000000@g.us",identifierNamespace:"crm",identifier:"ACME-42"}).matchedBy,"WHATSAPP_GROUP");
  assert.equal(resolveClientRoute(parsed,{email:"unknown@example.net"}).status,"FALLBACK");
});

test("routing email and domain validation rejects ambiguous or unsafe identities",()=>{
  assert.equal(normalizeRoutingEmail("Ops+Alerts@BÜCHER.example"),"ops+alerts@xn--bcher-kva.example");
  for(const value of ["foo bar@example.com",".owner@example.com","owner..team@example.com","owner@-bad.example","owner@bad-.example","owner@127.0.0.1","owner@[::1]","owner@localhost"]){
    assert.throws(()=>normalizeRoutingEmail(value),/Routing (?:email|domain) is invalid/);
  }
  for(const value of ["-bad.example","bad-.example","bad..example","127.0.0.1"]){
    assert.throws(()=>parseClientRouting({...definition,clients:[{...definition.clients[0],matchers:[{kind:"DOMAIN",sourceId:"manual",value}]}]}),/Routing domain is invalid/);
  }
});

test("validates every primary, escalation, and fallback Zammad destination",()=>{
  const routing=parseClientRouting(definition);const catalog={groups:[{id:"2",active:true,serviceIdentityCanCreate:true},{id:"7",active:true,serviceIdentityCanCreate:true}],owners:[{id:"12",active:true,groupIds:["7"]}]};
  assert.deepEqual(clientRoutingTargetBlockers(routing,catalog),[]);
  assert.deepEqual(clientRoutingTargetBlockers({...routing,clients:[{...routing.clients[0]!,escalationGroupId:"9",escalationOwnerId:"14"}]},catalog),[
    "Acme escalation: Zammad group 9 does not exist","Acme escalation: Zammad owner 14 is not active in group 9",
  ]);
});

test("rejects conflicting match ownership and unsafe connector configuration",()=>{
  assert.throws(()=>parseClientRouting({...definition,clients:[...definition.clients,{...definition.clients[0],id:"other"}]}),/belongs to more than one client/);
  assert.throws(()=>parseClientRouting({...definition,sources:[{id:"notion",name:"Notion",kind:"NOTION",syncMode:"SCHEDULED",scheduleMinutes:15,fieldMapping:{}}]}),/secret reference is invalid/);
  assert.throws(()=>parseClientRouting({...definition,sources:[{id:"http",name:"HTTP",kind:"HTTP_JSON",syncMode:"WEBHOOK",secretReference:"secret://x",endpointUrl:"http://internal",fieldMapping:{}}]}),/HTTPS URL/);
  for(const endpointUrl of ["https://crm.example/routes?access_token=inline","https://crm.example/routes?X-Amz-Credential=inline","https://crm.example/routes?key=inline"]){
    assert.throws(()=>parseClientRouting({...definition,clients:[],sources:[{id:"http",name:"HTTP",kind:"HTTP_JSON",syncMode:"WEBHOOK",secretReference:"secret://x",endpointUrl,fieldMapping:{}}]}),/credential query parameters/);
  }
  assert.equal(parseClientRouting({...definition,clients:[],sources:[{id:"http",name:"HTTP",kind:"HTTP_JSON",syncMode:"WEBHOOK",secretReference:"secret://x",endpointUrl:"https://crm.example/routes?tenant=northstar",fieldMapping:{}}]}).sources[0]?.endpointUrl,"https://crm.example/routes?tenant=northstar");
});

test("applies complete and delta connector snapshots without making Notion special",()=>{
  const parsed=parseClientRouting(definition);const source=parsed.sources.find(item=>item.id==="notion")!;
  const snapshot=materializeClientRoutingSourceSnapshot(source,{sourceId:"notion",revision:0,rows:[]},{mode:"FULL",complete:true,expectedRevision:0,rows:[
    {"Client ID":"acme",client_name:"Acme Logistics",zammad_group_id:"8",owner_id:"14",matcher_kind:"EMAIL",matcher_value:"help@acme.example"},
    {"Client ID":"acme",client_name:"Acme Logistics",zammad_group_id:"8",owner_id:"14",matcher_kind:"DOMAIN",matcher_value:"acme.example"},
    {"Client ID":"beta",client_name:"Beta",zammad_group_id:"9",matcher_kind:"DOMAIN",matcher_value:"beta.example"},
  ]});
  const full=deriveClientRoutingFromSourceSnapshots(parsed,[snapshot]);
  const acme=full.clients.find(client=>client.id==="acme")!;
  assert.equal(acme.name,"Acme");
  assert.equal(acme.zammadGroupId,"7");
  assert.equal(acme.routeSourceId,"manual");
  assert.deepEqual(acme.matchers.map(matcher=>matcher.sourceId),["notion","notion","manual"]);
  assert.equal(resolveClientRoute(full,{email:"hello@beta.example"}).client?.id,"beta");

  const nextSnapshot=materializeClientRoutingSourceSnapshot(source,snapshot,{mode:"DELTA",complete:false,expectedRevision:1,rows:[
    {"Client ID":"beta",deleted:true},
  ]});
  const delta=deriveClientRoutingFromSourceSnapshots(full,[nextSnapshot]);
  assert.equal(delta.clients.some(client=>client.id==="beta"),false);
  assert.equal(resolveClientRoute(delta,{email:"help@acme.example"}).client?.id,"acme");
  assert.equal(delta.clients.find(client=>client.id==="acme")?.matchers.some(matcher=>matcher.sourceId==="manual"),true);
});

test("canonicalizes provider row order so equivalent snapshots produce one deterministic definition",()=>{
  const parsed=parseClientRouting(definition);const source=parsed.sources.find(item=>item.id==="notion")!;const rows=[
    {"Client ID":"beta",client_name:"Beta",zammad_group_id:"9",matcher_kind:"DOMAIN",matcher_value:"beta.example"},
    {"Client ID":"acme",client_name:"Acme",zammad_group_id:"7",matcher_kind:"EMAIL",matcher_value:"help@acme.example"},
  ];
  const left=materializeClientRoutingSourceSnapshot(source,{sourceId:"notion",revision:0,rows:[]},{mode:"FULL",complete:true,expectedRevision:0,rows});
  const right=materializeClientRoutingSourceSnapshot(source,{sourceId:"notion",revision:0,rows:[]},{mode:"FULL",complete:true,expectedRevision:0,rows:[...rows].reverse()});
  assert.deepEqual(left,right);assert.deepEqual(deriveClientRoutingFromSourceSnapshots(parsed,[left]),deriveClientRoutingFromSourceSnapshots(parsed,[right]));
});

test("fails closed on ambiguous source updates and requires explicit deletion",()=>{
  const parsed=parseClientRouting(definition);const source=parsed.sources.find(item=>item.id==="notion")!;const empty={sourceId:"notion",revision:0,rows:[]};
  assert.throws(()=>materializeClientRoutingSourceSnapshot(source,empty,{mode:"FULL",complete:false,expectedRevision:0,rows:[]}),/complete full pull/);
  assert.throws(()=>materializeClientRoutingSourceSnapshot(source,empty,{mode:"DELTA",complete:false,expectedRevision:1,rows:[]}),/changed; refresh/);
  assert.throws(()=>materializeClientRoutingSourceSnapshot(source,empty,{mode:"DELTA",complete:false,expectedRevision:0,rows:[
    {"Client ID":"acme",deleted:true,matcher_kind:"DOMAIN",matcher_value:"acme.example"},
  ]}),/tombstone cannot include route or matcher fields/);
  const snapshot=materializeClientRoutingSourceSnapshot(source,empty,{mode:"FULL",complete:true,expectedRevision:0,rows:[
    {"Client ID":"other",client_name:"Other",zammad_group_id:"9",matcher_kind:"DOMAIN",matcher_value:"acme.example"},
  ]});
  const protectedDefinition=parseClientRouting({...definition,clients:[{...definition.clients[0],matchers:[...definition.clients[0].matchers,{kind:"DOMAIN",sourceId:"manual",value:"acme.example"}]}]});
  assert.throws(()=>deriveClientRoutingFromSourceSnapshots(protectedDefinition,[snapshot]),/belongs to more than one client/);
});

test("rebuilds from all last-known-good snapshots and rejects external route disagreement",()=>{
  const parsed=parseClientRouting({...definition,sources:[...definition.sources,{id:"zoho",name:"Zoho",kind:"ZOHO",syncMode:"WEBHOOK",secretReference:"secret://tenants/demo/zoho",endpointUrl:"https://www.zohoapis.eu/crm/v8/Accounts",fieldMapping:{}}]});
  const notion=parsed.sources.find(item=>item.id==="notion")!;const zoho=parsed.sources.find(item=>item.id==="zoho")!;
  const notionSnapshot=materializeClientRoutingSourceSnapshot(notion,{sourceId:"notion",revision:0,rows:[]},{mode:"FULL",complete:true,expectedRevision:0,rows:[
    {"Client ID":"beta",client_name:"Beta",zammad_group_id:"9",matcher_kind:"DOMAIN",matcher_value:"beta.example"},
  ]});
  const zohoSnapshot=materializeClientRoutingSourceSnapshot(zoho,{sourceId:"zoho",revision:0,rows:[]},{mode:"FULL",complete:true,expectedRevision:0,rows:[
    {client_id:"beta",client_name:"Beta",zammad_group_id:"10",matcher_kind:"CLIENT_IDENTIFIER",matcher_value:"BETA-1",matcher_namespace:"zoho"},
  ]});
  assert.throws(()=>deriveClientRoutingFromSourceSnapshots(parsed,[notionSnapshot,zohoSnapshot]),/route fields conflict/);
  assert.throws(()=>deriveClientRoutingFromSourceSnapshots(parsed,[notionSnapshot]),/zoho is missing/);
});

test("fails closed when an external ownership source disappears but another source still matches",()=>{
  const parsed=parseClientRouting({...definition,sources:[...definition.sources,{id:"zoho",name:"Zoho",kind:"ZOHO",syncMode:"WEBHOOK",secretReference:"secret://tenants/demo/zoho",endpointUrl:"https://www.zohoapis.eu/crm/v8/Accounts",fieldMapping:{}}],clients:[{
    ...definition.clients[0],routeSourceId:"notion",matchers:definition.clients[0].matchers.filter(matcher=>matcher.sourceId!=="manual").concat({kind:"CLIENT_IDENTIFIER",sourceId:"zoho",namespace:"zoho",value:"ACME-1"}),
  }]});
  const notion=parsed.sources.find(item=>item.id==="notion")!;const zoho=parsed.sources.find(item=>item.id==="zoho")!;
  const notionSnapshot=materializeClientRoutingSourceSnapshot(notion,{sourceId:"notion",revision:0,rows:[]},{mode:"FULL",complete:true,expectedRevision:0,rows:[]});
  const zohoSnapshot=materializeClientRoutingSourceSnapshot(zoho,{sourceId:"zoho",revision:0,rows:[]},{mode:"FULL",complete:true,expectedRevision:0,rows:[
    {client_id:"acme",client_name:"Acme",zammad_group_id:"7",owner_id:"12",matcher_kind:"CLIENT_IDENTIFIER",matcher_value:"ACME-1",matcher_namespace:"zoho"},
  ]});
  assert.throws(()=>deriveClientRoutingFromSourceSnapshots(parsed,[notionSnapshot,zohoSnapshot]),/route source notion no longer supplies/);
});
