import { ConflictException, Injectable, OnApplicationBootstrap, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import { recordStructuredLog } from "@wasalx/observability";
import { createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "./database.service.js";
import { ZammadServiceSecretService } from "./zammad-service-secret.service.js";
import { NativeMembershipObserver,type CapturedMembershipIdentity,type MembershipObservationSnapshot } from "./native-membership-observer.js";

export type NativeMembership = {tenant_id:string;user_id:string;oidc_subject:string;email:string;display_name:string;role:string;member_state:string;revision:string|number;native_user_id:string|null;requested_native_user_id:string|null;applied_revision:string|number;sync_state:string;zammad_instance_id:string|null};
type Instance={id:string;base_url:string;service_secret_reference:string};
type NativeResult={state:string;native_user_id?:string;revision?:number;candidates?:Array<{id:string;name:string;email:string;active:boolean}>};
const TERMINAL=new Set(["ADOPTION_REQUIRED","CONFLICT","PROTECTED"]);

@Injectable()
export class NativeMembershipService implements OnApplicationBootstrap,OnModuleDestroy {
  private timer?:ReturnType<typeof setInterval>;
  private running=false;
  private readonly observer=new NativeMembershipObserver((tenantId,userIds)=>this.database.rows<MembershipObservationSnapshot>(tenantId,`SELECT p.*,
      z.id AS current_instance_id,z.base_url,z.service_secret_reference,u.display_name AS source_display_name,
      (t.state='ACTIVE' AND z.state='WORKING' AND p.zammad_instance_id=z.id AND u.oidc_subject=p.oidc_subject AND u.email=p.email
        AND m.role=p.role AND m.state=p.member_state) AS source_identity_current
    FROM native_membership_projections p JOIN tenants t ON t.id=p.tenant_id
    LEFT JOIN zammad_instances z ON z.tenant_id=p.tenant_id
    LEFT JOIN users u ON u.id=p.user_id
    LEFT JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id
    WHERE p.tenant_id=$1 AND ($2::uuid[] IS NULL OR p.user_id=ANY($2::uuid[])) ORDER BY p.user_id`,[tenantId,userIds??null]),
    (row,signal)=>this.request(row,"DISCOVER",undefined,{instance:{id:row.current_instance_id!,base_url:row.base_url,service_secret_reference:row.service_secret_reference},signal}));
  constructor(private readonly database:DatabaseService,private readonly secrets:ZammadServiceSecretService){}
  observe(tenantId:string,userIds?:string[],captured?:ReadonlyMap<string,CapturedMembershipIdentity>){return this.observer.observe(tenantId,userIds,captured);}
  onApplicationBootstrap(){this.timer=setInterval(()=>{void this.drain()},15_000);this.timer.unref();}
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
  wake(tenantId: string) {
    void this.syncTenant(tenantId).catch(() => {
      recordStructuredLog("error", "native_projection.failed", { projection: "membership", phase: "wake" });
    });
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      const tenants = await this.database.pendingNativeMembershipTenants().catch(() => {
        recordStructuredLog("error", "native_projection.failed", { projection: "membership", phase: "discovery" });
        return [];
      });
      for (const tenantId of tenants) {
        await this.syncTenant(tenantId).catch(() => {
          recordStructuredLog("error", "native_projection.failed", { projection: "membership", phase: "tenant" });
        });
      }
    } finally {
      this.running = false;
    }
  }
  async syncTenant(tenantId:string){
    for(let index=0;index<20;index++){
      const intent=await this.database.withTenant(tenantId,async client=>{
        const row=(await client.query<NativeMembership>("SELECT * FROM native_membership_projections WHERE tenant_id=$1 AND sync_state='PENDING' ORDER BY updated_at,user_id FOR UPDATE SKIP LOCKED LIMIT 1",[tenantId])).rows[0];
        if(!row)return null;
        // Commit the unknown-outcome fence BEFORE sending any remote mutation.
        // A crash or result-commit failure must not leave an automatically replayable intent.
        await client.query("UPDATE native_membership_projections SET sync_state='UNAVAILABLE',updated_at=now() WHERE tenant_id=$1 AND user_id=$2",[tenantId,row.user_id]);
        const instance=await this.instance(row,client);
        if(!instance)return null;
        await client.query("UPDATE native_membership_projections SET zammad_instance_id=$3 WHERE tenant_id=$1 AND user_id=$2 AND zammad_instance_id IS NULL",[tenantId,row.user_id,instance.id]);
        return row;
      });
      if(!intent)break;
      await this.database.withTenant(tenantId,async client=>{
        const row=(await client.query<NativeMembership>("SELECT * FROM native_membership_projections WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",[tenantId,intent.user_id])).rows[0];
        // A newer lifecycle event is a separate intent, never an old-effect replay.
        if(!row||row.sync_state!=="UNAVAILABLE"||Number(row.revision)!==Number(intent.revision))return;
        await this.apply(client,row);
      });
    }
  }
  async candidates(tenantId:string,userId:string){
    const row=(await this.database.rows<NativeMembership>(tenantId,"SELECT * FROM native_membership_projections WHERE tenant_id=$1 AND user_id=$2",[tenantId,userId]))[0];
    if(!row)throw new ConflictException("Enable workspace access synchronization first");
    return(await this.request(row,"DISCOVER")).candidates??[];
  }
  private async apply(client:PoolClient,row:NativeMembership){
    let result:NativeResult;
    try{result=await this.request(row,"APPLY",client);}
    catch{
      await client.query("UPDATE native_membership_projections SET sync_state='UNAVAILABLE',updated_at=now() WHERE tenant_id=$1 AND user_id=$2",[row.tenant_id,row.user_id]);
      return;
    }
    if(result.state==="READY"&&Number(result.revision)===Number(row.revision)&&((typeof result.native_user_id==="string"&&/^[1-9][0-9]{0,15}$/u.test(result.native_user_id))||(result.native_user_id==null&&(row.member_state!=="ACTIVE"||row.role==="auditor")&&!row.native_user_id))){
      if(row.native_user_id&&row.native_user_id!==result.native_user_id){
        await client.query("UPDATE native_membership_projections SET sync_state=$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2",[row.tenant_id,row.user_id,"CONFLICT"]);
        return;
      }
      await client.query(`UPDATE native_membership_projections SET native_user_id=$3,applied_revision=revision,sync_state='READY',updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2`,[row.tenant_id,row.user_id,result.native_user_id]);
    }else{
      await client.query("UPDATE native_membership_projections SET sync_state=$3,updated_at=now() WHERE tenant_id=$1 AND user_id=$2",[row.tenant_id,row.user_id,TERMINAL.has(result.state)?result.state:"CONFLICT"]);
    }
  }
  private async request(row:NativeMembership,action:"APPLY"|"DISCOVER",client?:PoolClient,observation?:{instance:Instance;signal:AbortSignal}):Promise<NativeResult>{
    const instance=observation?.instance??await this.instance(row,client);
    if(!instance)throw new ServiceUnavailableException("The workspace identity service is unavailable");
    const credentials=await this.secrets.resolveCredentials(instance.service_secret_reference,{tenantId:row.tenant_id,instanceId:instance.id});
    observation?.signal.throwIfAborted();
    const target=new URL("/api/v1/wasalx/membership",instance.base_url);
    if(target.username||target.password||target.hash||(target.protocol!=="https:"&&process.env.NODE_ENV==="production"))throw new ServiceUnavailableException("The workspace identity service is unavailable");
    const body=JSON.stringify({action,tenant_id:row.tenant_id,instance_id:instance.id,user_id:row.user_id,subject:row.oidc_subject,email:row.email,name:row.display_name,role:row.role,state:row.member_state,revision:Number(row.revision),native_user_id:row.native_user_id,adopt_user_id:row.requested_native_user_id});
    const timestamp=String(Math.floor(Date.now()/1000));
    const signature=createHmac("sha256",credentials.jwtSecret).update(`${timestamp}\n${body}`).digest("hex");
    const response=await fetch(target,{method:"POST",headers:{authorization:`Token token=${credentials.apiToken}`,"content-type":"application/json","x-wasalx-timestamp":timestamp,"x-wasalx-signature":signature},body,redirect:"error",signal:observation?.signal??AbortSignal.timeout(8_000)});
    if(!response.ok)throw new ServiceUnavailableException("The workspace identity service is unavailable");
    const reader=response.body?.getReader();if(!reader)throw new Error("Empty native response");
    let text="";let length=0;const decoder=new TextDecoder();
    try{while(true){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;if(length>32_768)throw new Error("Native response limit");text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}
    finally{await reader.cancel();}
    const result=JSON.parse(text) as NativeResult;
    if(!result||typeof result!=="object"||typeof result.state!=="string")throw new Error("Invalid native response");
    if(result.candidates!==undefined&&(!Array.isArray(result.candidates)||result.candidates.length>21||result.candidates.some(candidate=>!candidate||typeof candidate.id!=="string"||!/^[1-9][0-9]{0,15}$/u.test(candidate.id)||typeof candidate.name!=="string"||candidate.name.length>400||typeof candidate.email!=="string"||candidate.email.length>320||typeof candidate.active!=="boolean")))throw new Error("Invalid account candidates");
    return result;
  }
  private async instance(row:NativeMembership,client?:PoolClient):Promise<Instance|undefined>{
    if(!client)return this.database.withTenant(row.tenant_id,transaction=>this.instance(row,transaction));
    const tenant=(await client.query<{active:boolean}>("SELECT app.lock_current_active_tenant_for_event_admission() AS active")).rows[0];
    if(tenant?.active!==true)return undefined;
    const sql="SELECT z.id,z.base_url,z.service_secret_reference FROM zammad_instances z WHERE z.tenant_id=$1 AND z.state='WORKING'";
    const instance=(await client.query<Instance>(sql,[row.tenant_id])).rows[0];
    return instance&&(!row.zammad_instance_id||row.zammad_instance_id===instance.id)?instance:undefined;
  }
}
