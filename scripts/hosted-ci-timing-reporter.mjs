import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";

const quarantine = JSON.parse(readFileSync(new URL("./test-quarantine.json", import.meta.url), "utf8"));

export function validateQuarantine(entries = quarantine, today = new Date().toISOString().slice(0, 10)) {
  assert(Array.isArray(entries), "Test quarantine must be an array");
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const { file, name, owner, expiresOn } = entry ?? {};
    const row = "Test quarantine row " + (index + 1) + ": " + file + " :: " + name;
    assert([file, name, owner].every(value => typeof value === "string" && value.trim() === value && value.length > 0), row + " requires a file, test name and owner");
    assert(typeof expiresOn === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(expiresOn)
      && new Date(expiresOn).toJSON()?.slice(0, 10) === expiresOn, row + " requires a valid UTC expiry date");
    assert(today < expiresOn, row + " expired on " + expiresOn + " (owner " + owner + ")");
    const key = JSON.stringify([file, name]);
    assert(!seen.has(key), row + " is duplicated");
    seen.add(key);
  }
  return entries;
}

export default async function* reportTimings(events, entries = quarantine) {
  for await (const { type, data } of events) {
    if (!data.file || (type !== "test:summary" && type !== "test:fail")) continue;
    const file = relative(process.cwd(), data.file).split(sep).join("/");
    if (type === "test:summary" && file.startsWith("tests/")) {
      yield `UNIT_TIMING ${JSON.stringify([file, Math.round(data.duration_ms)])}\n`;
    } else if (type === "test:fail" && !data.todo && !data.skip) {
      const known = entries.find(entry => entry.file === file && entry.name === data.name);
      if (known) yield `KNOWN TEST FAILURE ${JSON.stringify(known)}\n`;
    }
  }
}
