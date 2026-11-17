import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { metaRoutingUnits, reduceMetaRouting, metaThreadControlBody, parseMetaRoutingDeclaration, parseMetaRoutingReview, metaRoutingRuntime } from "../packages/core/dist/meta-routing.js";
import { HttpMetaGroupsClient } from "../services/control-api/dist/meta-groups.client.js";
import { Reflector } from "../services/control-api/node_modules/@nestjs/core/index.js";
import { MetaRoutingController,MetaThreadControlController,PlatformMetaRoutingController } from "../services/control-api/dist/meta-routing.controller.js";
import { PermissionGuard } from "../services/control-api/dist/permission.guard.js";
import { PlatformOperatorGuard } from "../services/control-api/dist/platform-operator-auth.js";

const phone = "123456789", account = "987654321", user = "16505550100", operation = "2d43a672-a278-4e34-8d03-b7bf1563ac90";
const time = "1760000000";
const value = (extra = {}) => ({ messaging_product: "whatsapp", metadata: { phone_number_id: phone }, ...extra });
const message = (extra = {}) => ({ id: "wamid.synthetic", from: user, timestamp: time, type: "text", text: { body: "synthetic" }, ...extra });
const handover = (type, extra = {}) => ({ messaging_product: "whatsapp", recipient: { phone_number_id: phone }, type, timestamp: time, ...extra });
const primary = () => metaRoutingUnits(account, "messages", value({ messages: [message()] }))[0].evidence;

test('anonymised first manual-connection webhook retains primary BSUID and phone identities',()=>{
  // Shape of the actual rejected DEV callback; every identifier and message is synthetic.
  const payload=JSON.parse(readFileSync(new URL('./fixtures/meta-primary-delivery-webhook.json',import.meta.url),'utf8'));
  const change=payload.entry[0].changes[0],unit=metaRoutingUnits(payload.entry[0].id,change.field,change.value)[0];
  assert.equal(unit.evidence.category,'PRIMARY_MESSAGE');
  assert.deepEqual(unit.evidence.peer,{kind:'BSUID',value:'SA.1234567890123456'});
  delete change.value.messages[0].from_user_id;delete change.value.contacts[0].user_id;
  assert.deepEqual(metaRoutingUnits(payload.entry[0].id,change.field,change.value)[0].evidence.peer,{kind:'PHONE',value:'12025550104'});
});

test('actual routing controllers retain tenant permissions and the separate operator boundary',async()=>{
  const reflector=new Reflector(),guard=new PermissionGuard(reflector);
  const context=(controller,method,request)=>({getClass:()=>controller,getHandler:()=>controller.prototype[method],switchToHttp:()=>({getRequest:()=>request})});
  for(const [controller,method,permission] of [[MetaRoutingController,'get','connection:read'],[MetaRoutingController,'declare','connection:write'],[MetaThreadControlController,'inspect','bot:read'],[MetaThreadControlController,'execute','bot:operate']]){
    assert.equal(reflector.getAllAndOverride('wasalx:permission',[controller.prototype[method],controller]),permission);
    assert.equal(reflector.getAllAndOverride('wasalx:public',[controller.prototype[method],controller]),undefined);
    assert.throws(()=>guard.canActivate(context(controller,method,{})),/permission/);
    assert.equal(guard.canActivate(context(controller,method,{principal:{role:'tenant_owner'}})),true);
  }
  assert.equal(reflector.getAllAndOverride('wasalx:public',[PlatformMetaRoutingController]),true);
  assert.equal(reflector.getAllAndOverride('wasalx:platform-operator',[PlatformMetaRoutingController]),true);
  assert.ok(Reflect.getMetadata('__guards__',PlatformMetaRoutingController).includes(PlatformOperatorGuard));
  let verified=0;const operator=new PlatformOperatorGuard({authenticate:async header=>{assert.equal(header,'Bearer synthetic-platform');verified++;return{subject:'synthetic-operator'}}},reflector);
  await assert.rejects(()=>operator.canActivate(context(PlatformMetaRoutingController,'review',{headers:{authorization:'Bearer synthetic-platform','x-wasalx-tenant-id':operation}})),/tenant-session/);
  assert.equal(verified,0);
  const request={headers:{authorization:'Bearer synthetic-platform'}};
  assert.equal(await operator.canActivate(context(PlatformMetaRoutingController,'review',request)),true);
  assert.equal(verified,1);assert.equal(request.platformOperator.subject,'synthetic-operator');
});

