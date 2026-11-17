import { createHmac, randomUUID } from "node:crypto";
import { clientRoutingTargetBlockers, deriveClientRoutingFromSourceSnapshots, materializeClientRoutingSourceSnapshot, parseClientRouting, type ClientRoutingSource, type ClientRoutingTargetCatalog } from "../../../packages/core/src/client-routing.js";
import { ZammadClient } from "../../../packages/zammad/src/client.js";
import { safeHttpsRequest } from "./bot-action.js";
import type { RoutingSyncJob, RoutingSyncRepository } from "./routing-sync-repository.js";
import { SecretResolutionError, type SecretResolver } from "./secrets.js";
import type { ResolvedSecret } from "./types.js";

class RoutingSourceError extends Error{constructor(message:string,readonly retryable:boolean,readonly retryAfterMs=30_000,readonly code?:"AUTH_REVOKED"){super(message);this.name="RoutingSourceError"}}
class RoutingLeaseLostError extends Error{}
type RoutingRequest=typeof safeHttpsRequest;

export class RoutingSyncProcessor{
  constructor(private readonly repository:RoutingSyncRepository,private readonly secrets:SecretResolver,private readonly request:RoutingRequest=safeHttpsRequest,private readonly targets?:((baseUrl:string,secretReference:string)=>Promise<ClientRoutingTargetCatalog>),private readonly externalConnectorsEnabled=process.env.CLIENT_ROUTING_EXTERNAL_CONNECTORS_ENABLED==="true"){}
  async drainTenant(tenantId:string){if(!this.externalConnectorsEnabled)return{claimed:0,succeeded:0,failed:0};const leaseId=randomUUID();const jobs=await this.repository.claim(tenantId,leaseId,5);let succeeded=0;let failed=0;await Promise.all(jobs.map(async job=>{try{await this.run(job,leaseId);succeeded++}catch(error){failed++;if(error instanceof RoutingLeaseLostError)return;const failure=error instanceof RoutingSourceError?error:error instanceof SecretResolutionError?new RoutingSourceError("This connection is not available for this workspace.",error.retryable):new RoutingSourceError("The data connection could not finish syncing. Try again.",true);if(failure.code==="AUTH_REVOKED")await this.repository.revokeBinding(job,leaseId,failure.message);await this.repository.fail(job,leaseId,failure.retryable,failure.message,failure.retryable?new Date(Date.now()+failure.retryAfterMs).toISOString():undefined)}}));return{claimed:jobs.length,succeeded,failed}}
  private async run(job:RoutingSyncJob,leaseId:string){
    const prefix=`secret://tenants/${job.tenantId}/routing/`;if(!job.secretReference.startsWith(prefix))throw new RoutingSourceError("This connection is not available for this workspace.",false);
    if(!await this.repository.bindingActive(job))throw new RoutingSourceError("Reconnect this data source before syncing again.",false);
    if(job.syncMode==="QUALIFICATION"){
      const renew=async()=>{if(!await this.repository.renew(job,leaseId))throw new RoutingLeaseLostError("Routing qualification lease was lost")};
      await renew();const credential=await this.secrets.resolve(job.secretReference,{kind:"routing",tenantId:job.tenantId});await pull({id:job.sourceId,name:job.sourceId,kind:job.kind,syncMode:"SCHEDULED",secretReference:job.secretReference,endpointUrl:job.endpointUrl,scheduleMinutes:job.scheduleMinutes??60,fieldMapping:job.fieldMapping},credential,this.request,renew);
      await renew();if(!await this.repository.completeQualification(job,leaseId))throw new RoutingLeaseLostError("Routing qualification completion fence was lost");return;
    }
    const context=await this.repository.context(job.tenantId);const definition=parseClientRouting(context.definition);const source=definition.sources.find(item=>item.id===job.sourceId);
    if(!source||source.kind!==job.kind||source.secretReference!==job.secretReference||source.endpointUrl!==job.endpointUrl)throw new RoutingSourceError("The connection changed during sync. Try again.",true);
    const renew=async()=>{if(!await this.repository.renew(job,leaseId))throw new RoutingLeaseLostError("Routing sync lease was lost")};
    await renew();const credential=await this.secrets.resolve(job.secretReference,{kind:"routing",tenantId:job.tenantId});const rows=await pull(source,credential,this.request,renew);
    const snapshot=materializeClientRoutingSourceSnapshot(source,{sourceId:source.id,revision:job.snapshotRevision,rows:job.snapshot},{mode:"FULL",complete:true,expectedRevision:job.snapshotRevision,rows});
    const external=definition.sources.filter(item=>item.kind!=="MANUAL");const stateIds=new Set(context.states.map(state=>state.sourceId));if(external.some(item=>!stateIds.has(item.id))||context.states.some(state=>!external.some(item=>item.id===state.sourceId)))throw new RoutingSourceError("Connected data is still being prepared. Try again.",true);
    const snapshots=context.states.map(state=>state.sourceId===source.id?snapshot:state.snapshot);const candidate=deriveClientRoutingFromSourceSnapshots(definition,snapshots);
    if(snapshots.every(item=>item.revision>0)){
      const blockers=clientRoutingTargetBlockers(candidate,await this.loadTargets(job.tenantId,context.zammadBaseUrl,context.zammadSecretReference));
      if(blockers.length)throw new RoutingSourceError("Some routing destinations are unavailable. Review the routing setup before activating this update.",false);
    }
    await renew();
    await this.repository.complete(job,leaseId,context,snapshot,undefined,candidate);
  }
  private async loadTargets(tenantId:string,baseUrl:string,secretReference:string){if(this.targets)return this.targets(baseUrl,secretReference);const secret=await this.secrets.resolve(secretReference,{kind:"zammad",tenantId,purpose:"service"});if(!secret.token)throw new RoutingSourceError("Support routing destinations are temporarily unavailable.",true);return new ZammadClient({baseUrl,token:secret.token}).routingTargets()}
}

