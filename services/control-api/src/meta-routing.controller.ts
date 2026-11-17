import { Body,Controller,Get,Headers,Param,Post,Req,UseGuards } from '@nestjs/common';
import { Requires } from './permission.guard.js';
import { PlatformOperatorGuard,PlatformOperatorOnly,SkipTenantAuthentication } from './platform-operator-auth.js';
import { MetaRoutingService } from './meta-routing.service.js';
import { MetaThreadControlService } from './meta-thread-control.service.js';
import type { AuthenticatedRequest } from './types.js';
import type { PlatformOperatorRequest } from './tenant-provisioning.types.js';

@Controller('v1/connections/:id/meta/routing')
export class MetaRoutingController {
 constructor(private readonly routing:MetaRoutingService){}
 @Get() @Requires('connection:read')
 get(@Req()request:AuthenticatedRequest,@Param('id')id:string){return this.routing.configuration(request,id)}
 @Post() @Requires('connection:write')
 declare(@Req()request:AuthenticatedRequest,@Param('id')id:string,@Headers('idempotency-key')key:string|undefined,@Body()body:unknown){return this.routing.declare(request,id,key,body)}
}

@Controller('platform/v1/operations/tenants/:tenantId/connections/:connectionId/meta-routing-review')
@SkipTenantAuthentication() @PlatformOperatorOnly() @UseGuards(PlatformOperatorGuard)
export class PlatformMetaRoutingController {
 constructor(private readonly routing:MetaRoutingService){}
 @Get()
 get(@Req()request:PlatformOperatorRequest,@Param('tenantId')tenantId:string,@Param('connectionId')connectionId:string){return this.routing.operatorView(request,tenantId,connectionId)}
 @Post()
 review(@Req()request:PlatformOperatorRequest,@Param('tenantId')tenantId:string,@Param('connectionId')connectionId:string,@Headers('idempotency-key')key:string|undefined,@Body()body:unknown){return this.routing.operatorReview(request,tenantId,connectionId,key,body)}
}

@Controller('v1/bot-flows/conversations/:id/meta-thread-control')
export class MetaThreadControlController {
 constructor(private readonly threads:MetaThreadControlService){}
 @Get() @Requires('bot:read')
 inspect(@Req()request:AuthenticatedRequest,@Param('id')id:string,@Headers('idempotency-key')key:string|undefined){return this.threads.inspect(request,id,key)}
 @Post() @Requires('bot:operate')
 execute(@Req()request:AuthenticatedRequest,@Param('id')id:string,@Headers('idempotency-key')key:string|undefined,@Body()body:unknown){return this.threads.execute(request,id,key,body)}
}
