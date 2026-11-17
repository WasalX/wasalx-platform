import {
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from "jose";
import type { RequestedIdentityPolicy } from "./repository.js";

export const REQUIRED_VERIFIED_CONTROLS = Object.freeze([
  "oidc_issuer_reachable",
  "oidc_jwks_signature_valid",
  "sso_policy_applied",
  "mfa_policy_applied",
  "session_timeout_applied",
  "privileged_reauthentication_applied",
  "support_access_approval_applied",
] as const);

export type IdentityPolicyAttestation = {
  tenantId: string;
  settingsVersion: number;
  policySha256: string;
  verificationRunId: string;
  evidenceSha256: string;
};

export class AttestationError extends Error {
  readonly status: number;
  readonly code: string;
  readonly safeMessage: string;
  constructor(
    status: number,
    code: string,
    safeMessage: string,
  ) {
    super(safeMessage);
    this.name = "AttestationError";
    this.status = status;
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

export class IdentityPolicyAttestationVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwksUri: URL;

  constructor(
    issuer: string,
    audience: string,
    jwksUri: URL,
  ) {
    this.issuer = issuer;
    this.audience = audience;
    this.jwksUri = jwksUri;
    this.jwks = createRemoteJWKSet(jwksUri, {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  }

  async verify(compactJws: string): Promise<IdentityPolicyAttestation> {
    if (
      compactJws.length < 100 || compactJws.length > 16_384 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(compactJws)
    ) {
      throw unauthorized("ATTESTATION_INVALID");
    }
    try {
      const verified = await jwtVerify(compactJws, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ["RS256", "ES256"],
        clockTolerance: 5,
        maxTokenAge: "5m",
        requiredClaims: ["sub", "jti", "iat", "exp"],
      });
      if (
        verified.protectedHeader.typ !== "wasalx-idp-session-attestation+jwt" ||
        !verified.protectedHeader.kid
      ) {
        throw unauthorized("ATTESTATION_HEADER_INVALID");
      }
      return validateAttestationClaims(verified.payload, compactJws);
    } catch (error) {
      if (error instanceof AttestationError) throw error;
      throw unauthorized("ATTESTATION_SIGNATURE_INVALID");
    }
  }

  async ready() {
    try {
      const response = await fetch(this.jwksUri, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 64 * 1024) return false;
      const body = await boundedJwks(response);
      return Array.isArray(body.keys) && body.keys.length > 0;
    } catch {
      return false;
    }
  }
}

async function boundedJwks(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return {} as { keys?: unknown[] };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 64 * 1024) {
      await reader.cancel();
      return {} as { keys?: unknown[] };
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as { keys?: unknown[] };
  } catch {
    return {} as { keys?: unknown[] };
  }
}

export function validateAttestationClaims(
  payload: JWTPayload,
  compactJws: string,
): IdentityPolicyAttestation {
  const tenantId = typeof payload.tenant_id === "string" ? payload.tenant_id.toLowerCase() : "";
  if (!uuid(tenantId)) throw unauthorized("ATTESTATION_TENANT_INVALID");
  const settingsVersion = payload.settings_version;
  if (typeof settingsVersion !== "number" || !Number.isSafeInteger(settingsVersion) || settingsVersion < 1) {
    throw unauthorized("ATTESTATION_VERSION_INVALID");
  }
  const policySha256 = typeof payload.policy_sha256 === "string" ? payload.policy_sha256 : "";
  if (!sha256(policySha256)) throw unauthorized("ATTESTATION_POLICY_DIGEST_INVALID");
  const verificationRunId = typeof payload.jti === "string" ? payload.jti : "";
  if (verificationRunId.length < 8 || verificationRunId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(verificationRunId)) {
    throw unauthorized("ATTESTATION_RUN_ID_INVALID");
  }
  if (payload.sub !== "identity-policy-verifier") {
    throw unauthorized("ATTESTATION_SUBJECT_INVALID");
  }
  const controls = payload.verified_controls;
  if (
    !Array.isArray(controls) || controls.some((item) => typeof item !== "string") ||
    new Set(controls).size !== controls.length ||
    REQUIRED_VERIFIED_CONTROLS.some((control) => !controls.includes(control))
  ) {
    throw unauthorized("ATTESTATION_CONTROLS_INCOMPLETE");
  }
  return {
    tenantId,
    settingsVersion,
    policySha256,
    verificationRunId,
    evidenceSha256: createHash("sha256").update(compactJws, "utf8").digest("hex"),
  };
}

export function identityPolicySha256(policy: RequestedIdentityPolicy) {
  const canonical = JSON.stringify({
    tenant_id: policy.tenant_id.toLowerCase(),
    version: Number(policy.version),
    sso_enforcement_state: policy.sso_enforcement_state,
    sso_provider_name: policy.sso_provider_name,
    sso_issuer: policy.sso_issuer,
    sso_email_domains: [...policy.sso_email_domains].map((value) => value.toLowerCase()).sort(),
    mfa_required_roles: [...policy.mfa_required_roles].sort(),
    session_timeout_minutes: Number(policy.session_timeout_minutes),
    privileged_reauth_minutes: Number(policy.privileged_reauth_minutes),
    support_access_requires_approval: policy.support_access_requires_approval,
    security_policy_state: policy.security_policy_state,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function equalSha256(left: string, right: string) {
  if (!sha256(left) || !sha256(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function unauthorized(code: string) {
  return new AttestationError(401, code, "The identity-policy verification evidence is invalid or expired.");
}

function sha256(value: string) {
  return /^[0-9a-f]{64}$/u.test(value);
}

function uuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}
