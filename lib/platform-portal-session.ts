import { oidcTransactionCookieName } from "./oidc-transaction-cookies.ts";

export type PlatformPortalSession = {
  version: 1;
  accessToken: string;
  subject: string;
  email: string;
  displayName: string;
  authenticatedAt: number;
  expiresAt: number;
  csrfToken: string;
};

export class PlatformPortalSessionError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "PlatformPortalSessionError";
    this.status = status;
  }
}

export function platformSessionCookieName() {
  return secureCookies()
    ? "__Host-wasalx_platform_session"
    : "wasalx_platform_session";
}

export function platformTransactionCookieName(state: string) {
  return oidcTransactionCookieName("wasalx_platform_oidc", state, secureCookies());
}

export function secureCookies() {
  return process.env.PORTAL_COOKIE_SECURE !== "false";
}

export function platformPortalOrigin() {
  const raw = process.env.PORTAL_PUBLIC_ORIGIN;
  if (!raw) throw new Error("PORTAL_PUBLIC_ORIGIN is required");
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("PORTAL_PUBLIC_ORIGIN must be an HTTP(S) origin");
  }
  return url.origin;
}

export function assertPlatformPortalSession(session: PlatformPortalSession) {
  const now = Math.floor(Date.now() / 1_000);
  if (
    session.version !== 1 ||
    !session.accessToken ||
    !session.subject ||
    !session.email ||
    !session.displayName ||
    !session.csrfToken ||
    !Number.isInteger(session.authenticatedAt) ||
    !Number.isInteger(session.expiresAt) ||
    session.expiresAt <= now + 10
  ) {
    throw new PlatformPortalSessionError(
      "The platform operator session is invalid or expired",
    );
  }
  return session;
}

export async function sealPlatformValue(value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await sessionKey(),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
}

export async function unsealPlatformValue<T>(sealed: string) {
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
    throw new PlatformPortalSessionError(
      "The platform sign-in request is invalid or expired",
    );
  }
}

export function parsePlatformCookies(header: string) {
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

export function safePlatformReturnPath(value: string | null | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//") || value.length > 512) {
    return "/platform";
  }
  try {
    const url = new URL(value, "https://portal.invalid");
    if (
      url.origin !== "https://portal.invalid" ||
      (url.pathname !== "/platform" && !url.pathname.startsWith("/platform/")) ||
      url.pathname.startsWith("/platform/auth/")
    ) {
      return "/platform";
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/platform";
  }
}

async function sessionKey() {
  const secret = process.env.PLATFORM_PORTAL_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "PLATFORM_PORTAL_SESSION_SECRET must contain at least 32 characters",
    );
  }
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
    .replace(/=+$/gu, "");
}

function decode(value: string) {
  const normalized = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
