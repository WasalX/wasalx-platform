import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { MetaDirectIdentityError, parseMetaDirectIdentity, parseMetaIdentityChange, metaDirectRecipientFields, metaDirectIdentityChangeEvidence,metaDirectTransitionEvidence,parseMetaDirectTransitionEvidence,metaDirectTransitionEdgeKey } from "../services/connector-worker/dist/packages/core/src/meta-direct-identity.js";
import { MetaGroupsAdapter } from "../services/connector-worker/dist/packages/connectors/src/meta.js";
import { WahaAdapter } from "../services/connector-worker/dist/packages/connectors/src/waha.js";
import { advanceBotFlow, parseBotFlow } from "../services/connector-worker/dist/packages/core/src/bot-flow.js";

test("Meta combines read and typing for an inbound webhook message without sending a reply", async t => {
  const webhook = JSON.parse(readFileSync(new URL("./fixtures/meta-primary-delivery-webhook.json", import.meta.url)));
  const { messages, metadata } = webhook.entry[0].changes[0].value;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ path: url.pathname, method: init.method, body: JSON.parse(init.body) });
    return Response.json({ success: true });
  });
  const adapter = new MetaGroupsAdapter({ accessToken: "synthetic-token", graphVersion: "v24.0",
    phoneNumberIdFor: () => metadata.phone_number_id,
    beforeMessageSend: async () => assert.fail("Read and typing must not consume send admission") });
  const input = { connectionId: "synthetic", groupId: messages[0].from, inboundMessageId: messages[0].id };
  const [operation] = adapter.agentReplySignals(input);
  assert.equal(operation.kind, "read-and-typing");
  assert.equal(await operation.send(new AbortController().signal), "sent");
  assert.deepEqual(requests, [{ path: `/v24.0/${metadata.phone_number_id}/messages`, method: "POST",
    body: { messaging_product: "whatsapp", status: "read", message_id: messages[0].id, typing_indicator: { type: "text" } } }]);
  assert.throws(() => adapter.agentReplySignals({ ...input, inboundMessageId: "not a Meta ID" }), { code: "META_INVALID_REQUEST" });
  assert.equal(requests.length, 1);
});

test("WAHA targets one inbound ID and reports an unsupported typing endpoint", async t => {
  const chatId = "12025550120@c.us";
  const adapter = new WahaAdapter({ baseUrl: "https://waha.example", apiKey: "synthetic", sessionFor: () => "synthetic-session" });
  const inboundMessageId = `false_${chatId}_3EB0965B123D06E0B70741`;
  const inbound = await adapter.normalizeDirectWebhook("synthetic", { event: "message", payload: {
    id: inboundMessageId, from: chatId, fromMe: false, body: "Synthetic", timestamp: 1_760_000_000,
  } }, new Headers());
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push([url.pathname, JSON.parse(init.body)]);
    return new Response(null, { status: url.pathname === "/api/sendSeen" ? 201 : 501 });
  });
  const input = { connectionId: "synthetic", groupId: inbound.chatId, inboundMessageId: inbound.messageId };
  const [read, typing] = adapter.agentReplySignals(input);
  assert.equal(await read.send(new AbortController().signal), "sent");
  assert.equal(await typing.send(new AbortController().signal), "unsupported");
  const target = { session: "synthetic-session", chatId };
  assert.deepEqual(requests, [["/api/sendSeen", { ...target, messageIds: [inboundMessageId] }], ["/api/startTyping", target]]);
  assert.throws(() => adapter.agentReplySignals({ ...input, groupId: "12025550121@c.us" }), { code: "WAHA_INVALID_REQUEST" });
  assert.throws(() => adapter.agentReplySignals({ ...input, inboundMessageId: inboundMessageId.replace("false_", "true_") }), { code: "WAHA_INVALID_REQUEST" });
  assert.equal(requests.length, 2);
});

test("131030 is a terminal TEST recipient rejection, never a group-capability error or fallback",async t=>{
  const old=globalThis.fetch;let calls=0;
  t.after(()=>{globalThis.fetch=old});
  globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(init.body);
    assert.equal(body.recipient,"US.syntheticOwner");assert.equal(Object.hasOwn(body,"to"),false);
    return new Response(JSON.stringify({error:{code:131030,type:"OAuthException",message:"private provider diagnostic"}}),{status:400});};
  const adapter=new MetaGroupsAdapter({accessToken:"synthetic-token-1234567890",graphVersion:"v24.0",phoneNumberIdFor:()=>"123"});
  await assert.rejects(adapter.send({connectionId:"c1",groupId:"12025550106",recipientType:"DIRECT",
    metaDirectRecipient:{kind:"BSUID",value:"US.syntheticOwner"},text:"Synthetic",idempotencyKey:"test-131030"}),error=>{
    assert.equal(error.code,"META_TEST_RECIPIENT_NOT_ALLOWED");assert.equal(error.retryable,false);
    assert.match(error.message,/test number/);assert.match(error.message,/131030/);assert.doesNotMatch(error.message,/private provider diagnostic/);return true;
  });
  assert.equal(calls,1);
});

