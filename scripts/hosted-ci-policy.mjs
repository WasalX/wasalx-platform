import { existsSync } from "node:fs";
import baseline from "./hosted-ci-baseline.mjs";

export function addonSkips(entrypoint, present = existsSync) {
  return baseline.tests.filter(entry => entry.entrypoint === entrypoint && !present(entry.input));
}

export function skipPattern(entries) {
  return `^(?:${entries.map(entry => RegExp.escape(entry.name)).join("|")})$`;
}
