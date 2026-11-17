import type { Locale } from "./i18n/locales.ts";
import { arabicCommonMessages } from "./i18n/messages/ar/common.ts";
import { englishCommonMessages } from "./i18n/messages/en/common.ts";
import { translateMessage, type TranslationValues } from "./i18n/translate.ts";

type CommonMessageKey = keyof typeof englishCommonMessages;

export type UiErrorCode =
  | "UNAUTHENTICATED"
  | "REAUTHENTICATION_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "VALIDATION_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "UNKNOWN";

const errorMessageKeys = {
  UNAUTHENTICATED: "common.errors.unauthenticated",
  REAUTHENTICATION_REQUIRED: "common.errors.reauthenticationRequired",
  FORBIDDEN: "common.errors.forbidden",
  NOT_FOUND: "common.errors.notFound",
  CONFLICT: "common.errors.conflict",
  RATE_LIMITED: "common.errors.rateLimited",
  VALIDATION_ERROR: "common.errors.invalid",
  SERVICE_UNAVAILABLE: "common.errors.unavailable",
  NETWORK_ERROR: "common.errors.network",
  TIMEOUT: "common.errors.timeout",
  UNKNOWN: "common.errors.generic",
} as const satisfies Record<UiErrorCode, CommonMessageKey>;

const knownCodes = new Set<UiErrorCode>(Object.keys(errorMessageKeys) as UiErrorCode[]);

export function normalizeUiErrorCode(error: unknown): UiErrorCode {
  if (typeof error === "object" && error !== null) {
    const value = error as { code?: unknown; status?: unknown; name?: unknown };
    if (typeof value.code === "string" && knownCodes.has(value.code as UiErrorCode)) {
      return value.code as UiErrorCode;
    }
    if (value.name === "AbortError") return "TIMEOUT";
    if (value.status === 401) return "UNAUTHENTICATED";
    if (value.status === 403) return "FORBIDDEN";
    if (value.status === 404) return "NOT_FOUND";
    if (value.status === 409) return "CONFLICT";
    if (value.status === 422 || value.status === 400) return "VALIDATION_ERROR";
    if (value.status === 429) return "RATE_LIMITED";
    if (typeof value.status === "number" && value.status >= 500) return "SERVICE_UNAVAILABLE";
    if (error instanceof TypeError) return "NETWORK_ERROR";
  }
  return "UNKNOWN";
}

export function uiErrorMessage(
  locale: Locale,
  code: UiErrorCode,
  values?: TranslationValues,
) {
  return translateMessage(
    locale === "ar" ? arabicCommonMessages : englishCommonMessages,
    errorMessageKeys[code],
    values,
  );
}

export function localizedUiError(locale: Locale, error: unknown) {
  const code = normalizeUiErrorCode(error);
  return { code, message: uiErrorMessage(locale, code) } as const;
}
