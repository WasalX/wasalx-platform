import assert from "node:assert/strict";
import test from "node:test";
import { botActionCapabilities, supportsBotActionInvocation } from "../packages/core/src/bot-action-capabilities.ts";
import { executeBotAction, isPublicBotActionAddress, mapBotActionResponse, notionPagePayload, ResponseLimitError, safeHttpsRequest, selectBotActionAddress } from "../services/connector-worker/dist/services/connector-worker/src/bot-action.js";

const baseJob={id:"action-1",tenantId:"tenant-a",conversationId:"conversation-1",sourceEventId:"event-1",actionNodeId:"lookup",requestInput:{order:"42"},onSuccessNodeId:"done",onFailureNodeId:"failed",attempts:1,fencingToken:1,kind:"HTTP_JSON" as const,endpointUrl:"https://api.example.com/orders",httpMethod:"POST" as const,authScheme:"NONE" as const,headers:{"x-client":"wasalx"},responseMapping:{"action.status":"/status"},timeoutMs:5000,maxResponseBytes:2048,flowDefinition:{},conversationVariables:{},zammadTicketId:"42",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",handoffZammadGroupId:"2"};

test("declarative action capabilities are shared by direct flows and group commands",()=>{
  const getAction={kind:"HTTP_JSON",endpointUrl:"https://api.example.com/orders",httpMethod:"GET",authScheme:"NONE",secretReference:null};
  assert.deepEqual(botActionCapabilities(getAction),{invocation_surfaces:["DIRECT_FLOW","GROUP_COMMAND"],retry_semantics:"REPLAY_SAFE"});
  assert.deepEqual(botActionCapabilities({...getAction,httpMethod:"POST"}),{invocation_surfaces:["DIRECT_FLOW","GROUP_COMMAND"],retry_semantics:"OUTCOME_UNKNOWN_ON_AMBIGUOUS_FAILURE"});
  const notion={kind:"NOTION_CREATE_PAGE",endpointUrl:"https://api.notion.com/v1/pages",httpMethod:"POST",authScheme:"BEARER",secretReference:"secret://tenants/tenant-a/bot-actions/notion"};
  assert.equal(supportsBotActionInvocation(notion,"GROUP_COMMAND"),true);
  assert.deepEqual(botActionCapabilities({...notion,httpMethod:"GET"}),{invocation_surfaces:[],retry_semantics:null});
  assert.deepEqual(botActionCapabilities({...getAction,endpointUrl:"http://127.0.0.1/action"}),{invocation_surfaces:[],retry_semantics:null});
});

test("bot actions reject internal and special network destinations",()=>{
  for(const address of ["127.0.0.1","192.0.2.1","192.0.2.1","172.16.0.1","192.0.2.1","192.0.2.1","192.0.2.1","198.51.100.1","::1","2001:db8::1","2001:db8::1","2001:2::1","2001:db8::1","2002::1","3fff::1"])assert.equal(isPublicBotActionAddress(address),false,address);
  assert.equal(isPublicBotActionAddress("8.8.8.8"),true);
  assert.equal(isPublicBotActionAddress("2606:4700:4700::1111"),true);
  assert.deepEqual(selectBotActionAddress([{address:"8.8.8.8",family:4},{address:"1.1.1.1",family:4}]),{address:"8.8.8.8",family:4});
  assert.throws(()=>selectBotActionAddress([{address:"8.8.8.8",family:4},{address:"127.0.0.1",family:4}]),/public addresses/);
});

test("Notion actions build one bounded create-page payload",()=>{
  assert.deepEqual(notionPagePayload({parent_type:"data_source_id",parent_id:"123456781234123412341234567890ab",title_property:"Name",title:"Order ORD-42",content:"Customer requested a human review."}),{
    parent:{type:"data_source_id",data_source_id:"123456781234123412341234567890ab"},
    properties:{Name:{title:[{type:"text",text:{content:"Order ORD-42"}}]}},
    children:[{object:"block",type:"paragraph",paragraph:{rich_text:[{type:"text",text:{content:"Customer requested a human review."}}]}}],
  });
  assert.throws(()=>notionPagePayload({parent_type:"page_id",parent_id:"internal",title:"Bad"}),/parent ID/);
});

test("bot actions persist only explicitly mapped bounded scalar response fields",()=>{
  assert.deepEqual(mapBotActionResponse({order:{status:"shipped",attempts:2},secret:"discarded"},{"action.status":"/order/status","action.attempts":"/order/attempts"}),{"action.status":"shipped","action.attempts":"2"});
  assert.throws(()=>mapBotActionResponse({order:{}},{"action.status":"/order/status"}),/missing or not scalar/);
  assert.throws(()=>mapBotActionResponse({order:{status:{private:true}}},{"action.status":"/order/status"}),/missing or not scalar/);
  const oversized=Object.fromEntries(Array.from({length:17},(_,index)=>[`field${index}`,"x".repeat(4096)]));
  const oversizedMapping=Object.fromEntries(Array.from({length:17},(_,index)=>[`action.field${index}`,`/field${index}`]));
  assert.throws(()=>mapBotActionResponse(oversized,oversizedMapping),/mapped response is too large/);
});

test("bot actions send one idempotent bounded request and map only declared output",async()=>{
  let request:{url:string;method:"GET"|"POST";headers:Record<string,string>;body:Record<string,unknown>;timeout:number;maxBytes:number}|undefined;
  const result=await executeBotAction({...baseJob,kind:"NOTION_CREATE_PAGE",endpointUrl:"https://api.notion.com/v1/pages",authScheme:"BEARER",secretReference:"secret://tenants/tenant-a/bot-actions/notion",requestInput:{parent_type:"page_id",parent_id:"123456781234123412341234567890ab",title:"Case 42"}},"notion-token",async(url,method,headers,body,timeout,maxBytes)=>{request={url:String(url),method,headers,body:JSON.parse(String(body)),timeout,maxBytes};return{status:201,headers:{},body:'{"status":"created","secret":"discarded"}'}});
  assert.deepEqual(result,{state:"SUCCEEDED",variables:{"action.status":"created"}});
  assert.ok(request);
  assert.equal(request.headers.authorization,"Bearer notion-token");
  assert.equal(request.headers["idempotency-key"],"bot-action:action-1");
  assert.equal(request.headers["notion-version"],"2026-03-11");
  assert.deepEqual(request.body.parent,{type:"page_id",page_id:"123456781234123412341234567890ab"});
  assert.deepEqual({url:request.url,method:request.method,timeout:request.timeout,maxBytes:request.maxBytes},{url:"https://api.notion.com/v1/pages",method:"POST",timeout:5000,maxBytes:2048});
});

test("bot action failures preserve safe retry and unknown-outcome boundaries",async()=>{
  const response=async(status:number,headers:Record<string,string|string[]|undefined>={})=>({status,headers,body:"{}"});
  assert.deepEqual(await executeBotAction(baseJob,undefined,async()=>response(302)),{state:"FAILED_TERMINAL",safeError:"Bot action returned HTTP 302"});
  assert.deepEqual(await executeBotAction({...baseJob,httpMethod:"GET"},undefined,async()=>response(429,{"retry-after":"7"})),{state:"FAILED_RETRYABLE",safeError:"Bot action returned HTTP 429",retryAfterMs:7000});
  assert.deepEqual(await executeBotAction({...baseJob,httpMethod:"GET"},undefined,async()=>response(503)),{state:"FAILED_RETRYABLE",safeError:"Bot action returned HTTP 503",retryAfterMs:30000});
  assert.deepEqual(await executeBotAction({...baseJob,httpMethod:"GET"},undefined,async()=>response(408)),{state:"FAILED_RETRYABLE",safeError:"Bot action returned HTTP 408",retryAfterMs:30000});
  assert.deepEqual(await executeBotAction(baseJob,undefined,async()=>response(425)),{state:"OUTCOME_UNKNOWN",safeError:"Bot action returned HTTP 425"});
  assert.deepEqual(await executeBotAction(baseJob,undefined,async()=>response(503)),{state:"OUTCOME_UNKNOWN",safeError:"Bot action returned HTTP 503"});
  const timeout=Object.assign(new Error("private token=must-not-leak"),{name:"AbortError"});
  assert.deepEqual(await executeBotAction({...baseJob,httpMethod:"GET"},undefined,async()=>{throw timeout}),{state:"FAILED_RETRYABLE",safeError:"Bot action timed out",retryAfterMs:30000});
  assert.deepEqual(await executeBotAction(baseJob,undefined,async()=>{throw timeout}),{state:"OUTCOME_UNKNOWN",safeError:"Bot action timed out"});
  assert.deepEqual(await executeBotAction(baseJob,undefined,async()=>{throw new ResponseLimitError}),{state:"FAILED_TERMINAL",safeError:"Bot action response exceeded its configured limit"});
  assert.deepEqual(await executeBotAction(baseJob,undefined,async()=>({status:200,headers:{},body:"not-json"})),{state:"FAILED_TERMINAL",safeError:"Bot action returned an invalid JSON response"});
  let sent=false;
  assert.deepEqual(await executeBotAction({...baseJob,kind:"NOTION_CREATE_PAGE",authScheme:"BEARER",requestInput:{parent_type:"page_id",parent_id:"invalid",title:"Bad"}},"notion-token",async()=>{sent=true;return response(201)}),{state:"FAILED_TERMINAL",safeError:"Bot action request is invalid"});
  assert.equal(sent,false);
});

test("bot action deadline includes DNS lookup",async()=>{
  const started=Date.now();let called=false;
  await assert.rejects(()=>safeHttpsRequest(new URL("https://api.example.com/action"),"GET",{},undefined,50,1024,{
    lookup:async()=>new Promise(()=>{}),
    call:async()=>{called=true;return{status:200,headers:{},body:"{}"}},
  }),error=>error instanceof Error&&error.name==="AbortError");
  assert.equal(called,false);
  assert.ok(Date.now()-started<500);
});

test("slow response cannot extend the total bot action deadline",async()=>{
  const started=Date.now();let called=false;
  await assert.rejects(()=>safeHttpsRequest(new URL("https://api.example.com/action"),"GET",{},undefined,100,1024,{
    lookup:async()=>[{address:"8.8.8.8",family:4}],
    call:async(_url,_method,_headers,_body,_address,_maxBytes,signal)=>new Promise((_resolve,reject)=>{
      called=true;
      signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
    }),
  } satisfies NonNullable<Parameters<typeof import("../services/connector-worker/src/bot-action.ts").safeHttpsRequest>[6]>),error=>error instanceof Error&&error.name==="AbortError");
  const elapsed=Date.now()-started;
  assert.equal(called,true);
  assert.ok(elapsed>=70&&elapsed<500,`deadline elapsed ${elapsed}ms`);
});
