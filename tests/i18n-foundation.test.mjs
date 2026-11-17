import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  localeFromLanguageTag,
  parseAcceptLanguage,
  resolveLocale,
  textDirection,
} from "../lib/i18n/locales.ts";
import { parseLocaleRequest } from "../lib/i18n/locale-request.ts";
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPastRelativeTime,
  formatRelativeTime,
} from "../lib/i18n/format.ts";
import { arabicMessages, englishMessages } from "../lib/i18n/messages/index.ts";
import {
  createTranslator,
  pluralCategory,
  translatePlural,
} from "../lib/i18n/translate.ts";
import { localizedUiError } from "../lib/ui-error.ts";
import { operatorFailureMessage, operatorLocalFailure, operatorResponseFailure } from "../lib/operator-ui.ts";

test("locale resolution validates the cookie and honors weighted language preferences", () => {
  assert.equal(resolveLocale({ cookie: "ar", acceptLanguage: "en" }), "ar");
  assert.equal(resolveLocale({ cookie: "AR", acceptLanguage: "ar-SA" }), "ar");
  assert.equal(resolveLocale({ cookie: "fr", acceptLanguage: "en;q=0.7, ar-SA;q=0.9" }), "ar");
  assert.equal(resolveLocale({ cookie: undefined, acceptLanguage: "fr, ar;q=0.5" }), "ar");
  assert.equal(resolveLocale({ cookie: undefined, acceptLanguage: "ar;q=0, en;q=0.5" }), "en");
  assert.equal(resolveLocale({ cookie: undefined, acceptLanguage: "ar;q=invalid, en;q=0.5" }), "en");
  assert.equal(resolveLocale({ cookie: undefined, acceptLanguage: "*" }), "en");
  assert.equal(parseAcceptLanguage(null), null);
  assert.equal(localeFromLanguageTag("AR-sa"), "ar");
  assert.equal(localeFromLanguageTag("not-a-locale"), null);
  assert.equal(textDirection("en"), "ltr");
  assert.equal(textDirection("ar"), "rtl");
});

test("locale mutation accepts only bounded same-origin JSON with a supported locale", async () => {
  const request = (body, headers = {}) =>
    new Request("https://portal.wasalx.test/api/locale", {
      method: "POST",
      headers: {
        origin: "https://portal.wasalx.test",
        "content-type": "application/json",
        ...headers,
      },
      body,
    });

  assert.deepEqual(
    await parseLocaleRequest(request(JSON.stringify({ locale: "ar" })), "https://portal.wasalx.test"),
    { ok: true, locale: "ar" },
  );
  assert.deepEqual(
    await parseLocaleRequest(
      request(JSON.stringify({ locale: "ar" }), { origin: "https://attacker.test" }),
      "https://portal.wasalx.test",
    ),
    { ok: false, status: 403, code: "LOCALE_ORIGIN_INVALID" },
  );
  assert.equal(
    (await parseLocaleRequest(request("locale=ar", { "content-type": "text/plain" }))).status,
    415,
  );
  assert.equal(
    (await parseLocaleRequest(request('{"locale":"ar"}', { "content-type": "application/json-invalid" }))).status,
    415,
  );
  assert.equal((await parseLocaleRequest(request(JSON.stringify({ locale: "fr" })))).status, 400);
  assert.equal((await parseLocaleRequest(request("{"))).status, 400);
  assert.equal(
    (await parseLocaleRequest(request(JSON.stringify({ locale: "ar", pad: "x".repeat(1_100) })))).status,
    413,
  );
});

