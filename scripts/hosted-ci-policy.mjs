import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import baseline from "./hosted-ci-baseline.mjs";

export function lintRatchet(results, allowed = baseline.lint, root = process.cwd()) {
  assert(Array.isArray(results), "Invalid ESLint report");
  const files = {}, regressions = [];
  let count = 0;
  for (const result of results) {
    const file = relative(root, result.filePath).replaceAll("\\", "/");
    assert(!result.fatalErrorCount, `Fatal lint error: ${file}`);
    const errors = result.messages.filter(message => message.severity === 2);
    assert.equal(errors.length, result.errorCount, "Incomplete ESLint report");
    for (const message of errors) {
      assert(message.ruleId, `Unclassified lint error: ${file}`);
      files[file] ??= {};
      files[file][message.ruleId] = (files[file][message.ruleId] ?? 0) + 1;
      count++;
    }
  }
  for (const [file, rules] of Object.entries(files)) {
    for (const [rule, total] of Object.entries(rules)) {
      const limit = allowed.files[file]?.[rule] ?? 0;
      if (total > limit) regressions.push(`${file}: ${rule}: ${total} > ${limit}`);
    }
  }
  if (count > allowed.count) regressions.push(`Total lint errors: ${count} > ${allowed.count}`);
  const decreased = Object.entries(allowed.files).some(([file, rules]) =>
    Object.entries(rules).some(([rule, limit]) => (files[file]?.[rule] ?? 0) < limit));
  return { count, recorded: allowed.count, files, regressions, decreased };
}

export function addonSkips(entrypoint, present = existsSync) {
  return baseline.tests.filter(entry => entry.entrypoint === entrypoint && !present(entry.input));
}

export function skipPattern(entries) {
  return `^(?:${entries.map(entry => RegExp.escape(entry.name)).join("|")})$`;
}
