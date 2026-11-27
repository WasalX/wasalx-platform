import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getBoundaryMessages } from "../lib/i18n/messages/boundary.ts";
import { arabicMessages, englishMessages } from "../lib/i18n/messages/index.ts";
import { readTenantPortalSource, tenantPortalFiles } from "./helpers/tenant-portal-source.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("workflow schema inspection is read-only and restricted to flow administrators", async () => {
  const source = await read("app/BotAutomation.tsx");
  assert.match(source, /\{canWrite \? \(\s*<details className="routing-raw">/u);
  assert.match(source, /<pre dir="ltr" aria-label=\{t\("bot\.flow\.schema\.label"\)\}><code>\{JSON\.stringify\(definition, null, 2\)\}<\/code><\/pre>/u);
  assert.doesNotMatch(source, /bot\.flow\.schema\.[^\n]+<textarea/u);
});

test("the saved routing configuration is shown only to routing writers", async () => {
  const source = await read("app/ClientRouting.tsx");
  // Writers get the closed disclosure; read-only roles get nothing in its place.
  assert.match(source, /\{canWrite \? \(\s*<details className="routing-raw">\s*<summary>\{t\("routing\.detail\.raw"\)\}<\/summary>\s*<pre>\{JSON\.stringify\(definition, null, 2\)\}<\/pre>\s*<\/details>\s*\) : null\}/u);
  assert.equal(source.match(/JSON\.stringify\(definition, null, 2\)/gu)?.length, 1);
});

test("automation and tenant screens show no raw flow definition or developer terms by default", async () => {
  const source = await read("app/BotAutomation.tsx");
  // The only raw definition sits in a disclosure that starts closed.
  assert.equal(source.match(/JSON\.stringify\(definition/gu)?.length, 1);
  assert.match(source, /<details className="routing-raw">\s*<summary>\{t\("bot\.flow\.schema\.title"\)\}<\/summary>\s*<p>\{t\("bot\.flow\.schema\.help"\)\}<\/p>\s*<pre dir="ltr" aria-label=\{t\("bot\.flow\.schema\.label"\)\}><code>\{JSON\.stringify\(definition/u);
  assert.doesNotMatch(source, /<details className="routing-raw"[^>]*\sopen/u);
  // Example input values come from the catalogues, never a literal in code.
  for (const file of [...tenantPortalFiles, "app/ClientRouting.tsx", "app/BotAutomation.tsx", "app/CaseLifecycle.tsx", "app/platform/PlatformConsole.tsx"]) {
    assert.doesNotMatch(await read(file), /placeholder="/u, file);
  }
  const values = (text) => [...text.matchAll(/^ {2}"[^"]+": "((?:[^"\\]|\\.)*)",\r?$/gmu)].map((match) => match[1].replace(/\{[^}]+\}/gu, ""));
  for (const catalogue of ["automation", "tenant"]) {
    for (const value of values(await read(`lib/i18n/messages/en/${catalogue}.ts`))) {
      assert.doesNotMatch(value, /\b(?:revisions?|immutable|JSON(?! file)|schemas?|payloads?)\b/iu, value);
    }
    for (const value of values(await read(`lib/i18n/messages/ar/${catalogue}.ts`))) {
      assert.doesNotMatch(value, /(?<!ملف )JSON|غير قابل|حمول/u, value);
    }
  }
});

test("audit filtering searches only the role-safe presentation already shown on screen", async () => {
  const source = readTenantPortalSource();
  assert.match(source, /const filteredEntries = normalizedQuery\s*\? entries\.filter\(\(row\) => Object\.values\(presentation\(row\)\)/u);
  assert.match(source, /<Toolbar query=\{query\} setQuery=\{setQuery\} placeholder=\{t\("tenant\.audit\.search"\)\}>/u);
  assert.match(source, /filteredEntries\.map\(\(row\) =>/u);
  assert.match(source, /!filteredEntries\.length \? <Empty title=\{t\(entries\.length \? "tenant\.audit\.noMatchesTitle" : "tenant\.audit\.emptyTitle"\)/u);
});

test("platform console copy names a provider only on its figures and never an internal component", async () => {
  const internal = { en: /control API|control plane could|database identit|least-privilege|fenced/iu, ar: /واجهة برمجة تطبيقات التحكم|تحميل مستوى التحكم|هويات قاعدة البيانات|مسيّج/u };
  for (const [locale, messages] of [["en", englishMessages], ["ar", arabicMessages]]) {
    for (const [key, value] of [...Object.entries(messages), ...Object.entries(getBoundaryMessages(locale))]) {
      if (!key.startsWith("platform.")) continue;
      assert.doesNotMatch(value, internal[locale], key);
      // Staff screens may name a provider only where it labels that provider's capacity or usage (DESIGN.md).
      if (value.includes("WAHA")) assert.match(key, /^platform\.(?:workers\.(?:title|empty)|states\.waha_)/u, key);
    }
  }
  assert.equal(arabicMessages["platform.error.signInAgain"], arabicMessages["tenant.session.signIn"]);
  assert.notEqual(englishMessages["platform.error.eyebrow"], englishMessages["platform.error.eyebrow"].toUpperCase());
  assert.match(await read("app/platform/PlatformBoundary.module.css"), /\.eyebrow \{[^}]*text-transform: uppercase;/u);
});
