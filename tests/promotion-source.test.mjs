import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyPromotionSource } from "../scripts/release/verify-promotion-source.mjs";

test("promotion preserves build identity and rejects missing, different or unrelated trees", context => {
  const cwd = mkdtempSync(join(tmpdir(), "wasalx-promotion-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Promotion test");
  writeFileSync(join(cwd, "app.txt"), "qualified source\n");
  git("add", "app.txt"); git("commit", "-m", "build");
  const sourceRevision = git("rev-parse", "HEAD");
  const sourceTree = git("rev-parse", "HEAD^{tree}");
  git("commit", "--allow-empty", "-m", "promotion");
  const promotion = git("rev-parse", "HEAD");
  const manifest = { release: { profile: "production", sourceRepository: "WasalX/WasalX", sourceRevision, sourceTree } };
  const result = verifyPromotionSource(manifest, "WasalX/WasalX", promotion, cwd);
  assert.equal(result.buildRevision, sourceRevision);
  assert.equal(result.promotionRevision, promotion);
  const manifestPath = join(cwd, "manifest.json");
  const receiptPath = join(cwd, "receipt.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const cli = () => execFileSync(process.execPath,
    [fileURLToPath(new URL("../scripts/release/verify-promotion-source.mjs", import.meta.url)),
      manifestPath, "WasalX/WasalX", promotion, receiptPath], { cwd, stdio: "pipe" });
  // Source equality cannot turn an incomplete artifact manifest into a receipt.
  assert.throws(cli);
  assert.equal(existsSync(receiptPath), false);
  writeFileSync(receiptPath, "preserve prior receipt");
  assert.throws(cli);
  assert.equal(readFileSync(receiptPath, "utf8"), "preserve prior receipt");
  for (const override of [{ profile: undefined }, { profile: "development" }, { sourceTree: undefined }, { sourceTree: "f".repeat(40) }, { sourceRepository: "fork/repo" }]) {
    assert.throws(() => verifyPromotionSource({ release: { ...manifest.release, ...override } }, "WasalX/WasalX", promotion, cwd));
  }
  writeFileSync(join(cwd, "app.txt"), "different source\n");
  git("add", "app.txt"); git("commit", "-m", "different");
  assert.throws(() => verifyPromotionSource(manifest, "WasalX/WasalX", git("rev-parse", "HEAD"), cwd));
  const unrelated = git("commit-tree", sourceTree, "-m", "unrelated");
  assert.throws(() => verifyPromotionSource(manifest, "WasalX/WasalX", unrelated, cwd));
});
