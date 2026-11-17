import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";
import type { Locale } from "./i18n/locales.ts";
import { readBoundedJson } from "./bounded-json.ts";
import { OIDC_TRANSACTION_MAX_AGE_SECONDS, validOidcState } from "./oidc-transaction-cookies.ts";
import {
  PortalSessionError,
  assertOidcSessionBinding,
  portalPublicOrigin,
  safeReturnPath,
  type PortalSession,
  type OidcSessionBinding,
} from "./portal-session.ts";

export type OidcTransaction = {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  requestedTenantId?: string;
  stepUp?: "privileged" | "required_mfa";
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

export type OidcLoginFailureReason="expired"|"identity"|"membership"|"unavailable";
export class OidcLoginError extends PortalSessionError{
  readonly reason:OidcLoginFailureReason;
  constructor(reason:OidcLoginFailureReason,message:string,status=401){super(message,status);this.reason=reason;this.name="OidcLoginError"}
}

export function oidcConfiguration() {
  const issuer = required("OIDC_ISSUER").replace(/\/$/, "");
  const configuration = {
    issuer,
    clientId: required("OIDC_CLIENT_ID"),
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    authorizationEndpoint:
      process.env.OIDC_AUTHORIZATION_ENDPOINT ??
      `${issuer}/protocol/openid-connect/auth`,
    endSessionEndpoint:
      process.env.OIDC_END_SESSION_ENDPOINT ??
      `${issuer}/protocol/openid-connect/logout`,
    tokenEndpoint:
      process.env.OIDC_TOKEN_ENDPOINT ??
      `${issuer}/protocol/openid-connect/token`,
    jwksUri:
      process.env.OIDC_JWKS_URI ?? `${issuer}/protocol/openid-connect/certs`,
    redirectUri: required("OIDC_REDIRECT_URI"),
    controlApiUrl: required("CONTROL_API_URL").replace(/\/$/, ""),
  };
  for (const value of [configuration.issuer, configuration.authorizationEndpoint, configuration.endSessionEndpoint, configuration.tokenEndpoint, configuration.jwksUri]) {
    const url = new URL(value);
    if (!allowedOidcUrl(url)) throw new Error("OIDC URLs must use HTTPS outside local development");
  }
  const controlApi = new URL(configuration.controlApiUrl);
  const privateControlApi = controlApi.origin === "http://wasalx-api:3001";
  if ((!allowedOidcUrl(controlApi) && !privateControlApi) || controlApi.username || controlApi.password || controlApi.pathname !== "/" || controlApi.search || controlApi.hash) {
    throw new Error("CONTROL_API_URL must be an HTTPS origin or the private control service");
  }
  const redirect = new URL(configuration.redirectUri);
  if (redirect.origin !== portalPublicOrigin() || redirect.pathname !== "/auth/callback" || redirect.search || redirect.hash) {
    throw new Error("OIDC_REDIRECT_URI must be the portal callback URL");
  }
  return configuration;
}

export async function createOidcTransaction(input: {
  returnTo?: string;
  tenantId?: string;
  stepUp?: "privileged" | "required_mfa";
}) {
  const verifier = randomToken(64);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const transaction: OidcTransaction = {
    state: randomToken(32),
    nonce: randomToken(32),
    verifier,
    returnTo: safeReturnPath(input.returnTo),
    requestedTenantId: validUuid(input.tenantId) ? input.tenantId : undefined,
    stepUp: input.stepUp,
    createdAt: Date.now(),
  };
  return { transaction, challenge: base64url(new Uint8Array(digest)) };
}

export function authorizationUrl(
  transaction: OidcTransaction,
  challenge: string,
  locale: Locale = "en",
) {
  const config = oidcConfiguration();
  const url = new URL(config.authorizationEndpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "openid profile email",
    redirect_uri: config.redirectUri,
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ui_locales: locale,
  }).toString();
  if (transaction.stepUp === "privileged" || transaction.stepUp === "required_mfa") {
    const acrValues = required("OIDC_PRIVILEGED_ACR_VALUES").trim();
    if (!acrValues) throw new Error("OIDC_PRIVILEGED_ACR_VALUES is required");
    if (transaction.stepUp === "privileged") {
      url.searchParams.set("prompt", "login");
      url.searchParams.set("max_age", "0");
    }
    url.searchParams.set("acr_values", acrValues);
  }
  return url;
}

export function oidcLogoutUrl(returnTo: string | null | undefined) {
  const config=oidcConfiguration();
  const postLogout=new URL(safeReturnPath(returnTo),portalPublicOrigin());
  postLogout.hash="";
  const url=new URL(config.endSessionEndpoint);
  url.searchParams.set("client_id",config.clientId);
  url.searchParams.set("post_logout_redirect_uri",postLogout.toString());
  return url;
}

