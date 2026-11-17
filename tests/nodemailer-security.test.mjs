import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("mailer parses malformed address headers without blocking the process", () => {
  const code = `
    const assert = require("node:assert/strict");
    const { createRequire } = require("node:module");
    const mailerRequire = createRequire(${JSON.stringify(new URL("../services/invitation-mailer/package.json", import.meta.url).href)});
    const parser = mailerRequire("nodemailer/lib/addressparser");
    assert.deepEqual(parser("WasalX <invites@example.com>"), [{address: "invites@example.com", name: "WasalX"}]);
    for (const input of [" >" + ">[x][x]".repeat(40_000), "[x]".repeat(40_000) + "@"])
      assert.ok(Array.isArray(parser(input)));
  `;
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", code], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});
