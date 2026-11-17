import Redis from "ioredis";
import { validatedRedisUrl } from "../packages/core/src/redis-security.ts";
import { oidcConfiguration, refreshOidcSession } from "./oidc.ts";
import { PortalSessionError, assertOidcSessionBinding, assertPortalSession, type OidcSessionBinding, type PortalSession } from "./portal-session.ts";

const sessionPrefix = "wasalx:portal:session:";
const lockPrefix = "wasalx:portal:session-refresh:";
const logoutPrefix = "wasalx:portal:oidc-logout:";
const logoutRetentionSeconds = 86_400 + 125 + 5;
let redis: Redis | undefined;
type Stored = { raw: string; session: PortalSession; marker: string };

// Every admitting operation compares the same row and logout marker in Redis.
const loadScript = `
if redis.call('get',KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('exists',KEYS[3]) == 1 then redis.call('del',KEYS[1],KEYS[2]); return -1 end
redis.call('expire',KEYS[1],ARGV[2]); return 1`;
const createScript = `
if redis.call('exists',KEYS[2]) == 1 then return -1 end
if redis.call('set',KEYS[1],ARGV[1],'EX',ARGV[2],'NX') then return 1 end
return 0`;
const claimScript = `
if redis.call('get',KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('exists',KEYS[3]) == 1 then redis.call('del',KEYS[1],KEYS[2]); return -1 end
if redis.call('set',KEYS[2],ARGV[2],'EX',ARGV[3],'NX') then return 1 end
return 2`;
const commitScript = `
if redis.call('exists',KEYS[3]) == 1 then
 if redis.call('get',KEYS[1]) == ARGV[1] and redis.call('get',KEYS[2]) == ARGV[2] then redis.call('del',KEYS[1],KEYS[2]) end
 return -1
end
if redis.call('get',KEYS[1]) == ARGV[3] then return 1 end
if redis.call('get',KEYS[1]) ~= ARGV[1] or redis.call('get',KEYS[2]) ~= ARGV[2] then return 0 end
redis.call('set',KEYS[1],ARGV[3],'EX',ARGV[4]); redis.call('del',KEYS[2]); return 1`;
const abandonScript = `
if redis.call('get',KEYS[1]) == ARGV[1] and redis.call('get',KEYS[2]) == ARGV[2] then return redis.call('del',KEYS[1],KEYS[2]) end
return 0`;
const invalidScript = `
if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1],KEYS[2]) end
return 0`;

export async function createStoredPortalSession(session: PortalSession) {
  assertPortalSession(session);
  const marker = await bindingKey(session.oidcBinding);
  const id = randomToken(32);
  const ttl = remainingLifetime(session);
  const result = await evaluate(createScript, [`${sessionPrefix}${id}`, marker], [JSON.stringify(session), Math.min(ttl, session.sessionTimeoutSeconds)]);
  if (result !== 1) throw new PortalSessionError("The identity session is no longer available");
  return { id, maxAge: ttl };
}

export async function loadStoredPortalSession(id: string): Promise<PortalSession> {
  assertSessionId(id);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stored = await read(id);
    if (!await admit(id, stored)) continue;
    if (stored.session.expiresAt <= Math.floor(Date.now() / 1_000) + 60) return refreshWithLock(id, stored);
    assertPortalSession(stored.session);
    return stored.session;
  }
  throw new PortalSessionError("The portal session changed; sign in again", 503);
}

export async function deleteStoredPortalSession(id: string | undefined) {
  if (id && /^[A-Za-z0-9_-]{43}$/u.test(id)) {
    // One Redis DEL is atomic; a pending grant cannot recreate this missing row.
    try { await client().del(`${sessionPrefix}${id}`, `${lockPrefix}${id}`); }
    catch { throw unavailable(); }
  }
}

export async function recordOidcLogout(binding: OidcSessionBinding) {
  const key = await bindingKey(binding);
  // Duplicate deliveries do not extend a tombstone's lifetime.
  try { await client().set(key, "1", "EX", logoutRetentionSeconds, "NX"); }
  catch { throw unavailable(); }
}