async function pull(source:ClientRoutingSource,secret:ResolvedSecret,request:RoutingRequest,renew:()=>Promise<void>){
  if(!source.endpointUrl)throw new RoutingSourceError("This connection needs an endpoint before it can sync.",false);
  const token=secret.accessToken??secret.token??secret.apiKey??secret.value;
  if(source.kind==="NOTION")return notionRows(new URL(source.endpointUrl),source.fieldMapping,requiredToken(token),request,renew);
  if(source.kind==="ZOHO")return zohoRows(new URL(source.endpointUrl),requiredToken(token),request,renew);
  await renew();return httpRows(new URL(source.endpointUrl),secret,token,request);
}

async function notionRows(url:URL,fieldMapping:Record<string,string>,token:string,request:RoutingRequest,renew:()=>Promise<void>){const rows:Record<string,unknown>[]=[];let cursor:string|undefined;
  const propertyNames=new Set(["client_id","client_name","zammad_group_id","owner_id","escalation_group_id","escalation_owner_id","matcher_kind","matcher_value","matcher_namespace","connection_id","deleted"].map(field=>fieldMapping[field]??field));
  for(let page=0;page<100;page++){
    await renew();
    const body=JSON.stringify({page_size:100,...(cursor?{start_cursor:cursor}:{})});const response=await json(url,"POST",{authorization:`Bearer ${token}`,"notion-version":"2026-03-11","content-type":"application/json"},body,request);
    const input=record(response);const results=array(input.results);for(const result of results)rows.push(flattenNotion(result,propertyNames));
    if(rows.length>10_000)throw new RoutingSourceError("This data source has too many records to sync safely.",false);
    if(recordOrUndefined(input.request_status)?.type==="incomplete")throw new RoutingSourceError("This data source could not provide a complete snapshot.",false);
    if(input.has_more!==true)return rows;cursor=typeof input.next_cursor==="string"&&input.next_cursor?input.next_cursor:undefined;if(!cursor)throw new RoutingSourceError("This data source returned an incomplete page.",false);
  }
  throw new RoutingSourceError("This data source could not provide a complete snapshot.",false);
}

async function zohoRows(endpoint:URL,token:string,request:RoutingRequest,renew:()=>Promise<void>){const rows:Record<string,unknown>[]=[];let page=1;let pageToken:string|undefined;
  for(let requestNumber=0;requestNumber<50;requestNumber++){
    await renew();
    const url=new URL(endpoint);url.searchParams.set("per_page","200");if(pageToken)url.searchParams.set("page_token",pageToken);else url.searchParams.set("page",String(page));
    const input=record(await json(url,"GET",{authorization:`Zoho-oauthtoken ${token}`},undefined,request));for(const item of array(input.data))rows.push(record(item));
    if(rows.length>10_000)throw new RoutingSourceError("This data source has too many records to sync safely.",false);
    const info=record(input.info);if(info.more_records!==true)return rows;
    pageToken=typeof info.next_page_token==="string"&&info.next_page_token?info.next_page_token:undefined;if(!pageToken){page+=1;if(page>10)throw new RoutingSourceError("This data source could not provide the next page. Try again.",true)}
  }
  throw new RoutingSourceError("This data source has too many records to sync safely.",false);
}

