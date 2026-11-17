import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  RuleGovernanceService,
  requireRuleIdempotencyKey,
  requireRuleSetUuid,
  ruleMetricDays,
} from "../services/control-api/dist/rule-governance.service.js";
import { RuleTestService } from "../services/control-api/dist/rule-test.service.js";
import { InboundRepository } from "../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js";

const tenantId="10000000-0000-4000-8000-000000000001";
const setId="14000000-0000-4000-8000-000000000001";
const familyId="14100000-0000-4000-8000-000000000001";
const ruleId="14200000-0000-4000-8000-000000000001";
const principal={
  subject:"owner-a",
  userId:"10100000-0000-4000-8000-000000000001",
  tenantId,
  email:"owner@a.invalid",
  displayName:"Owner A",
  role:"tenant_owner",
};

function snapshotDatabase(savedExamples, matcherOptions={digitLength:10}){
  const client={query:async sql=>{
    if(sql.includes("FROM rule_sets s"))return{rows:[{
      id:setId,tenant_id:tenantId,family_id:familyId,name:"Operations",
      version:2,state:"DRAFT",revision:1,snapshot_sha256:"a".repeat(64),
      supersedes_rule_set_id:null,rollback_source_rule_set_id:null,
      created_at:"2026-08-09T00:00:00.000Z",activated_at:null,retired_at:null,
    }]};
    if(sql.includes("FROM trigger_rules"))return{rows:[{
      id:ruleId,name:"Ten digits",matcher_type:"exact_length",pattern:"[0-9]{10}",
      matcher_options:matcherOptions,priority:1,enabled:true,
      saved_examples:savedExamples,
    }]};
    throw new Error(`Unexpected rule snapshot query: ${sql}`);
  }};
  return{withTenant:async(id,operation)=>{
    assert.equal(id,tenantId);
    return operation(client);
  }};
}

test("rule governance validates identifiers, metric windows, and idempotency headers",()=>{
  assert.equal(requireRuleSetUuid(setId),setId);
  assert.equal(requireRuleIdempotencyKey("activate-operations-v2"),"activate-operations-v2");
  assert.equal(ruleMetricDays(undefined),30);
  assert.equal(ruleMetricDays("365"),365);
  assert.throws(()=>requireRuleSetUuid("not-a-uuid"),/must be a UUID/);
  assert.throws(()=>requireRuleIdempotencyKey("has whitespace"),/Idempotency-Key/);
  assert.throws(()=>ruleMetricDays(366),/between 1 and 365/);
});

test("saved Arabic-Indic examples participate in activation readiness",async()=>{
  const service=new RuleGovernanceService(snapshotDatabase([{
    name:"Arabic digits",message:"Shipment ١٢٣٤٥٦٧٨٩٠",expectedMatches:["1234567890"],
  }]),new RuleTestService());
  const readiness=await service.readiness(principal,setId);
  assert.equal(readiness.ready,true);
  assert.equal(readiness.checkedExamples,1);
  assert.deepEqual(readiness.blockers,[]);
});

test("readiness evaluates saved sender contexts against versioned team policy",async()=>{
  for(const sender of ["team","customer","unknown"]){
    const expectedMatches=sender==="customer"?["1234567890"]:[];
    const service=new RuleGovernanceService(snapshotDatabase([{
      name:"Sender policy",message:"1234567890",sender,expectedMatches,
    }],{digitLength:10,teamSenderPolicy:"exclude"}),new RuleTestService());
    const readiness=await service.readiness(principal,setId);
    assert.equal(readiness.ready,true);
    assert.equal(readiness.checkedExamples,1);
  }
});

