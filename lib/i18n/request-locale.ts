import { cookies, headers } from "next/headers";
import { resolveLocale, type Locale } from "./locales.ts";

export function localeCookieSecure() {
  return process.env.PORTAL_COOKIE_SECURE !== "false";
}

export function localeCookieName() {
  return localeCookieSecure() ? "__Host-wasalx_locale" : "wasalx_locale";
}

export async function getRequestLocale(): Promise<Locale> {
  const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
  return resolveLocale({
    cookie: cookieStore.get(localeCookieName())?.value,
    acceptLanguage: requestHeaders.get("accept-language"),
  });
}
