import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { HttpTenantProvisioningDriver } from "./tenant-provisioning.driver.js";
import { TenantProvisioningRepository } from "./tenant-provisioning.repository.js";
import type {
  PlatformOperatorPrincipal,
  TenantProvisioningCreateSpec,
  TenantProvisioningRelease,
  TenantProvisioningSpec,
} from "./tenant-provisioning.types.js";
import { TenantProvisioningWorker } from "./tenant-provisioning.worker.js";

type OperatorCall = {
  idempotencyKey: string;
  operator: PlatformOperatorPrincipal;
  requestId: string;
};

@Injectable()
export class TenantProvisioningService {
  constructor(
    private readonly repository: TenantProvisioningRepository,
    private readonly driver: HttpTenantProvisioningDriver,
    private readonly worker: TenantProvisioningWorker,
  ) {}

  async create(spec: TenantProvisioningCreateSpec, input: OperatorCall) {
    this.assertDatabase();
    try {
      const requestSha256 = requestHash({ action: "CREATE", spec });
      const replay = await this.repository.replayCreate({ ...input, requestSha256 });
      if (replay) return replay;
      this.assertOperational();
      const persistedSpec: TenantProvisioningSpec = {
        ...spec,
        deployment: {
          ...spec.deployment,
          release: configuredRelease(spec.deployment.zammadVersion),
        },
      };
      const result = await this.repository.create({
        ...input,
        requestSha256,
        spec: persistedSpec,
      });
      this.worker.kick();
      return result;
    } catch (error) {
      throw mapProvisioningError(error);
    }
  }

  async status(
    tenantId: string,
    operator: PlatformOperatorPrincipal,
    requestId: string,
  ) {
    this.assertDatabase();
    try {
      const result = await this.repository.status(tenantId, operator, requestId);
      if (!result) throw new NotFoundException("Tenant provisioning operation not found");
      return result;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw mapProvisioningError(error);
    }
  }

  async retry(tenantId: string, input: OperatorCall) {
    this.assertOperational();
    try {
      const result = await this.repository.retry(tenantId, {
        ...input,
        requestSha256: requestHash({ action: "RETRY", tenantId }),
      });
      this.worker.kick();
      return result;
    } catch (error) {
      throw mapProvisioningError(error);
    }
  }

  async suspend(tenantId: string, reason: string, input: OperatorCall) {
    this.assertOperational();
    try {
      const result = await this.repository.suspend(tenantId, reason, {
        ...input,
        requestSha256: requestHash({ action: "SUSPEND", tenantId, reason }),
      });
      this.worker.kick();
      return result;
    } catch (error) {
      throw mapProvisioningError(error);
    }
  }

  async resume(tenantId: string, reason: string, input: OperatorCall) {
    this.assertOperational();
    try {
      const result = await this.repository.resume(tenantId, reason, {
        ...input,
        requestSha256: requestHash({ action: "RESUME", tenantId, reason }),
      });
      this.worker.kick();
      return result;
    } catch (error) {
      throw mapProvisioningError(error);
    }
  }

  private assertDatabase() {
    if (!this.repository.isConfigured()) {
      throw new ServiceUnavailableException(
        "The least-privilege tenant provisioning database role is not configured",
      );
    }
  }

  private assertOperational() {
    this.assertDatabase();
    if (!this.driver.isConfigured() || !this.worker.isOperational()) {
      throw new ServiceUnavailableException(
        "A real tenant provisioning driver is not configured",
      );
    }
  }
}

export function configuredRelease(
  zammadVersion: string,
  environment: NodeJS.ProcessEnv = process.env,
): TenantProvisioningRelease {
  let imagesByVersion: unknown;
  try { imagesByVersion = JSON.parse(requiredReleaseValue(environment, "ZAMMAD_IMAGE_BY_VERSION_JSON")); }
  catch { throw new Error("The tenant runtime release configuration is invalid"); }
  if (!imagesByVersion || typeof imagesByVersion !== "object" || Array.isArray(imagesByVersion)) {
    throw new Error("The tenant runtime release configuration is invalid");
  }
  if (!Object.hasOwn(imagesByVersion, zammadVersion)) {
    throw new UnprocessableEntityException("The requested Zammad version is not supported");
  }
  const zammad = (imagesByVersion as Record<string, unknown>)[zammadVersion];
  const release = {
    packageVersion: requiredReleaseValue(environment, "WASALX_ZAMMAD_PACKAGE_VERSION"),
    packageSha256: requiredReleaseValue(environment, "WASALX_ZAMMAD_PACKAGE_SHA256").toLowerCase(),
    images: {
      zammad,
      configurator: environment.ZAMMAD_CONFIGURATOR_IMAGE,
      nginx: environment.ZAMMAD_NGINX_IMAGE,
      redis: environment.ZAMMAD_REDIS_IMAGE,
      memcached: environment.ZAMMAD_MEMCACHED_IMAGE,
    },
  };
  if (
    release.packageVersion.length > 64 ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(release.packageVersion) ||
    !/^[0-9a-f]{64}$/u.test(release.packageSha256) ||
    Object.values(release.images).some((image) =>
      typeof image !== "string" || image.length > 2_048 || !/^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$/u.test(image)
    )
  ) {
    throw new Error("The tenant runtime release configuration is invalid");
  }
  return release as TenantProvisioningRelease;
}

function requiredReleaseValue(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name];
  if (!value || value.trim() !== value || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new Error("The tenant runtime release configuration is incomplete");
  }
  return value;
}

export function requestHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported idempotency input");
}

function mapProvisioningError(error: unknown) {
  if (
    error instanceof ConflictException ||
    error instanceof NotFoundException ||
    error instanceof ServiceUnavailableException ||
    error instanceof UnprocessableEntityException
  ) {
    return error;
  }
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  if (code === "23505" || code === "55000") {
    return new ConflictException(
      code === "23505"
        ? "The idempotency key or tenant slug conflicts with an existing request"
        : "The requested tenant lifecycle transition is not allowed",
    );
  }
  if (code === "P0002") {
    return new NotFoundException("Tenant provisioning operation not found");
  }
  return new ServiceUnavailableException(
    "The tenant provisioning control plane is temporarily unavailable",
  );
}