test("group commands require a slash-prefixed starts-with matcher",async()=>{
  const service=new RuleGovernanceService({withTenant:async()=>{throw new Error("invalid command must fail before database access")}},new RuleTestService());
  await assert.rejects(()=>service.create(principal,"create-command","request-command",{name:"Unsafe command",rules:[{name:"Status",matcherType:"contains",pattern:"status",matcherOptions:{groupCommand:{actionId:"orders.status",input:{reference:"{{message.argument}}"},successReply:"{{action.state}}",failureReply:"{{action.error}}"}},priority:1,enabled:true,savedExamples:[]}]}),/slash-prefixed starts-with matcher/);
});

test("a cloned group rule preserves inherited action pins and resolves only newly added actions",async()=>{
  const sourceId="14000000-0000-4000-8000-000000000021";
  const cloneId="14000000-0000-4000-8000-000000000022";
  const inheritedAction={id:"45000000-0000-4000-8000-000000000021",action_key:"orders.lookup",active_revision_id:"45100000-0000-4000-8000-000000000021",response_mapping:{"action.status":"/status"},kind:"HTTP_JSON",endpoint_url:"https://orders.example/v1",http_method:"GET",auth_scheme:"NONE",secret_reference:null};
  const addedAction={id:"45000000-0000-4000-8000-000000000022",action_key:"orders.update",active_revision_id:"45100000-0000-4000-8000-000000000022",response_mapping:{"action.updated":"/updated"},kind:"HTTP_JSON",endpoint_url:"https://orders.example/update",http_method:"POST",auth_scheme:"NONE",secret_reference:null};
  const rules=[
    {id:"14200000-0000-4000-8000-000000000021",name:"Lookup",matcher_type:"starts_with",pattern:"/lookup",matcher_options:{groupCommand:{actionId:inheritedAction.action_key,input:{},successReply:"{{action.status}}",failureReply:"{{action.error}}"}},priority:1,enabled:true,saved_examples:[]},
    {id:"14200000-0000-4000-8000-000000000022",name:"Update",matcher_type:"starts_with",pattern:"/update",matcher_options:{groupCommand:{actionId:addedAction.action_key,input:{},successReply:"{{action.updated}}",failureReply:"{{action.error}}"}},priority:2,enabled:true,saved_examples:[]},
  ];
  const set={id:cloneId,tenant_id:tenantId,family_id:familyId,name:"Operations",version:2,state:"DRAFT",revision:1,snapshot_sha256:"e".repeat(64),supersedes_rule_set_id:sourceId,rollback_source_rule_set_id:null,created_at:"2026-08-24T00:00:00.000Z",activated_at:null,retired_at:null};
  let copied=false;let added=false;let activeCatalogReads=0;
  const client={query:async(sql,values=[])=>{
    if(sql.includes("FROM rule_set_operations"))return{rows:[]};
    if(sql.includes("pg_advisory_xact_lock")||sql.includes("INSERT INTO audit_events")||sql.includes("INSERT INTO rule_set_operations"))return{rows:[],rowCount:1};
    if(sql.includes("FROM rule_sets s")&&sql.includes("JOIN rule_families"))return{rows:[set]};
    if(sql.includes("FROM trigger_rules")&&!sql.includes("JOIN rule_sets"))return{rows:rules};
    if(sql.includes("SELECT id FROM rule_families"))return{rows:[{id:familyId}]};
    if(sql.includes("INSERT INTO automation_action_revision_pins")&&sql.includes("SELECT pin.tenant_id,$1")){copied=true;assert.deepEqual(values,[cloneId,tenantId,sourceId,[inheritedAction.action_key,addedAction.action_key]]);return{rows:[],rowCount:1};}
    if(sql.includes("FROM automation_action_revision_pins pin"))return{rows:added?[inheritedAction,addedAction]:copied?[inheritedAction]:[]};
    if(sql.includes("FROM bot_action_definitions")&&sql.includes("state='ACTIVE'")){activeCatalogReads+=1;assert.deepEqual(values,[tenantId,[addedAction.action_key]]);return{rows:[addedAction]};}
    if(sql.includes("INSERT INTO automation_action_revision_pins")){assert.deepEqual(values,[tenantId,cloneId,addedAction.id,addedAction.active_revision_id]);added=true;return{rows:[],rowCount:1};}
    if(sql.includes("FROM rule_sets")&&sql.includes("state='ACTIVE'"))return{rows:[]};
    if(sql.includes("UPDATE group_bindings"))return{rows:[],rowCount:0};
    if(sql.includes("UPDATE rule_sets")&&sql.includes("SET state='ACTIVE'"))return{rows:[{...set,state:"ACTIVE",revision:2}],rowCount:1};
    throw new Error(`Unexpected cloned group action query: ${sql}`);
  }};
  const service=new RuleGovernanceService({withTenant:async(_tenant,callback)=>callback(client)},new RuleTestService());
  const result=await service.activate(principal,cloneId,"activate-cloned-actions","request-cloned-actions",{expectedRevision:1,expectedActiveRuleSetId:null,expectedActiveRevision:null});
  assert.equal(result.id,cloneId);assert.equal(copied,true);assert.equal(added,true);assert.equal(activeCatalogReads,1);
});

