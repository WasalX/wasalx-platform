import { BadRequestException, Body, Controller, Get, Headers, Post, Req } from "@nestjs/common";
import { createHash } from "node:crypto";
import { parseNativeRoutingSyncCommand } from "@wasalx/core/native-routing-contract";
import { DatabaseService } from "./database.service.js";
import { NativeRoutingSyncService } from "./native-routing-sync.service.js";
import { ZammadRoutingCatalogService } from "./zammad-routing-catalog.service.js";
import { Requires } from "./permission.guard.js";
import { requirePrivilegedAuthentication } from "./privileged-auth.js";
import { findOperationReceipt, requireOperationKey, withOperationReceipt } from "./idempotent-operation.js";
import { appendAudit } from "./audit.js";
import type { AuthenticatedRequest } from "./types.js";

@Controller("v1/zammad/routing-sync")
export class NativeRoutingSyncController{
  constructor(private readonly database:DatabaseService,private readonly sync:NativeRoutingSyncService,private readonly catalogs:ZammadRoutingCatalogService){}
  @Get() @Requires("group:read")
  status(@Req()request:AuthenticatedRequest){return this.sync.status(request.principal.tenantId);}
  @Post() @Requires("bot:write")
  async command(@Req()request:AuthenticatedRequest,@Headers("idempotency-key")key:string,@Body()body:unknown){
    const principal=request.principal,idempotencyKey=requireOperationKey(key);
    let command:ReturnType<typeof parseNativeRoutingSyncCommand>;
    try{command=parseNativeRoutingSyncCommand(body);}catch{throw new BadRequestException({code:"NATIVE_ROUTING_VALIDATION_ERROR",message:"Routing synchronization request is invalid"});}
    const requestSha256=createHash("sha256").update(JSON.stringify({nativeRouting:command})).digest("hex");
    const replay=await this.database.withTenant(principal.tenantId,client=>findOperationReceipt(client,principal,"ROUTING_SYNC",idempotencyKey,requestSha256));
    if(replay)return replay;
    // Catalog HTTP is deliberately outside the configuration-save transaction.
    if(command.action==="SAVE_DEFAULTS"&&command.departmentDefaults.some(policy=>policy.enabled)){
      const catalog=await this.catalogs.get(principal.tenantId,true);
      for(const policy of command.departmentDefaults){
        if(!policy.enabled)continue;
        const group=catalog.groups.find(item=>item.id===policy.zammadGroupId),owner=catalog.owners.find(item=>item.id===policy.zammadOwnerId);
        if(!group?.active||!group.serviceIdentityCanCreate||!owner?.active||!owner.groupIds.includes(policy.zammadGroupId))throw new BadRequestException({code:"NATIVE_ROUTING_VALIDATION_ERROR",message:"Select an active queue and eligible agent"});
      }
    }
    const result=await this.database.withTenant(principal.tenantId,client=>withOperationReceipt(client,principal,"ROUTING_SYNC",idempotencyKey,
      requestSha256,String(request.id),async()=>{
        if(command.action==="SAVE_DEFAULTS")await requirePrivilegedAuthentication(client,principal,"saving native queue defaults");
        const status=await this.sync.command(client,principal.tenantId,command);
        await appendAudit(client,principal,{action:`routing.native_${command.action.toLowerCase()}`,targetType:"tenant",targetId:principal.tenantId,requestId:String(request.id),newValue:{desired_revision:status.desiredRevision,policy_count:status.departmentDefaults.length}});
        return status;
      }));
    this.sync.wake(principal.tenantId);return result;
  }
}
