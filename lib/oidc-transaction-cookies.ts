export const OIDC_TRANSACTION_MAX_AGE_SECONDS = 10 * 60;
export const OIDC_TRANSACTION_MAX_COOKIES = 4;

const OIDC_STATE = /^[A-Za-z0-9_-]{43}$/u;

export function validOidcState(value: unknown): value is string {
  return typeof value === "string" && OIDC_STATE.test(value);
}

export function oidcTransactionCookiePrefix(base: string, secure: boolean) {
  return `${secure ? "__Host-" : ""}${base}_`;
}

export function oidcTransactionCookieName(base: string, state: string, secure: boolean) {
  if (!validOidcState(state)) throw new Error("OIDC state is invalid");
  return `${oidcTransactionCookiePrefix(base, secure)}${state}`;
}

export function oidcTransactionFamilyNames(cookies: Map<string, string>, base: string, secure: boolean) {
  const prefix = oidcTransactionCookiePrefix(base, secure);
  return [...cookies.keys()].filter((name) => name.startsWith(prefix) && /^[A-Za-z0-9_-]{1,128}$/u.test(name.slice(prefix.length)));
}

export async function oidcTransactionCookieEvictions(
  cookies: Map<string, string>,
  base: string,
  secure: boolean,
  unseal: (value: string) => Promise<{ state?: unknown; createdAt?: unknown }>,
  retainedCount = OIDC_TRANSACTION_MAX_COOKIES - 1,
) {
  const prefix = oidcTransactionCookiePrefix(base, secure);
  const valid: Array<{ name: string; createdAt: number }> = [];
  const evicted: string[] = [];
  const now = Date.now();
  for (const name of oidcTransactionFamilyNames(cookies, base, secure)) {
    try {
      const transaction = await unseal(cookies.get(name)!);
      const createdAt = Number(transaction.createdAt);
      if (
        !validOidcState(transaction.state) ||
        name !== `${prefix}${transaction.state}` ||
        !Number.isFinite(createdAt) ||
        createdAt > now ||
        now - createdAt > OIDC_TRANSACTION_MAX_AGE_SECONDS * 1_000
      ) throw new Error("invalid");
      valid.push({ name, createdAt });
    } catch {
      evicted.push(name);
    }
  }
  valid.sort((left, right) => right.createdAt - left.createdAt || left.name.localeCompare(right.name));
  evicted.push(...valid.slice(Math.max(0, retainedCount)).map(({ name }) => name));
  return evicted;
}
