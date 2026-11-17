import { isLocale, type Locale } from "./locales.ts";
import { BoundedBodyError, readBoundedBody } from "../bounded-json.ts";

export const localeRequestBodyLimit = 1_024;

export type LocaleRequestErrorCode =
  | "LOCALE_ORIGIN_INVALID"
  | "LOCALE_CONTENT_TYPE_INVALID"
  | "LOCALE_REQUEST_TOO_LARGE"
  | "LOCALE_INVALID";

export type LocaleRequestResult =
  | { ok: true; locale: Locale }
  | { ok: false; status: 400 | 403 | 413 | 415; code: LocaleRequestErrorCode };

export function localeRequestOrigin(request: Request) {
  const configured = process.env.PORTAL_PUBLIC_ORIGIN;
  if (!configured) return new URL(request.url).origin;
  const value = new URL(configured);
  if (
    !["http:", "https:"].includes(value.protocol) ||
    value.pathname !== "/" ||
    value.search ||
    value.hash
  ) {
    throw new Error("PORTAL_PUBLIC_ORIGIN must be an HTTP(S) origin without a path");
  }
  return value.origin;
}

export async function parseLocaleRequest(
  request: Request,
  expectedOrigin = localeRequestOrigin(request),
): Promise<LocaleRequestResult> {
  if (request.headers.get("origin") !== expectedOrigin) {
    return { ok: false, status: 403, code: "LOCALE_ORIGIN_INVALID" };
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return { ok: false, status: 415, code: "LOCALE_CONTENT_TYPE_INVALID" };
  }
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null) {
    const declaredLength = Number(declaredHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      return { ok: false, status: 400, code: "LOCALE_INVALID" };
    }
    if (declaredLength > localeRequestBodyLimit) {
      return { ok: false, status: 413, code: "LOCALE_REQUEST_TOO_LARGE" };
    }
  }

  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBody(request, localeRequestBodyLimit, 5_000));
  } catch (error) {
    if (error instanceof BoundedBodyError && error.status === 413) {
      return { ok: false, status: 413, code: "LOCALE_REQUEST_TOO_LARGE" };
    }
    return { ok: false, status: 400, code: "LOCALE_INVALID" };
  }

  try {
    const body = JSON.parse(raw) as { locale?: unknown };
    if (!isLocale(body.locale)) {
      return { ok: false, status: 400, code: "LOCALE_INVALID" };
    }
    return { ok: true, locale: body.locale };
  } catch {
    return { ok: false, status: 400, code: "LOCALE_INVALID" };
  }
}
