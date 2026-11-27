import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { parseWahaTestRecipientAllowlist, wahaTestRecipientAllowed, wahaTestWebhookAllowed } from "../packages/core/dist/waha-test-recipient-scope.js";
import { WahaAdapter } from "../services/connector-worker/dist/packages/connectors/src/waha.js";
import { WebhookIngressController } from "../services/control-api/dist/webhook-ingress.controller.js";
import { DeliveryProcessor } from "../services/connector-worker/dist/services/connector-worker/src/processor.js";
import { synchronizeGroups } from "../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js";

const group="123456789@g.us", otherGroup="987654321@g.us", phone="12025550106@c.us", bot="12025550104@c.us";
const raw=JSON.stringify([group,"12025550106",bot]);

function gowsQuote(chat=group){
  const stanza="ABCDEF1234567890123456",quoted={conversation:"Synthetic original"};
  return {event:"message.any",engine:"GOWS",payload:{
    id:`false_${chat}_SYNTHETIC_${phone}`,from:chat,to:bot,fromMe:false,participant:phone,
    timestamp:Math.floor(Date.now()/1000),body:"Synthetic quoted reopen",
    replyTo:{id:stanza,participant:bot,body:"Synthetic original",hasMedia:false,media:null,_data:quoted},
    _data:{Info:{Chat:chat},Message:{extendedTextMessage:{text:"Synthetic quoted reopen",contextInfo:{
      stanzaID:stanza,participant:bot,quotedMessage:quoted,
    }}}},
  }};
}

test("WAHA recipient scope denies by default and only an explicit opt-out disables it",()=>{
  for(const raw of [undefined,""," ","[]"]){
    const denied=parseWahaTestRecipientAllowlist(raw);
    assert.equal(denied.size,0);
    assert.equal(wahaTestRecipientAllowed(denied,phone),false);
    assert.equal(wahaTestRecipientAllowed(denied,otherGroup),false);
    assert.equal(wahaTestWebhookAllowed(denied,{event:"message",payload:{from:phone,to:"me",id:`false_${phone}_TEST`}}),false);
    assert.equal(wahaTestWebhookAllowed(denied,{event:"session.status",payload:{status:"WORKING"}}),false);
  }
  assert.equal(parseWahaTestRecipientAllowlist("*"),undefined);
  assert.equal(wahaTestRecipientAllowed(parseWahaTestRecipientAllowlist("*"),otherGroup),true);
  const allowed=parseWahaTestRecipientAllowlist(raw);
  for(const recipient of [group,phone,bot,"12025550106@s.whatsapp.net"]) assert.equal(wahaTestRecipientAllowed(allowed,recipient),true);
  for(const recipient of [otherGroup,"12025550162@c.us","12025550106@lid",group+" ","status@broadcast"]) assert.equal(wahaTestRecipientAllowed(allowed,recipient),false);
  assert.equal(wahaTestRecipientAllowed(parseWahaTestRecipientAllowlist("[]"),phone),false);
  for(const invalid of ['"*"'," * ",'"all"',"{}",'["*@g.us"]','["Example Workshop"]',"[null]",'["https://example.com"]',"x".repeat(8193)]) assert.throws(()=>parseWahaTestRecipientAllowlist(invalid));
});

