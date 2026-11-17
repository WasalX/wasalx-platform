import { languageTag, type Locale } from "./locales.ts";

export type MessageDictionary = Readonly<Record<string, string>>;
export type DictionaryFor<Dictionary extends MessageDictionary> = {
  readonly [Key in keyof Dictionary]: string;
};
export type TranslationValue = string | number;
export type TranslationValues = Readonly<Record<string, TranslationValue>>;
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
export type PluralForms = Readonly<
  { other: string } & Partial<Record<Exclude<PluralCategory, "other">, string>>
>;

export function interpolateMessage(template: string, values: TranslationValues = {}) {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : placeholder,
  );
}

export function createTranslator<const Dictionary extends MessageDictionary>(dictionary: Dictionary) {
  return <Key extends keyof Dictionary & string>(key: Key, values?: TranslationValues) =>
    interpolateMessage(dictionary[key], values);
}

export function translateMessage(
  dictionary: MessageDictionary,
  key: string,
  values?: TranslationValues,
) {
  const template = dictionary[key] ?? dictionary["common.errors.generic"] ?? "";
  return interpolateMessage(template, values);
}

export function pluralCategory(locale: Locale, count: number): PluralCategory {
  return new Intl.PluralRules(languageTag(locale)).select(count) as PluralCategory;
}

export function translatePlural(
  locale: Locale,
  count: number,
  forms: PluralForms,
  values: TranslationValues = {},
) {
  const template = forms[pluralCategory(locale, count)] ?? forms.other;
  return interpolateMessage(template, { ...values, count });
}
