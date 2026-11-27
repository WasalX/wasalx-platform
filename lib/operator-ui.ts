import type { Locale } from "./i18n/locales.ts";
import { localizedUiError, type UiErrorCode } from "./ui-error.ts";

export type CodedOperatorError = Error & { code: UiErrorCode };
export type OperatorFailure = { code: UiErrorCode; message: string };

// Only errors created from local translations may retain their message at the UI boundary.
const localOperatorFailures = new WeakSet<Error>();

export function operatorLocalFailure(message: string): Error {
  const error = new Error(message);
  localOperatorFailures.add(error);
  return error;
}

export function operatorFailure(error: unknown, fallback: string, locale: Locale = documentLocale()): OperatorFailure {
  const { code, message } = localizedUiError(locale, error);
  if (error instanceof Error && localOperatorFailures.has(error)) return { code, message: error.message };
  return { code, message: code === "UNKNOWN" ? fallback : message };
}

export function operatorFailureMessage(error: unknown, fallback: string, locale?: Locale): string {
  return operatorFailure(error, fallback, locale).message;
}

export async function operatorResponseFailure(
  response: Response,
  fallback: string,
  locale: Locale = documentLocale(),
): Promise<CodedOperatorError> {
  const body = await response.json().catch(() => ({})) as { code?: unknown };
  const localized = localizedUiError(locale, { status: response.status, code: body.code });
  return Object.assign(operatorLocalFailure(localized.message || fallback), { code: localized.code });
}

const PUBLIC_REVIEW_METADATA_KEYS = new Set([
  "reference_count",
  "configured_limit",
  "media_type",
  "media_size",
  "attempt_count",
  "retry_requires_confirmation",
]);

export function visibleReviewMetadata(
  value: unknown,
  showDiagnostics: boolean,
  reviewState?: unknown,
): Array<[string, unknown]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const closed = reviewState === "RESOLVED" || reviewState === "DISCARDED";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !closed || key !== "retry_requires_confirmation");
  if (showDiagnostics) return entries;
  return entries.filter(([key, item]) =>
    PUBLIC_REVIEW_METADATA_KEYS.has(key)
    && (typeof item === "string" || typeof item === "number" || typeof item === "boolean"),
  );
}

export function unmatchedReviewItems(
  failedDeliveries: Array<Record<string, unknown>>,
  reviews: Array<Record<string, unknown>>,
) {
  const deliveryTickets = new Set(
    failedDeliveries.map(ticketReference).filter((value): value is string => value !== null),
  );
  return reviews.filter((review) => {
    const ticket = ticketReference(review);
    return ticket === null || !deliveryTickets.has(ticket);
  });
}

export function createLatestRequestFence() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    invalidate() {
      current += 1;
    },
    isCurrent(request: number) {
      return request === current;
    },
  };
}

export function confirmUnsavedNavigation(
  message: string,
  root: Pick<Document, "querySelector"> = document,
  confirm: (message: string) => boolean = window.confirm,
) {
  return !root.querySelector('[data-unsaved="true"]') || confirm(message);
}

export function shouldPauseAutomaticRefresh(
  root: Pick<Document, "querySelector"> = document,
) {
  return Boolean(
    root.querySelector(
      '[data-unsaved="true"], dialog[open] form, [contenteditable="true"]',
    ),
  );
}

function ticketReference(row: Record<string, unknown>) {
  const value = row.ticket_number ?? row.zammad_ticket_number ?? row.zammad_ticket_id;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim().replace(/^#/u, "");
  return normalized || null;
}

function documentLocale(): Locale {
  return typeof document !== "undefined"
    && document.documentElement.lang.toLowerCase().startsWith("ar")
    ? "ar"
    : "en";
}

export function deliveryFailureGuidance(row: Record<string, unknown>): string | null {
  if (row.state !== "FAILED_TERMINAL" || !Array.isArray(row.delivery_attempts)) return null;
  const latest = row.delivery_attempts.reduce<Record<string, unknown> | null>((selected, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return selected;
    const attempt = value as Record<string, unknown>;
    return Number.isInteger(attempt.attempt_number)
      && (!selected || Number(attempt.attempt_number) > Number(selected.attempt_number)) ? attempt : selected;
  }, null);
  return latest?.state === "FAILED_TERMINAL" && latest.provider_code === "META_CUSTOMER_WINDOW_CLOSED"
    ? "tenant.deliveries.windowClosedGuidance" : null;
}
