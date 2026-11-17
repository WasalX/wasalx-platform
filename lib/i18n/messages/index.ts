import type { Locale } from "../locales.ts";
import { arabicMessages } from "./ar/index.ts";
import { englishMessages } from "./en/index.ts";

export type MessageKey = keyof typeof englishMessages;
export type ProductMessages = Readonly<Record<MessageKey, string>>;

export function getMessages(locale: Locale): ProductMessages {
  return locale === "ar" ? arabicMessages : englishMessages;
}

export { arabicMessages, englishMessages };
