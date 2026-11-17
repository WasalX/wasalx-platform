"use client";

import { useEffect, useRef, useState } from "react";
import { localeMetadata, supportedLocales, type Locale } from "../lib/i18n/locales.ts";
import { rememberBoundaryLocale } from "./boundary-preferences.ts";

export async function persistBrowserLocale(
  locale: Locale,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher("/api/locale", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locale }),
  });
  if (!response.ok) throw new Error("LOCALE_UPDATE_FAILED");
}

export function reloadCurrentDocument() {
  window.location.reload();
}

const localeFocusKey = "wasalx:locale-focus";

export function LocaleSwitcher({
  locale,
  label,
  errorMessage,
  className,
}: {
  locale: Locale;
  label: string;
  errorMessage: string;
  className?: string;
}) {
  const [pending, setPending] = useState<Locale | null>(null);
  const [failed, setFailed] = useState(false);
  const fieldsetRef = useRef<HTMLFieldSetElement>(null);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(localeFocusKey) !== "1") return;
      window.sessionStorage.removeItem(localeFocusKey);
      fieldsetRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="false"]')?.focus();
    } catch {
      // Storage may be unavailable; the locale change still works without focus restoration.
    }
  }, []);

  async function selectLocale(nextLocale: Locale) {
    if (nextLocale === locale) return;
    setPending(nextLocale);
    setFailed(false);
    try {
      await persistBrowserLocale(nextLocale);
      rememberBoundaryLocale(nextLocale);
      try {
        window.sessionStorage.setItem(localeFocusKey, "1");
      } catch {
        // Storage may be unavailable; reloading remains the safe locale boundary.
      }
      reloadCurrentDocument();
    } catch {
      setPending(null);
      setFailed(true);
    }
  }

  return (
    <div className={className}>
      <fieldset disabled={pending !== null} ref={fieldsetRef}>
        <legend className="wx-visually-hidden">
          {label}
        </legend>
        {supportedLocales.map((option) => (
          <button
            className="wx-button"
            key={option}
            type="button"
            aria-pressed={option === locale}
            onClick={() => void selectLocale(option)}
          >
            {localeMetadata[option].label}
          </button>
        ))}
      </fieldset>
      {failed ? (
        <p role="alert">{errorMessage}</p>
      ) : null}
    </div>
  );
}