test("changed rule behavior blocks activation through saved-example mismatch",async()=>{
  const service=new RuleGovernanceService(snapshotDatabase([{
    name:"Regression",message:"Shipment 1234567890",expectedMatches:["9999999999"],
  }]),new RuleTestService());
  const readiness=await service.readiness(principal,setId);
  assert.equal(readiness.ready,false);
  assert.equal(readiness.blockers[0]?.code,"SAVED_EXAMPLE_MISMATCH");
});

test("group-rule rollback copies the source action revision instead of the current catalog revision",async()=>{
  const sourceId="14000000-0000-4000-8000-000000000011";
  const activeId="14000000-0000-4000-8000-000000000012";
  const rollbackId="14000000-0000-4000-8000-000000000013";
  const actionId="45000000-0000-4000-8000-000000000011";
  const revisionOneId="45100000-0000-4000-8000-000000000011";
  const sourceRule={id:"14200000-0000-4000-8000-000000000011",name:"Historical status",matcher_type:"starts_with",pattern:"/status",matcher_options:{groupCommand:{actionId:"orders.rollback",input:{},successReply:"{{action.status}}",failureReply:"{{action.error}}"}},priority:1,enabled:true,saved_examples:[]};
  const setRow=(id,state,version,revision)=>({id,tenant_id:tenantId,family_id:familyId,name:"Operations",version,state,revision,snapshot_sha256:String(version).repeat(64),supersedes_rule_set_id:null,rollback_source_rule_set_id:null,created_at:"2026-08-24T00:00:00.000Z",activated_at:state==="DRAFT"?null:"2026-08-24T00:00:00.000Z",retired_at:state==="RETIRED"?"2026-08-24T01:00:00.000Z":null});
  let copied=0;
  const client={query:async(sql,values=[])=>{
    if(sql.includes("FROM rule_set_operations"))return{rows:[]};
    if(sql.includes("pg_advisory_xact_lock")||sql.includes("INSERT INTO audit_events")||sql.includes("INSERT INTO rule_set_operations"))return{rows:[],rowCount:1};
    if(sql.includes("FROM rule_sets s")&&sql.includes("JOIN rule_families"))return{rows:[values[1]===rollbackId?setRow(rollbackId,"DRAFT",3,1):setRow(sourceId,"RETIRED",1,2)]};
    if(sql.includes("FROM trigger_rules")&&!sql.includes("JOIN rule_sets"))return{rows:[sourceRule]};
    if(sql.includes("FROM rule_sets")&&sql.includes("state='ACTIVE'"))return{rows:[setRow(activeId,"ACTIVE",2,2)]};
    if(sql.includes("COALESCE(MAX(version),0)+1"))return{rows:[{version:3}]};
    if(sql.includes("app.create_rule_set_snapshot"))return{rows:[{id:rollbackId,family_id:familyId,version:3,state:"DRAFT",revision:1,snapshot_sha256:"3".repeat(64)}]};
    if(sql.includes("INSERT INTO automation_action_revision_pins")&&sql.includes("SELECT pin.tenant_id,$1")){copied+=1;assert.deepEqual(values,[rollbackId,tenantId,sourceId,["orders.rollback"]]);assert.match(sql,/ON CONFLICT DO NOTHING/);return{rows:[],rowCount:1};}
    if(sql.includes("FROM automation_action_revision_pins pin"))return{rows:[{id:actionId,action_key:"orders.rollback",active_revision_id:revisionOneId,response_mapping:{"action.status":"/status"},kind:"HTTP_JSON",endpoint_url:"https://revision-one.example/status",http_method:"GET",auth_scheme:"NONE",secret_reference:null}]};
    if(sql.includes("FROM bot_action_definitions")&&sql.includes("state='ACTIVE'"))throw new Error("rollback must not resolve current action revision two");
    if(sql.includes("FROM whatsapp_groups group_record")&&sql.includes("FOR UPDATE OF group_record"))return{rows:[{id:"40000000-0000-4000-8000-000000000004"}]};
    if(sql.includes("UPDATE rule_sets")&&sql.includes("SET state='RETIRED'"))return{rows:[setRow(activeId,"RETIRED",2,3)],rowCount:1};
    if(sql.includes("UPDATE group_bindings"))return{rows:[],rowCount:1};
    if(sql.includes("UPDATE rule_sets")&&sql.includes("SET state='ACTIVE'"))return{rows:[{id:rollbackId,family_id:familyId,version:3,state:"ACTIVE",revision:2,snapshot_sha256:"3".repeat(64)}],rowCount:1};
    throw new Error(`Unexpected rollback query: ${sql}`);
  }};
  const service=new RuleGovernanceService({withTenant:async(_tenant,callback)=>callback(client)},new RuleTestService());
  const result=await service.rollback(principal,sourceId,"rollback-group-v1","request-rollback-group",{expectedSourceRevision:2,expectedActiveRuleSetId:activeId,expectedActiveRevision:2});
  assert.equal(result.id,rollbackId);
  assert.equal(result.rollbackSourceRuleSetId,sourceId);
  assert.equal(copied,1);
});

