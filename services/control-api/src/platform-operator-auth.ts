import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { PUBLIC_ROUTE } from "./auth.guard.js";
import type {
  PlatformOperatorPrincipal,
  PlatformOperatorRequest,
} from "./tenant-provisioning.types.js";
import { recordAuthorizationAnomaly } from "@wasalx/observability";

export const PLATFORM_OPERATOR_ROUTE = "wasalx:platform-operator";
export const PlatformOperatorOnly = () => SetMetadata(PLATFORM_OPERATOR_ROUTE, true);
export const SkipTenantAuthentication = () => SetMetadata(PUBLIC_ROUTE, true);

@Injectable()
export class PlatformOperatorAuthService {
  private readonly configured: boolean;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly maxAuthenticationAge: number;
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor() {
    this.issuer =
      process.env.PLATFORM_OPERATOR_OIDC_ISSUER?.replace(/\/+$/u, "") ?? "";
    this.audience = process.env.PLATFORM_OPERATOR_OIDC_AUDIENCE?.trim() ?? "";
    this.maxAuthenticationAge = boundedInteger(
      process.env.PLATFORM_OPERATOR_MAX_AUTH_AGE_SECONDS,
      900,
      60,
      3_600,
    );
    const ordinaryAudience = process.env.OIDC_AUDIENCE;
    let configured = false;
    if (
      this.issuer &&
      this.audience &&
      this.audience !== ordinaryAudience
    ) {
      try {
        const issuer = new URL(this.issuer);
        const jwks = new URL(
          process.env.PLATFORM_OPERATOR_OIDC_JWKS_URI ??
            `${this.issuer}/protocol/openid-connect/certs`,
        );
        if (isAllowedOidcUrl(issuer) && isAllowedOidcUrl(jwks)) {
          this.jwks = createRemoteJWKSet(jwks);
          configured = true;
        }
      } catch {
        // Malformed or insecure operator identity configuration fails closed.
      }
    }
    this.configured = configured;
  }

  isConfigured() {
    return this.configured;
  }

  async authenticate(authorization: string | undefined) {
    if (!this.configured || !this.jwks) {
      throw new ServiceUnavailableException(
        "Platform operator authentication is not configured",
      );
    }
    if (!authorization?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Platform operator bearer token is required");
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(authorization.slice(7), this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ["RS256", "ES256"],
        clockTolerance: 5,
      }));
    } catch {
      throw new UnauthorizedException("Invalid platform operator token");
    }
    return assertPlatformOperatorClaims(
      payload,
      Math.floor(Date.now() / 1_000),
      this.maxAuthenticationAge,
    );
  }
}

@Injectable()
export class PlatformOperatorGuard implements CanActivate {
  constructor(
    private readonly auth: PlatformOperatorAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    const required = this.reflector.getAllAndOverride<boolean>(
      PLATFORM_OPERATOR_ROUTE,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;
    const request = context.switchToHttp().getRequest<PlatformOperatorRequest>();
    if (request.headers["x-wasalx-tenant-id"] !== undefined) {
      recordAuthorizationAnomaly("service_api", "operator_tenant_header_forbidden");
      throw new UnauthorizedException(
        "Platform operator requests must not use tenant-session headers",
      );
    }
    const authorization = request.headers.authorization;
    try {
      request.platformOperator = await this.auth.authenticate(
        Array.isArray(authorization) ? authorization[0] : authorization,
      );
    } catch (error) {
      recordAuthorizationAnomaly("service_api", "operator_claims_rejected");
      throw error;
    }
    return true;
  }
}

export function assertPlatformOperatorClaims(
  payload: JWTPayload,
  now: number,
  maxAuthenticationAge: number,
): PlatformOperatorPrincipal {
  const realmAccess = payload.realm_access as
    | { roles?: unknown }
    | undefined;
  const realmRoles = Array.isArray(realmAccess?.roles)
    ? realmAccess.roles.filter((role): role is string => typeof role === "string")
    : [];
  if (
    payload.platform_role !== "platform_operator" &&
    !realmRoles.includes("wasalx-platform-operator")
  ) {
    throw new UnauthorizedException("Platform operator role is required");
  }
  const methods = Array.isArray(payload.amr)
    ? payload.amr.filter((method): method is string => typeof method === "string")
    : [];
  if (!methods.some((method) => ["mfa", "otp", "hwk"].includes(method))) {
    throw new UnauthorizedException("Platform operator MFA is required");
  }
  if (
    typeof payload.auth_time !== "number" ||
    payload.auth_time > now + 5 ||
    now - payload.auth_time > maxAuthenticationAge
  ) {
    throw new UnauthorizedException(
      "Recent platform operator authentication is required",
    );
  }
  if (
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.email !== "string" ||
    !payload.email
  ) {
    throw new UnauthorizedException("Platform operator identity is incomplete");
  }
  return {
    subject: payload.sub,
    email: payload.email,
    displayName:
      typeof payload.name === "string" && payload.name
        ? payload.name
        : payload.email,
    authenticatedAt: payload.auth_time,
  };
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Platform operator authentication age must be between ${minimum} and ${maximum} seconds`,
    );
  }
  return value;
}

function isAllowedOidcUrl(url: URL) {
  const localHttp =
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_INSECURE_PLATFORM_OPERATOR_OIDC === "true";
  return (
    (url.protocol === "https:" || (url.protocol === "http:" && localHttp)) &&
    !url.username &&
    !url.password &&
    !url.hash
  );
}
