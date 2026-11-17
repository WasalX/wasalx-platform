import type { TenantRole } from "./request-auth.ts";
import { oidcTransactionCookieName } from "./oidc-transaction-cookies.ts";

export type PortalSession = {
  version: 1;
  // Optional in stored legacy JSON; authorization requires a verified binding.
  oidcBinding?: OidcSessionBinding;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  subject: string;
  userId: string;
  email: string;
  displayName: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: TenantRole;
  authenticatedAt?: number;
  authenticationMethods?: string[];
  authenticationContext?: string;
  csrfToken: string;
  createdAt: number;
  sessionTimeoutSeconds: number;
  absoluteExpiresAt: number;
};

export type OidcSessionBinding = { issuer: string; clientId: string; sid: string };
export function assertOidcSessionBinding(value: unknown): asserts value is OidcSessionBinding {
  const binding = value as OidcSessionBinding | undefined;
  if (!binding || [binding.issuer, binding.clientId, binding.sid].some(value =>
    typeof value !== "string" || value.length < 1 || value.length > 1_024 ||
    [...value].some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)))
    throw new PortalSessionError("The identity session is unavailable");
}

export class PortalSessionError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "PortalSessionError";
    this.status = status;
  }
}

export function sessionCookieName() {
  return cookieSecure() ? "__Host-wasalx_session" : "wasalx_session";
}
export function transactionCookieName(state: string) {
  return oidcTransactionCookieName("wasalx_oidc", state, cookieSecure());
}
export function cookieSecure() {
  return process.env.PORTAL_COOKIE_SECURE !== "false";
}
export function portalPublicOrigin() {
  const value = process.env.PORTAL_PUBLIC_ORIGIN;
  if (!value) throw new Error("PORTAL_PUBLIC_ORIGIN is required");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "PORTAL_PUBLIC_ORIGIN must be an HTTP(S) origin without a path",
    );
  return url.origin;
}

export async function sealPortalValue(value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await sessionKey(),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
}
export async function unsealPortalValue<T>(sealed: string): Promise<T> {
  try {
    const [ivValue, ciphertextValue, ...rest] = sealed.split(".");
    if (!ivValue || !ciphertextValue || rest.length) throw new Error("invalid");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(ivValue) },
      await sessionKey(),
      decode(ciphertextValue),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    throw new PortalSessionError("The portal session is invalid or expired");
  }
}

export async function getPortalSessionFromRequest(request: Request) {
  const value = parseCookies(request.headers.get("cookie") ?? "").get(
    sessionCookieName(),
  );
  if (!value) throw new PortalSessionError("Sign in is required");
  const { loadStoredPortalSession } = await import("./portal-session-store.ts");
  return assertPortalShellSession(request,await loadStoredPortalSession(value));
}

export function assertPortalShellSession(request:Request,session:PortalSession){
  const tenantId=request.headers.get("x-wasalx-shell-tenant-id");
  const role=request.headers.get("x-wasalx-shell-role");
  if((tenantId!==null&&tenantId!==session.tenantId)||(role!==null&&role!==session.role))
    throw new PortalSessionError("The signed-in workspace changed");
  return session;
}

export function assertPortalSession(
  session: PortalSession,
  options: { allowExpiredAccessToken?: boolean } = {},
) {
  assertOidcSessionBinding(session.oidcBinding);
  if (
    session.version !== 1 ||
    !session.accessToken ||
    !session.subject ||
    !session.tenantId ||
    !session.userId ||
    !session.email ||
    !session.role ||
    !session.csrfToken ||
    !Number.isSafeInteger(session.createdAt) ||
    !Number.isSafeInteger(session.expiresAt) ||
    !Number.isInteger(session.sessionTimeoutSeconds) ||
    session.sessionTimeoutSeconds < 15 * 60 ||
    session.sessionTimeoutSeconds > 24 * 60 * 60 ||
    !Number.isSafeInteger(session.absoluteExpiresAt) ||
    session.absoluteExpiresAt <= session.createdAt ||
    session.absoluteExpiresAt - session.createdAt > 86_400
  )
    throw new PortalSessionError("The portal session is incomplete");
  const now = Math.floor(Date.now() / 1000);
  if (
    session.createdAt > now + 5 ||
    session.absoluteExpiresAt <= now ||
    (!options.allowExpiredAccessToken && session.expiresAt <= now + 15)
  )
    throw new PortalSessionError("The portal session has expired");
  return session;
}
export function validateSession(session: PortalSession) {
  return assertPortalSession(session);
}

export function finalizePortalLoginSession(
  session: PortalSession,
  previous: PortalSession | undefined,
  stepUp: "privileged" | "required_mfa" | undefined,
) {
  if (stepUp !== "privileged") return session;
  if (
    !previous ||
    previous.subject !== session.subject ||
    previous.tenantId !== session.tenantId
  )
    throw new PortalSessionError(
      "The privileged session no longer matches the signed-in workspace",
    );
  return { ...session, csrfToken: previous.csrfToken } satisfies PortalSession;
}

export function parseCookies(header: string) {
  const result = new Map<string, string>();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !result.has(name)) result.set(name, value);
  }
  return result;
}

export function safeReturnPath(value: string | null | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//") || value.length > 512) return "/app";
  try {
    const url = new URL(value, "https://portal.invalid");
    if (url.origin !== "https://portal.invalid") return "/app";
    if (url.pathname.startsWith("/auth/")) return "/app";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/app";
  }
}

async function sessionKey() {
  const secret = process.env.PORTAL_SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error(
      "PORTAL_SESSION_SECRET must contain at least 32 characters",
    );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
function encode(value: Uint8Array) {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}
function decode(value: string) {
  const normalized = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