export function oidcSessionBinding(payload: JWTPayload): OidcSessionBinding {
  const config = oidcConfiguration();
  const binding = { issuer: config.issuer, clientId: config.clientId, sid: payload.sid };
  assertOidcSessionBinding(binding);
  return binding;
}

export class OidcLogoutError extends Error {
  readonly status: number;
  constructor(status = 400) {
    super("The logout request could not be verified");
    this.status = status;
  }
}
const logoutJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function verifyOidcLogoutToken(token: string): Promise<OidcSessionBinding> {
  if (token.length > 32_768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) throw new OidcLogoutError();
  const config = oidcConfiguration();
  let jwks = logoutJwks.get(config.jwksUri);
  if (!jwks) { jwks = createRemoteJWKSet(new URL(config.jwksUri), { timeoutDuration: 5_000 }); logoutJwks.set(config.jwksUri, jwks); }
  try {
    const { payload, protectedHeader } = await jwtVerify(token, jwks, {
      issuer: config.issuer, audience: config.clientId, algorithms: ["RS256", "ES256"],
      clockTolerance: 5, typ: "logout+jwt", requiredClaims: ["iss", "aud", "iat", "exp", "jti", "sid", "events"],
    });
    const now = Math.floor(Date.now() / 1_000);
    const event = (payload.events as Record<string, unknown> | undefined)?.["http://schemas.openid.net/event/backchannel-logout"];
    const audience = Array.isArray(payload.aud) && payload.aud.length === 1 ? payload.aud[0] : payload.aud;
    if (protectedHeader.typ !== "logout+jwt" || audience !== config.clientId ||
      !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
      payload.iat! > now + 5 || now - payload.iat! > 125 || payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 125 ||
      typeof payload.jti !== "string" || payload.jti.length < 1 || payload.jti.length > 1_024 ||
      Object.hasOwn(payload, "nonce") || !event || typeof event !== "object" || Array.isArray(event)) throw new OidcLogoutError();
    return oidcSessionBinding(payload);
  } catch (error) {
    if (error instanceof OidcLogoutError) throw error;
    const unavailable = error instanceof errors.JWKSTimeout ||
      error instanceof errors.JWKSInvalid || error instanceof errors.JWKInvalid || error instanceof TypeError ||
      (error instanceof DOMException && error.name === "TimeoutError") ||
      (error instanceof errors.JOSEError && error.constructor === errors.JOSEError);
    throw new OidcLogoutError(unavailable ? 503 : 400);
  }
}

export async function completeOidcLogin(input: {
  code: string;
  transaction: OidcTransaction;
}) {
  const config = oidcConfiguration();
  if (Date.now() - input.transaction.createdAt > OIDC_TRANSACTION_MAX_AGE_SECONDS * 1_000)
    throw new OidcLoginError("expired","The sign-in request expired");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: input.code,
    redirect_uri: config.redirectUri,
    code_verifier: input.transaction.verifier,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);
  const tokens = await exchangeTokens(config.tokenEndpoint, body);
  if (!tokens.id_token)
    throw new OidcLoginError(
      "identity",
      "The identity provider did not return an ID token",
    );
  let verified;
  try{
    verified = await jwtVerify(
      tokens.id_token,
      createRemoteJWKSet(new URL(config.jwksUri)),
      {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ["RS256", "ES256"],
        clockTolerance: 5,
      },
    );
  }catch(error){
    const unavailable=error instanceof errors.JWKSTimeout||error instanceof TypeError||(error instanceof DOMException&&error.name==="TimeoutError")||(error instanceof errors.JOSEError&&error.constructor===errors.JOSEError);
    throw new OidcLoginError(unavailable?"unavailable":"identity",unavailable?"Identity verification is temporarily unavailable":"The identity token could not be verified",unavailable?503:401);
  }
  if (
    verified.payload.nonce !== input.transaction.nonce ||
    !verified.payload.sub
  )
    throw new OidcLoginError("identity","OIDC nonce validation failed");
  if (
    Array.isArray(verified.payload.aud) &&
    verified.payload.aud.length > 1 &&
    verified.payload.azp !== config.clientId
  )
    throw new OidcLoginError("identity","OIDC authorized-party validation failed");
  let oidcBinding: OidcSessionBinding;
  try { oidcBinding = oidcSessionBinding(verified.payload); }
  catch { throw new OidcLoginError("identity", "The identity session could not be verified"); }
  if (input.transaction.stepUp === "privileged") {
    try{assertPrivilegedOidcClaims(verified.payload)}catch{throw new OidcLoginError("identity","The identity provider did not return the required authentication evidence",403)}
  } else if (input.transaction.stepUp === "required_mfa") {
    try{assertRequiredMfaOidcClaims(verified.payload)}catch{throw new OidcLoginError("identity","The identity provider did not return the required authentication evidence",403)}
  }
  const discovery = await discoverOidcMemberships(tokens.access_token!);
  if (discovery.subject !== verified.payload.sub)
    throw new OidcLoginError("identity","OIDC token subject validation failed");
  const selected = input.transaction.requestedTenantId
    ? discovery.tenants.find(
        (tenant) => tenant.id === input.transaction.requestedTenantId,
      )
    : discovery.tenants[0];
  if (!selected)
    throw new OidcLoginError(
      "membership",
      "The requested workspace is not available to this account",
      403,
    );
  if(selected.mfaRequiredRoles.includes(selected.role)&&!hasMfaClaims(verified.payload)){
    throw new PortalMfaRequiredError(selected.id);
  }
  const now = Math.floor(Date.now() / 1000);
  const sessionTimeoutSeconds=Math.min(Math.max(Number(selected.sessionTimeoutMinutes),15),1440)*60;
  return {
    version: 1,
    oidcBinding,
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token,
    expiresAt: tokenExpiry(now, tokens.expires_in),
    subject: discovery.subject,
    userId: discovery.user.id,
    email: discovery.user.email,
    displayName: discovery.user.display_name,
    tenantId: selected.id,
    tenantName: selected.name,
    tenantSlug: selected.slug,
    role: selected.role,
    authenticatedAt:
      typeof verified.payload.auth_time === "number"
        ? verified.payload.auth_time
        : undefined,
    authenticationMethods: Array.isArray(verified.payload.amr)
      ? verified.payload.amr.filter(
          (method): method is string => typeof method === "string",
        )
      : [],
    authenticationContext:
      typeof verified.payload.acr === "string" ? verified.payload.acr : undefined,
    csrfToken: randomToken(32),
    createdAt: now,
    sessionTimeoutSeconds,
    absoluteExpiresAt: now + sessionTimeoutSeconds,
  } satisfies PortalSession;
}