test("normalizes WAHA direct text, location, and poll choices without accepting groups", async () => {
  const adapter = new WahaAdapter({ baseUrl: "https://waha.example", apiKey: "key", sessionFor: () => "session" });
  const text = await adapter.normalizeDirectWebhook("c1", { event: "message.any", payload: { id: "m1", from: "12025550130@lid", notifyName: "Notify fallback", body: "Hello", timestamp: 1_700_000_000, _data: { Info: { SenderAlt: "12025550102@s.whatsapp.net", PushName: "Push fallback", VerifiedName: { Details: { verifiedName: "Verified customer" } } } } } }, new Headers());
  assert.deepEqual(text?.input, { type: "text", text: "Hello" });
  assert.equal(text?.senderPhone, "+12025550102");
  assert.equal(text?.senderName, "Verified customer");
  assert.equal(text?.senderNameQuality, "VERIFIED");
  const namedFallback = await adapter.normalizeDirectWebhook("c1", { event: "message.any", payload: { id: "m1-fallback", from: "12025550130@lid", notifyName: "Notify customer", body: "Hello", timestamp: 1_700_000_000, _data: { Info: { SenderAlt: "12025550102@s.whatsapp.net", PushName: "Push fallback" } } } }, new Headers());
  assert.equal(namedFallback?.senderName, "Notify customer");
  assert.equal(namedFallback?.senderNameQuality, "NOTIFY");
  const location = await adapter.normalizeDirectWebhook("c1", { event: "message", payload: { id: "m2", from: "12025550102@c.us", location: { latitude: 24.7, longitude: 46.7 }, timestamp: 1_700_000_000 } }, new Headers());
  assert.deepEqual(location?.input, { type: "location", latitude: 24.7, longitude: 46.7 });
  const gowsLocation = await adapter.normalizeDirectWebhook("c1", { event: "message", payload: { id: "m2-gows", from: "12025550102@c.us", location: { latitude: "24.7000", longitude: "46.7000", live: false }, timestamp: 1_700_000_000 } }, new Headers());
  assert.deepEqual(gowsLocation?.input, { type: "location", latitude: 24.7, longitude: 46.7 });
  const malformedLocation = await adapter.normalizeDirectWebhook("c1", { event: "message", payload: { id: "m2-bad", from: "12025550102@c.us", body: "Fallback", location: { latitude: "24.7 north", longitude: "46.7" }, timestamp: 1_700_000_000 } }, new Headers());
  assert.deepEqual(malformedLocation?.input, { type: "text", text: "Fallback" });
  const contact = await adapter.normalizeDirectWebhook("c1", { event: "message", payload: { id: "m2-contact", from: "12025550102@c.us", vCards: ["BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Test Contact\r\nTEL;TYPE=CELL:12025550102\r\nEND:VCARD"], timestamp: 1_700_000_000 } }, new Headers());
  assert.deepEqual(contact?.input, { type: "text", text: "Shared contact\nName: Test Contact\nPhone: 12025550102" });
  const vote = await adapter.normalizeDirectWebhook("c1", { event: "poll.vote", payload: { vote: { id: "v1", to: "me", from: "12025550102@c.us", selectedOptions: ["Human"], timestamp: 1_700_000_000 }, poll: { fromMe: true } } }, new Headers());
  assert.deepEqual(vote?.input, { type: "choice", label: "Human" });
  const flow = parseBotFlow({ schemaVersion: 1, name: "Templated poll", start: "menu", maxSteps: 3, nodes: [
    { id: "menu", type: "choice", prompt: "Choose", options: [{ id: "human", label: "{{action.owner}}", next: "done" }] },
    { id: "done", type: "end" },
  ] });
  assert.equal(advanceBotFlow(flow, "menu", { type: "choice", choiceId: vote.input.label }, { "action.owner": "Human" }).state, "RESOLVED");
  const media = await adapter.normalizeDirectWebhook("c1", { event: "message.any", payload: { id: "m4", from: "12025550102@c.us", body: "Proof", replyTo: { id: "quoted-1" }, media: { url: "http://localhost:3000/api/s3/proof", mimetype: "image/png", filename: "proof.png" }, timestamp: 1_700_000_000 } }, new Headers());
  assert.equal(media?.quotedMessageId, "quoted-1");
  assert.deepEqual(media?.media, { type: "image", url: "http://localhost:3000/api/s3/proof", mimeType: "image/png", fileName: "proof.png" });
  const ordinary = await adapter.normalizeDirectWebhook("c1", { event: "message.any", payload: { id: "m5", from: "12025550102@c.us", body: "Ordinary", replyTo: null, timestamp: 1_700_000_001 } }, new Headers());
  assert.deepEqual(ordinary?.input, { type: "text", text: "Ordinary" });
  assert.equal(ordinary?.quotedMessageId, undefined);
  assert.equal(await adapter.normalizeDirectWebhook("c1", { event: "message.any", payload: { id: "m6", from: "12025550102@c.us", body: "Malformed", replyTo: {}, timestamp: 1_700_000_001 } }, new Headers()), null);
  assert.equal(await adapter.normalizeDirectWebhook("c1", { event: "message", payload: { id: "m3", from: "fixture-0019@example.test", body: "No" } }, new Headers()), null);
});

test('signed transition evidence retains complete structured phone-less edge and exact source account',()=>{
 const asset={providerSessionId:'71000000-0000-4000-8000-000000000001',phoneNumberId:'123',wabaId:'456'};
 const source=(system,extra={})=>({object:'whatsapp_business_account',entry:[{id:'456',changes:[{field:'messages',value:{metadata:{phone_number_id:'123'},messages:[{id:'wamid.changed.one',timestamp:'1800000000',type:'system',system,...extra}]}}]}]});
 const raw=source({type:'user_changed_user_id',previous_user_id:'SA.Old',user_id:'SA.New'}),evidence=metaDirectTransitionEvidence(raw,'a'.repeat(64),asset);
 assert(evidence);assert.deepEqual(evidence.change,{kind:'USER_CHANGED_USER_ID',previous:{bsuid:'SA.Old'},current:{bsuid:'SA.New'}});assert.equal(evidence.providerTimestamp,'2027-01-15T08:00:00.000Z');assert.deepEqual(evidence.asset,asset);
 assert.deepEqual(parseMetaDirectTransitionEvidence(JSON.parse(JSON.stringify(evidence))),evidence);
 assert.equal(metaDirectTransitionEvidence(raw,'a'.repeat(64),{...asset,wabaId:'999'}),null);
 assert.equal(metaDirectTransitionEvidence(raw,'a'.repeat(64),{...asset,phoneNumberId:'999'}),null);
 const numberChange=metaDirectTransitionEvidence(source({type:'user_changed_number',user_id:'SA.New'}, {from:'12025550106'}),'a'.repeat(64),asset);
 assert(numberChange);assert.deepEqual(numberChange.change.previous,{phone:'12025550106'});assert.deepEqual(numberChange.change.current,{bsuid:'SA.New'},'Missing current phone/previous BSUID is not manufactured');
 const legacy=metaDirectTransitionEvidence(source({type:'user_changed_number',wa_id:'12025550140'},{from:'12025550106'}),'a'.repeat(64),asset);assert(legacy);assert.deepEqual(legacy.change.current,{phone:'12025550140'});
 for(const system of [{type:'unknown',user_id:'SA.New'},{type:'user_changed_user_id',user_id:'SA.New'},{type:'user_changed_number',wa_id:null,user_id:'SA.New'},{type:'user_changed_number',user_id:'SA.ENT.parentOnly'}])assert.equal(metaDirectTransitionEvidence(source(system),'a'.repeat(64),asset),null);
});

