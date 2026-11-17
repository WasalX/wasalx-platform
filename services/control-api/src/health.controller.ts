import {
  Controller,
  Get,
  ServiceUnavailableException,
  SetMetadata,
} from "@nestjs/common";
import { DatabaseService } from "./database.service.js";
import { PUBLIC_ROUTE } from "./auth.guard.js";
import { SecretProvisioningService } from "./secret-provisioning.service.js";
import { TenantDrainService } from "./tenant-drain.service.js";
@Controller("health")
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly drain: TenantDrainService,
    private readonly secrets: SecretProvisioningService,
  ) {}
  @Get("live") @SetMetadata(PUBLIC_ROUTE, true) live() {
    return { status: "ok", time: new Date().toISOString() };
  }
  @Get("ready") @SetMetadata(PUBLIC_ROUTE, true) async ready() {
    const [database, redis, secretManager] = await Promise.all([
      this.database.ready().catch(() => false),
      this.drain.ready(),
      this.secrets.ready(),
    ]);
    const checks = { database, redis, secret_manager: secretManager };
    if (!database || !redis || !secretManager)
      throw new ServiceUnavailableException({
        status: "failed",
        checks,
        time: new Date().toISOString(),
      });
    return {
      status: "ok",
      checks,
      time: new Date().toISOString(),
    };
  }
}