export async function refreshOidcSession(session: PortalSession) {
  if (!session.refreshToken)
    throw new PortalSessionError("The portal session has expired");
  const config = oidcConfiguration();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: session.refreshToken,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);
  const tokens = await exchangeTokens(config.tokenEndpoint, body);
  const discovery = await discoverOidcMemberships(tokens.access_token!);
  if (discovery.subject !== session.subject)
    throw new PortalSessionError(
      "The refreshed identity no longer matches this session",
    );
  const tenant = discovery.tenants.find((item) => item.id === session.tenantId);
  if (!tenant)
    throw new PortalSessionError(
      "Access to this workspace has been revoked",
      403,
    );
  if(tenant.mfaRequiredRoles.includes(tenant.role)&&!hasMfaSession(session))throw new PortalSessionError("Multi-factor authentication is required",403);
  const now = Math.floor(Date.now() / 1000);
  const sessionTimeoutSeconds=Math.min(Math.max(Number(tenant.sessionTimeoutMinutes),15),1440)*60;
  return {
    ...session,
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token ?? session.refreshToken,
    expiresAt: tokenExpiry(now, tokens.expires_in),
    userId: discovery.user.id,
    email: discovery.user.email,
    displayName: discovery.user.display_name,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    role: tenant.role,
    sessionTimeoutSeconds,
    absoluteExpiresAt:Math.min(session.absoluteExpiresAt,now+sessionTimeoutSeconds),
  } satisfies PortalSession;
}