test('transition semantic duplicate key is separate from each immutable event evidence identity',()=>{
 const asset={providerSessionId:'71000000-0000-4000-8000-000000000001',phoneNumberId:'123',wabaId:'456'};
 const first=parseMetaDirectTransitionEvidence({schemaVersion:1,change:{kind:'USER_CHANGED_USER_ID',previous:{bsuid:'SA.Old'},current:{bsuid:'SA.New'}},providerTimestamp:'2026-10-07T00:00:00.000Z',messageIdSha256:'a'.repeat(64),payloadSha256:'b'.repeat(64),asset});
 const duplicate={...first,messageIdSha256:'c'.repeat(64),payloadSha256:'d'.repeat(64),providerTimestamp:'2026-10-07T00:00:01.000Z'};
 assert.equal(metaDirectTransitionEdgeKey(first),metaDirectTransitionEdgeKey(duplicate));assert.notEqual(first.payloadSha256,duplicate.payloadSha256);
 assert.notEqual(metaDirectTransitionEdgeKey(first),metaDirectTransitionEdgeKey({...first,change:{...first.change,current:{bsuid:'SA.Other'}}}));
 for(const invalid of [{...first,payloadSha256:'unknown'},{...first,asset:{...asset,wabaId:null}},{...first,providerTimestamp:'2026-10-07'},{...first,change:{...first.change,current:{bsuid:'XX.New'}}},{...first,grant:true}])assert.throws(()=>parseMetaDirectTransitionEvidence(invalid),MetaDirectIdentityError);
});

test("uses a numbered-text direct fallback and the WAHA location endpoint", async () => {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: "sent-1" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const adapter = new WahaAdapter({ baseUrl: "https://waha.example", apiKey: "key", sessionFor: () => "session" });
    await adapter.send({ connectionId: "c1", groupId: "12025550102@c.us", recipientType: "DIRECT", text: "Choose", choices: { options: [{ id: "human", label: "Human" }] }, idempotencyKey: "1" });
    await adapter.send({ connectionId: "c1", groupId: "12025550102@c.us", recipientType: "DIRECT", text: "Location transcript", location: { latitude: 24.7, longitude: 46.7, name: "Office", address: "Riyadh" }, idempotencyKey: "2" });
    assert.deepEqual(requests, [
      { path: "/api/sendText", body: { session: "session", chatId: "12025550102@c.us", text: "Choose\n1. Human" } },
      { path: "/api/sendLocation", body: { session: "session", chatId: "12025550102@c.us", latitude: 24.7, longitude: 46.7, title: "Office" } },
    ]);
  } finally { globalThis.fetch = original; }
});