test("typed passive units preserve their source and never flatten traffic or collide across users", () => {
  const units = metaRoutingUnits(account, "standby", value({ standby: {
    messages: [message(), message({ from: "16505550101" })],
    message_echoes: [{ id: "echo", timestamp: time, to: user, type: "text", text: { body: "context" } }],
    statuses: [{ id: "own-collision", timestamp: time, status: "delivered" }],
  } }));
  assert.deepEqual(units.map(u => u.evidence.category), ["STANDBY_MESSAGE", "STANDBY_MESSAGE", "STANDBY_ECHO", "STANDBY_STATUS"]);
  assert.equal(new Set(units.map(u => u.evidence.payloadSha256)).size, 4);
  for (const unit of units) { assert.equal(unit.field, "standby"); assert.equal(unit.value.messages, undefined); assert.equal(Object.keys(unit.value.standby).length, 1); }
  assert.equal(units[3].evidence.peer, undefined);
  assert.equal(reduceMetaRouting(undefined, units[3].evidence, true), undefined);
});

test("handovers permit absent optional roles and sender but never invent a BSUID", () => {
  for (const type of ["control_passed", "control_taken"]) {
    const noPeer = metaRoutingUnits(account, "messaging_handovers", handover(type, { sender: { user_id: "SA.unsupported" } }))[0];
    assert.equal(noPeer.evidence.peer, undefined);
    if (type === "control_passed") assert.equal(reduceMetaRouting(undefined, noPeer.evidence, true), undefined);
    const known = metaRoutingUnits(account, "messaging_handovers", handover(type, { sender: { phone_number: user } }))[0];
    assert.deepEqual(known.evidence.peer, { kind: "PHONE", value: user });
    assert.throws(() => metaRoutingUnits(account, "messaging_handovers", handover(type, { sender: null })));
  }
  assert.throws(() => metaRoutingUnits(account, "messaging_handovers", handover("release")));
});

test("direct live units isolate adjacent receipts and honor the existing BSUID identity contract", () => {
  const units = metaRoutingUnits(account, "messages", value({ messages: [message({ from_user_id: "SA.synthetic" })], statuses: [{ id: "other", timestamp: time, status: "read", recipient_id: user }] }));
  assert.equal(units[0].value.statuses, undefined); assert.equal(units[1].value.messages, undefined);
  assert.deepEqual(units[0].evidence.peer, { kind: "BSUID", value: "SA.synthetic" });
  assert.throws(() => metaRoutingUnits("foreign", "messages", value({ messages: [message()] })));
  assert.throws(() => metaRoutingUnits(account, "standby", value({ messages: [message()] })));
  assert.throws(() => metaRoutingUnits(account, "standby", value({ standby: { messages: [message({ group_id: "group" })] } })));
});

test("ownership requires configuration, conflicts hold, user inactivity invalidates epochs", () => {
  const p = primary();
  assert.equal(reduceMetaRouting(undefined, p, false).state, "UNKNOWN");
  const owned = reduceMetaRouting(undefined, p, true);
  assert.equal(owned.state, "OWN"); assert.equal(owned.epoch, 1);
  assert.deepEqual(reduceMetaRouting(owned, p, true), owned);
  const later = { ...p, observedAt: new Date(Date.parse(p.observedAt) + 1000).toISOString(), payloadSha256: "a".repeat(64) };
  assert.equal(reduceMetaRouting(owned, later, true).epoch, 1);
  const negative = { ...p, category: "CONTROL_TAKEN", payloadSha256: "b".repeat(64) };
  assert.equal(reduceMetaRouting(owned, negative, true).state, "UNKNOWN");
  assert.equal(reduceMetaRouting(reduceMetaRouting(undefined, negative, true), p, true).state, "UNKNOWN");
  for (const events of [[p, negative, { ...p, payloadSha256: "c".repeat(64) }], [negative, p, { ...negative, payloadSha256: "d".repeat(64) }]]) {
    let state; for (const event of events) state = reduceMetaRouting(state, event, true);
    assert.equal(state.state, "UNKNOWN");
  }
  assert.equal(reduceMetaRouting(owned, { ...later, observedAt: new Date(Date.parse(p.observedAt) + 86_400_000).toISOString() }, true).epoch, 2);
  for (const category of ["OWN_MESSAGE_STATUS", "STANDBY_STATUS", "STANDBY_ECHO"]) assert.deepEqual(reduceMetaRouting(owned, { ...later, category }, true), owned);
  const standby=reduceMetaRouting(owned,{...later,category:'STANDBY_MESSAGE'},true);
  assert.equal(standby.state,'STANDBY');assert.equal(standby.lastCustomerMessageAt,later.observedAt);
  const control=reduceMetaRouting(standby,{...later,category:'CONTROL_PASSED',observedAt:new Date(Date.parse(later.observedAt)+1000).toISOString(),payloadSha256:'e'.repeat(64)},true);
  assert.equal(control.lastCustomerMessageAt,later.observedAt,'control never fabricates later user activity');
});

