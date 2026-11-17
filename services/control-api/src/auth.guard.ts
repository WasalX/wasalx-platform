import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthService } from "./auth.service.js";
import type { AuthenticatedRequest } from "./types.js";
import { recordAuthorizationAnomaly } from "@wasalx/observability";

export const PUBLIC_ROUTE="wasalx:public";
@Injectable()
export class AuthGuard implements CanActivate{
  constructor(private readonly auth:AuthService,private readonly reflector:Reflector){}
  async canActivate(context:ExecutionContext){if(this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE,[context.getHandler(),context.getClass()]))return true;const request=context.switchToHttp().getRequest<AuthenticatedRequest>();const authorization=request.headers.authorization;const tenantHeader=request.headers["x-wasalx-tenant-id"];const tenantId=Array.isArray(tenantHeader)?tenantHeader[0]:tenantHeader;if(!authorization?.startsWith("Bearer ")||!tenantId||!isUuid(tenantId)){recordAuthorizationAnomaly("tenant_api","missing_or_invalid_credentials");throw new UnauthorizedException("Bearer token and valid tenant header are required")}try{request.principal=await this.auth.authenticate(authorization.slice(7),tenantId);return true}catch(error){recordAuthorizationAnomaly("tenant_api","token_or_membership_rejected");throw error}}
}
function isUuid(value:string){return/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)}