test("normalizes Meta direct choices and sends native buttons, lists, and bounded fallback", async () => {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const adapter = new MetaGroupsAdapter({ accessToken: "test-access-token-value-123456", graphVersion: "v24.0", phoneNumberIdFor: () => "123" });
    const message = await adapter.normalizeDirectWebhook("c1", { entry: [{ changes: [{ value: { messages: [{ id: "wamid.in", from: "12025550102", timestamp: "1700000000", type: "interactive", context:{id:"wamid.prompt"}, interactive: { button_reply: { id: "status", title: "Status" } } }] } }] }] });
    assert.deepEqual(message?.input, { type: "choice", choiceId: "status", label: "Status", source:"META_NATIVE" });
    assert.equal(message?.quotedMessageId,"wamid.prompt");
    assert.equal(await adapter.normalizeDirectWebhook("c1", { entry: [{ changes: [{ value: { messages: [{ id: "wamid.stale", from: "12025550102", timestamp: "1700000000", type: "interactive", interactive: { button_reply: { id: "status", title: "Status" } } }] } }] }] }),null);
    const form = await adapter.normalizeDirectWebhook("c1", { entry: [{ changes: [{ value: { messages: [{ id: "wamid.form", from: "12025550102", timestamp: "1700000000", type: "interactive", interactive: { nfm_reply: { response_json: JSON.stringify({ flow_token: "flow-token-1", accepted: true, order_id: "ORD-42" }) } } }] } }] }] });
    assert.deepEqual(form?.input, { type: "flow_response", flowToken: "flow-token-1", data: { accepted: "true", order_id: "ORD-42" } });
    const media = await adapter.normalizeDirectWebhook("c1", { entry: [{ changes: [{ value: { messages: [{ id: "wamid.media", from: "12025550102", timestamp: "1700000000", type: "image", context: { id: "wamid.quoted" }, image: { id: "media-id", mime_type: "image/png", caption: "Proof" } }] } }] }] });
    assert.equal(media?.quotedMessageId, "wamid.quoted");
    assert.deepEqual(media?.media, { type: "image", url: "meta-media://media-id", mimeType: "image/png" });
    const contact = await adapter.normalizeDirectWebhook("c1", { entry: [{ changes: [{ value: {
      contacts: [{ profile: { name: "Customer\u202e Name" }, wa_id: "12025550102" }],
      messages: [{ id: "wamid.contact", from: "12025550102", timestamp: "1700000001", type: "contacts", contacts: [{ name: { formatted_name: "Test\nContact" }, phones: [{ phone: "12025550102" }] }] }],
    } }] }] });
    assert.equal(contact?.senderName, "Customer Name");
    assert.deepEqual(contact?.input, { type: "text", text: "Shared contact\nName: Test Contact\nPhone: 12025550102" });
    const sticker = await adapter.normalizeDirectWebhook("c1", { entry: [{ changes: [{ value: { messages: [{ id: "wamid.sticker", from: "12025550102", timestamp: "1700000002", type: "sticker", sticker: { id: "sticker-id", mime_type: "image/webp" } }] } }] }] });
    assert.deepEqual(sticker?.input, { type: "text", text: "Sticker" });
    assert.deepEqual(sticker?.media, { type: "image", url: "meta-media://sticker-id", mimeType: "image/webp", isSticker: true });
    const reaction = await adapter.normalizeDirectWebhook("c1", { entry: [{ changes: [{ value: { messages: [{ id: "wamid.reaction", from: "12025550102", timestamp: "1700000003", type: "reaction", reaction: { message_id: "wamid.original", emoji: "👍" } }] } }] }] });
    assert.deepEqual(reaction?.input, { type: "reaction", emoji: "👍", removed: false });
    assert.equal(reaction?.quotedMessageId, "wamid.original");
    const location = await adapter.normalizeDirectWebhook("c1", { entry: [{ changes: [{ value: { messages: [{ id: "wamid.location", from: "12025550102", timestamp: "1700000004", type: "location", location: { latitude: 24.7, longitude: 46.7, name: "Riyadh\nOffice", address: "King Road" } }] } }] }] });
    assert.deepEqual(location?.input, { type: "location", latitude: 24.7, longitude: 46.7, name: "Riyadh Office", address: "King Road" });
    const unsupported = await adapter.normalizeDirectWebhook("c1", { entry: [{ changes: [{ value: { messages: [{ id: "wamid.unknown", from: "12025550102", timestamp: "1700000005", type: "unknown", errors: [{ code: 130501 }] }] } }] }] });
    assert.deepEqual(unsupported?.input, { type: "unsupported", text: "This WhatsApp message type is not supported yet." });
    await adapter.send({ connectionId: "c1", groupId: "12025550102", recipientType: "DIRECT", text: "Choose", choices: { options: [{ id: "a", label: "A" }] }, idempotencyKey: "1" });
    await adapter.send({ connectionId: "c1", groupId: "12025550102", recipientType: "DIRECT", text: "Choose", choices: { buttonLabel: "Select", options: ["A","B","C","D"].map(label=>({id:label.toLowerCase(),label})) }, idempotencyKey: "2" });
    await adapter.send({ connectionId: "c1", groupId: "12025550102", recipientType: "DIRECT", text: "Choose", choices: { options: [{ id: "long", label: "A deliberately descriptive option label" }] }, idempotencyKey: "3" });
    await adapter.send({ connectionId: "c1", groupId: "12025550102", recipientType: "DIRECT", text: "Location transcript", location: { latitude: 24.7, longitude: 46.7, name: "Office", address: "Riyadh" }, idempotencyKey: "4" });
    await adapter.send({ connectionId: "c1", groupId: "12025550102", recipientType: "DIRECT", text: "Order update sent", template: { name: "order_update", languageCode: "en_US", bodyParameters: ["ORD-42"] }, idempotencyKey: "5" });
    await adapter.send({ connectionId: "c1", groupId: "12025550102", recipientType: "DIRECT", text: "Confirm order", flow: { id: "12345", token: "flow-token-1", buttonLabel: "Confirm", screen: "ORDER", data: { order_id: "ORD-42" } }, idempotencyKey: "6" });
    assert.equal(requests[0].recipient_type, "individual");
    assert.equal(requests[0].interactive.type, "button");
    assert.equal(requests[1].interactive.type, "list");
    assert.equal(requests[1].interactive.action.button,"Select");
    assert.deepEqual(requests[1].interactive.action.sections[0].rows,[{id:"a",title:"A"},{id:"b",title:"B"},{id:"c",title:"C"},{id:"d",title:"D"}]);
    assert.equal(requests[2].type,"text");
    assert.match(requests[2].text.body,/1\. A deliberately descriptive option label/);
    assert.deepEqual(requests[3].location,{latitude:24.7,longitude:46.7,name:"Office",address:"Riyadh"});
    assert.deepEqual(requests[4].template,{name:"order_update",language:{code:"en_US"},components:[{type:"body",parameters:[{type:"text",text:"ORD-42"}]}]});
    assert.deepEqual(requests[5].interactive,{type:"flow",body:{text:"Confirm order"},action:{name:"flow",parameters:{flow_message_version:"3",flow_action:"navigate",flow_token:"flow-token-1",flow_id:"12345",flow_cta:"Confirm",flow_action_payload:{screen:"ORDER",data:{order_id:"ORD-42"}}}}});
  } finally { globalThis.fetch = original; }
});