test("GOWS bare inbound quotes require consistent signed chat and stanza context",async()=>{
  const allowed=parseWahaTestRecipientAllowlist(raw);
  const adapter=new WahaAdapter({baseUrl:"https://provider.test",apiKey:"synthetic",sessionFor:()=>"synthetic"});
  for(const event of ["message","message.any"]){
    const body={...gowsQuote(),event};
    assert.equal(wahaTestWebhookAllowed(allowed,body),true);
    const normalized=await adapter.normalizeWebhook("synthetic",body,new Headers());
    assert.equal(normalized.groupId,group);assert.equal(normalized.quotedMessageId,body.payload.replyTo.id);
  }
  assert.equal(wahaTestWebhookAllowed(allowed,gowsQuote(phone)),true);
  const mutations=[
    b=>{delete b.engine},b=>{b.engine="WEBJS"},b=>{b.event="message.edited"},
    b=>{b.payload.replyTo=b.payload.replyTo.id},b=>{b.payload.replyTo="unknown"},
    b=>{b.payload.replyTo={id:"unknown"}},b=>{delete b.payload._data},
    b=>{delete b.payload.id},b=>{b.payload.id=`false_${otherGroup}_SYNTHETIC`},
    b=>{b.payload._data.Info.Chat=otherGroup},b=>{b.payload._data.Info.Chat=phone},
    b=>{b.payload._data.Message.extendedTextMessage.contextInfo.stanzaID="DIFFERENT"},
    b=>{delete b.payload._data.Message.extendedTextMessage.contextInfo.quotedMessage},
    b=>{b.payload.replyTo._serialized=`false_${otherGroup}_QUOTE`},
    b=>{b.payload.replyTo._serialized="unknown"},
    b=>{b.payload.replyTo.id=`false_${phone}_QUOTE`},
  ];
  for(const mutate of mutations){const body=structuredClone(gowsQuote());mutate(body);assert.equal(wahaTestWebhookAllowed(allowed,body),false)}
  for(const id of ["",42,"bad id","bad\nidentifier","x".repeat(1025)]){
    const body=gowsQuote();body.payload.replyTo.id=id;
    body.payload._data.Message.extendedTextMessage.contextInfo.stanzaID=id;
    assert.equal(wahaTestWebhookAllowed(allowed,body),false);
  }
});

test("test ingress admits lifecycle and approved chats but rejects unknown or conflicting chat evidence",()=>{
  const allowed=parseWahaTestRecipientAllowlist(raw);
  const message=(chat)=>({event:"message",payload:{from:chat,to:"me",id:`false_${chat}_TEST`}});
  assert.equal(wahaTestWebhookAllowed(allowed,message(group)),true);
  assert.equal(wahaTestWebhookAllowed(allowed,message(phone)),true);
  assert.equal(wahaTestWebhookAllowed(allowed,{event:"session.status",payload:{status:"WORKING"}}),true);
  assert.equal(wahaTestWebhookAllowed(allowed,{event:"message.any",payload:{from:bot,to:phone,fromMe:true,id:`true_${phone}_TEST`}}),true);
  assert.equal(wahaTestWebhookAllowed(allowed,{event:"message.ack.group",payload:{id:`true_${group}_TEST`,participant:"12025550162@c.us"}}),true);
  assert.equal(wahaTestWebhookAllowed(allowed,{event:"poll.vote",payload:{vote:{from:phone},poll:{id:`true_${phone}_POLL`}}}),true);
  assert.equal(wahaTestWebhookAllowed(allowed,{event:"message.revoked",payload:{after:{id:`false_${group}_REVOKE`},revokedMessageId:`false_${group}_TEST`}}),true);
  assert.equal(wahaTestWebhookAllowed(allowed,{event:"message.edited",payload:{from:group,id:`false_${group}_EDIT`,editedMessageId:`false_${group}_TEST`}}),true);
  assert.equal(wahaTestWebhookAllowed(allowed,{event:"message.reaction",payload:{from:group,id:`false_${group}_REACT`,reaction:{messageId:`false_${group}_TEST`}}}),true);
  assert.equal(wahaTestWebhookAllowed(allowed,{event:"message",payload:{from:group,replyTo:{id:`false_${group}_QUOTE`}}}),true);
  for(const body of [{event:"message",payload:{to:bot}},{event:"message.ack.group",payload:{to:bot,participant:phone}},{event:"poll.vote",payload:{to:bot,vote:{selectedOptions:["synthetic"]}}}]) assert.equal(wahaTestWebhookAllowed(allowed,body),false);
  for(const body of [message(otherGroup),message("12025550162@c.us"),{event:"message",payload:{}},{event:"message",payload:{chatId:group,from:otherGroup}},{event:"message",payload:{from:group,id:`false_${otherGroup}_TEST`}},{event:"message.edited",payload:{from:group,editedMessageId:`false_${otherGroup}_TEST`}},{event:"message",payload:{from:group,replyTo:`false_${phone}_QUOTE`}},{event:"message",payload:{from:group,replyTo:"unknown"}}]) assert.equal(wahaTestWebhookAllowed(allowed,body),false);
  assert.equal(wahaTestWebhookAllowed(undefined,message(otherGroup)),true);
});