export async function portalSessionStoreReady() {
  try {
    return await Promise.race([
      client().ping().then((value) => value === "PONG"),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
  } catch { return false; }
}

async function refreshWithLock(id: string, current: Stored): Promise<PortalSession> {
  if (!current.session.refreshToken) throw new PortalSessionError("The portal session has expired");
  const owner = randomToken(16);
  const keys = [`${sessionPrefix}${id}`, `${lockPrefix}${id}`, current.marker];
  // A durable intent lasts until the ORIGINAL local expiry, not a renewable 10s lease.
  // An unknown Redis claim acknowledgement cannot authorize an HTTP grant.
  const acquired = await evaluate(claimScript, keys, [current.raw, owner, remainingLifetime(current.session)]);
  if (acquired === -1) throw new PortalSessionError("The identity session has ended");
  if (acquired === 1) {
    try {
      // Exactly one bounded HTTP exchange. Never replay after an unknown provider effect.
      const refreshed = await refreshOidcSession(current.session);
      assertPortalSession(refreshed);
      if (await bindingKey(refreshed.oidcBinding) !== current.marker ||
          refreshed.createdAt !== current.session.createdAt || refreshed.absoluteExpiresAt > current.session.absoluteExpiresAt)
        throw new PortalSessionError("The refreshed identity session changed");
      const committed = await evaluate(commitScript, keys, [current.raw, owner, JSON.stringify(refreshed),
        Math.min(refreshed.sessionTimeoutSeconds, remainingLifetime(refreshed))]);
      if (committed !== 1) throw new PortalSessionError("The identity session has ended");
      return refreshed;
    } catch (error) {
      // If cleanup is UNKNOWN the durable intent remains. Never unlock in finally.
      // A changed row/owner is never removed by this failed operation.
      try { await evaluate(abandonScript, keys.slice(0, 2), [current.raw, owner]); } catch { throw unavailable(); }
      if (error instanceof PortalSessionError) throw error;
      throw unavailable();
    }
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 75));
    const stored = await read(id);
    if (!await admit(id, stored)) continue;
    if (stored.session.expiresAt > current.session.expiresAt) { assertPortalSession(stored.session); return stored.session; }
  }
  // Still-valid cached evidence is allowed only after a fresh atomic marker check.
  const latest = await read(id);
  if (await admit(id, latest) && latest.session.expiresAt > Math.floor(Date.now() / 1_000) + 15) {
    assertPortalSession(latest.session); return latest.session;
  }
  throw new PortalSessionError("The portal session refresh is unresolved; sign in again");
}

async function read(id: string): Promise<Stored> {
  let raw: string | null;
  try { raw = await client().get(`${sessionPrefix}${id}`); } catch { throw unavailable(); }
  if (!raw) throw new PortalSessionError("The portal session is invalid or expired");
  try {
    const session = JSON.parse(raw) as PortalSession;
    assertPortalSession(session, { allowExpiredAccessToken: true });
    return { raw, session, marker: await bindingKey(session.oidcBinding) };
  } catch {
    // Only the rejected opaque row, including legacy no-SID rows; never a scan.
    await evaluate(invalidScript, [`${sessionPrefix}${id}`, `${lockPrefix}${id}`], [raw]);
    throw new PortalSessionError("The portal session is invalid or expired");
  }
}

async function admit(id: string, stored: Stored) {
  const status = await evaluate(loadScript, [`${sessionPrefix}${id}`, `${lockPrefix}${id}`, stored.marker],
    [stored.raw, Math.min(stored.session.sessionTimeoutSeconds, remainingLifetime(stored.session))]);
  if (status === -1) throw new PortalSessionError("The identity session has ended");
  return status === 1;
}
async function bindingKey(binding: unknown) {
  assertOidcSessionBinding(binding);
  const config = oidcConfiguration();
  if (binding.issuer !== config.issuer || binding.clientId !== config.clientId)
    throw new PortalSessionError("The identity session is not available to this portal");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([binding.issuer, binding.clientId, binding.sid])));
  return logoutPrefix + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
async function evaluate(script: string, keys: string[], args: Array<string | number>) {
  try { return Number(await client().eval(script, keys.length, ...keys, ...args)); }
  catch { throw unavailable(); }
}
function assertSessionId(id: string) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(id)) throw new PortalSessionError("The portal session is invalid or expired");
}
function remainingLifetime(session: PortalSession) {
  const ttl = session.absoluteExpiresAt - Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new PortalSessionError("The portal session has expired");
  return ttl;
}
function unavailable() { return new PortalSessionError("The portal session service is unavailable", 503); }
function client() {
  if (!redis) {
    const url = process.env.PORTAL_SESSION_REDIS_URL ?? process.env.REDIS_URL;
    if (!url) throw new Error("PORTAL_SESSION_REDIS_URL or REDIS_URL is required");
    redis = new Redis(validatedRedisUrl(url, process.env, "PORTAL_SESSION_REDIS_URL"), {
      maxRetriesPerRequest: 2, enableReadyCheck: true, lazyConnect: false,
    });
  }
  return redis;
}
function randomToken(bytes: number) {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