test("enforces Meta direct wire limits and Flow CTA rules",async()=>{
  const requests=[];const original=globalThis.fetch;
  globalThis.fetch=async(_input,init)=>{requests.push(JSON.parse(String(init?.body)));return Response.json({messages:[{id:"wamid.boundary"}]})};
  try{
    const adapter=new MetaGroupsAdapter({accessToken:"test-access-token-value-123456",graphVersion:"v24.0",phoneNumberIdFor:()=>"123"});
    await adapter.send({connectionId:"c1",groupId:"12025550102",recipientType:"DIRECT",text:"x".repeat(1_024),choices:{options:[{id:"a",label:"A"}]},idempotencyKey:"button-max"});
    await adapter.send({connectionId:"c1",groupId:"12025550102",recipientType:"DIRECT",text:"x".repeat(1_025),choices:{options:[{id:"a",label:"A"}]},idempotencyKey:"button-over"});
    const longLabel="x".repeat(25);
    await adapter.send({connectionId:"c1",groupId:"12025550102",recipientType:"DIRECT",text:"x".repeat(4_096-(4+longLabel.length)),choices:{options:[{id:"a",label:longLabel}]},idempotencyKey:"fallback-max"});
    await assert.rejects(()=>adapter.send({connectionId:"c1",groupId:"12025550102",recipientType:"DIRECT",text:"x".repeat(4_097-(4+longLabel.length)),choices:{options:[{id:"a",label:longLabel}]},idempotencyKey:"fallback-over"}),error=>error?.code==="META_INVALID_REQUEST");
    await assert.rejects(()=>adapter.send({connectionId:"c1",groupId:"12025550102",recipientType:"DIRECT",text:"Flow",flow:{id:"12345",token:"flow-token",buttonLabel:"Confirm ✅",data:{}},idempotencyKey:"flow-emoji"}),error=>error?.code==="META_INVALID_REQUEST");
    assert.equal(requests[0].interactive.type,"button");
    assert.equal(requests[1].interactive.type,"list");
    assert.equal(requests[2].text.body.length,4_096);
  }finally{globalThis.fetch=original}
});

test("classifies official Meta errors by numeric code and retains only safe diagnostics",async()=>{
  const original=globalThis.fetch;
  try{
    const adapter=new MetaGroupsAdapter({accessToken:"test-access-token-value-123456",graphVersion:"v24.0",phoneNumberIdFor:()=>"123"});
    for(const [graphCode,expected,retryable] of [
      [190,"META_AUTHENTICATION_FAILED",false],[131005,"META_PERMISSION_REQUIRED",false],[131009,"META_INVALID_REQUEST",false],
      [131047,"META_CUSTOMER_WINDOW_CLOSED",false],[130429,"META_RATE_LIMITED",true],[131056,"META_RATE_LIMITED",true],
      [131000,"META_SERVER_ERROR",true],[131016,"META_SERVER_ERROR",true],[131026,"META_DELIVERY_REJECTED",false],
      [131050,"META_DELIVERY_REJECTED",false],[131051,"META_DELIVERY_REJECTED",false],[131052,"META_DELIVERY_REJECTED",false],[131053,"META_DELIVERY_REJECTED",false],
    ]){
      globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:graphCode,error_subcode:7,type:"OAuthException",message:"private token material"}}),{status:400,headers:{"content-type":"application/json"}});
      await assert.rejects(()=>adapter.send({connectionId:"c1",groupId:"12025550102",recipientType:"DIRECT",text:"Hello",idempotencyKey:String(graphCode)}),error=>{
        assert.equal(error?.code,expected);assert.equal(error?.retryable,retryable);assert.equal(error?.outcomeKnown,!retryable);
        assert.match(error?.message??"",new RegExp(`code=${graphCode}`));assert.match(error?.message??"",/subcode=7 type=OAuthException/u);
        assert.doesNotMatch(error?.message??"",/private token material|Groups API/u);return true;
      });
    }
  }finally{globalThis.fetch=original}
});

test("reports a closed official customer-service window without retrying", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 131047 } }), { status: 400, headers: { "content-type": "application/json" } });
  try {
    const adapter = new MetaGroupsAdapter({ accessToken: "test-access-token-value-123456", graphVersion: "v24.0", phoneNumberIdFor: () => "123" });
    await assert.rejects(() => adapter.send({ connectionId: "c1", groupId: "12025550102", recipientType: "DIRECT", text: "Hello", idempotencyKey: "closed" }), (error) => error?.code === "META_CUSTOMER_WINDOW_CLOSED" && error?.retryable === false && /approved template/u.test(error.message));
  } finally { globalThis.fetch = original; }
});

const bsuidFixture = JSON.parse(readFileSync(new URL("./fixtures/meta-bsuid-contract.json", import.meta.url), "utf8"));
const metaValue = (payload) => payload.entry[0].changes[0].value;
const metaAdapter = () => new MetaGroupsAdapter({ accessToken:"test-access-token-value-123456", graphVersion:"v24.0", phoneNumberIdFor:()=>"123" });

test("signed identity-change evidence holds known aliases or the asset without guessing hidden previous IDs", () => {
  const payloadSha256="a".repeat(64);
  assert.deepEqual(metaDirectIdentityChangeEvidence(bsuidFixture.change,payloadSha256),{
    schemaVersion:1,scope:"ALIASES",previous:[{kind:"BSUID",value:bsuidFixture.bsuid}],payloadSha256,
  });
  for(const system of [{type:"user_changed_number",user_id:bsuidFixture.nextBsuid},{type:"user_changed_user_id",previous_user_id:null},{type:"unknown"}]) {
    const payload=structuredClone(bsuidFixture.change);metaValue(payload).messages[0].system=system;
    assert.deepEqual(metaDirectIdentityChangeEvidence(payload,payloadSha256),{schemaVersion:1,scope:"ASSET",previous:[],payloadSha256});
  }
  assert.equal(metaDirectIdentityChangeEvidence(bsuidFixture.bsuidOnly,payloadSha256),null);
  const group=structuredClone(bsuidFixture.change);metaValue(group).messages[0].group_id="group-id";
  assert.equal(metaDirectIdentityChangeEvidence(group,payloadSha256),null);
  assert.throws(()=>metaDirectIdentityChangeEvidence(bsuidFixture.change,"invalid"),MetaDirectIdentityError);
});

