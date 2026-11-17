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
import { TenantProvisioningService } from "./tenant-provisioning.service.js";
import type {
  PlatformOperatorRequest,
  TenantProvisioningCreateSpec,
} from "./tenant-provisioning.types.js";

@Controller("platform/v1/tenants")
@SkipTenantAuthentication()
@PlatformOperatorOnly()
@UseGuards(PlatformOperatorGuard)
export class TenantProvisioningController {
  constructor(private readonly provisioning: TenantProvisioningService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(
    @Req() request: PlatformOperatorRequest,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.provisioning.create(parseSpec(body), {
      idempotencyKey: requireIdempotencyKey(idempotencyKey),
      operator: request.platformOperator,
      requestId: String(request.id),
    });
  }

  @Get(":tenantId/provisioning")
  status(
    @Req() request: PlatformOperatorRequest,
    @Param("tenantId") tenantId: string,
  ) {
    return this.provisioning.status(
      requireUuid(tenantId),
      request.platformOperator,
      String(request.id),
    );
  }

  @Post(":tenantId/provisioning/retry")
  @HttpCode(HttpStatus.ACCEPTED)
  retry(
    @Req() request: PlatformOperatorRequest,
    @Param("tenantId") tenantId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    return this.provisioning.retry(requireUuid(tenantId), {
      idempotencyKey: requireIdempotencyKey(idempotencyKey),
      operator: request.platformOperator,
      requestId: String(request.id),
    });
  }

  @Post(":tenantId/suspend")
  @HttpCode(HttpStatus.ACCEPTED)
  suspend(
    @Req() request: PlatformOperatorRequest,
    @Param("tenantId") tenantId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const reason = parseReason(body);
    return this.provisioning.suspend(requireUuid(tenantId), reason, {
      idempotencyKey: requireIdempotencyKey(idempotencyKey),
      operator: request.platformOperator,
      requestId: String(request.id),
    });
  }

  @Post(":tenantId/resume")
  @HttpCode(HttpStatus.ACCEPTED)
  resume(
    @Req() request: PlatformOperatorRequest,
    @Param("tenantId") tenantId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.provisioning.resume(requireUuid(tenantId), parseResumeReason(body), {
      idempotencyKey: requireIdempotencyKey(idempotencyKey),
      operator: request.platformOperator,
      requestId: String(request.id),
    });
  }
}

export function parseSpec(body: unknown): TenantProvisioningCreateSpec {
  if (!isRecord(body) || !isRecord(body.owner) || !isRecord(body.deployment)) {
    throw new BadRequestException(
      "Tenant, owner, and deployment configuration are required",
    );
  }
  const name = requiredString(body.name, "Tenant name", 120, 2);
  const slug = requiredString(body.slug, "Tenant slug", 63).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(slug)) {
    throw new BadRequestException("Tenant slug must be DNS-label safe");
  }
  const retentionDays = Number(body.retentionDays ?? 90);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
    throw new BadRequestException("Retention days must be between 1 and 3650");
  }
  const oidcSubject = requiredString(body.owner.oidcSubject, "Owner OIDC subject", 255);
  const email = requiredString(body.owner.email, "Owner email", 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new BadRequestException("Owner email is invalid");
  }
  const displayName = requiredString(body.owner.displayName, "Owner display name", 120);
  const region = requiredString(body.deployment.region, "Deployment region", 63);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(region)) {
    throw new BadRequestException("Deployment region must be DNS-label safe");
  }
  const resourceProfile = body.deployment.resourceProfile;
  if (!isResourceProfile(resourceProfile)) {
    throw new BadRequestException("Resource profile must be small, medium, or large");
  }
  const zammadVersion = requiredString(
    body.deployment.zammadVersion,
    "Pinned Zammad version",
    40,
  );
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(zammadVersion)) {
    throw new BadRequestException("A pinned semantic Zammad version is required");
  }
  return {
    tenant: { name, slug, retentionDays },
    owner: { oidcSubject, email, displayName },
    deployment: {
      region,
      resourceProfile,
      zammadVersion,
    },
  };
}

function parseReason(body: unknown) {
  if (!isRecord(body)) throw new BadRequestException("Suspension reason is required");
  return requiredString(body.reason, "Suspension reason", 500, 3);
}

export function parseResumeReason(body: unknown) {
  if (!isRecord(body)) throw new BadRequestException("Reactivation reason is required");
  return requiredString(body.reason, "Reactivation reason", 500, 3);
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

function requireUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new BadRequestException("Tenant ID must be a UUID");
  }
  return value;
}

function requiredString(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 1,
) {
  if (typeof value !== "string") {
    throw new BadRequestException(`${label} is required`);
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isResourceProfile(
  value: unknown,
): value is "small" | "medium" | "large" {
  return value === "small" || value === "medium" || value === "large";
}

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}