test("create operations replay the original result and use sealed database functions",async()=>{
  let operation;
  const statements=[];
  const client={query:async(sql,values=[])=>{
    statements.push(sql);
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM rule_set_operations"))return{rows:operation?[operation]:[]};
    if(sql.includes("SELECT id FROM rule_families"))return{rows:[]};
    if(sql.includes("app.create_rule_family"))return{rows:[{id:familyId}]};
    if(sql.includes("app.create_rule_set_snapshot"))return{rows:[{
      id:setId,family_id:familyId,version:1,state:"DRAFT",revision:1,
      snapshot_sha256:"b".repeat(64),
    }]};
    if(sql.includes("INSERT INTO audit_events"))return{rows:[]};
    if(sql.includes("INSERT INTO rule_set_operations")){
      operation={action:values[1],request_sha256:values[3],result:values[6]};
      return{rows:[]};
    }
    throw new Error(`Unexpected create query: ${sql}`);
  }};
  const database={withTenant:async(id,callback)=>{
    assert.equal(id,tenantId);
    return callback(client);
  }};
  const service=new RuleGovernanceService(database,new RuleTestService());
  const input={name:"Operations",rules:[{
    name:"Ten digits",matcherType:"exact_length",pattern:"[0-9]{10}",
    matcherOptions:{digitLength:10},priority:1,enabled:true,
    savedExamples:[{name:"Positive",message:"ID 1234567890",expectedMatches:["1234567890"]}],
  }]};
  const created=await service.create(principal,"create-operations","request-create",input);
  const replayed=await service.create(principal,"create-operations","request-create-replay",input);
  assert.equal(created.id,setId);
  assert.equal(created.duplicate,false);
  assert.equal(replayed.id,setId);
  assert.equal(replayed.duplicate,true);
  const replayReads=statements.filter(sql=>sql.includes("FROM rule_set_operations"));
  assert.ok(replayReads.length>=2);
  assert.ok(replayReads.every(sql=>!sql.includes("FOR UPDATE")),"append-only replay reads must rely on the preceding advisory transaction lock");
  const familyRead=statements.find(sql=>sql.includes("SELECT id FROM rule_families"));
  assert.ok(familyRead&&!familyRead.includes("FOR UPDATE"),"immutable family existence reads must rely on the preceding family advisory lock");
  assert.equal(statements.filter(sql=>sql.includes("app.create_rule_set_snapshot")).length,1);
  assert.equal(statements.some(sql=>/INSERT INTO trigger_rules/.test(sql)),false);
});

