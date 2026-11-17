import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { jwtVerify } from "jose";
import { recordAuthorizationAnomaly } from "@wasalx/observability";

const sources = new Set([
  "control-api",
  "connector-worker",
  "media-service",
  "tenant-provisioner",
  "waha-registry",
  "zammad-monitor",
]);

export type MeteringServicePrincipal = {
  tenantId: string;
  subject: string;
  source: string;
};

@Injectable()
export class MeteringAuthService {
  private readonly secret?: Uint8Array;

  constructor() {
    const configured = process.env.METERING_SERVICE_JWT_SECRET;
    if (configured && configured.length < 32) {
      throw new Error("METERING_SERVICE_JWT_SECRET must contain at least 32 characters");
    }
    this.secret = configured
      ? new TextEncoder().encode(configured)
      : undefined;
  }

  async authenticate(authorization: string | undefined) {
    if (!this.secret) {
      throw new ServiceUnavailableException(
        "Metering service authentication is not configured",
      );
    }
    if (!authorization?.startsWith("Bearer ")) {
      recordAuthorizationAnomaly("service_api", "missing_metering_token");
      throw new UnauthorizedException("Metering bearer token is required");
    }
    try {
      const { payload } = await jwtVerify(authorization.slice(7), this.secret, {
        issuer: "wasalx-runtime",
        audience: "wasalx-metering",
        algorithms: ["HS256"],
        clockTolerance: 5,
      });
      const scopes = new Set(String(payload.scope ?? "").split(" "));
      const tenantId = payload.tenant_id;
      const source = payload.source;
      const now = Math.floor(Date.now() / 1_000);
      if (
        !scopes.has("metering:write") ||
        typeof tenantId !== "string" ||
        !isUuid(tenantId) ||
        typeof source !== "string" ||
        !sources.has(source) ||
        typeof payload.sub !== "string" ||
        !payload.sub ||
        typeof payload.iat !== "number" ||
        typeof payload.exp !== "number" ||
        payload.iat > now + 5 ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat > 300
      ) {
        throw new Error("claims");
      }
      return {
        tenantId,
        subject: payload.sub,
        source,
      } satisfies MeteringServicePrincipal;
    } catch {
      recordAuthorizationAnomaly("service_api", "metering_token_rejected");
      throw new UnauthorizedException("Invalid metering service token");
    }
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}