test("group poll scope follows the chat and rejects every contradictory poll/vote remote",()=>{
  const allowed=parseWahaTestRecipientAllowlist(raw);
  const groupVote=(chat=group,sender=phone)=>({event:"poll.vote",payload:{
    vote:{id:`false_${chat}_VOTE`,to:chat,from:sender,fromMe:false,selectedOptions:["synthetic"]},
    poll:{id:`true_${chat}_POLL`,to:chat,from:bot,fromMe:true},
  }});
  assert.equal(wahaTestWebhookAllowed(allowed,groupVote()),true);
  assert.equal(wahaTestWebhookAllowed(allowed,groupVote(group,"12025550162@c.us")),true);
  assert.equal(wahaTestWebhookAllowed(allowed,groupVote(otherGroup,phone)),false);
  for(const sender of ["not-a-JID",group,null]){
    assert.equal(wahaTestWebhookAllowed(allowed,groupVote(group,sender)),false);
  }
  const missingVoter=groupVote();delete missingVoter.payload.vote.from;
  assert.equal(wahaTestWebhookAllowed(allowed,missingVoter),false);
  for(const field of ["vote-id","vote-to","poll-id","poll-to"]){
    const event=groupVote();
    if(field==="vote-id")event.payload.vote.id=`false_${otherGroup}_VOTE`;
    if(field==="vote-to")event.payload.vote.to=otherGroup;
    if(field==="poll-id")event.payload.poll.id=`true_${otherGroup}_POLL`;
    if(field==="poll-to")event.payload.poll.to=otherGroup;
    assert.equal(wahaTestWebhookAllowed(allowed,event),false,field);
  }
  const direct={event:"poll.vote",payload:{vote:{id:`false_${phone}_VOTE`,from:phone,to:"me"},poll:{id:`true_${phone}_POLL`,to:phone,from:"me"}}};
  assert.equal(wahaTestWebhookAllowed(allowed,direct),true);
  direct.payload.vote.from="12025550162@c.us";
  assert.equal(wahaTestWebhookAllowed(allowed,direct),false);
});