test("parses exact BSUID sender evidence and only joint matching contacts establish alias association", () => {
  const { phone, bsuid, parentBsuid } = bsuidFixture;
  assert.deepEqual(parseMetaDirectIdentity({from_user_id:bsuid}, [{user_id:bsuid}]), {identity:{bsuid,jointContact:false},contactIndex:0});
  assert.deepEqual(parseMetaDirectIdentity({from:phone,from_user_id:bsuid}), {identity:{phone,bsuid,jointContact:false}});
  assert.deepEqual(parseMetaDirectIdentity({from:phone}, [{wa_id:phone,user_id:bsuid}]), {identity:{phone,bsuid,jointContact:true},contactIndex:0});
  assert.deepEqual(parseMetaDirectIdentity({from_user_id:bsuid}, [{wa_id:phone,user_id:bsuid,parent_user_id:parentBsuid}]), {identity:{phone,bsuid,parentBsuid,jointContact:true},contactIndex:0});
  for (const [message, contacts] of [
    [{from:phone,from_user_id:bsuid},[{wa_id:phone,user_id:bsuidFixture.nextBsuid}]],
    [{from:phone,from_user_id:bsuid},[{wa_id:"12025550141",user_id:bsuid}]],
    [{from_user_id:bsuid},[{user_id:bsuid},{user_id:bsuid}]],
    [{from_user_id:bsuid},[{user_id:bsuidFixture.nextBsuid,profile:{name:"same name"}}]],
    [{},[{user_id:bsuid}]], [{from:null},undefined],
    [{from_user_id:"US.ENT.11815798345668008403"},undefined],
    [{from:phone,from_user_id:"bad"},undefined],
    [{from:phone},[{wa_id:phone,user_id:null}]],
  ]) assert.throws(()=>parseMetaDirectIdentity(message,contacts),MetaDirectIdentityError);
  for(const value of [" us.a","us.a","ZZ.a","US.a ","US."+"a".repeat(129),"US.a/secret"])
    assert.throws(()=>metaDirectRecipientFields({kind:"BSUID",value}),MetaDirectIdentityError);
  assert.deepEqual(metaDirectRecipientFields({kind:"BSUID",value:"US.aA09"}),{recipient:"US.aA09"});
  assert.throws(()=>metaDirectRecipientFields({kind:"BSUID",value:bsuid,to:phone}),MetaDirectIdentityError);
});

test("normalizes phone-less Meta text/media/native choice without name or username identity fallback", async () => {
  const adapter=metaAdapter();
  const message=await adapter.normalizeDirectWebhook("c1",bsuidFixture.bsuidOnly);
  assert.equal(message.chatId,bsuidFixture.bsuid);assert.equal(message.senderId,bsuidFixture.bsuid);
  assert.equal(message.senderPhone,undefined);assert.equal(message.senderName,"عميل تجريبي");
  assert.deepEqual(message.metaIdentity,{bsuid:bsuidFixture.bsuid,jointContact:false});
  const joint=await adapter.normalizeDirectWebhook("c1",bsuidFixture.joint);
  assert.equal(joint.chatId,bsuidFixture.phone);assert.equal(joint.senderPhone,"+"+bsuidFixture.phone);
  assert.equal(joint.metaIdentity.jointContact,true);
  for(const replacement of [
    {type:"image",image:{id:"media-bsuid",mime_type:"image/png",caption:"صورة"}},
    {type:"interactive",context:{id:"wamid.prompt"},interactive:{button_reply:{id:"human",title:"موظف"}}},
  ]) {
    const payload=structuredClone(bsuidFixture.bsuidOnly);delete metaValue(payload).messages[0].text;Object.assign(metaValue(payload).messages[0],replacement);
    const parsed=await adapter.normalizeDirectWebhook("c1",payload);
    assert.equal(parsed.chatId,bsuidFixture.bsuid);assert.equal(parsed.senderPhone,undefined);
    if(replacement.type==="image")assert.equal(parsed.media.url,"meta-media://media-bsuid");
    else assert.deepEqual(parsed.input,{type:"choice",choiceId:"human",label:"موظف",source:"META_NATIVE"});
  }
  const bad=structuredClone(bsuidFixture.joint);metaValue(bad).contacts[0].user_id=bsuidFixture.nextBsuid;
  await assert.rejects(()=>adapter.normalizeDirectWebhook("c1",bad),error=>error.code==="META_DIRECT_IDENTITY_INVALID"&&error.outcomeKnown===true);
  const group=structuredClone(bsuidFixture.bsuidOnly);metaValue(group).messages[0].group_id="group-id";
  assert.equal(await adapter.normalizeDirectWebhook("c1",group),null);
});

