import assert from "node:assert/strict";
import test from "node:test";
import { InboundProcessor as ProductionInboundProcessor } from "../services/connector-worker/dist/services/connector-worker/src/inbound-processor.js";

class InboundProcessor extends ProductionInboundProcessor {
  constructor(repository,...dependencies){super({messageIsWithinAdmissionWindow:async()=>true,hasRunnableGroupBinding:async()=>false,renewWahaWorkerAssignment:async(_event,context)=>context,...repository},...dependencies)}
}

test("an appended inbound group article keeps the service creator and renders the WhatsApp customer as author",async()=>{
  const event={id:"group-event",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"group-event",eventType:"message",attempts:1,
    payload:{event:"message",payload:{id:"group-message",chatId:"447700900008@g.us",participant:"12125550102@s.whatsapp.net",notifyName:"Noura",body:"1234567890",timestamp:1_700_000_000}}};
  const context={bindingId:"binding-a",groupId:"447700900008@g.us",groupName:"Operations",zammadGroup:"2",acknowledgementTemplate:"Case {{tickets}}",maxIdentifiers:20,
    agentPrefix:"Agent",ruleVersion:1,zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,
    rules:[{id:"rule-a",name:"Shipment",matcherType:"exact_length",pattern:"",prefix:null,digitLength:10,priority:1,enabled:true,version:1}]};
  const completed=[];
  const repository={claim:async()=>[event],normalize:async()=>"new",context:async()=>context,ticketsForQuotedMessage:async()=>[],
    linkZammadCustomer:async()=>{},correlate:async(_event,_context,_message,_reference,actions)=>{const articleId=await actions.append("42");return{id:"42",number:"10042",articleId}},
    enqueueAcknowledgement:async()=>"delivery-a",complete:async(_event,_lease,status)=>completed.push(status),fail:async()=>{throw new Error("unexpected failure")}};
  const calls=[];const original=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{const url=new URL(String(input));const method=init?.method??"GET";const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path:url.pathname,method,body});
    if(url.pathname==="/api/v1/users/search")return Response.json([]);
    if(url.pathname==="/api/v1/users")return Response.json({id:7,login:body.login,firstname:body.firstname,lastname:"",mobile:body.mobile});
    if(url.pathname==="/api/v1/ticket_articles/by_ticket/42")return Response.json([]);
    if(url.pathname==="/api/v1/ticket_articles"&&method==="POST")return Response.json({id:90});
    return new Response(null,{status:404})};
  try{assert.deepEqual(await new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})}).drainTenant("tenant-a"),{events:1,acknowledgements:1})}finally{globalThis.fetch=original}
  assert.deepEqual(completed,["PROCESSED"]);
  assert.equal(calls.find(call=>call.path==="/api/v1/users")?.body.mobile,"+12125550102");
  const article=calls.find(call=>call.path==="/api/v1/ticket_articles")?.body;
  assert.equal(article.sender,"Customer");assert.equal(article.origin_by_id,7);
  assert.equal(calls.some(call=>call.path==="/api/v1/tickets"&&call.method==="POST"),false);
});
