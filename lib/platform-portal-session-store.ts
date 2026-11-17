import Redis from "ioredis";
import { validatedRedisUrl } from "../packages/core/src/redis-security.ts";
import {
  assertPlatformPortalSession,
  PlatformPortalSessionError,
  type PlatformPortalSession,
} from "./platform-portal-session.ts";

const sessionPrefix = "wasalx:platform-portal:session:";
let redis: Redis | undefined;

export async function createStoredPlatformSession(
  session: PlatformPortalSession,
) {
  assertPlatformPortalSession(session);
  const id = randomToken(32);
  const maxAge = remainingLifetime(session);
  await client().set(`${sessionPrefix}${id}`, JSON.stringify(session), "EX", maxAge);
  return { id, maxAge };
}

export async function loadStoredPlatformSession(id: string) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(id)) {
    throw new PlatformPortalSessionError(
      "The platform operator session is invalid or expired",
    );
  }
  const value = await client().get(`${sessionPrefix}${id}`);
  if (!value) {
    throw new PlatformPortalSessionError(
      "The platform operator session is invalid or expired",
    );
  }
  try {
    const session = assertPlatformPortalSession(
      JSON.parse(value) as PlatformPortalSession,
    );
    await client().expire(`${sessionPrefix}${id}`, remainingLifetime(session));
    return session;
  } catch (error) {
    if (error instanceof PlatformPortalSessionError) throw error;
    throw new PlatformPortalSessionError(
      "The platform operator session is invalid or expired",
    );
  }
}

export async function deleteStoredPlatformSession(id: string | undefined) {
  if (id && /^[A-Za-z0-9_-]{43}$/u.test(id)) {
    await client().del(`${sessionPrefix}${id}`);
  }
}

function remainingLifetime(session: PlatformPortalSession) {
  const lifetime = session.expiresAt - Math.floor(Date.now() / 1_000);
  if (lifetime < 1) {
    throw new PlatformPortalSessionError(
      "The platform operator session is invalid or expired",
    );
  }
  return Math.min(lifetime, 15 * 60);
}

function client() {
  if (!redis) {
    const url =
      process.env.PLATFORM_PORTAL_SESSION_REDIS_URL ??
      process.env.PORTAL_SESSION_REDIS_URL ??
      process.env.REDIS_URL;
    if (!url) {
      throw new Error(
        "PLATFORM_PORTAL_SESSION_REDIS_URL or REDIS_URL is required",
      );
    }
    redis = new Redis(validatedRedisUrl(url, process.env, "PLATFORM_PORTAL_SESSION_REDIS_URL"), {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false,
    });
  }
  return redis;
}

function randomToken(bytes: number) {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/gu, "");
}