test("thread control emits exactly one provider recipient and finite pass targets", () => {
  assert.deepEqual(metaThreadControlBody("take", undefined, { kind: "BSUID", value: "SA.synthetic" }, operation), { messaging_product: "whatsapp", action: "take", recipient: "SA.synthetic", metadata: operation });
  assert.equal(metaThreadControlBody("release", undefined, { kind: "PHONE", value: user }, operation).to, user);
  for (const role of ["ai_agent", "ctwa", "customer_service", "escalation", "marketing", "utility"]) assert.deepEqual(metaThreadControlBody("pass", role, { kind: "PHONE", value: user }, operation).control_pass, { target_role: role });
  for (const action of ["take", "release"]) assert.throws(() => metaThreadControlBody(action, "escalation", { kind: "PHONE", value: user }, operation));
  assert.throws(() => metaThreadControlBody("pass", "human", { kind: "PHONE", value: user }, operation));
  assert.throws(() => metaThreadControlBody({ toString: () => "take" }, undefined, { kind: "PHONE", value: user }, operation));
});

test("thread-control transport uses one bounded request and malformed success remains unknown", async () => {
  const original = globalThis.fetch; let count = 0;
  const client = new HttpMetaGroupsClient(new URL("https://graph.facebook.com"), "v24.0", "synthetic-token-for-routing-tests", phone);
  globalThis.fetch = async (url, init) => {
    count++; assert.equal(new URL(url).pathname, `/v24.0/${phone}/thread_control`);
    assert.equal(init.method, "POST"); const body = JSON.parse(init.body);
    assert.equal(body.recipient, "SA.synthetic"); assert.equal(body.to, undefined); assert.equal(body.messaging_account_id, undefined);
    return Response.json({ messaging_product: "whatsapp" });
  };
  try { await assert.rejects(client.threadControl("take", undefined, { kind: "BSUID", value: "SA.synthetic" }, operation), error => error.outcomeKnown === false); assert.equal(count, 1); }
  finally { globalThis.fetch = original; }
});

for (const [name, body, known] of [["empty object", {}, false], ["array", [], false], ["partial error", { error: { code: 100 } }, false], ["provider rejection", { error: { code: 100, message: "Synthetic rejection" } }, true]]) {
  test(`thread-control HTTP400 ${name} preserves mutation outcome certainty`, async () => {
    const original = globalThis.fetch; let count = 0;
    globalThis.fetch = async () => { count++; return Response.json(body, { status: 400 }); };
    try {
      const client = new HttpMetaGroupsClient(new URL("https://graph.facebook.com"), "v24.0", "synthetic-token-for-routing-tests", phone);
      await assert.rejects(client.threadControl("release", undefined, { kind: "PHONE", value: user }, operation), error => error.outcomeKnown === known);
      assert.equal(count, 1);
    } finally { globalThis.fetch = original; }
  });
}


test("declaration has only a versioned HOLD policy and never accepts caller authority", () => {
  const good = {expectedVersion:0,expectedSessionId:operation,fallback:"HOLD"};
  assert.deepEqual(parseMetaRoutingDeclaration(good),good);
  for(const bad of [{...good,fallback:"HUMAN_HANDOFF"},{...good,fallback:{toString:()=>"HOLD"}},{...good,legacy:true},{...good,state:"OWN"},{...good,expectedVersion:"0"},{...good,expectedSessionId:"other"}]) assert.throws(()=>parseMetaRoutingDeclaration(bad));
});

test("operator observation is typed and cannot assert ownership or change evidence mode", () => {
  const good={expectedSessionId:operation,expectedConfigurationVersion:1,expectedReviewVersion:0,disposition:"REVIEWED",observedAt:"2026-10-01T10:00:00.000Z",evidenceSha256:"a".repeat(64),evidenceReference:"synthetic/review-1",scope:"PHONE_OVERRIDE",roles:["escalation"],targets:["customer_service"],fields:["messages","messaging_handovers"],termsAccepted:true,threadControlEnabled:true,personallyObserved:true};
  assert.deepEqual(parseMetaRoutingReview(good,Date.parse("2026-10-07T00:00:00Z")),good);
  for(const bad of [{...good,roles:[null]},{...good,roles:["escalation","escalation"]},{...good,fields:["messages"]},{...good,personallyObserved:false},{...good,termsAccepted:false},{...good,mode:"LIVE"},{...good,state:"OWN"},{...good,evidenceReference:"secret value with spaces"},{...good,observedAt:"2026-10-09T00:00:00.000Z"},{...good,expectedReviewVersion:"0"}]) assert.throws(()=>parseMetaRoutingReview(bad,Date.parse("2026-10-07T00:00:00Z")));
  assert.equal(parseMetaRoutingReview({...good,disposition:"REVOKED",roles:[],targets:[],fields:[],termsAccepted:false}).disposition,"REVOKED");
});

