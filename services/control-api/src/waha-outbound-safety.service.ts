import { ConflictException, Injectable, NotFoundException, OnModuleDestroy } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { appendAudit } from "./audit.js";
import { DatabaseService } from "./database.service.js";
import { withOperationReceipt } from "./idempotent-operation.js";
import { TenantDrainService } from "./tenant-drain.service.js";
import type { Principal } from "./types.js";

export type TenantOutboundControlChange={expectedVersion:number;enabled:boolean;reason:string};
export type ConnectionOutboundPolicyChange=TenantOutboundControlChange&{
  inboundResponseOnly:boolean;responseWindowSeconds:number;
  allowHumanGroupWorkspaceInitiation:boolean;
  connectionCapacity:number;connectionRefillTokens:number;connectionRefillSeconds:number;
  numberCapacity:number;numberRefillTokens:number;numberRefillSeconds:number;
  minimumSpacingSeconds:number;
};

@Injectable()
export class WahaOutboundSafetyService implements OnModuleDestroy{
  private readonly operatorPool?:Pool;
  constructor(private readonly database:DatabaseService,private readonly drain:TenantDrainService){
    const connectionString=process.env.WAHA_OPERATOR_DATABASE_URL;
    if(connectionString)this.operatorPool=new Pool({connectionString,max:Math.min(Number(process.env.DATABASE_POOL_SIZE??20),3),statement_timeout:10_000,application_name:"wasalx-waha-outbound-safety-api"});
  }
  async tenantSettings(tenantId:string){return this.database.withTenant(tenantId,async client=>{
    const control=(await client.query("SELECT enabled,version,reason,updated_at FROM waha_outbound_tenant_controls WHERE tenant_id=$1",[tenantId])).rows[0];
    const policies=(await client.query(`SELECT p.connection_id,c.name,c.phone_e164,p.enabled,p.inbound_response_only,p.allow_human_group_workspace_initiation,
      p.response_window_seconds,p.connection_capacity,p.connection_refill_tokens,p.connection_refill_seconds,
      p.number_capacity,p.number_refill_tokens,p.number_refill_seconds,p.minimum_spacing_seconds,
      p.version,p.reason,p.updated_at
      FROM waha_outbound_connection_policies p JOIN connections c
        ON c.tenant_id=p.tenant_id AND c.id=p.connection_id
      WHERE p.tenant_id=$1 ORDER BY c.name,p.connection_id`,[tenantId])).rows;
    return{control,policies};
  })}
  async changeTenantControl(principal:Principal,input:TenantOutboundControlChange,idempotencyKey:string,requestId:string){const result=await this.database.withTenant(principal.tenantId,async client=>withOperationReceipt(client,principal,"WAHA_OUTBOUND_TENANT_CONTROL",idempotencyKey,operationHash(input),requestId,async()=>{
    const previous=(await client.query<{enabled:boolean;version:string|number;reason:string}>("SELECT enabled,version,reason FROM waha_outbound_tenant_controls WHERE tenant_id=$1 FOR UPDATE",[principal.tenantId])).rows[0];
    if(!previous)throw new NotFoundException("WAHA outbound tenant control was not found");
    if(Number(previous.version)!==input.expectedVersion)throw new ConflictException("WAHA outbound tenant control changed. Refresh and try again.");
    const next=(await client.query("UPDATE waha_outbound_tenant_controls SET enabled=$2,version=version+1,reason=$3,updated_by=$4,updated_at=now() WHERE tenant_id=$1 RETURNING enabled,version,reason,updated_at",[principal.tenantId,input.enabled,input.reason,principal.userId])).rows[0];
    await appendAudit(client,principal,{action:"waha.outbound.tenant_control_changed",targetType:"waha_outbound_control",targetId:principal.tenantId,requestId,previousValue:previous,newValue:next});
    return next;
  },"Idempotency key was already used for a different WAHA outbound tenant control"));if(input.enabled)await this.drain.wake(principal.tenantId);return result}
  async changeConnectionPolicy(principal:Principal,connectionId:string,input:ConnectionOutboundPolicyChange,idempotencyKey:string,requestId:string){const result=await this.database.withTenant(principal.tenantId,async client=>withOperationReceipt(client,principal,"WAHA_OUTBOUND_CONNECTION_POLICY",idempotencyKey,operationHash({connectionId,...input}),requestId,async()=>{
    const previous=(await client.query("SELECT * FROM waha_outbound_connection_policies WHERE tenant_id=$1 AND connection_id=$2 FOR UPDATE",[principal.tenantId,connectionId])).rows[0];
    if(!previous)throw new NotFoundException("WAHA outbound connection policy was not found");
    if(Number(previous.version)!==input.expectedVersion)throw new ConflictException("WAHA outbound connection policy changed. Refresh and try again.");
    const next=(await client.query(`UPDATE waha_outbound_connection_policies SET
      enabled=$3,inbound_response_only=$4,allow_human_group_workspace_initiation=$5,response_window_seconds=$6,
      connection_capacity=$7,connection_refill_tokens=$8,connection_refill_seconds=$9,
      number_capacity=$10,number_refill_tokens=$11,number_refill_seconds=$12,
      minimum_spacing_seconds=$13,version=version+1,reason=$14,updated_by=$15,updated_at=now()
      WHERE tenant_id=$1 AND connection_id=$2 RETURNING *`,[principal.tenantId,connectionId,input.enabled,input.inboundResponseOnly,input.allowHumanGroupWorkspaceInitiation,input.responseWindowSeconds,input.connectionCapacity,input.connectionRefillTokens,input.connectionRefillSeconds,input.numberCapacity,input.numberRefillTokens,input.numberRefillSeconds,input.minimumSpacingSeconds,input.reason,principal.userId])).rows[0];
    await appendAudit(client,principal,{action:"waha.outbound.connection_policy_changed",targetType:"connection",targetId:connectionId,requestId,previousValue:safePolicy(previous),newValue:safePolicy(next)});
    return next;
  },"Idempotency key was already used for a different WAHA outbound connection policy"));if(input.enabled)await this.drain.wake(principal.tenantId);return result}
  async platformControl(){return this.operatorJson("SELECT app.get_waha_platform_outbound_control() AS result",[])}
  async changePlatformControl(input:TenantOutboundControlChange,operatorSubject:string,requestId:string){try{return await this.operatorJson("SELECT app.set_waha_platform_outbound_control($1,$2,$3,$4,$5) AS result",[input.expectedVersion,input.enabled,operatorSubject,input.reason,requestId])}catch(error){if(postgresCode(error)==="40001")throw new ConflictException("WAHA platform outbound control changed. Refresh and try again.");throw error}}
  async onModuleDestroy(){await this.operatorPool?.end()}
  private async operatorJson(sql:string,values:unknown[]){if(!this.operatorPool)throw new Error("WAHA_OPERATOR_DATABASE_URL is required");const value=(await this.operatorPool.query<{result:unknown}>(sql,values)).rows[0]?.result;if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("WAHA outbound safety operation returned no result");return value}
}

function safePolicy(value:Record<string,unknown>){return Object.fromEntries(Object.entries(value).filter(([key])=>!["tenant_id","updated_by"].includes(key)))}
function operationHash(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex")}
function postgresCode(error:unknown){return error&&typeof error==="object"&&"code" in error&&typeof error.code==="string"?error.code:undefined}
