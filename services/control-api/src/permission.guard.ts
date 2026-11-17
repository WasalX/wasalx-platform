import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { can, type Permission } from "./rbac.js";
import type { AuthenticatedRequest } from "./types.js";
import { recordAuthorizationAnomaly } from "@wasalx/observability";
const PERMISSION="wasalx:permission";
export const Requires=(permission:Permission)=>SetMetadata(PERMISSION,permission);
@Injectable()
export class PermissionGuard implements CanActivate{constructor(private readonly reflector:Reflector){}canActivate(context:ExecutionContext){const permission=this.reflector.getAllAndOverride<Permission>(PERMISSION,[context.getHandler(),context.getClass()]);if(!permission)return true;const principal=context.switchToHttp().getRequest<AuthenticatedRequest>().principal;if(!principal||!can(principal.role,permission)){recordAuthorizationAnomaly("tenant_api","permission_denied");throw new ForbiddenException(`Missing permission ${permission}`)}return true}}
