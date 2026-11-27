import { ConflictException, Injectable, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { recordStructuredLog } from "@wasalx/observability";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { nativeRoutingRevision, parseDepartmentDefaults, serializeNativeRoutingManifest, type NativeRoutingRequest, type NativeRoutingResponse, type NativeRoutingSyncStatus } from "@wasalx/core/native-routing-contract";
import { DatabaseService } from "./database.service.js";
import { ZammadServiceSecretService } from "./zammad-service-secret.service.js";
import { buildNativeRoutingManifest } from "./native-routing-manifest.js";

export type NativeRoutingProjection={tenant_id:string;zammad_instance_id:string;desired_revision:string|number;applied_revision:string|number;
  desired_manifest:NativeRoutingRequest["manifest"]|null;desired_sha256:string|null;observed_sha256:string|null;department_defaults:unknown;
  sync_state:Exclude<NativeRoutingSyncStatus["state"],"UNCONFIGURED">;next_action:"CHECK"|"APPLY"|null;attempted_request:NativeRoutingRequest|null;
  error_code:string|null;safe_retry:boolean;claim_id:string|null;claim_expires_at:Date|string|null;last_checked_at:Date|string|null};
type Instance={id:string;base_url:string;service_secret_reference:string;state:string};
type Intent={row:NativeRoutingProjection;instance:Instance;request:NativeRoutingRequest;claimId:string};
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
export const nativeRoutingUnavailable=():NativeRoutingSyncStatus=>({state:"UNCONFIGURED",desiredRevision:0,appliedRevision:0,desiredSha256:null,observedSha256:null,lastCheckedAt:null,errorCode:null,safeRetry:false,departmentDefaults:[]});
export function nativeRoutingStatus(row:NativeRoutingProjection,now=Date.now()):NativeRoutingSyncStatus{
  const checkedTime=new Date(row.last_checked_at??NaN).getTime();
  const lastCheckedAt=Number.isFinite(checkedTime)?new Date(checkedTime).toISOString():null;
  const checkingFailedStatus=row.sync_state==="FAILED"&&row.next_action==="CHECK";
  // A due background check is not proof that it ran before the receipt expired.
  const expiredReadback=row.sync_state==="SYNCED"&&(!lastCheckedAt||now-checkedTime>6*60_000||checkedTime-now>30_000);
  const state=checkingFailedStatus||expiredReadback?"PENDING":row.sync_state;
  return{state,desiredRevision:nativeRoutingRevision(Number(row.desired_revision),1),appliedRevision:nativeRoutingRevision(Number(row.applied_revision)),
    desiredSha256:row.desired_sha256,observedSha256:row.observed_sha256,lastCheckedAt,
    errorCode:checkingFailedStatus?null:row.error_code,safeRetry:state===row.sync_state&&row.safe_retry&&["PENDING","FAILED"].includes(row.sync_state),departmentDefaults:parseDepartmentDefaults(row.department_defaults)};
}
export function validateNativeRoutingResponse(value:unknown,request:NativeRoutingRequest):NativeRoutingResponse{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("NATIVE_ROUTING_INVALID_RECEIPT");
  const result=value as NativeRoutingResponse;
  if(result.schema_version!==1||result.tenant_id!==request.tenant_id||result.instance_id!==request.instance_id||result.revision!==request.revision||result.desired_sha256!==request.desired_sha256
    ||!Number.isSafeInteger(result.applied_revision)||result.applied_revision<0||result.applied_revision>Number.MAX_SAFE_INTEGER
    ||(result.observed_sha256!==null&&(typeof result.observed_sha256!=="string"||!/^[a-f0-9]{64}$/u.test(result.observed_sha256)))
    ||!["SYNCED","DRIFT","CONFLICT"].includes(result.state)||!Array.isArray(result.items)||result.items.length>25_000)throw new Error("NATIVE_ROUTING_INVALID_RECEIPT");
  const keys=new Set<string>();
  for(const item of result.items){
    if(!item||typeof item.key!=="string"||item.key.length>200||!/^[A-Za-z0-9:_-]+$/u.test(item.key)||keys.has(item.key)
      ||!["CONFIGURATION","GROUP_REFERENCE","GROUP_BINDING","BOT_HANDOFF","DEPARTMENT_DEFAULT","CLIENT_ROUTING"].includes(item.kind)||!["SYNCED","DRIFT","UNAPPLIED"].includes(item.state)
      ||(item.native_id!==null&&(typeof item.native_id!=="string"||!/^[1-9][0-9]{0,15}$/u.test(item.native_id)))
      ||(item.error_code!==undefined&&(typeof item.error_code!=="string"||!/^[A-Z][A-Z0-9_]{0,100}$/u.test(item.error_code))))throw new Error("NATIVE_ROUTING_INVALID_RECEIPT");
    keys.add(item.key);
  }
  if(result.state==="SYNCED"&&(result.applied_revision!==request.revision||result.observed_sha256!==request.desired_sha256||result.items.some(item=>item.state!=="SYNCED"||item.error_code)))throw new Error("NATIVE_ROUTING_INVALID_RECEIPT");
  return result;
}

@Injectable()
export class NativeRoutingSyncService implements OnApplicationBootstrap,OnModuleDestroy{
  private timer?:ReturnType<typeof setInterval>;private running=false;
  constructor(private readonly database:DatabaseService,private readonly secrets:ZammadServiceSecretService){}
  onApplicationBootstrap(){this.timer=setInterval(()=>{void this.drain();},15_000);this.timer.unref();}
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
  wake(tenantId: string) {
    void this.syncTenant(tenantId).catch(() => {
      recordStructuredLog("error", "native_projection.failed", { projection: "routing", phase: "wake" });
    });
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      const tenants = await this.database.pendingNativeRoutingTenants().catch(() => {
        recordStructuredLog("error", "native_projection.failed", { projection: "routing", phase: "discovery" });
        return [];
      });
      for (const tenantId of tenants) {
        await this.syncTenant(tenantId).catch(() => {
          recordStructuredLog("error", "native_projection.failed", { projection: "routing", phase: "tenant" });
        });
      }
    } finally {
      this.running = false;
    }
  }
  async status(tenantId:string){return this.database.withTenant(tenantId,async client=>{const row=await this.row(client,tenantId);return row?nativeRoutingStatus(row):nativeRoutingUnavailable();});}
  async syncTenant(tenantId:string){
    const intent=await this.prepare(tenantId);if(!intent)return;
    let credentials:{apiToken:string;jwtSecret:string};let target:URL;
    try{
      credentials=await this.secrets.resolveCredentials(intent.instance.service_secret_reference,{tenantId,instanceId:intent.instance.id});
      target=new URL("/api/v1/wasalx/routing/configuration",intent.instance.base_url);
      if(target.username||target.password||target.hash||!["http:","https:"].includes(target.protocol)||(process.env.NODE_ENV==="production"&&target.protocol!=="https:"))throw new Error("Invalid native URL");
    }catch{await this.failure(intent,false);return;}
    if(!await this.fence(intent))return;
    try{
      const body=JSON.stringify(intent.request),timestamp=String(Math.floor(Date.now()/1000));
      const signature=createHmac("sha256",credentials.jwtSecret).update(`${timestamp}\n${body}`).digest("hex");
      const response=await fetch(target,{method:"POST",headers:{authorization:`Token token=${credentials.apiToken}`,"content-type":"application/json","x-wasalx-timestamp":timestamp,"x-wasalx-signature":signature},body,redirect:"error",signal:AbortSignal.timeout(8_000)});
      if(!response.ok)throw new Error("Native result unavailable");
      const reader=response.body?.getReader();if(!reader)throw new Error("Empty native response");
      let length=0,text="";const decoder=new TextDecoder();
      try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>5_242_880)throw new Error("Native response limit");text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel();}
      await this.settle(intent,validateNativeRoutingResponse(JSON.parse(text),intent.request));
    }catch{await this.failure(intent,true);}
  }
  private async row(client:PoolClient,tenantId:string,lock=false){return(await client.query<NativeRoutingProjection>(`SELECT * FROM native_routing_projections WHERE tenant_id=$1${lock?" FOR UPDATE":""}`,[tenantId])).rows[0];}
  private async instance(client:PoolClient,tenantId:string){
    if((await client.query<{active:boolean}>("SELECT app.lock_current_active_tenant_for_event_admission() AS active")).rows[0]?.active!==true)return undefined;
    return(await client.query<Instance>("SELECT id,base_url,service_secret_reference,state FROM zammad_instances WHERE tenant_id=$1",[tenantId])).rows[0];
  }
  private async prepare(tenantId:string):Promise<Intent|null>{return this.database.withTenant(tenantId,async client=>{
    const row=await this.row(client,tenantId,true);if(!row||row.claim_expires_at&&new Date(row.claim_expires_at).getTime()>Date.now())return null;
    const driftCheckDue=row.sync_state==="SYNCED"&&row.last_checked_at&&new Date(row.last_checked_at).getTime()<Date.now()-300_000;
    if(!row.next_action&&row.sync_state!=="APPLYING"&&!driftCheckDue)return null;
    const instance=await this.instance(client,tenantId);
    if(!instance||instance.state!=="WORKING"||instance.id!==row.zammad_instance_id){
      await client.query("UPDATE native_routing_projections SET sync_state=$2,next_action=NULL,safe_retry=false,error_code=$3,claim_id=NULL,claim_expires_at=NULL WHERE tenant_id=$1",[tenantId,row.attempted_request?"OUTCOME_UNKNOWN":"FAILED","NATIVE_ROUTING_CONFIGURATION_UNAVAILABLE"]);return null;
    }
    const uncertain=row.attempted_request&&(row.sync_state==="OUTCOME_UNKNOWN"||row.sync_state==="APPLYING");
    try{
      if(!uncertain&&(!row.desired_manifest||!row.desired_sha256)){row.desired_manifest=await buildNativeRoutingManifest(client,tenantId,parseDepartmentDefaults(row.department_defaults));row.desired_sha256=hash(serializeNativeRoutingManifest(row.desired_manifest));
        await client.query("UPDATE native_routing_projections SET desired_manifest=$2,desired_sha256=$3 WHERE tenant_id=$1",[tenantId,row.desired_manifest,row.desired_sha256]);}
    }catch{await client.query("UPDATE native_routing_projections SET sync_state=$2,next_action=NULL,error_code='NATIVE_ROUTING_VALIDATION_ERROR',safe_retry=false WHERE tenant_id=$1",[tenantId,row.attempted_request?"OUTCOME_UNKNOWN":"FAILED"]);return null;}
    const initialCheck=Number(row.applied_revision)===0&&!Number.isFinite(new Date(row.last_checked_at??NaN).getTime());
    const request:NativeRoutingRequest=uncertain?{...row.attempted_request!,action:"CHECK"}:{schema_version:1,action:initialCheck?"CHECK":row.next_action??"CHECK",tenant_id:tenantId,instance_id:instance.id,
      revision:nativeRoutingRevision(Number(row.desired_revision),1),desired_sha256:row.desired_sha256!,expected_native_revision:nativeRoutingRevision(Number(row.applied_revision)),manifest:row.desired_manifest!};
    if(Buffer.byteLength(JSON.stringify(request))>5_242_880){await client.query("UPDATE native_routing_projections SET sync_state='FAILED',next_action=NULL,error_code='NATIVE_ROUTING_VALIDATION_ERROR',safe_retry=false WHERE tenant_id=$1",[tenantId]);return null;}
    const claimId=randomUUID();
    await client.query("UPDATE native_routing_projections SET claim_id=$2,claim_expires_at=now()+interval '30 seconds' WHERE tenant_id=$1",[tenantId,claimId]);
    return{row,instance,request,claimId};
  });}
  private async fence(intent:Intent){return this.database.withTenant(intent.row.tenant_id,async client=>{
    const row=await this.row(client,intent.row.tenant_id,true),instance=await this.instance(client,intent.row.tenant_id);
    if(!row||row.claim_id!==intent.claimId)return false;
    if(!instance||instance.id!==intent.request.instance_id||instance.state!=="WORKING"){
      await client.query("UPDATE native_routing_projections SET claim_id=NULL,claim_expires_at=NULL,next_action=NULL,sync_state=$2,safe_retry=false,error_code='NATIVE_ROUTING_CONFIGURATION_UNAVAILABLE' WHERE tenant_id=$1",[row.tenant_id,row.attempted_request?"OUTCOME_UNKNOWN":"FAILED"]);return false;
    }
    if(intent.request.action==="APPLY"&&(Number(row.desired_revision)!==intent.request.revision||row.desired_sha256!==intent.request.desired_sha256||row.sync_state!=="PENDING")){
      await client.query("UPDATE native_routing_projections SET claim_id=NULL,claim_expires_at=NULL WHERE tenant_id=$1",[row.tenant_id]);return false;
    }
    if(intent.request.action==="APPLY")await client.query("UPDATE native_routing_projections SET attempted_request=$2,sync_state='APPLYING',safe_retry=false,next_action='CHECK' WHERE tenant_id=$1",[row.tenant_id,intent.request]);
    return true;
  });}
  private async failure(intent:Intent,dispatched:boolean){await this.database.withTenant(intent.row.tenant_id,async client=>{
    const row=await this.row(client,intent.row.tenant_id,true);if(!row||row.claim_id!==intent.claimId)return;
    const unknown=!!row.attempted_request||dispatched&&intent.request.action==="APPLY";
    await client.query(`UPDATE native_routing_projections SET sync_state=$2,safe_retry=$3,next_action=$4,error_code=$5,claim_id=NULL,claim_expires_at=NULL,updated_at=now() WHERE tenant_id=$1`,
      [row.tenant_id,unknown?"OUTCOME_UNKNOWN":row.sync_state==="DRIFT"?"DRIFT":"FAILED",!unknown&&intent.request.action==="APPLY"&&["PENDING","FAILED"].includes(row.sync_state),unknown&&intent.request.action==="APPLY"?"CHECK":null,unknown?"NATIVE_ROUTING_OUTCOME_UNKNOWN":"NATIVE_ROUTING_CONFIGURATION_UNAVAILABLE"]);
  });}
  private async settle(intent:Intent,result:NativeRoutingResponse){await this.database.withTenant(intent.row.tenant_id,async client=>{
    const row=await this.row(client,intent.row.tenant_id,true);if(!row||row.claim_id!==intent.claimId)return;
    const known=Math.max(Number(row.applied_revision),result.applied_revision);
    let state:NativeRoutingProjection["sync_state"]="DRIFT",next:"APPLY"|null=null,error:string|null="NATIVE_ROUTING_DRIFT",safe=false;
    if(result.state==="SYNCED"&&result.applied_revision>=Number(row.applied_revision)){
      if(Number(row.desired_revision)===result.revision&&row.desired_sha256===result.observed_sha256){state="SYNCED";error=null;}
      else{state="PENDING";next="APPLY";error=null;safe=true;}
    }else if(result.state==="CONFLICT"&&intent.request.action==="CHECK"&&result.applied_revision>=Number(row.applied_revision)&&result.applied_revision<intent.request.revision
      &&result.items.length>0&&result.items.every(item=>item.state!=="DRIFT"&&(!item.error_code||["NOT_APPLIED","REVISION_AHEAD"].includes(item.error_code)))){
      state="PENDING";next="APPLY";error=null;safe=true;
    }
    await client.query(`UPDATE native_routing_projections SET applied_revision=$2,observed_sha256=$3,sync_state=$4,next_action=$5,error_code=$6,
      safe_retry=$7,attempted_request=NULL,last_checked_at=now(),claim_id=NULL,claim_expires_at=NULL,updated_at=now() WHERE tenant_id=$1`,[row.tenant_id,known,result.observed_sha256,state,next,error,safe]);
  });}
  async command(client:PoolClient,tenantId:string,command:import("@wasalx/core/native-routing-contract").NativeRoutingSyncCommand){
    let row=await this.row(client,tenantId,true);const created=!row;
    if(!row){if(command.expectedRevision!==0)throw conflict();await client.query("SELECT app.queue_native_routing($1)",[tenantId]);row=await this.row(client,tenantId,true);}
    if(!row)throw new ConflictException({code:"NATIVE_ROUTING_CONFIGURATION_UNAVAILABLE",message:"Connect a native workspace first"});
    if(Number(row.desired_revision)!==command.expectedRevision&&!(created&&command.expectedRevision===0))throw conflict();
    if(command.action==="SAVE_DEFAULTS"){
      await client.query("UPDATE native_routing_projections SET department_defaults=$2 WHERE tenant_id=$1",[tenantId,JSON.stringify(command.departmentDefaults)]);
      await client.query("SELECT app.queue_native_routing($1)",[tenantId]);
      if(row.sync_state==="DRIFT")await client.query("UPDATE native_routing_projections SET next_action='CHECK' WHERE tenant_id=$1",[tenantId]);
    }else if(command.action==="RECONCILE"){
      if(!row.safe_retry||!["PENDING","FAILED"].includes(row.sync_state)||row.attempted_request||row.claim_expires_at&&new Date(row.claim_expires_at).getTime()>Date.now())throw new ConflictException({code:"NATIVE_ROUTING_RETRY_NOT_SAFE",message:"Check the native outcome before retrying"});
      await client.query("UPDATE native_routing_projections SET sync_state='PENDING',next_action='APPLY',error_code=NULL WHERE tenant_id=$1",[tenantId]);
    }else{
      if(row.claim_expires_at&&new Date(row.claim_expires_at).getTime()>Date.now())throw conflict();
      await client.query("UPDATE native_routing_projections SET next_action='CHECK' WHERE tenant_id=$1",[tenantId]);
    }
    return nativeRoutingStatus((await this.row(client,tenantId))!);
  }
}
const conflict=()=>new ConflictException({code:"NATIVE_ROUTING_REVISION_CONFLICT",message:"Routing configuration changed; refresh before continuing"});
