import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("workflow schema inspection is read-only and restricted to flow administrators", async () => {
  const source = await read("app/BotAutomation.tsx");
  assert.match(source, /\{canWrite \? \(\s*<details className="routing-raw">/u);
  assert.match(source, /<pre aria-label=\{t\("bot\.flow\.schema\.label"\)\}><code>\{JSON\.stringify\(definition, null, 2\)\}<\/code><\/pre>/u);
  assert.doesNotMatch(source, /bot\.flow\.schema\.[^\n]+<textarea/u);
});

test("automation and tenant screens show no raw flow definition or developer terms by default", async () => {
  const source = await read("app/BotAutomation.tsx");
  // The only raw definition sits in a disclosure that starts closed.
  assert.equal(source.match(/JSON\.stringify\(definition/gu)?.length, 1);
  assert.match(source, /<details className="routing-raw">\s*<summary>\{t\("bot\.flow\.schema\.title"\)\}<\/summary>\s*<p>\{t\("bot\.flow\.schema\.help"\)\}<\/p>\s*<pre aria-label=\{t\("bot\.flow\.schema\.label"\)\}><code>\{JSON\.stringify\(definition/u);
  assert.doesNotMatch(source, /<details className="routing-raw"[^>]*\sopen/u);
  assert.doesNotMatch(await read("app/ClientRouting.tsx"), /placeholder="ACME-42"/u);
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
  const source = await read("app/WasalXApp.tsx");
  assert.match(source, /const filteredEntries = normalizedQuery\s*\? entries\.filter\(\(row\) => Object\.values\(presentation\(row\)\)/u);
  assert.match(source, /<Toolbar query=\{query\} setQuery=\{setQuery\} placeholder=\{t\("tenant\.audit\.search"\)\}>/u);
  assert.match(source, /filteredEntries\.map\(\(row\) =>/u);
  assert.match(source, /!filteredEntries\.length \? <Empty title=\{t\(entries\.length \? "tenant\.audit\.noMatchesTitle" : "tenant\.audit\.emptyTitle"\)/u);
});
