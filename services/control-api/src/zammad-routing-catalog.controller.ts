import { Controller, Get, Header, Req } from "@nestjs/common";
import { Requires } from "./permission.guard.js";
import type { AuthenticatedRequest } from "./types.js";
import { ZammadRoutingCatalogService } from "./zammad-routing-catalog.service.js";

@Controller("v1/zammad/routing-catalogs")
export class ZammadRoutingCatalogController {
  constructor(private readonly catalogs: ZammadRoutingCatalogService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  @Requires("group:read")
  list(@Req() request: AuthenticatedRequest) {
    return this.catalogs.get(request.principal.tenantId);
  }
}
