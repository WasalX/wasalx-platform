import { lookup } from "node:dns/promises";
import {MetaDirectEffectNotAttempted} from "../../../packages/core/src/meta-direct-identity.js";
import { request } from "node:https";
import { isIP } from "node:net";
import type { BotActionRequest } from "./types.js";

export type BotActionResult=
  |{state:"SUCCEEDED";variables:Record<string,string>}
  |{state:"FAILED_RETRYABLE";safeError:string;retryAfterMs:number}
  |{state:"FAILED_TERMINAL"|"OUTCOME_UNKNOWN";safeError:string};
export type BotActionTransport=typeof safeHttpsRequest;
type BotActionLookup=(hostname:string)=>Promise<Array<{address:string;family:number}>>;
type BotActionCall=(url:URL,method:"GET"|"POST",headers:Record<string,string>,body:string|undefined,address:{address:string;family:number},maxBytes:number,signal:AbortSignal)=>Promise<{status:number;headers:Record<string,string|string[]|undefined>;body:string}>;

export async function executeBotAction(job:BotActionRequest,bearerToken?:string,transport:BotActionTransport=safeHttpsRequest,beforeRequest?:()=>Promise<void>):Promise<BotActionResult>{
  let url:URL;let body:string|undefined;let headers:Record<string,string>;
  try{
    url=new URL(job.endpointUrl);
    if(job.httpMethod==="GET")for(const [key,value] of Object.entries(job.requestInput))url.searchParams.set(key,value);
    body=job.httpMethod==="POST"?JSON.stringify(job.kind==="NOTION_CREATE_PAGE"?notionPagePayload(job.requestInput):job.requestInput):undefined;
    headers={...job.headers,accept:"application/json","user-agent":"WasalX bot action/1","idempotency-key":`bot-action:${job.id}`};
    if(body)headers["content-type"]="application/json";
    if(job.authScheme==="BEARER"){
      if(!bearerToken||bearerToken.length>8192)throw new Error("Bot action bearer credential is unavailable");
      headers.authorization=`Bearer ${bearerToken}`;
    }
    if(job.kind==="NOTION_CREATE_PAGE")headers["notion-version"]="2026-03-11";
  }catch{return{state:"FAILED_TERMINAL",safeError:"Bot action request is invalid"}}
  try{
    // Injected test transports have no DNS phase. The production callback runs
    // inside safeHttpsRequest after address validation, immediately before HTTP.
    if(transport!==safeHttpsRequest)await beforeRequest?.();
    const response=await transport(url,job.httpMethod,headers,body,job.timeoutMs,job.maxResponseBytes,transport===safeHttpsRequest?{beforeRequest}:undefined);
    if(response.status>=200&&response.status<300){
      try{
        const parsed=response.body.length?JSON.parse(response.body) as unknown:{};
        return{state:"SUCCEEDED",variables:mapBotActionResponse(parsed,job.responseMapping)};
      }catch{return{state:"FAILED_TERMINAL",safeError:"Bot action returned an invalid JSON response"}}
    }
    const safeError=`Bot action returned HTTP ${response.status}`;
    if(response.status===408||response.status===425)return job.httpMethod==="GET"?{state:"FAILED_RETRYABLE",safeError,retryAfterMs:retryAfter(response.headers["retry-after"])}:{state:"OUTCOME_UNKNOWN",safeError};
    if(response.status===429)return{state:"FAILED_RETRYABLE",safeError,retryAfterMs:retryAfter(response.headers["retry-after"])};
    if(response.status>=500&&job.httpMethod==="GET")return{state:"FAILED_RETRYABLE",safeError,retryAfterMs:30_000};
    return{state:response.status>=500?"OUTCOME_UNKNOWN":"FAILED_TERMINAL",safeError};
  }catch(error){
    if(error instanceof MetaDirectEffectNotAttempted)throw error;
    if(error instanceof ResponseLimitError)return{state:"FAILED_TERMINAL",safeError:error.message};
    const safeError=error instanceof Error&&error.name==="AbortError"?"Bot action timed out":"Bot action network request failed";
    return job.httpMethod==="GET"?{state:"FAILED_RETRYABLE",safeError,retryAfterMs:30_000}:{state:"OUTCOME_UNKNOWN",safeError};
  }
}

export async function safeHttpsRequest(url:URL,method:"GET"|"POST",headers:Record<string,string>,body:string|undefined,timeoutMs:number,maxBytes:number,dependencies:{lookup?:BotActionLookup;call?:BotActionCall;beforeRequest?:()=>Promise<void>}={}){
  if(url.protocol!=="https:"||url.username||url.password||url.hash)throw new Error("Configured HTTPS endpoint is invalid");
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(abortError()),timeoutMs);
  try{
    const addresses=await abortable((dependencies.lookup??defaultLookup)(url.hostname),controller.signal);
    const address=selectBotActionAddress(addresses);
    await dependencies.beforeRequest?.();
    if(controller.signal.aborted&&dependencies.beforeRequest)throw new MetaDirectEffectNotAttempted("BUSY");
    return await abortable((dependencies.call??call)(url,method,headers,body,address,maxBytes,controller.signal),controller.signal);
  }finally{clearTimeout(timeout)}
}

