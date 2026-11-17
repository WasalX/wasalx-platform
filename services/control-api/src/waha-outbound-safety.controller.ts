import { BadRequestException, Body, Controller, Get, Headers, Param, Patch, Req, UseGuards } from "@nestjs/common";
import { requireOperationKey } from "./idempotent-operation.js";
import { PlatformOperatorGuard, PlatformOperatorOnly, SkipTenantAuthentication } from "./platform-operator-auth.js";
import { Requires } from "./permission.guard.js";
import type { PlatformOperatorRequest } from "./tenant-provisioning.types.js";
import type { AuthenticatedRequest } from "./types.js";
import { WahaOutboundSafetyService, type ConnectionOutboundPolicyChange, type TenantOutboundControlChange } from "./waha-outbound-safety.service.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

@Controller("v1/settings/waha-outbound-safety")
export class TenantWahaOutboundSafetyController{
  constructor(private readonly safety:WahaOutboundSafetyService){}
  @Get() @Requires("settings:read")
  settings(@Req() request:AuthenticatedRequest){return this.safety.tenantSettings(request.principal.tenantId)}
  @Patch("control") @Requires("settings:write")
  control(@Req() request:AuthenticatedRequest,@Headers("idempotency-key") key:string|undefined,@Body() body:unknown){return this.safety.changeTenantControl(request.principal,parseControl(body),requireOperationKey(key),String(request.id))}
  @Patch("connections/:connectionId") @Requires("settings:write")
  connection(@Req() request:AuthenticatedRequest,@Param("connectionId") connectionId:string,@Headers("idempotency-key") key:string|undefined,@Body() body:unknown){if(!UUID.test(connectionId))throw new BadRequestException("Connection ID is invalid");return this.safety.changeConnectionPolicy(request.principal,connectionId,parsePolicy(body),requireOperationKey(key),String(request.id))}
}

@Controller("platform/v1/waha-outbound-safety")
@SkipTenantAuthentication() @PlatformOperatorOnly() @UseGuards(PlatformOperatorGuard)
export class PlatformWahaOutboundSafetyController{
  constructor(private readonly safety:WahaOutboundSafetyService){}
  @Get() settings(){return this.safety.platformControl()}
  @Patch() change(@Req() request:PlatformOperatorRequest,@Body() body:unknown){return this.safety.changePlatformControl(parseControl(body),request.platformOperator.subject,String(request.id))}
}

export function parseControl(body:unknown):TenantOutboundControlChange{const value=record(body);return{expectedVersion:integer(value.expectedVersion,"Expected version",1,Number.MAX_SAFE_INTEGER),enabled:boolean(value.enabled,"Enabled"),reason:reason(value.reason)}}
export function parsePolicy(body:unknown):ConnectionOutboundPolicyChange{const value=record(body);const inboundResponseOnly=boolean(value.inboundResponseOnly,"Inbound-response-only");if(!inboundResponseOnly)throw new BadRequestException("WAHA outbound must remain inbound-response-only");return{...parseControl(body),inboundResponseOnly,allowHumanGroupWorkspaceInitiation:boolean(value.allowHumanGroupWorkspaceInitiation,"Human group-workspace initiation"),responseWindowSeconds:integer(value.responseWindowSeconds,"Response window",300,604800),connectionCapacity:integer(value.connectionCapacity,"Connection capacity",1,1000),connectionRefillTokens:integer(value.connectionRefillTokens,"Connection refill tokens",1,1000),connectionRefillSeconds:integer(value.connectionRefillSeconds,"Connection refill interval",1,86400),numberCapacity:integer(value.numberCapacity,"Number capacity",1,1000),numberRefillTokens:integer(value.numberRefillTokens,"Number refill tokens",1,1000),numberRefillSeconds:integer(value.numberRefillSeconds,"Number refill interval",1,86400),minimumSpacingSeconds:integer(value.minimumSpacingSeconds,"Minimum spacing",1,3600)}}
function record(value:unknown){if(!value||typeof value!=="object"||Array.isArray(value))throw new BadRequestException("WAHA outbound safety input is required");return value as Record<string,unknown>}
function boolean(value:unknown,label:string){if(typeof value!=="boolean")throw new BadRequestException(`${label} must be a boolean`);return value}
function integer(value:unknown,label:string,min:number,max:number){const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<min||parsed>max)throw new BadRequestException(`${label} must be between ${min} and ${max}`);return parsed}
function reason(value:unknown){if(typeof value!=="string"||value.trim()!==value||value.length<3||value.length>500||/[\p{Cc}\p{Cf}]/u.test(value))throw new BadRequestException("A safe change reason is required");return value}
