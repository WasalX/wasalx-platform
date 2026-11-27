import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PUBLIC_ROUTE } from "./auth.guard.js";
import { can, type Permission } from "./rbac.js";
import type { AuthenticatedRequest } from "./types.js";
import { recordAuthorizationAnomaly } from "@wasalx/observability";

const PERMISSION="wasalx:permission";
export const Requires=(permission:Permission)=>SetMetadata(PERMISSION,permission);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const targets = [context.getHandler(), context.getClass()];
    const permission = this.reflector.getAllAndOverride<Permission>(PERMISSION, targets);
    if (permission === undefined && this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets) === true) {
      return true;
    }

    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (permission === undefined || !principal || !can(principal.role, permission)) {
      recordAuthorizationAnomaly("tenant_api", "permission_denied");
      throw new ForbiddenException(permission === undefined ? "Route permission is required" : `Missing permission ${permission}`);
    }
    return true;
  }
}
