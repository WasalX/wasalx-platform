import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Locale } from "./i18n/locales.ts";
import { readBoundedJson } from "./bounded-json.ts";
import { OIDC_TRANSACTION_MAX_AGE_SECONDS, validOidcState } from "./oidc-transaction-cookies.ts";
import { portalPublicOrigin } from "./portal-session.ts";
import {
  PlatformPortalSessionError,
  safePlatformReturnPath,
  type PlatformPortalSession,
} from "./platform-portal-session.ts";

export type PlatformOidcTransaction = {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  createdAt: number;
};

type TokenResponse = {
  access_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export function platformOidcConfiguration() {
  const issuer = required("PLATFORM_OPERATOR_OIDC_ISSUER").replace(/\/+$/u, "");
  const clientId = required("PLATFORM_OPERATOR_OIDC_CLIENT_ID");
  const configuration = {
    issuer,
    clientId,
    clientSecret: process.env.PLATFORM_OPERATOR_OIDC_CLIENT_SECRET,
    audience: required("PLATFORM_OPERATOR_OIDC_AUDIENCE"),
    authorizationEndpoint:
      process.env.PLATFORM_OPERATOR_OIDC_AUTHORIZATION_ENDPOINT ??
      `${issuer}/protocol/openid-connect/auth`,
    endSessionEndpoint:
      process.env.PLATFORM_OPERATOR_OIDC_END_SESSION_ENDPOINT ??
      `${issuer}/protocol/openid-connect/logout`,
    tokenEndpoint:
      process.env.PLATFORM_OPERATOR_OIDC_TOKEN_ENDPOINT ??
      `${issuer}/protocol/openid-connect/token`,
    jwksUri:
      process.env.PLATFORM_OPERATOR_OIDC_JWKS_URI ??
      `${issuer}/protocol/openid-connect/certs`,
    redirectUri: required("PLATFORM_OPERATOR_OIDC_REDIRECT_URI"),
    maxAuthenticationAge: boundedInteger(
      process.env.PLATFORM_OPERATOR_MAX_AUTH_AGE_SECONDS,
      900,
      60,
      900,
    ),
  };
  if (
    clientId === process.env.OIDC_CLIENT_ID ||
    configuration.audience === process.env.OIDC_AUDIENCE
  ) {
    throw new Error("Platform OIDC must not reuse the tenant client or audience");
  }
  for (const value of [
    configuration.issuer,
    configuration.authorizationEndpoint,
    configuration.endSessionEndpoint,
    configuration.tokenEndpoint,
    configuration.jwksUri,
    configuration.redirectUri,
  ]) {
    const url = new URL(value);
    if (!allowedPlatformOidcUrl(url)) {
      throw new Error("Platform OIDC URLs must use HTTPS outside local development");
    }
  }
  const redirect = new URL(configuration.redirectUri);
  if (redirect.origin !== portalPublicOrigin() || redirect.pathname !== "/platform/auth/callback" || redirect.search || redirect.hash) {
    throw new Error("PLATFORM_OPERATOR_OIDC_REDIRECT_URI must be the platform callback URL");
  }
  return configuration;
}

export async function createPlatformOidcTransaction(returnTo?: string) {
  const verifier = randomToken(64);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const transaction: PlatformOidcTransaction = {
    state: randomToken(32),
    nonce: randomToken(32),
    verifier,
    returnTo: safePlatformReturnPath(returnTo),
    createdAt: Date.now(),
  };
  return { transaction, challenge: base64url(new Uint8Array(digest)) };
}

export function platformAuthorizationUrl(
  transaction: PlatformOidcTransaction,
  challenge: string,
  locale: Locale = "en",
) {
  const configuration = platformOidcConfiguration();
  const url = new URL(configuration.authorizationEndpoint);
  const parameters: Record<string, string> = {
    client_id: configuration.clientId,
    response_type: "code",
    scope: "openid profile email",
    redirect_uri: configuration.redirectUri,
    state: transaction.state,
    nonce: transaction.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "login",
    max_age: "0",
    ui_locales: locale,
  };
  const acrValues = process.env.PLATFORM_OPERATOR_OIDC_ACR_VALUES?.trim();
  if (acrValues) parameters.acr_values = acrValues;
  url.search = new URLSearchParams(parameters).toString();
  return url;
}

export function platformOidcLogoutUrl(returnTo:string|null|undefined){
  const configuration=platformOidcConfiguration();
  const postLogout=new URL(safePlatformReturnPath(returnTo),portalPublicOrigin());
  postLogout.hash="";
  const url=new URL(configuration.endSessionEndpoint);
  url.searchParams.set("client_id",configuration.clientId);
  url.searchParams.set("post_logout_redirect_uri",postLogout.toString());
  return url;
}

export async function completePlatformOidcLogin(input: {
  code: string;
  transaction: PlatformOidcTransaction;
}) {
  const configuration = platformOidcConfiguration();
  if (!validPlatformOidcTransaction(input.transaction)) {
    throw new PlatformPortalSessionError("The platform sign-in request expired");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: configuration.clientId,
    code: input.code,
    redirect_uri: configuration.redirectUri,
    code_verifier: input.transaction.verifier,
  });
  if (configuration.clientSecret) {
    body.set("client_secret", configuration.clientSecret);
  }
  const response = await fetch(configuration.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  let tokens: TokenResponse;
  try { tokens = await readBoundedJson<TokenResponse>(response); }
  catch { throw new PlatformPortalSessionError("Platform OIDC token exchange returned an invalid response"); }
  if (
    !response.ok ||
    tokens.error ||
    !tokens.access_token ||
    !tokens.id_token ||
    tokens.token_type?.toLowerCase() !== "bearer"
  ) {
    throw new PlatformPortalSessionError(
      tokens.error_description ?? "Platform OIDC token exchange failed",
    );
  }
  const jwks = createRemoteJWKSet(new URL(configuration.jwksUri));
  const [{ payload: identity }, { payload: access }] = await Promise.all([
    jwtVerify(tokens.id_token, jwks, {
      issuer: configuration.issuer,
      audience: configuration.clientId,
      algorithms: ["RS256", "ES256"],
      clockTolerance: 5,
    }),
    jwtVerify(tokens.access_token, jwks, {
      issuer: configuration.issuer,
      audience: configuration.audience,
      algorithms: ["RS256", "ES256"],
      clockTolerance: 5,
    }),
  ]);
  if (
    identity.nonce !== input.transaction.nonce ||
    !identity.sub ||
    access.sub !== identity.sub
  ) {
    throw new PlatformPortalSessionError("Platform OIDC identity validation failed");
  }
  validateAuthorizedParty(identity, configuration.clientId);
  const claims = platformClaims(access, configuration.maxAuthenticationAge);
  const now = Math.floor(Date.now() / 1_000);
  const accessExpiry = Number(access.exp ?? now + 60);
  return {
    version: 1,
    accessToken: tokens.access_token,
    subject: claims.subject,
    email: claims.email,
    displayName: claims.displayName,
    authenticatedAt: claims.authenticatedAt,
    expiresAt: Math.min(
      accessExpiry,
      claims.authenticatedAt + configuration.maxAuthenticationAge,
      now + 15 * 60,
    ),
    csrfToken: randomToken(32),
  } satisfies PlatformPortalSession;
}

export function validPlatformOidcTransaction(value: PlatformOidcTransaction) {
  const age = Date.now() - Number(value?.createdAt);
  return Boolean(
    validOidcState(value?.state) &&
      /^[A-Za-z0-9_-]{43}$/u.test(value.nonce) &&
      /^[A-Za-z0-9_-]{86}$/u.test(value.verifier) &&
      typeof value?.returnTo === "string" &&
      safePlatformReturnPath(value.returnTo) === value.returnTo &&
      Number.isFinite(value.createdAt) && age >= 0 && age <= OIDC_TRANSACTION_MAX_AGE_SECONDS * 1_000,
  );
}

export function platformClaims(payload: JWTPayload, maxAge: number) {
  const now = Math.floor(Date.now() / 1_000);
  const realmAccess = payload.realm_access as { roles?: unknown } | undefined;
  const realmRoles = Array.isArray(realmAccess?.roles)
    ? realmAccess.roles.filter((role): role is string => typeof role === "string")
    : [];
  const methods = Array.isArray(payload.amr)
    ? payload.amr.filter((method): method is string => typeof method === "string")
    : [];
  if (
    payload.platform_role !== "platform_operator" &&
    !realmRoles.includes("wasalx-platform-operator")
  ) {
    throw new PlatformPortalSessionError("Platform operator role is required", 403);
  }
  if (!methods.some((method) => ["mfa", "otp", "hwk"].includes(method))) {
    throw new PlatformPortalSessionError("Platform operator MFA is required", 403);
  }
  if (
    typeof payload.auth_time !== "number" ||
    payload.auth_time > now + 5 ||
    now - payload.auth_time > maxAge
  ) {
    throw new PlatformPortalSessionError(
      "Recent platform operator authentication is required",
      403,
    );
  }
  if (
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.email !== "string" ||
    !payload.email
  ) {
    throw new PlatformPortalSessionError("Platform operator identity is incomplete");
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

function validateAuthorizedParty(payload: JWTPayload, clientId: string) {
  if (
    Array.isArray(payload.aud) &&
    payload.aud.length > 1 &&
    payload.azp !== clientId
  ) {
    throw new PlatformPortalSessionError(
      "Platform OIDC authorized-party validation failed",
    );
  }
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
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
      `Platform authentication age must be between ${minimum} and ${maximum} seconds`,
    );
  }
  return value;
}

function allowedPlatformOidcUrl(url: URL) {
  const explicitlyLocalRuntime =
    process.env.NODE_ENV !== "production" ||
    process.env.WASALX_ENVIRONMENT === "local-full";
  const localHttp =
    explicitlyLocalRuntime &&
    process.env.ALLOW_INSECURE_PLATFORM_OPERATOR_OIDC === "true";
  return (
    (url.protocol === "https:" || (url.protocol === "http:" && localHttp)) &&
    !url.username &&
    !url.password &&
    !url.hash
  );
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