test("routing mode comes from trusted server runtime and simulated evidence cannot become live", () => {
  const base={META_GRAPH_VERSION:"v24.0"};
  assert.deepEqual(metaRoutingRuntime(base),{mode:"LIVE",graphOrigin:"https://graph.facebook.com",graphVersion:"v24.0"});
  const simulation={...base,META_GRAPH_BASE_URL:"https://provider.invalid",META_ROUTING_SIMULATION_BINDING_SHA256:"a".repeat(64)};
  assert.equal(metaRoutingRuntime(simulation).mode,"SIMULATED");
  const canonical={...simulation,META_GRAPH_BASE_URL:"https://graph.facebook.com",NODE_ENV:"development"};
  assert.deepEqual(metaRoutingRuntime(canonical),{mode:"SIMULATED",graphOrigin:"https://graph.facebook.com",graphVersion:"v24.0",simulationBindingSha256:"a".repeat(64)});
  assert.deepEqual(metaRoutingRuntime({...base,NODE_ENV:"production"}),metaRoutingRuntime(base));
  assert.deepEqual(metaRoutingRuntime({...base,META_ROUTING_SIMULATION_BINDING_SHA256:""}),metaRoutingRuntime(base));
  for(const change of [{META_ROUTING_SIMULATION_BINDING_SHA256:"b".repeat(64)},{META_GRAPH_VERSION:"v25.0"},{META_ROUTING_SIMULATION_BINDING_SHA256:undefined}])
    assert.notDeepEqual(metaRoutingRuntime({...canonical,...change}),metaRoutingRuntime(canonical),"changed runtime cannot reuse prior observation");
  for(const bad of [{...canonical,NODE_ENV:"production"},{...canonical,META_ROUTING_SIMULATION_BINDING_SHA256:" "},{...canonical,META_ROUTING_SIMULATION_BINDING_SHA256:"g".repeat(64)}])
    assert.throws(()=>metaRoutingRuntime(bad));
  for(const bad of [{},{...simulation,NODE_ENV:"production"},{...simulation,META_ROUTING_SIMULATION_BINDING_SHA256:undefined},{...base,META_GRAPH_BASE_URL:"http://graph.facebook.com"},{...base,META_GRAPH_BASE_URL:"https://graph.facebook.com/extra"}])assert.throws(()=>metaRoutingRuntime(bad));
});

test("typed routing rejects mixed live and passive/import envelopes", () => {
  for(const key of ["standby","history","state_sync","message_echoes"])assert.throws(()=>metaRoutingUnits(account,"messages",value({messages:[message()],[key]:[]})));
  for(const key of ["messages","statuses","history","state_sync","message_echoes"])assert.throws(()=>metaRoutingUnits(account,"standby",value({standby:{messages:[message()]},[key]:[]})));
  for(const key of ["messages","statuses","standby","history","state_sync","message_echoes"])assert.throws(()=>metaRoutingUnits(account,"messaging_handovers",handover("control_taken",{[key]:[]})));
});

test("a newer signed primary can resolve a time conflict but receipts never refresh customer activity", () => {
  const p=primary(), negative={...p,category:"CONTROL_TAKEN",payloadSha256:"b".repeat(64)};
  let state=reduceMetaRouting(reduceMetaRouting(undefined,p,true),negative,true);
  const later={...p,observedAt:new Date(Date.parse(p.observedAt)+1000).toISOString(),payloadSha256:"c".repeat(64)};
  state=reduceMetaRouting(state,later,true);assert.equal(state.state,"OWN");
  const taken=reduceMetaRouting(state,{...later,category:"CONTROL_TAKEN",observedAt:new Date(Date.parse(later.observedAt)+1000).toISOString(),payloadSha256:"d".repeat(64)},true);
  assert.equal(taken.lastCustomerMessageAt,later.observedAt);
});

test("final request hook failure makes no provider call and successful thread control requires request ID",async()=>{
  const original=globalThis.fetch;let count=0;
  globalThis.fetch=async()=>{count++;return Response.json({messaging_product:"whatsapp",request_id:"synthetic-request"})};
  try{
    const blocked=new HttpMetaGroupsClient(new URL("https://graph.facebook.com"),"v24.0","synthetic-token-for-routing-tests",phone,async()=>{throw new Error("currentness changed")});
    await assert.rejects(blocked.threadControl("take",undefined,{kind:"PHONE",value:user},operation),/currentness changed/);assert.equal(count,0);
    const client=new HttpMetaGroupsClient(new URL("https://graph.facebook.com"),"v24.0","synthetic-token-for-routing-tests",phone);
    assert.deepEqual(await client.threadControl("release",undefined,{kind:"PHONE",value:user},operation),{requestId:"synthetic-request"});assert.equal(count,1);
  }finally{globalThis.fetch=original}
});
