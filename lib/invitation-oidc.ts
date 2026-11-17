import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Locale } from "./i18n/locales.ts";
import { assertPrivilegedOidcClaims, oidcConfiguration, oidcSessionBinding } from "./oidc.ts";
import { BoundedBodyError, readBoundedBody, readBoundedJson } from "./bounded-json.ts";
import { oidcTransactionCookieName } from "./oidc-transaction-cookies.ts";
import {
  portalPublicOrigin,
  type PortalSession,
} from "./portal-session.ts";

export type InvitationOidcTransaction = {
  kind: "tenant_invitation";
  state: string;
  nonce: string;
  verifier: string;
  token: string;
  createdAt: number;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type InvitationAcceptance = {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  user_id: string;
  membership_role: PortalSession["role"];
};

type SessionDiscovery = {
  subject: string;
  user: { id: string; email: string; display_name: string };
  tenants: Array<{
    id: string;
    name: string;
    slug: string;
    state: string;
    role: PortalSession["role"];
    mfaRequiredRoles: string[];
    sessionTimeoutMinutes: number;
  }>;
};

export type InvitationFailureState =
  | "expired_or_used"
  | "identity_mismatch"
  | "identity_unverified"
  | "membership_conflict"
  | "accepted_session_pending"
  | "authentication_failed";

export class InvitationAcceptanceError extends Error {
  readonly result: InvitationFailureState;
  constructor(result: InvitationFailureState) {
    super("Invitation acceptance failed");
    this.name = "InvitationAcceptanceError";
    this.result = result;
  }
}

export class InvitationRequestTooLargeError extends Error {
  constructor() {
    super("Invitation request is too large");
    this.name = "InvitationRequestTooLargeError";
  }
}

export async function readBoundedInvitationRequest(request: Request, timeoutMs = 5_000) {
  const maximumBytes = 512;
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximumBytes) {
      throw new InvitationRequestTooLargeError();
    }
  }

  if (!request.body) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request, maximumBytes, timeoutMs));
  } catch (error) {
    if (error instanceof BoundedBodyError && error.status === 413) throw new InvitationRequestTooLargeError();
    throw error;
  }
}

export function invitationTransactionCookieName(state: string) {
  const secure = process.env.PORTAL_COOKIE_SECURE !== "false";
  return oidcTransactionCookieName("wasalx_invitation_oidc", state, secure);
}

export function validInvitationToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

export async function createInvitationOidcTransaction(token: string) {
  if (!validInvitationToken(token)) throw new InvitationAcceptanceError("expired_or_used");
  const verifier = randomToken(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const transaction: InvitationOidcTransaction = {
    kind: "tenant_invitation",
    state: randomToken(32),
    nonce: randomToken(32),
    verifier,
    token,
    createdAt: Date.now(),
  };
  return { transaction, challenge: base64url(new Uint8Array(digest)) };
}

export function invitationAuthorizationUrl(
  transaction: InvitationOidcTransaction,
  challenge: string,
  locale: Locale = "en",
) {
  const config = invitationOidcConfiguration();
  const url = new URL(config.authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "openid profile email",
    redirect_uri: config.invitationRedirectUri,
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "login",
    max_age: "0",
    ui_locales: locale,
  }).toString();
  url.searchParams.set("acr_values", required("OIDC_PRIVILEGED_ACR_VALUES"));
  return url;
}

export function validInvitationTransaction(value: InvitationOidcTransaction) {
  return Boolean(
    value?.kind === "tenant_invitation" &&
    validInvitationToken(value.token) &&
    /^[A-Za-z0-9_-]{43}$/u.test(value.state) &&
    /^[A-Za-z0-9_-]{43}$/u.test(value.nonce) &&
    /^[A-Za-z0-9_-]{86}$/u.test(value.verifier) &&
    Number.isFinite(value.createdAt) &&
    Date.now() - value.createdAt >= 0 &&
    Date.now() - value.createdAt <= 10 * 60_000,
  );
}

export async function completeInvitationAcceptance(input: {
  code: string;
  transaction: InvitationOidcTransaction;
}) {
  if (!validInvitationTransaction(input.transaction)) {
    throw new InvitationAcceptanceError("authentication_failed");
  }
  const config = invitationOidcConfiguration();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: input.code,
    redirect_uri: config.invitationRedirectUri,
    code_verifier: input.transaction.verifier,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);
  const tokens = await exchangeTokens(config.tokenEndpoint, body);
  if (!tokens.id_token || !tokens.access_token) {
    throw new InvitationAcceptanceError("authentication_failed");
  }
  const verified = await verifyIdToken(config, tokens.id_token, input.transaction.nonce);
  if (!verified.mfa) throw new InvitationAcceptanceError("authentication_failed");
  const accepted = await acceptInvitation(config.controlApiUrl, tokens.access_token, input.transaction.token, verified.subject);
  try {
    const discovery: SessionDiscovery = await discover(config.controlApiUrl, tokens.access_token);
    if (discovery.subject !== verified.subject) throw new Error("subject_mismatch");
    const tenant = discovery.tenants.find((candidate) => candidate.id === accepted.tenant_id);
    if (!tenant || tenant.role !== accepted.membership_role) throw new Error("membership_missing");
    const now = Math.floor(Date.now() / 1_000);
    const sessionTimeoutSeconds=Math.min(Math.max(Number(tenant.sessionTimeoutMinutes),15),1440)*60;
    const session: PortalSession = {
      version: 1,
      oidcBinding: verified.oidcBinding,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: now + Math.min(Math.max(Number(tokens.expires_in ?? 300), 60), 86_400),
      subject: discovery.subject,
      userId: discovery.user.id,
      email: discovery.user.email,
      displayName: discovery.user.display_name,
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      role: tenant.role,
      authenticatedAt:verified.authenticatedAt,
      authenticationMethods:verified.authenticationMethods,
      authenticationContext:verified.authenticationContext,
      csrfToken: randomToken(32),
      createdAt: now,
      sessionTimeoutSeconds,
      absoluteExpiresAt: now + sessionTimeoutSeconds,
    };
    return { session, accepted };
  } catch {
    throw new InvitationAcceptanceError("accepted_session_pending");
  }
}