async function httpRows(url:URL,secret:ResolvedSecret,token:string|undefined,request:RoutingRequest){const timestamp=String(Math.floor(Date.now()/1000));const headers:Record<string,string>={accept:"application/json"};
  if(token)headers.authorization=`Bearer ${token}`;
  else if(secret.hmacKey){headers["x-wasalx-timestamp"]=timestamp;headers["x-wasalx-signature"]=`sha256=${createHmac("sha256",secret.hmacKey).update(`${timestamp}\nGET\n${url.pathname}${url.search}`).digest("hex")}`}
  else throw new RoutingSourceError("Reconnect this data source before syncing again.",false);
  const input=record(await json(url,"GET",headers,undefined,request));if(input.complete!==true)throw new RoutingSourceError("This data source could not provide a complete snapshot.",false);return array(input.rows).map(item=>record(item));
}

async function json(url:URL,method:"GET"|"POST",headers:Record<string,string>,body:string|undefined,request:RoutingRequest){
  let response;try{response=await request(url,method,{...headers,accept:"application/json","user-agent":"WasalX routing sync/1"},body,15_000,5_000_000)}catch{throw new RoutingSourceError("The data source could not be reached. Try again.",true)}
  if(response.status===429)throw new RoutingSourceError("The data source is temporarily rate limited. Try again.",true,retryAfter(response.headers["retry-after"]));
  if(response.status>=500)throw new RoutingSourceError("The data source is temporarily unavailable. Try again.",true);
  if(response.status===401||response.status===403)throw new RoutingSourceError("Reconnect this data source before syncing again.",false,30_000,"AUTH_REVOKED");
  if(response.status<200||response.status>=300)throw new RoutingSourceError("The data source rejected the sync request. Review the connection.",false);
  const contentType=Array.isArray(response.headers["content-type"])?response.headers["content-type"]?.[0]:response.headers["content-type"];
  if(!contentType?.toLowerCase().startsWith("application/json"))throw new RoutingSourceError("The data source returned an unsupported response.",false);
  try{return JSON.parse(response.body) as unknown}catch{throw new RoutingSourceError("The data source returned an unreadable response.",false)}
}

function flattenNotion(value:unknown,names:Set<string>){const page=record(value);const properties=record(page.properties);return Object.fromEntries([...names].flatMap(name=>{if(!Object.hasOwn(properties,name))return[];const scalar=notionScalar(properties[name]);return scalar===null||scalar===undefined||scalar===""?[]:[[name,scalar]]}))}
function notionScalar(value:unknown):unknown{const property=record(value);const type=String(property.type??"");const selected=property[type];
  if(type==="title"||type==="rich_text")return array(selected).map(item=>String(record(item).plain_text??"")).join("");
  if(type==="select"||type==="status")return selected==null?null:record(selected).name;
  if(type==="formula")return notionScalar(record(selected));
  if(type==="number")return selected==null?null:String(selected);
  if(type==="date")return selected==null?null:record(selected).start;
  if(["email","url","phone_number","checkbox","string","boolean"].includes(type))return selected;
  throw new RoutingSourceError("A mapped field uses an unsupported value type.",false);
}
function requiredToken(value:string|undefined){if(!value||value.length>8192)throw new RoutingSourceError("Reconnect this data source before syncing again.",false);return value}
function retryAfter(value:string|string[]|undefined){const raw=Array.isArray(value)?value[0]:value;const seconds=Number(raw);return Number.isFinite(seconds)&&seconds>=1?Math.min(3_600_000,Math.ceil(seconds*1000)):30_000}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw new RoutingSourceError("The data source returned an unexpected response.",false);return value as Record<string,unknown>}
function recordOrUndefined(value:unknown){return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined}
function array(value:unknown):unknown[]{if(!Array.isArray(value))throw new RoutingSourceError("The data source returned an unexpected response.",false);return value}