test("scoped group discovery requests metadata only and never reads contacts or foreign rosters",async(t)=>{
  const previous=process.env.WASALX_TEST_RECIPIENT_ALLOWLIST,fetchBefore=globalThis.fetch;
  t.after(()=>{if(previous===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=previous;globalThis.fetch=fetchBefore});
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=raw;
  await t.test("only selected metadata is returned and provider counts are not invented",async()=>{
    const calls=[];
    globalThis.fetch=async(url)=>{calls.push(new URL(url));return Response.json([
      {JID:group,Name:"Selected test group",ParticipantCount:0},
      {JID:otherGroup,Name:"Excluded test group",ParticipantCount:0},
    ]);};
    const adapter=new WahaAdapter({baseUrl:"https://provider.test",apiKey:"synthetic-unused",sessionFor:()=>"synthetic-session"});
    const result=await adapter.listGroups("synthetic-connection");
    assert.equal(calls.length,1);assert.equal(calls[0].searchParams.get("exclude"),"participants");
    assert.deepEqual(result.groups,[{id:group,name:"Selected test group",participants:0}]);
  });
  await t.test("provider exclusion violations in foreign groups fail closed",async()=>{
    for(const roster of [[{JID:phone}],{unexpected:"roster"}]){
      const calls=[];globalThis.fetch=async(url)=>{calls.push(new URL(url));return Response.json([
        {JID:group,Name:"Selected test group",ParticipantCount:0},
        {JID:otherGroup,Name:"Excluded test group",Participants:roster},
      ]);};
      const adapter=new WahaAdapter({baseUrl:"https://provider.test",apiKey:"synthetic-unused",sessionFor:()=>"synthetic-session"});
      await assert.rejects(adapter.listGroups("synthetic-connection"),{code:"WAHA_TEST_GROUP_METADATA_INVALID"});assert.equal(calls.length,1);
    }
  });
  await t.test("unexpected selected roster or missing count refuses without contact lookup",async()=>{
    for(const detail of [{Participants:[{JID:phone}]},{}]){
      const calls=[];globalThis.fetch=async(url)=>{calls.push(new URL(url));return Response.json([{JID:group,Name:"Selected test group",...detail}]);};
      const adapter=new WahaAdapter({baseUrl:"https://provider.test",apiKey:"synthetic-unused",sessionFor:()=>"synthetic-session"});
      await assert.rejects(adapter.listGroups("synthetic-connection"));assert.equal(calls.length,1);
    }
  });
  await t.test("pagination follows provider page size after excluding other groups",async()=>{
    globalThis.fetch=async()=>Response.json(Array.from({length:100},()=>({JID:otherGroup,Name:"Excluded test group",ParticipantCount:0})));
    const adapter=new WahaAdapter({baseUrl:"https://provider.test",apiKey:"synthetic-unused",sessionFor:()=>"synthetic-session"});
    assert.deepEqual(await adapter.listGroups("synthetic-connection"),{groups:[],nextCursor:"100"});
  });
  await t.test("a scope without group recipients makes no directory request",async()=>{
    process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=JSON.stringify([phone]);
    let calls=0;globalThis.fetch=async()=>{calls++;throw new Error("directory request forbidden");};
    const adapter=new WahaAdapter({baseUrl:"https://provider.test",apiKey:"synthetic-unused",sessionFor:()=>"synthetic-session"});
    assert.deepEqual(await adapter.listGroups("synthetic-connection"),{groups:[],nextCursor:undefined});assert.equal(calls,0);
  });
});

test("scoped metadata synchronization preserves excluded groups and all participant rows",async(t)=>{
  const previous=process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;
  t.after(()=>{if(previous===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=previous});
  const job={tenantId:"00000000-0000-4000-8000-000000000001",connectionId:"00000000-0000-4000-8000-000000000002",provider:"WAHA"};
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=raw;
  await t.test("stale update is limited and no participant query is issued",async()=>{
    const queries=[];const client={query:async(sql,params)=>{queries.push({sql,params});return {rows:[],rowCount:0};}};
    await synchronizeGroups(client,job,[{id:group,name:"Selected test group",participants:0}]);
    const stale=queries.find(q=>/UPDATE whatsapp_groups/u.test(q.sql));
    assert.match(stale.sql,/external_group_id\s*=\s*ANY\(\$3::text\[\]\)/u);assert.deepEqual(stale.params[2],[group]);
    assert.ok(queries.every(q=>!q.sql.includes("group_workspace_participants")));
  });
  await t.test("foreign group cannot reach persistence",async()=>{
    let queries=0;const client={query:async()=>{queries++;return {rows:[],rowCount:0};}};
    await assert.rejects(synchronizeGroups(client,job,[{id:otherGroup,name:"Excluded test group",participants:0}]),{code:"WAHA_TEST_RECIPIENT_NOT_ALLOWED"});assert.equal(queries,0);
  });
  await t.test("no group recipients is a no-op",async()=>{
    process.env.WASALX_TEST_RECIPIENT_ALLOWLIST="[]";
    let queries=0;const client={query:async()=>{queries++;return {rows:[],rowCount:0};}};
    await synchronizeGroups(client,job,[]);assert.equal(queries,0);
  });
});

test("final WAHA send boundary refuses excluded targets and cross-chat replies/reactions before network",async(t)=>{
  const before=process.env.WASALX_TEST_RECIPIENT_ALLOWLIST, fetchBefore=globalThis.fetch;
  t.after(()=>{if(before===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=before;globalThis.fetch=fetchBefore});
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=raw;
  const calls=[],warnings=[];
  t.mock.method(process.stderr, "write", (line) => { warnings.push(String(line)); return true; });
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return new Response(JSON.stringify({id:`true_${group}_SENT`}),{status:200})};
  const adapter=new WahaAdapter({baseUrl:"http://fixture.invalid",apiKey:"synthetic-key",sessionFor:()=>"synthetic-session"});
  const input={connectionId:"synthetic",groupId:group,text:"synthetic",idempotencyKey:"synthetic"};
  assert.equal((await adapter.send(input)).state,"SENT");
  assert.equal((await adapter.send({...input,groupId:phone,recipientType:"DIRECT"})).state,"SENT");
  assert.equal((await adapter.send({...input,replyToMessageId:`false_${group}_REPLY`})).state,"SENT");
  assert.equal((await adapter.send({...input,text:"",reaction:{messageId:`false_${group}_REACTION`,emoji:"✅"}})).state,"SENT");
  const acceptedCalls=calls.length;
  for(const rejected of [
    {...input,groupId:otherGroup}, {...input,groupId:"12025550162@c.us",recipientType:"DIRECT"},
    {...input,replyToMessageId:`false_${otherGroup}_REPLY`}, {...input,replyToMessageId:"unresolved-id"},
    {...input,replyToMessageId:`false_${phone}_REPLY`},
    {...input,text:"",reaction:{messageId:`false_${otherGroup}_REACTION`,emoji:"✅"}},
    {...input,groupId:otherGroup,media:{bytes:new Uint8Array([1]),mimeType:"image/png",filename:"synthetic.png"}},
  ]) await assert.rejects(adapter.send(rejected),error=>error.code==="WAHA_TEST_RECIPIENT_NOT_ALLOWED"&&error.outcomeKnown===true);
  assert.equal(calls.length,acceptedCalls);assert.equal(warnings.length,7);
  for (const line of warnings) {
    const { timestamp, request_id, ...entry } = JSON.parse(line);
    assert.deepEqual(entry, {
      level: "warn", event: "waha.test_recipient_scope_refused",
      component: "waha-connector", error_code: "WAHA_TEST_RECIPIENT_NOT_ALLOWED",
    });
    assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(request_id, /^[a-f0-9-]{36}$/u);
  }
  for(const raw of [undefined,""," ","[]","not-json"]){
    if(raw===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=raw;
    if(raw==="not-json")assert.throws(()=>new WahaAdapter({baseUrl:"http://fixture.invalid",apiKey:"synthetic-key",sessionFor:()=>"synthetic-session"}));
    else {
      const denied=new WahaAdapter({baseUrl:"http://fixture.invalid",apiKey:"synthetic-key",sessionFor:()=>"synthetic-session"});
      await assert.rejects(denied.send(input),{code:"WAHA_TEST_RECIPIENT_NOT_ALLOWED"});
    }
    assert.equal(calls.length,acceptedCalls);
  }
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST="*";
  const normal=new WahaAdapter({baseUrl:"http://fixture.invalid",apiKey:"synthetic-key",sessionFor:()=>"synthetic-session"});
  assert.equal((await normal.send({...input,groupId:otherGroup})).state,"SENT");
});

test("excluded deliveries fail before begin-send, secret reads, native writes or media staging",async(t)=>{
  const previous=process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;
  t.after(()=>{if(previous===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=previous});
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=raw;
  const effects=[],failures=[];
  const repository={whatsAppMarketingOptedOut:async()=>false,beginSend:async()=>effects.push("begin"),fail:async(_job,_lease,retryable,error)=>failures.push({retryable,error})};
  const processor=new DeliveryProcessor(repository,{resolve:async()=>{effects.push("secret");throw new Error("Unexpected secret read")}},{metaGraphVersion:"v24.0"},8,{prepare:async()=>{effects.push("media");throw new Error("Unexpected media preparation")}});
  const job={id:"synthetic",provider:"waha",tenantId:"synthetic",connectionId:"synthetic",groupId:otherGroup,ticketId:"42",text:"synthetic",contentType:"text/plain",attempts:1,idempotencyKey:"synthetic"};
  assert.equal(await processor.deliver(job,"synthetic-lease"),false);
  assert.equal(await processor.deliver({...job,media:{mimeType:"image/png"}},"synthetic-lease"),false);
  assert.deepEqual(effects,[]);assert.equal(failures.length,2);
  assert(failures.every(value=>value.retryable===false&&value.error.includes("outside the configured test scope")));
});

test("signed WAHA ingress drops excluded chats before persistence and wake, preserving normal signature gates",async(t)=>{
  const previous=process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;
  t.after(()=>{if(previous===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=previous});
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=raw;
  const token="s".repeat(32),secret="synthetic-hmac-key",connection="synthetic-connection",session="synthetic-session";
  const route={tenant_id:"synthetic-tenant",connection_id:connection,provider:"WAHA",hmac_secret_reference:"secret://synthetic/hmac"};
  const persisted=[],wakes=[];
  const database={resolveWahaWebhookRoute:async()=>route,acceptWebhookEvent:async(actual,input)=>{assert.equal(actual,route);persisted.push(input);return{id:"synthetic",duplicate:false}}};
  let controller=new WebhookIngressController(database,{resolveHmac:async()=>secret},{wakeInbound:async tenant=>wakes.push(tenant)});
  const invoke=(chat,badSignature=false,metadataConnection=connection,payload,omitEngine=false)=>{
    const timestamp=Date.now();const body={id:"event-synthetic",event:"message",timestamp,session,engine:"GOWS",metadata:{connectionId:metadataConnection},payload:payload??{from:chat,to:"me",id:`false_${chat}_TEST`,body:"synthetic"}};
    if(omitEngine)delete body.engine;
    const bytes=Buffer.from(JSON.stringify(body));return controller.waha(token,{rawBody:bytes,headers:{"x-webhook-hmac-algorithm":"sha512","x-webhook-timestamp":String(timestamp),"x-webhook-hmac":badSignature?"0".repeat(128):createHmac("sha512",secret).update(bytes).digest("hex")}},body);
  };
  assert.equal((await invoke(group)).accepted,true);assert.equal(persisted.length,1);assert.equal(wakes.length,1);
  for(const chat of [otherGroup,"12025550162@c.us"]){assert.deepEqual(await invoke(chat),{accepted:false,dropped:true});assert.equal(persisted.length,1);assert.equal(wakes.length,1)}
  await assert.rejects(invoke(otherGroup,true),error=>error.getStatus()===401);
  await assert.rejects(invoke(group,false,"foreign-connection"),error=>error.getStatus()===400);
  assert.equal(persisted.length,1);assert.equal(wakes.length,1);
  assert.equal((await invoke(phone)).accepted,true);
  assert.equal(persisted.length,2);assert.equal(wakes.length,2);
  for(const omitEngine of [false,true]){
    const before=persisted.length;
    assert.equal((await invoke(group,false,connection,gowsQuote().payload,omitEngine)).accepted,true);
    assert.equal(persisted.length,before+1);assert.equal(wakes.length,before+1);
    assert.equal(persisted.at(-1).providerEngine,"GOWS");
    assert.equal(persisted.at(-1).payload.engine,omitEngine?undefined:"GOWS");
    const foreignContext=gowsQuote().payload;foreignContext._data.Info.Chat=otherGroup;
    assert.deepEqual(await invoke(group,false,connection,foreignContext,omitEngine),{accepted:false,dropped:true});
    await assert.rejects(invoke(group,true,connection,gowsQuote().payload,omitEngine),error=>error.getStatus()===401);
    await assert.rejects(invoke(group,false,"foreign-connection",gowsQuote().payload,omitEngine),error=>error.getStatus()===400);
    assert.equal(persisted.length,before+1);assert.equal(wakes.length,before+1);
  }
  const accepted=persisted.length;
  for(const raw of [undefined,"","[]","not-json"]){
    if(raw===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=raw;
    const create=()=>new WebhookIngressController(database,{resolveHmac:async()=>secret},{wakeInbound:async tenant=>wakes.push(tenant)});
    if(raw==="not-json")assert.throws(create);
    else {controller=create();assert.deepEqual(await invoke(phone),{accepted:false,dropped:true})}
    assert.equal(persisted.length,accepted);assert.equal(wakes.length,accepted);
  }
});