function defaultLookup(hostname:string){return lookup(hostname,{all:true,verbatim:true})}

export function selectBotActionAddress(addresses:Array<{address:string;family:number}>){if(!addresses.length||addresses.some(({address})=>!isPublicBotActionAddress(address)))throw new Error("Configured HTTPS endpoint did not resolve to public addresses");return addresses[0]!}

function call(url:URL,method:"GET"|"POST",headers:Record<string,string>,body:string|undefined,address:{address:string;family:number},maxBytes:number,signal:AbortSignal){
  return new Promise<{status:number;headers:Record<string,string|string[]|undefined>;body:string}>((resolve,reject)=>{
    const req=request(url,{method,headers,signal,family:address.family,lookup:(_host,_options,callback)=>callback(null,address.address,address.family as 4|6)},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){response.destroy(new ResponseLimitError());return}chunks.push(chunk)});
      response.on("end",()=>resolve({status:response.statusCode??0,headers:response.headers,body:Buffer.concat(chunks).toString("utf8")}));
      response.on("error",reject);
    });
    req.on("error",reject);
    if(body)req.write(body);
    req.end();
  });
}

function abortable<T>(operation:Promise<T>,signal:AbortSignal){
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener("abort",abort,{once:true});
    operation.then(value=>{signal.removeEventListener("abort",abort);resolve(value)},error=>{signal.removeEventListener("abort",abort);reject(error)});
  });
}

function abortError(){return Object.assign(new Error("Bot action timed out"),{name:"AbortError"})}

export function mapBotActionResponse(value:unknown,mapping:Record<string,string>){
  const variables:Record<string,string>={};
  for(const [key,pointer] of Object.entries(mapping)){
    const selected=pointer.split("/").slice(1).map(part=>part.replace(/~1/gu,"/").replace(/~0/gu,"~")).reduce<unknown>((current,part)=>current&&typeof current==="object"?(current as Record<string,unknown>)[part]:undefined,value);
    if(typeof selected!=="string"&&typeof selected!=="number"&&typeof selected!=="boolean")throw new Error(`Bot action response ${key} is missing or not scalar`);
    const text=String(selected);
    if([...text].length>4096)throw new Error(`Bot action response ${key} is too large`);
    variables[key]=text;
    if(Buffer.byteLength(JSON.stringify(variables),"utf8")>65_536)throw new Error("Bot action mapped response is too large");
  }
  return variables;
}

export function notionPagePayload(input:Record<string,string>){
  const parentType=input.parent_type;
  if(parentType!=="page_id"&&parentType!=="data_source_id")throw new Error("Notion parent type is invalid");
  const parentId=input.parent_id;
  if(!parentId||!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/iu.test(parentId))throw new Error("Notion parent ID is invalid");
  const property=input.title_property??"Name";
  const title=input.title;
  if(!title||[...title].length>200||[...property].length<1||[...property].length>100)throw new Error("Notion page title is invalid");
  const content=input.content;
  if(content&&[...content].length>2_000)throw new Error("Notion page content is too large");
  return{
    parent:{type:parentType,[parentType]:parentId},
    properties:{[property]:{title:[{type:"text",text:{content:title}}]}},
    ...(content?{children:[{object:"block",type:"paragraph",paragraph:{rich_text:[{type:"text",text:{content}}]}}]}:{}),
  };
}

function retryAfter(value:string|string[]|undefined){const raw=Array.isArray(value)?value[0]:value;const seconds=Number(raw);return Number.isFinite(seconds)&&seconds>=1?Math.min(3_600_000,Math.ceil(seconds*1000)):30_000}

export function isPublicBotActionAddress(address:string){
  const family=isIP(address);
  if(family===4){
    const [a,b,c]=address.split(".").map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||(b===88&&c===99)))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
  }
  if(family!==6)return false;
  const normalized=address.toLowerCase();
  if(normalized.startsWith("::ffff:"))return isPublicBotActionAddress(normalized.slice(7));
  const [firstRaw="",secondRaw="0"]=normalized.split(":");
  const first=Number.parseInt(firstRaw,16);const second=Number.parseInt(secondRaw||"0",16);
  return first>=0x2000&&first<=0x3fff&&!(first===0x2001&&(second<=0x01ff||second===0x0db8))&&first!==0x2002&&!(first===0x3fff&&second<=0x0fff);
}

export class ResponseLimitError extends Error{constructor(){super("Bot action response exceeded its configured limit");this.name="ResponseLimitError"}}
