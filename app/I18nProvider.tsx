"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { textDirection, type Locale } from "../lib/i18n/locales.ts";
import {
  translateMessage,
  type MessageDictionary,
  type TranslationValues,
} from "../lib/i18n/translate.ts";

type I18nContextValue = {
  locale: Locale;
  direction: "ltr" | "rtl";
  t: (key: string, values?: TranslationValues) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);
const RelativeClockContext = createContext<number | null>(null);

export function I18nProvider({
  locale,
  messages,
  renderedAt,
  children,
}: {
  locale: Locale;
  messages: MessageDictionary;
  renderedAt: number;
  children: ReactNode;
}) {
  const [relativeClock, setRelativeClock] = useState(renderedAt);

  useEffect(() => {
    const update = () => setRelativeClock(Date.now());
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, [renderedAt]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      direction: textDirection(locale),
      t: (key, values) => translateMessage(messages, key, values),
    }),
    [locale, messages],
  );
  return (
    <I18nContext.Provider value={value}>
      <RelativeClockContext.Provider value={relativeClock}>
        {children}
      </RelativeClockContext.Provider>
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}

export function useRelativeClock() {
  const value = useContext(RelativeClockContext);
  if (value === null) throw new Error("useRelativeClock must be used inside I18nProvider");
  return value;
}