export function validOidcTransaction(value: OidcTransaction) {
  const age = Date.now() - Number(value?.createdAt);
  return Boolean(
    validOidcState(value?.state) &&
      /^[A-Za-z0-9_-]{43}$/u.test(value.nonce) &&
      /^[A-Za-z0-9_-]{86}$/u.test(value.verifier) &&
      typeof value?.returnTo === "string" &&
      safeReturnPath(value.returnTo) === value.returnTo &&
      (value.requestedTenantId === undefined || validUuid(value.requestedTenantId)) &&
      (value.stepUp === undefined || value.stepUp === "privileged" || value.stepUp === "required_mfa") &&
      Number.isFinite(value.createdAt) && age >= 0 && age <= OIDC_TRANSACTION_MAX_AGE_SECONDS * 1_000,
  );
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
async function exchangeTokens(endpoint: string, body: URLSearchParams) {
  let response:Response;
  try{
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  }catch{throw new OidcLoginError("unavailable","The identity provider is temporarily unavailable",503)}
  let tokens: TokenResponse;
  try { tokens = await readBoundedJson<TokenResponse>(response); }
  catch { throw new OidcLoginError("unavailable","OIDC token exchange returned an invalid response",503); }
  if (!response.ok || tokens.error || !tokens.access_token)
    throw new OidcLoginError(
      tokens.error==="invalid_grant"?"expired":response.status===429||response.status>=500?"unavailable":"identity",
      tokens.error_description ?? "OIDC token exchange failed",
      response.status===429||response.status>=500?503:401,
    );
  return tokens;
}
export async function discoverOidcMemberships(accessToken: string) {
  const config = oidcConfiguration();
  let response:Response;
  try{
    response = await fetch(`${config.controlApiUrl}/v1/session`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  }catch{throw new OidcLoginError("unavailable","Workspace discovery is temporarily unavailable",503)}
  let discovery: SessionDiscovery | { message?: string };
  try { discovery = await readBoundedJson<SessionDiscovery | { message?: string }>(response); }
  catch { throw new OidcLoginError("unavailable","Workspace discovery returned an invalid response",503); }
  if(response.status===429||response.status>=500)throw new OidcLoginError("unavailable","Workspace discovery is temporarily unavailable",503);
  if(!response.ok&&response.status!==401&&response.status!==403)throw new OidcLoginError("unavailable","Workspace discovery is temporarily unavailable",503);
  if (!response.ok || !("tenants" in discovery) || !discovery.tenants.length){
    const reason=response.status===401?"identity":"membership";
    throw new OidcLoginError(
      reason,
      "message" in discovery && discovery.message
        ? discovery.message
        : "No active WasalX tenant membership was found",
      reason==="membership"?403:401,
    );
  }
  return discovery;
}
function allowedOidcUrl(url: URL) {
  const local = process.env.NODE_ENV !== "production" || process.env.WASALX_ENVIRONMENT === "local-full";
  return (url.protocol === "https:" || (local && url.protocol === "http:")) && !url.username && !url.password && !url.hash;
}
function tokenExpiry(now: number, value: number | undefined) {
  return now + Math.min(Math.max(Number(value ?? 300), 60), 86_400);
}
function randomToken(bytes: number) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
function base64url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}
function validUuid(value: string | undefined) {
  return (
    value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function assertPrivilegedOidcClaims(payload: JWTPayload) {
  const now = Math.floor(Date.now() / 1_000);
  if (
    typeof payload.auth_time !== "number" ||
    !Number.isSafeInteger(payload.auth_time) ||
    payload.auth_time > now + 5 ||
    now - payload.auth_time > 60
  ) {
    throw new PortalSessionError(
      "The identity provider did not perform fresh authentication",
      403,
    );
  }
  const methods = new Set(
    (Array.isArray(payload.amr) ? payload.amr : [])
      .filter((method): method is string => typeof method === "string")
      .map((method) => method.trim().toLowerCase()),
  );
  const acceptedMethods = configuredValues(
    process.env.OIDC_PRIVILEGED_MFA_AMR_VALUES,
    ["mfa"],
  );
  const context = typeof payload.acr === "string" ? payload.acr.trim() : "";
  const acceptedContexts = configuredValues(
    process.env.OIDC_PRIVILEGED_ACR_VALUES,
    [],
  );
  if (
    !acceptedMethods.some((method) => methods.has(method)) &&
    (!context || !acceptedContexts.includes(context))
  ) {
    throw new PortalSessionError(
      "The identity provider did not return authoritative MFA evidence",
      403,
    );
  }
}

export function assertRequiredMfaOidcClaims(payload: JWTPayload) {
  if (!hasMfaClaims(payload)) {
    throw new PortalSessionError("The identity provider did not return authoritative MFA evidence", 403);
  }
}

export class PortalMfaRequiredError extends PortalSessionError{readonly tenantId:string;constructor(tenantId:string){super("Multi-factor authentication is required",403);this.name="PortalMfaRequiredError";this.tenantId=tenantId}}

function hasMfaClaims(payload:JWTPayload){return hasMfaEvidence(Array.isArray(payload.amr)?payload.amr.filter((value):value is string=>typeof value==="string"):[],typeof payload.acr==="string"?payload.acr:undefined)}
function hasMfaSession(session:PortalSession){return hasMfaEvidence(session.authenticationMethods??[],session.authenticationContext)}
function hasMfaEvidence(methods:string[],context?:string){const acceptedMethods=configuredValues(process.env.OIDC_PRIVILEGED_MFA_AMR_VALUES,["mfa"]);const normalized=new Set(methods.map(value=>value.trim().toLowerCase()));if(acceptedMethods.some(value=>normalized.has(value)))return true;return Boolean(context&&configuredValues(process.env.OIDC_PRIVILEGED_ACR_VALUES,[]).includes(context.trim()))}

function configuredValues(raw: string | undefined, fallback: string[]) {
  return [
    ...new Set(
      (raw === undefined ? fallback : raw.split(/[\s,]+/u))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}