test("migration seals snapshots, scopes lineage, and forces tenant isolation",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0025_rule_governance.sql",import.meta.url),"utf8");
  const familyLookupFix=await readFile(new URL("../services/control-api/migrations/0038_rule_snapshot_family_lookup.sql",import.meta.url),"utf8");
  assert.match(sql,/FOREIGN KEY \(tenant_id,supersedes_rule_set_id\)/);
  assert.match(sql,/FOREIGN KEY \(tenant_id,rollback_source_rule_set_id\)/);
  assert.match(sql,/FOREIGN KEY \(tenant_id,event_inbox_id,rule_set_id\)/);
  assert.match(sql,/FOREIGN KEY \(tenant_id,rule_set_id,trigger_rule_id\)/);
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.create_rule_set_snapshot/);
  assert.match(sql,/SECURITY DEFINER\s+SET search_path=pg_catalog,app/);
  assert.match(sql,/REVOKE INSERT,UPDATE,DELETE ON trigger_rules FROM wasalx_app/);
  assert.match(sql,/REVOKE INSERT,UPDATE ON rule_sets FROM wasalx_app/);
  assert.match(sql,/GRANT SELECT,INSERT ON rule_set_operations,rule_match_observations TO wasalx_app/);
  assert.doesNotMatch(sql,/GRANT UPDATE[^;]*rule_set_operations/u);
  assert.match(sql,/REVOKE ALL ON FUNCTION app\.create_rule_set_snapshot[^;]+ FROM PUBLIC/);
  assert.match(sql,/'rule_families','rule_set_operations','rule_match_observations'/);
  assert.match(sql,/EXECUTE format\('ALTER TABLE %I ENABLE ROW LEVEL SECURITY'/);
  assert.match(sql,/EXECUTE format\('ALTER TABLE %I FORCE ROW LEVEL SECURITY'/);
  assert.match(sql,/event_inbox_rule_snapshot_once/);
  assert.doesNotMatch(sql,/message_body|normalized_reference/);
  assert.match(familyLookupFix,/FROM public\.rule_families AS family/);
  assert.match(familyLookupFix,/family\.tenant_id=current_tenant/);
  assert.match(familyLookupFix,/family\.id=requested_family_id/);
  assert.match(familyLookupFix,/family\.name=requested_name/);
});

test("runtime pins retry evaluation and writes body-free idempotent observations",async()=>{
  const repository=await readFile(new URL("../services/connector-worker/src/inbound-repository.ts",import.meta.url),"utf8");
  const processor=await readFile(new URL("../services/connector-worker/src/inbound-processor.ts",import.meta.url),"utf8");
  assert.match(repository,/governing_rule_set_id IS NULL/);
  assert.match(repository,/s\.id=e\.governing_rule_set_id/);
  assert.match(repository,/s\.state IN \('ACTIVE','RETIRED'\)/);
  assert.match(repository,/ON CONFLICT \(tenant_id,event_inbox_id,trigger_rule_id\) DO NOTHING/);
  assert.match(processor,/recordRuleObservations\?\.\(event, context, rules, matches\)/);
  assert.ok(
    processor.indexOf("recordRuleObservations")<processor.indexOf("references.length === 0"),
    "unmatched evaluations must be observed before the early return",
  );
});

