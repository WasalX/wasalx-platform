export const supportedLocales = ["en", "ar"] as const;

export type Locale = (typeof supportedLocales)[number];
export type TextDirection = "ltr" | "rtl";

export const defaultLocale: Locale = "en";
export const wasalxTimeZone = "Asia/Riyadh";

export const localeMetadata = {
  en: {
    languageTag: "en-SA-u-ca-gregory-nu-latn",
    direction: "ltr",
    label: "English",
  },
  ar: {
    languageTag: "ar-SA-u-ca-gregory-nu-arab",
    direction: "rtl",
    label: "العربية",
  },
} as const satisfies Record<
  Locale,
  { languageTag: string; direction: TextDirection; label: string }
>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && supportedLocales.includes(value as Locale);
}

export function localeFromLanguageTag(value: unknown): Locale | null {
  if (typeof value !== "string") return null;
  const primaryLanguage = value.trim().toLowerCase().split("-")[0];
  return isLocale(primaryLanguage) ? primaryLanguage : null;
}

export function parseAcceptLanguage(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const preferences = value
    .split(",")
    .map((entry, index) => {
      const [rawTag, ...parameters] = entry.trim().split(";");
      let quality = 1;
      for (const parameter of parameters) {
        const match = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/iu.exec(parameter);
        if (/^\s*q\s*=/iu.test(parameter)) quality = match ? Number(match[1]) : 0;
      }
      return { tag: rawTag?.trim() ?? "", quality, index };
    })
    .filter(({ tag, quality }) => tag !== "*" && quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index);

  for (const preference of preferences) {
    const locale = localeFromLanguageTag(preference.tag);
    if (locale) return locale;
  }
  return null;
}

export function resolveLocale(input: {
  cookie?: unknown;
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(input.cookie)) return input.cookie;
  return parseAcceptLanguage(input.acceptLanguage) ?? defaultLocale;
}

export function languageTag(locale: Locale) {
  return localeMetadata[locale].languageTag;
}

export function textDirection(locale: Locale) {
  return localeMetadata[locale].direction;
}
