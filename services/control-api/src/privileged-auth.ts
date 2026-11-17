import { ForbiddenException } from "@nestjs/common";
import type { Principal } from "./types.js";

type Queryable = {
  query: <T>(sql: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

type PrivilegedAuthenticationPolicy = {
  privileged_reauth_minutes: number | string;
};

const DEFAULT_MFA_AMR_VALUES = ["mfa"];

export function authoritativeMfaPolicy() {
  const mfa_amr_values = configuredValues(process.env.OIDC_PRIVILEGED_MFA_AMR_VALUES, DEFAULT_MFA_AMR_VALUES);
  const mfa_acr_values = configuredValues(process.env.OIDC_PRIVILEGED_ACR_VALUES, []);
  if ([mfa_amr_values, mfa_acr_values].some(values => values.length > 32
    || values.some(value => value.length > 128 || /[\s\p{Cc}\p{Cf}]/u.test(value)))) return undefined;
  return { mfa_amr_values, mfa_acr_values };
}

/**
 * Enforces the tenant's recent-authentication window and authoritative MFA
 * evidence from the already verified OIDC access token. Missing or malformed
 * claims and missing tenant policy all fail closed.
 */
export async function requirePrivilegedAuthentication(
  queryable: Queryable,
  principal: Principal,
  action: string,
) {
  const policy = (
    await queryable.query<PrivilegedAuthenticationPolicy>(
      "SELECT privileged_reauth_minutes FROM tenant_settings WHERE tenant_id=$1",
      [principal.tenantId],
    )
  ).rows[0];
  if (!policy) throw reauthenticationRequired(action);

  const maximumMinutes = Number(policy.privileged_reauth_minutes);
  if (
    !Number.isSafeInteger(maximumMinutes) ||
    maximumMinutes < 5 ||
    maximumMinutes > 120
  ) {
    throw reauthenticationRequired(action);
  }

  if (!hasRecentAuthentication(principal, maximumMinutes)) {
    throw reauthenticationRequired(action);
  }

  if (!hasAuthoritativeMfa(principal)) {
    throw reauthenticationRequired(action, "Multi-factor authentication");
  }
}

export function hasRecentAuthentication(
  principal: Pick<Principal, "authenticatedAt">,
  maximumMinutes: number,
  now = Math.floor(Date.now() / 1_000),
) {
  const authenticatedAt = principal.authenticatedAt;
  return Number.isSafeInteger(maximumMinutes) && maximumMinutes > 0
    && Number.isSafeInteger(authenticatedAt) && authenticatedAt! <= now + 5
    && now - authenticatedAt! <= maximumMinutes * 60;
}

export function hasAuthoritativeMfa(
  principal: Pick<Principal, "authenticationMethods" | "authenticationContext">,
) {
  const policy = authoritativeMfaPolicy();
  if (!policy) return false;
  const methods = new Set(
    (principal.authenticationMethods ?? [])
      .filter((value) => typeof value === "string")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (policy.mfa_amr_values.some((value) => methods.has(value))) return true;

  const context = principal.authenticationContext?.trim();
  if (!context) return false;
  return policy.mfa_acr_values.includes(context);
}

function configuredValues(raw: string | undefined, fallback: string[]) {
  const values = (raw === undefined ? fallback : raw.split(/[\s,]+/u))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function reauthenticationRequired(action: string, prefix = "Recent authentication") {
  return new ForbiddenException({
    statusCode: 403,
    error: "Forbidden",
    code: "REAUTHENTICATION_REQUIRED",
    message: `${prefix} is required before ${action}.`,
  });
}
