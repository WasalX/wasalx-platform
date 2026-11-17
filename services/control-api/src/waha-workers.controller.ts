import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  PlatformOperatorGuard,
  PlatformOperatorOnly,
  SkipTenantAuthentication,
} from "./platform-operator-auth.js";
import type { PlatformOperatorRequest } from "./tenant-provisioning.types.js";
import {
  WahaWorkersService,
  type WahaWorkerModeChange,
} from "./waha-workers.service.js";

@Controller("platform/v1/waha-workers")
@SkipTenantAuthentication()
@PlatformOperatorOnly()
@UseGuards(PlatformOperatorGuard)
export class WahaWorkersController {
  constructor(private readonly workers: WahaWorkersService) {}

  @Get()
  list() {
    return this.workers.list();
  }

  @Patch(":workerKey/mode")
  changeMode(
    @Req() request: PlatformOperatorRequest,
    @Param("workerKey") rawWorkerKey: string,
    @Body() body: unknown,
  ) {
    const workerKey = requireWorkerKey(rawWorkerKey);
    const change = parseModeChange(body);
    return this.workers.changeMode(workerKey, change, request.platformOperator.subject);
  }
}

export function parseModeChange(body: unknown): WahaWorkerModeChange {
  if (!isRecord(body)) throw new BadRequestException("WAHA worker mode is required");
  const version = Number(body.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new BadRequestException("A valid WAHA worker version is required");
  }
  const lifecycleState = body.lifecycleState;
  if (lifecycleState !== "ACTIVE" && lifecycleState !== "DRAINING" && lifecycleState !== "DISABLED") {
    throw new BadRequestException("WAHA worker lifecycle state is invalid");
  }
  const rolloutMode = body.rolloutMode;
  if (rolloutMode !== "STABLE" && rolloutMode !== "CANARY") {
    throw new BadRequestException("WAHA worker rollout mode is invalid");
  }
  const canarySessionLimit = body.canarySessionLimit === undefined
    ? undefined
    : Number(body.canarySessionLimit);
  if (rolloutMode === "STABLE" && canarySessionLimit !== undefined) {
    throw new BadRequestException("Stable workers cannot have a canary session limit");
  }
  if (rolloutMode === "CANARY" &&
      (!Number.isSafeInteger(canarySessionLimit) || (canarySessionLimit ?? 0) < 1 || (canarySessionLimit ?? 0) > 10_000)) {
    throw new BadRequestException("A canary session limit is required");
  }
  if (typeof body.reason !== "string" || body.reason.trim() !== body.reason ||
      body.reason.length < 3 || body.reason.length > 500 || /[\p{Cc}\p{Cf}]/u.test(body.reason)) {
    throw new BadRequestException("A safe change reason is required");
  }
  return {
    version,
    lifecycleState,
    rolloutMode,
    ...(canarySessionLimit === undefined ? {} : { canarySessionLimit }),
    reason: body.reason,
  };
}

function requireWorkerKey(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new BadRequestException("WAHA worker key is invalid");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
