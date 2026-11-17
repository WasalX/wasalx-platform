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

test("audit filtering searches only the role-safe presentation already shown on screen", async () => {
  const source = await read("app/WasalXApp.tsx");
  assert.match(source, /const filteredEntries = normalizedQuery\s*\? entries\.filter\(\(row\) => Object\.values\(presentation\(row\)\)/u);
  assert.match(source, /<Toolbar query=\{query\} setQuery=\{setQuery\} placeholder=\{t\("tenant\.audit\.search"\)\}>/u);
  assert.match(source, /filteredEntries\.map\(\(row\) =>/u);
  assert.match(source, /!filteredEntries\.length \? <Empty title=\{t\(entries\.length \? "tenant\.audit\.noMatchesTitle" : "tenant\.audit\.emptyTitle"\)/u);
});