test("recognizes structured identity changes without from and never admits them as direct bot input", async () => {
  const adapter=metaAdapter();const change=await adapter.normalizeIdentityChangeWebhook("c1",bsuidFixture.change);
  assert.deepEqual(change.change,{kind:"USER_CHANGED_USER_ID",previous:{bsuid:bsuidFixture.bsuid},current:{bsuid:bsuidFixture.nextBsuid}});
  assert.equal(change.messageId,"wamid.changed");assert.equal("input" in change,false);
  assert.equal(await adapter.normalizeDirectWebhook("c1",bsuidFixture.change),null);
  const system={type:"user_changed_number",user_id:bsuidFixture.nextBsuid,wa_id:"12025550141"};
  assert.deepEqual(parseMetaIdentityChange({type:"system",from:bsuidFixture.phone,system}),{kind:"USER_CHANGED_NUMBER",previous:{phone:bsuidFixture.phone},current:{phone:"12025550141",bsuid:bsuidFixture.nextBsuid}});
  for(const variant of [
    {type:"user_changed_number",user_id:bsuidFixture.nextBsuid,previous_user_id:bsuidFixture.bsuid},
    {type:"user_changed_number",user_id:bsuidFixture.nextBsuid},
    {type:"user_changed_number",wa_id:"12025550141"},
    {type:"user_changed_number",wa_id:"12025550141",user_id:bsuidFixture.nextBsuid},
  ]) {
    const payload=structuredClone(bsuidFixture.change);metaValue(payload).messages[0].system=variant;
    const observed=await adapter.normalizeIdentityChangeWebhook("c1",payload);
    assert.equal(observed.change.kind,"USER_CHANGED_NUMBER");
    assert.deepEqual(observed.change.previous,variant.previous_user_id?{bsuid:variant.previous_user_id}:{});
    assert.deepEqual(observed.change.current,{...(variant.wa_id?{phone:variant.wa_id}:{}),...(variant.user_id?{bsuid:variant.user_id}:{})});
    assert.equal(await adapter.normalizeDirectWebhook("c1",payload),null);
  }
  for(const invalid of [{type:"user_changed_number"},{type:"user_changed_number",wa_id:null,user_id:bsuidFixture.nextBsuid},{type:"user_changed_number",wa_id:"12025550141",user_id:"bad"}])
    assert.throws(()=>parseMetaIdentityChange({type:"system",system:invalid}),MetaDirectIdentityError);
  assert.throws(()=>parseMetaIdentityChange({type:"system",system:{type:"user_changed_user_id",user_id:bsuidFixture.nextBsuid,body:"old US.guess"}}),MetaDirectIdentityError);
  const unknown=structuredClone(bsuidFixture.change);metaValue(unknown).messages[0].system.type="unknown-change";
  assert.equal(await adapter.normalizeDirectWebhook("c1",unknown),null);
  await assert.rejects(()=>adapter.normalizeIdentityChangeWebhook("c1",unknown),error=>error.code==="META_DIRECT_IDENTITY_INVALID");
});

test("sends BSUID recipient exclusively for each supported direct payload and rejects raw/group selectors before upload", async () => {
  const original=globalThis.fetch;const requests=[];
  globalThis.fetch=async(input,init)=>{requests.push({path:new URL(String(input)).pathname,body:JSON.parse(String(init.body))});return Response.json({messages:[{id:"wamid.sent"}],contacts:[{input:bsuidFixture.bsuid,user_id:bsuidFixture.bsuid}]})};
  try {
    const adapter=metaAdapter();const base={connectionId:"c1",groupId:"canonical-chat-key",recipientType:"DIRECT",metaDirectRecipient:{kind:"BSUID",value:bsuidFixture.bsuid},text:"مرحبا",idempotencyKey:"fixture"};
    for(const extra of [{},{choices:{options:[{id:"a",label:"أ"}]}},{location:{latitude:24.7,longitude:46.7}},{template:{name:"order_update",languageCode:"ar",bodyParameters:[]}},{flow:{id:"12345",token:"token",buttonLabel:"Confirm",data:{}}},{media:{filename:"photo.png",mimeType:"image/png",bytes:new Uint8Array([1]),providerMediaId:"media123"}}]) await adapter.send({...base,...extra});
    assert.equal(requests.length,6);
    for(const request of requests){assert.equal(request.body.recipient,bsuidFixture.bsuid);assert.equal("to" in request.body,false);assert.equal(request.body.recipient_type,"individual");}
    await adapter.send({...base,metaDirectRecipient:{kind:"PHONE",value:bsuidFixture.phone}});
    assert.equal(requests.at(-1).body.to,bsuidFixture.phone);assert.equal("recipient" in requests.at(-1).body,false);
    const before=requests.length;
    for(const invalid of [{...base,metaDirectRecipient:undefined,groupId:bsuidFixture.bsuid},{...base,metaDirectRecipient:null},{...base,recipientType:"GROUP"},{...base,metaDirectRecipient:{kind:"BSUID",value:bsuidFixture.parentBsuid}}]) {
      await assert.rejects(()=>adapter.send(invalid),error=>error.code==="META_DIRECT_IDENTITY_INVALID"&&error.outcomeKnown);
      await assert.rejects(()=>adapter.prepareMedia({...invalid,media:{filename:"photo.png",mimeType:"image/png",bytes:new Uint8Array([1])}}),error=>error.code==="META_DIRECT_IDENTITY_INVALID"&&error.outcomeKnown);
    }
    assert.equal(requests.length,before);
    await adapter.send({connectionId:"c1",groupId:"group-id",text:"Group remains unchanged",idempotencyKey:"group"});
    assert.equal(requests.at(-1).body.to,"group-id");assert.equal(requests.at(-1).body.recipient_type,"group");
  }finally{globalThis.fetch=original}
});

test("classifies unsupported BSUID 131062 once without phone fallback or raw provider text",async()=>{
  const original=globalThis.fetch;let requests=0;
  globalThis.fetch=async()=>{requests++;return Response.json({error:{code:131062,message:"private recipient details"}},{status:400})};
  try{await assert.rejects(()=>metaAdapter().send({connectionId:"c1",groupId:bsuidFixture.phone,recipientType:"DIRECT",metaDirectRecipient:{kind:"BSUID",value:bsuidFixture.bsuid},text:"Test",idempotencyKey:"unsupported"}),error=>{
    assert.equal(error.code,"META_UNSUPPORTED_MESSAGE");assert.equal(error.retryable,false);assert.equal(error.outcomeKnown,true);assert.doesNotMatch(error.message,/private recipient details/u);return true;
  });assert.equal(requests,1);}finally{globalThis.fetch=original}
});