function invitationOidcConfiguration() {
  const base = oidcConfiguration();
  const invitationRedirectUri = process.env.OIDC_INVITATION_REDIRECT_URI ??
    `${portalPublicOrigin()}/invitations/callback`;
  const redirect = new URL(invitationRedirectUri);
  if (
    redirect.origin !== portalPublicOrigin() ||
    redirect.pathname !== "/invitations/callback" || redirect.search || redirect.hash
  ) {
    throw new Error("OIDC_INVITATION_REDIRECT_URI must be the portal invitation callback URL");
  }
  return { ...base, invitationRedirectUri: redirect.toString() };
}

async function exchangeTokens(endpoint: string, body: URLSearchParams) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const tokens = await readBoundedJson<TokenResponse>(response);
    if (!response.ok || tokens.error || !tokens.access_token || tokens.token_type?.toLowerCase() !== "bearer") {
      throw new InvitationAcceptanceError("authentication_failed");
    }
    return tokens;
  } catch (error) {
    if (error instanceof InvitationAcceptanceError) throw error;
    throw new InvitationAcceptanceError("authentication_failed");
  }
}

async function verifyIdToken(
  config: ReturnType<typeof invitationOidcConfiguration>,
  idToken: string,
  nonce: string,
) {
  try {
    const verified = await jwtVerify(
      idToken,
      createRemoteJWKSet(new URL(config.jwksUri)),
      {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ["RS256", "ES256"],
        clockTolerance: 5,
      },
    );
    if (
      verified.payload.nonce !== nonce || !verified.payload.sub ||
      (Array.isArray(verified.payload.aud) && verified.payload.aud.length > 1 &&
        verified.payload.azp !== config.clientId)
    ) {
      throw new Error("identity_token_invalid");
    }
    assertPrivilegedOidcClaims(verified.payload);
    return { subject: verified.payload.sub,mfa:true,oidcBinding:oidcSessionBinding(verified.payload),
      authenticatedAt:typeof verified.payload.auth_time==="number"?verified.payload.auth_time:undefined,
      authenticationMethods:Array.isArray(verified.payload.amr)?verified.payload.amr.filter((value):value is string=>typeof value==="string"):[],
      authenticationContext:typeof verified.payload.acr==="string"?verified.payload.acr:undefined };
  } catch {
    throw new InvitationAcceptanceError("authentication_failed");
  }
}

async function acceptInvitation(controlApiUrl: string, accessToken: string, token: string, expectedSubject: string) {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch(`${controlApiUrl}/v1/invitations/accept`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ token, expectedSubject }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      break;
    } catch {
      if (attempt === 1) throw new InvitationAcceptanceError("authentication_failed");
    }
  }
  if (!response) throw new InvitationAcceptanceError("authentication_failed");
  if (!response.ok) {
    if (response.status === 410) throw new InvitationAcceptanceError("expired_or_used");
    if (response.status === 403) throw new InvitationAcceptanceError("identity_mismatch");
    if (response.status === 401) throw new InvitationAcceptanceError("identity_unverified");
    if (response.status === 409) throw new InvitationAcceptanceError("membership_conflict");
    throw new InvitationAcceptanceError("authentication_failed");
  }
  let value: InvitationAcceptance;
  try { value = await readBoundedJson<InvitationAcceptance>(response); }
  catch { throw new InvitationAcceptanceError("authentication_failed"); }
  if (!value?.tenant_id || !value.user_id || !value.membership_role) {
    throw new InvitationAcceptanceError("authentication_failed");
  }
  return value;
}

async function discover(controlApiUrl: string, accessToken: string) {
  try {
    const response = await fetch(`${controlApiUrl}/v1/session`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const value = await readBoundedJson<SessionDiscovery>(response);
    if (!response.ok || !value?.subject || !value.user || !Array.isArray(value.tenants)) {
      throw new Error("discovery_failed");
    }
    return value;
  } catch {
    throw new InvitationAcceptanceError("authentication_failed");
  }
}

function randomToken(bytes: number) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/gu, "");
}

function required(name:string){const value=process.env[name]?.trim();if(!value)throw new Error(`${name} is required`);return value}