test("observation persistence emits bounded counts without message content",async()=>{
  const queries=[];
  const client={
    query:async(sql,values=[])=>{queries.push({sql,values});return{rows:[]}},
    release:()=>{},
  };
  const repository=new InboundRepository({connect:async()=>client});
  await repository.recordRuleObservations(
    {
      id:"14300000-0000-4000-8000-000000000001",tenantId,
      connectionId:"12000000-0000-4000-8000-000000000001",provider:"waha",
      providerEventId:"event-sensitive",eventType:"message",attempts:1,
      payload:{body:"sensitive customer message 1234567890"},
    },
    {bindingId:"15000000-0000-4000-8000-000000000001",ruleSetId:setId},
    [{id:ruleId,enabled:true},{id:"14200000-0000-4000-8000-000000000002",enabled:false}],
    [{ruleId},{ruleId}],
  );
  const insert=queries.find(query=>query.sql.includes("INSERT INTO rule_match_observations"));
  assert.ok(insert);
  assert.deepEqual(insert.values,[
    tenantId,"14300000-0000-4000-8000-000000000001",
    "15000000-0000-4000-8000-000000000001",setId,[ruleId],[2],
  ]);
  assert.doesNotMatch(JSON.stringify(insert.values),/sensitive customer message|1234567890/);
  assert.match(insert.sql,/ON CONFLICT .* DO NOTHING/s);
});

test("group sender lookup delegates scoped original identities without trusting message flags",async()=>{
  for(const [participantId,expected] of [
    ["12025550120@c.us","team"],
    ["123456789@lid","team"],
    ["123456789@lid","unknown"],
    ["12025550121@s.whatsapp.net","customer"],
  ]){
    const queries=[];
    const client={query:async(sql,values=[])=>{
      queries.push({sql,values});
      return{rows:sql.includes("app.group_rule_sender")?[{sender:expected}]:[]};
    },release:()=>{}};
    const repository=new InboundRepository({connect:async()=>client});
    const result=await repository.groupRuleSender({tenantId,connectionId:"connection-a"},{groupId:"group-a",participantId,fromMe:true,participantPhone:"12025550182"});
    assert.equal(result,expected);
    const lookup=queries.find(query=>query.sql.includes("app.group_rule_sender"));
    assert.deepEqual(lookup.values.slice(0,4),[tenantId,"connection-a","group-a",participantId]);
    assert.equal(lookup.values.length,4);


  }
});

test("review sender classification follows its durable source rather than synthetic payload",async()=>{
  const queries=[];
  const client={query:async(sql,values=[])=>{
    queries.push({sql,values});
    return{rows:sql.includes("SELECT message.external_message_id")
      ?[{external_message_id:"provider-message-1",external_participant_id:"12025550120@c.us",participant_name:"Team member",from_me:false,from_api:false}]
      :sql.includes("app.group_rule_sender")?[{sender:"team"}]:[]};
  },release:()=>{}};
  const repository=new InboundRepository({connect:async()=>client});
  const event={tenantId,id:"reprocess-a",connectionId:"connection-a",eventType:"quarantine.reprocess",payload:{quarantineId:"review-a"}};
  const original=await repository.originalReprocessParticipant(event,"group-a");
  assert.deepEqual(original,{replyToMessageId:"provider-message-1",participantId:"12025550120@c.us",participantName:"Team member",fromMe:false,fromApi:false});
  assert.equal(await repository.groupRuleSender(event,
    {groupId:"group-a",participantId:"wasalx-review",...original}),"team");
  assert.deepEqual(queries.find(query=>query.sql.includes("SELECT message.external_message_id")).values,
    [tenantId,"review-a","reprocess-a","connection-a","group-a"]);
  assert.equal(queries.find(query=>query.sql.includes("app.group_rule_sender")).values[3],"12025550120@c.us");
});
