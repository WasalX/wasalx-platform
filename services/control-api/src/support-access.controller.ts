import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  PlatformOperatorGuard,
  PlatformOperatorOnly,
  SkipTenantAuthentication,
} from "./platform-operator-auth.js";
import { Requires } from "./permission.guard.js";
import { SupportAccessService } from "./support-access.service.js";
import type { PlatformOperatorRequest } from "./tenant-provisioning.types.js";
import type { AuthenticatedRequest } from "./types.js";

@Controller("v1/support-access")
export class TenantSupportAccessController {
  constructor(private readonly support: SupportAccessService) {}

  @Get()
  @Requires("support:read")
  list(@Req() request: AuthenticatedRequest) {
    return this.support.list(request.principal);
  }

  @Post(":id/approve")
  @Requires("support:approve")
  approve(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = decisionBody(body, false);
    return this.support.approve(
      request.principal,
      requireUuid(id, "Support access ID"),
      input.expectedVersion,
      input.durationSeconds,
      String(request.id),
    );
  }

  @Post(":id/deny")
  @Requires("support:approve")
  deny(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = decisionBody(body, true);
    return this.support.deny(
      request.principal,
      requireUuid(id, "Support access ID"),
      input.expectedVersion,
      input.reason!,
      String(request.id),
    );
  }

  @Post(":id/revoke")
  @Requires("support:approve")
  revoke(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = decisionBody(body, true);
    return this.support.revoke(
      request.principal,
      requireUuid(id, "Support access ID"),
      input.expectedVersion,
      input.reason!,
      String(request.id),
    );
  }
}

@Controller("platform/v1/support-access")
@SkipTenantAuthentication()
@PlatformOperatorOnly()
@UseGuards(PlatformOperatorGuard)
export class PlatformSupportAccessController {
  constructor(private readonly support: SupportAccessService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  request(
    @Req() request: PlatformOperatorRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const input = requestBody(body);
    return this.support.request(
      input.tenantId,
      input.reason,
      input.durationSeconds,
      {
        idempotencyKey: requireIdempotencyKey(idempotencyKey),
        operator: request.platformOperator,
        requestId: String(request.id),
      },
    );
  }

  @Get(":id")
  get(@Req() request: PlatformOperatorRequest, @Param("id") id: string) {
    return this.support.operatorGet(
      requireUuid(id, "Support access ID"),
      request.platformOperator,
      String(request.id),
    );
  }

  @Get(":id/overview")
  overview(@Req() request: PlatformOperatorRequest, @Param("id") id: string) {
    return this.support.overview(
      requireUuid(id, "Support access ID"),
      request.platformOperator,
      String(request.id),
    );
  }

  @Post(":id/cancel")
  cancel(
    @Req() request: PlatformOperatorRequest,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    const supportId = requireUuid(id, "Support access ID");
    return this.support.cancel(supportId, {
      idempotencyKey: requireIdempotencyKey(idempotencyKey),
      operator: request.platformOperator,
      requestId: String(request.id),
    });
  }
}

function requestBody(value: unknown) {
  if (!isRecord(value)) throw new BadRequestException("Support access request is required");
  const tenantId = requireUuid(value.tenantId, "Tenant ID");
  const reason = requiredText(value.reason, "Support reason", 10, 500);
  const durationSeconds = Number(value.durationSeconds ?? 900);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 300 || durationSeconds > 3_600) {
    throw new BadRequestException("Support duration must be between 300 and 3600 seconds");
  }
  return { tenantId, reason, durationSeconds };
}

function decisionBody(value: unknown, requiresReason: boolean) {
  if (!isRecord(value)) throw new BadRequestException("Support decision is required");
  const expectedVersion = Number(value.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new BadRequestException("A valid expectedVersion is required");
  }
  const durationSeconds =
    value.durationSeconds === undefined ? undefined : Number(value.durationSeconds);
  if (
    durationSeconds !== undefined &&
    (!Number.isInteger(durationSeconds) || durationSeconds < 300 || durationSeconds > 3_600)
  ) {
    throw new BadRequestException("Granted duration must be between 300 and 3600 seconds");
  }
  const reason = requiresReason
    ? requiredText(value.reason, "Decision reason", 3, 500)
    : undefined;
  return { expectedVersion, durationSeconds, reason };
}

function requireUuid(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new BadRequestException(`${label} must be a UUID`);
  }
  return value;
}

function requireIdempotencyKey(value: string | undefined) {
  if (
    !value ||
    value.length > 255 ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    throw new BadRequestException("A valid Idempotency-Key header is required");
  }
  return value;
}

function requiredText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (typeof value !== "string") throw new BadRequestException(`${label} is required`);
  const normalized = value.trim();
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    hasControlCharacters(normalized)
  ) {
    throw new BadRequestException(`${label} is invalid`);
  }
  return normalized;
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
