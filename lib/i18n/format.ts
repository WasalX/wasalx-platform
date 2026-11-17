import { languageTag, wasalxTimeZone, type Locale } from "./locales.ts";

export type DateValue = Date | number | string;

function dateValue(value: DateValue) {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) throw new RangeError("Invalid date value");
  return result;
}

export function formatDateTime(
  value: DateValue,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions,
) {
  const selectedOptions = options ?? { dateStyle: "medium", timeStyle: "short" };
  return new Intl.DateTimeFormat(languageTag(locale), {
    ...selectedOptions,
    timeZone: selectedOptions.timeZone ?? wasalxTimeZone,
  }).format(dateValue(value));
}

export function formatNumber(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
) {
  return new Intl.NumberFormat(languageTag(locale), options).format(value);
}

export function formatCurrency(value: number, currency: string, locale: Locale) {
  return formatNumber(value, locale, {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
  });
}

export function formatList(values: readonly string[], locale: Locale) {
  return new Intl.ListFormat(languageTag(locale), {
    style: "long",
    type: "conjunction",
  }).format(values);
}

export function formatRelativeTime(
  value: DateValue,
  locale: Locale,
  relativeTo: DateValue,
) {
  const seconds = (dateValue(value).getTime() - dateValue(relativeTo).getTime()) / 1_000;
  const absolute = Math.abs(seconds);
  if (absolute < 30) {
    return new Intl.RelativeTimeFormat(languageTag(locale), { numeric: "auto" }).format(
      0,
      "second",
    );
  }
  const [divisor, unit]: [number, Intl.RelativeTimeFormatUnit] =
    absolute < 60
      ? [1, "second"]
      : absolute < 3_600
        ? [60, "minute"]
        : absolute < 86_400
          ? [3_600, "hour"]
          : absolute < 604_800
            ? [86_400, "day"]
            : absolute < 2_629_800
              ? [604_800, "week"]
              : absolute < 31_557_600
                ? [2_629_800, "month"]
                : [31_557_600, "year"];
  return new Intl.RelativeTimeFormat(languageTag(locale), { numeric: "auto" }).format(
    Math.round(seconds / divisor),
    unit,
  );
}

export function formatPastRelativeTime(
  value: DateValue,
  locale: Locale,
  relativeTo: DateValue,
) {
  const event = dateValue(value);
  const reference = dateValue(relativeTo);
  return formatRelativeTime(
    event.getTime() > reference.getTime() ? reference : event,
    locale,
    reference,
  );
}

const durationUnits = [
  [86_400, "day"],
  [3_600, "hour"],
  [60, "minute"],
  [1, "second"],
] as const;

export function formatDuration(totalSeconds: number, locale: Locale) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    throw new RangeError("Duration must be a finite non-negative number");
  }
  let remaining = Math.round(totalSeconds);
  const parts: string[] = [];
  for (const [seconds, unit] of durationUnits) {
    const amount = Math.floor(remaining / seconds);
    if (!amount && parts.length === 0 && seconds !== 1) continue;
    if (amount || (seconds === 1 && parts.length === 0)) {
      parts.push(
        new Intl.NumberFormat(languageTag(locale), {
          style: "unit",
          unit,
          unitDisplay: "long",
        }).format(amount),
      );
      remaining -= amount * seconds;
    }
    if (parts.length === 2) break;
  }
  return formatList(parts, locale);
}

export function formatBytes(bytes: number, locale: Locale) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError("Bytes must be a finite non-negative number");
  }
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;
  const unitIndex = bytes === 0 ? 0 : Math.min(Math.floor(Math.log(bytes) / Math.log(1_024)), 4);
  const value = bytes / 1_024 ** unitIndex;
  return new Intl.NumberFormat(languageTag(locale), {
    style: "unit",
    unit: units[unitIndex],
    unitDisplay: "short",
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  }).format(value);
}