test("normalizes BSUID receipt identity and failed missing-recipient status without creating aliases",async()=>{
  const adapter=metaAdapter();const first=await adapter.normalizeReceipts("c1",bsuidFixture.status);
  assert.equal(first.length,1);assert.equal(first[0].externalMessageId,"wamid.sent");assert.equal(first[0].status,"DELIVERED");
  assert.match(first[0].receiptKey,/^[0-9a-f]{64}$/u);assert.deepEqual(first[0].metadata,{errorCount:0});
  assert.doesNotMatch(JSON.stringify(first),new RegExp(bsuidFixture.bsuid.replace(/\./gu,"\\."),"u"));
  assert.deepEqual(await adapter.normalizeReceipts("c1",structuredClone(bsuidFixture.status)),first);
  const other=structuredClone(bsuidFixture.status);metaValue(other).statuses[0].recipient_user_id=bsuidFixture.nextBsuid;
  assert.notEqual((await adapter.normalizeReceipts("c1",other))[0].receiptKey,first[0].receiptKey);
  const corrected=structuredClone(bsuidFixture.status);metaValue(corrected).statuses[0].pricing={billable:true,pricing_model:"PMP",category:"service",type:"regular"};
  const correctedReceipt=(await adapter.normalizeReceipts("c1",corrected))[0];
  assert.equal(correctedReceipt.metaPricingObservation.state,"VALID");assert.notEqual(correctedReceipt.receiptKey,first[0].receiptKey);
  assert.doesNotMatch(JSON.stringify(correctedReceipt),new RegExp(bsuidFixture.bsuid.replace(/\./gu,"\\."),"u"));
  metaValue(corrected).statuses[0].recipient_parent_user_id=null;
  await assert.rejects(()=>adapter.normalizeReceipts("c1",corrected),error=>error.code==="META_DIRECT_IDENTITY_INVALID");
  const missing=structuredClone(bsuidFixture.status);const item=metaValue(missing).statuses[0];delete item.recipient_user_id;item.status="failed";item.errors=[{code:131062}];
  const failed=await adapter.normalizeReceipts("c1",missing);assert.equal(failed.length,1);assert.equal(failed[0].status,"FAILED");assert.deepEqual(failed[0].errorCodes,["131062"]);
  item.recipient_user_id=null;await assert.rejects(()=>adapter.normalizeReceipts("c1",missing),error=>error.code==="META_DIRECT_IDENTITY_INVALID");
});

test("immutable Meta recipient snapshot rejects ambiguous ownership and malformed transport fields",async()=>{
 const {parseMetaDirectRecipientSnapshot}=await import("../services/connector-worker/dist/packages/core/src/meta-direct-identity.js");
 const snapshot={schemaVersion:1,claim:"ALIAS_VERIFIED",recipient:{kind:"BSUID",value:"SA."+"a".repeat(128)},
  asset:{providerSessionId:"71000000-0000-4000-8000-000000000001",phoneNumberId:"123",wabaId:"456"},
  participantId:"71000000-0000-4000-8000-000000000002",aliasId:"71000000-0000-4000-8000-000000000003",aliasRevision:1};
 assert.deepEqual(parseMetaDirectRecipientSnapshot(snapshot),snapshot);
 for(const change of [
  {claim:"LEGACY_PHONE_CONTEXT"},{claim:"unknown"},{aliasRevision:0},{aliasRevision:Number.MAX_SAFE_INTEGER+1},
  {aliasId:"foreign"},{participantId:null},{to:"12025550132"},
  {asset:{...snapshot.asset,wabaId:null}},{asset:{...snapshot.asset,phoneNumberId:"foreign"}},
  {recipient:{kind:"BSUID",value:"SA.ENT.noRecipient"}},{recipient:{...snapshot.recipient,to:"12025550132"}}
 ])assert.throws(()=>parseMetaDirectRecipientSnapshot({...snapshot,...change}),MetaDirectIdentityError);
});


test('transition receipts reject invented grants, ambiguous alias slots and unsafe revision types',async()=>{
 const {parseMetaDirectTransitionReceipt}=await import('../services/connector-worker/dist/packages/core/src/meta-direct-identity.js');
 const id='71000000-0000-4000-8000-000000000001';
 const value={schemaVersion:1,state:'APPLIED',evidenceSha256:'a'.repeat(64),participantId:id,canonical:'100',nativeCustomerId:'8',anchorEventId:id,
  predecessorAliases:[],successorAliases:[{id,revision:1}],appliedEventId:id};
 assert.deepEqual(parseMetaDirectTransitionReceipt(value),value);
 for(const extra of [{state:'PREPARED'},{state:'HELD'},{nativeCustomerId:8},{successorAliases:[]},{grant:true},
  {successorAliases:[{id,revision:1},{id,revision:2}]},{successorAliases:[{id,revision:Number.MAX_SAFE_INTEGER+1}]},
  {successorAliases:[{id,revision:1,recipient:'forged'}]},{anchorEventId:'foreign'}])
  assert.throws(()=>parseMetaDirectTransitionReceipt({...value,...extra}),MetaDirectIdentityError);
});

test('account-derived identity receipts retain exact attribution and reject partial or invented bridge fields',async()=>{
 const {parseMetaDirectTransitionReceipt}=await import('../services/connector-worker/dist/packages/core/src/meta-direct-identity.js');
 const id='71000000-0000-4000-8000-000000000001';
 const receipt={schemaVersion:1,state:'APPLIED',evidenceSha256:'a'.repeat(64),participantId:id,canonical:'100',nativeCustomerId:'8',anchorEventId:id,
  predecessorAliases:[],successorAliases:[{id,revision:1}],appliedEventId:id,accountTransitionId:id,
  targetAsset:{providerSessionId:id,phoneNumberId:'123',wabaId:'456'}};
 assert.deepEqual(parseMetaDirectTransitionReceipt(receipt),receipt);
 for(const change of [{accountTransitionId:undefined},{accountTransitionId:null},{targetAsset:undefined},{targetAsset:null},
  {targetAsset:{...receipt.targetAsset,wabaId:null}},{targetAsset:{...receipt.targetAsset,phoneNumberId:123}},
  {targetAsset:{...receipt.targetAsset,providerSessionId:'foreign'}},{targetAsset:{...receipt.targetAsset,OWN:true}},
  {sourceAsset:receipt.targetAsset},{financialAuthority:true}])
  assert.throws(()=>parseMetaDirectTransitionReceipt({...receipt,...change}),MetaDirectIdentityError);
 // Parsing is a structural boundary only; SQL validates the stored account chain.
});