test("locale request admission cancels a chunked oversized body before reading the remainder", async () => {
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(600));
      if (pulls > 10) throw new Error("Locale admission read beyond its byte budget");
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const request = new Request("https://portal.wasalx.test/api/locale", {
    method: "POST",
    headers: { origin: "https://portal.wasalx.test", "content-type": "application/json" },
    body: stream,
    duplex: "half",
  });
  assert.deepEqual(await parseLocaleRequest(request), { ok: false, status: 413, code: "LOCALE_REQUEST_TOO_LARGE" });
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("English and Arabic dictionaries have exact key parity", () => {
  const englishKeys = Object.keys(englishMessages).sort();
  const arabicKeys = Object.keys(arabicMessages).sort();
  assert.deepEqual(arabicKeys, englishKeys);
  assert.ok(englishKeys.length >= 60);
  for (const key of englishKeys) {
    assert.ok(englishMessages[key].trim(), `English message ${key} must not be empty`);
    assert.ok(arabicMessages[key].trim(), `Arabic message ${key} must not be empty`);
  }
});

test("typed translation interpolates values and Arabic exposes every plural category", () => {
  const translate = createTranslator({ greeting: "Hello, {name}." });
  assert.equal(translate("greeting", { name: "Maya" }), "Hello, Maya.");
  assert.deepEqual(
    [0, 1, 2, 3, 11, 100].map((count) => pluralCategory("ar", count)),
    ["zero", "one", "two", "few", "many", "other"],
  );
  assert.equal(
    translatePlural(
      "ar",
      2,
      {
        zero: "لا عناصر",
        one: "عنصر واحد",
        two: "عنصران",
        few: "{count} عناصر",
        many: "{count} عنصرا",
        other: "{count} عنصر",
      },
    ),
    "عنصران",
  );
});

test("native formatters use Gregorian Riyadh time and explicit localized digits", () => {
  const instant = "2026-01-15T12:00:00.000Z";
  const timeOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  assert.equal(formatDateTime(instant, "en", timeOptions), "15:00");
  assert.equal(formatDateTime(instant, "ar", timeOptions), "١٥:٠٠");
  assert.equal(formatNumber(123_456, "en"), "123,456");
  assert.equal(formatNumber(123_456, "ar"), "١٢٣٬٤٥٦");
  assert.match(formatDuration(7_200, "en"), /2 hours/u);
  assert.match(formatDuration(7_200, "ar"), /ساعتان/u);
  assert.match(formatBytes(1_048_576, "en"), /1 MB/u);
  assert.equal(formatRelativeTime("2026-01-15T12:00:20.000Z", "en", instant), "now");
  assert.match(formatRelativeTime("2026-01-15T12:00:45.000Z", "en", instant), /in 45 seconds/u);
  assert.equal(formatPastRelativeTime("2026-01-15T12:00:45.000Z", "en", instant), "now");
  assert.equal(formatPastRelativeTime("2026-01-15T12:02:00.000Z", "en", instant), "now");
  assert.match(formatRelativeTime("2026-01-15T11:55:00.000Z", "ar", instant), /دقائق/u);
  assert.throws(() => formatDuration(-1, "en"), RangeError);
});

test("explicit UTC and selected zones are honored without changing Riyadh defaults", () => {
  const instant = "2026-01-15T12:00:00.000Z";
  const timeOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  for (const [locale, defaultTime, utc, tokyo] of [["en", "15:00", "12:00", "21:00"], ["ar", "١٥:٠٠", "١٢:٠٠", "٢١:٠٠"]]) {
    assert.equal(formatDateTime(instant, locale, timeOptions), defaultTime);
    assert.equal(formatDateTime(instant, locale, { ...timeOptions, timeZone: "UTC" }), utc);
    assert.equal(formatDateTime(instant, locale, { ...timeOptions, timeZone: "Asia/Tokyo" }), tokyo);
  }
  assert.throws(() => formatDateTime(instant, "en", { timeZone: "not-a-time-zone" }), RangeError);
});

test("localized UI errors never expose raw provider messages", () => {
  const forbidden = localizedUiError("ar", {
    status: 403,
    message: "private provider credential zammad-secret",
  });
  assert.equal(forbidden.code, "FORBIDDEN");
  assert.match(forbidden.message, /صلاحية/u);
  assert.doesNotMatch(forbidden.message, /provider|zammad|secret/iu);

  const reauthentication = localizedUiError("en", {
    status: 403,
    code: "REAUTHENTICATION_REQUIRED",
  });
  assert.deepEqual(reauthentication, {
    code: "REAUTHENTICATION_REQUIRED",
    message: "Reauthenticate to continue.",
  });

  const unknown = localizedUiError("en", new Error("database host leaked"));
  assert.deepEqual(unknown, { code: "UNKNOWN", message: "Something went wrong. Try again." });
});

test("client UI error localization does not import the full product catalog", async () => {
  const source = await readFile(new URL("../lib/ui-error.ts", import.meta.url), "utf8");
  assert.match(source, /messages\/en\/common\.ts/u);
  assert.match(source, /messages\/ar\/common\.ts/u);
  assert.doesNotMatch(source, /messages\/index\.ts|getMessages/u);
});

test("locale endpoint is fail-closed and relative time advances only after hydration", async () => {
  const route = await readFile(new URL("../app/api/locale/route.ts", import.meta.url), "utf8");
  const switcher = await readFile(new URL("../app/LocaleSwitcher.tsx", import.meta.url), "utf8");
  const provider = await readFile(new URL("../app/I18nProvider.tsx", import.meta.url), "utf8");
  assert.match(route, /parseLocaleRequest\(request\)/u);
  assert.match(route, /httpOnly:\s*true/u);
  assert.match(route, /sameSite:\s*"lax"/u);
  assert.match(route, /"cache-control":\s*"no-store"/u);
  assert.match(switcher, /credentials:\s*"same-origin"/u);
  assert.match(switcher, /window\.location\.reload\(\)/u);
  assert.match(switcher, /wasalx:locale-focus/u);
  assert.match(switcher, /querySelector<HTMLButtonElement>\('\[aria-pressed="false"\]'\)\?\.focus\(\)/u);
  assert.doesNotMatch(switcher, /getMessages|translateMessage/u);
  assert.doesNotMatch(switcher, /<form/u);
  assert.match(switcher, /label:\s*string/u);
  assert.match(switcher, /errorMessage:\s*string/u);
  assert.match(provider, /useState\(renderedAt\)/u);
  assert.match(provider, /useEffect\(\(\) => \{/u);
  assert.match(provider, /setRelativeClock\(Date\.now\(\)\)/u);
  assert.match(provider, /window\.setInterval\(update, 60_000\)/u);
  assert.match(provider, /const RelativeClockContext = createContext<number \| null>\(null\)/u);
  assert.match(provider, /<RelativeClockContext\.Provider value=\{relativeClock\}>/u);
  assert.match(provider, /export function useRelativeClock\(\)/u);
  assert.doesNotMatch(provider, /renderedAt: relativeClock/u);
  assert.match(provider, /\[locale, messages\]/u);
});

test("the framework 404 is branded, localized, and safe", async () => {
  const source = await readFile(new URL("../app/not-found.tsx", import.meta.url), "utf8");
  assert.match(source, /common\.notFound\.title/u);
  assert.match(source, /common\.notFound\.body/u);
  assert.match(source, /common\.actions\.goHome/u);
  assert.match(source, /robots:\s*\{ index: false, follow: false \}/u);
  assert.doesNotMatch(source, /provider|zammad|waha|gows/iu);
});

test("operator catch boundaries localize transport and parser errors in both languages", () => {
  for (const locale of ["en", "ar"]) {
    const fallback = locale === "ar" ? "تعذّر إكمال الإجراء." : "The action could not be completed.";
    const network = operatorFailureMessage(new TypeError("Failed to fetch private.internal"), fallback, locale);
    assert.equal(network, localizedUiError(locale, new TypeError()).message);
    for (const error of [new SyntaxError("Unexpected token from private.internal"), new Error("private.internal token=secret"), { message: "private.internal" }]) {
      assert.equal(operatorFailureMessage(error, fallback, locale), fallback);
    }
    const forbidden = operatorFailureMessage({ code: "FORBIDDEN", message: "secret" }, fallback, locale);
    assert.equal(forbidden, localizedUiError(locale, { code: "FORBIDDEN" }).message);
    assert.doesNotMatch(network + forbidden, /private|secret|fetch/iu);
  }
});

test("explicit local validation and structured HTTP errors retain actionable translated feedback", async () => {
  for (const locale of ["en", "ar"]) {
    const validation = locale === "ar" ? "أدخل رقم هاتف صالحًا." : "Enter a valid phone number.";
    assert.equal(operatorFailureMessage(operatorLocalFailure(validation), "fallback", locale), validation);
    assert.equal(operatorFailureMessage(new Error(validation), "fallback", locale), "fallback");
    for (const [status, code] of [[403, "REAUTHENTICATION_REQUIRED"], [403, "FORBIDDEN"], [409, "CONFLICT"]]) {
      const response = new Response(JSON.stringify({ code, message: "private.internal secret" }), { status, headers: { "content-type": "application/json" } });
      const error = await operatorResponseFailure(response, "fallback", locale);
      assert.equal(error.code, code);
      assert.equal(operatorFailureMessage(error, "fallback", locale), localizedUiError(locale, { code }).message);
      assert.doesNotMatch(error.message, /private|secret/iu);
    }
  }
});
