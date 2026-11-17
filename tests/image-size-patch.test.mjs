import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const requireFromVinext = createRequire(import.meta.resolve("vinext"));
const { imageSize } = requireFromVinext("image-size");

test("locally patched image-size rejects zero-length ICNS entries without looping", () => {
  const input = new Uint8Array(16);
  input.set(new TextEncoder().encode("icns"), 0);
  new DataView(input.buffer).setUint32(4, 16, false);
  input.set(new TextEncoder().encode("ic07"), 8);
  new DataView(input.buffer).setUint32(12, 0, false);
  assert.throws(() => imageSize(input), /Invalid ICNS entry length/);
});

test("local advisory patch guards ICNS, HEIF, and JXL progress in every distributed module", async () => {
  const patch = await readFile(
    new URL("../patches/image-size@2.0.2.patch", import.meta.url),
    "utf8",
  );
  for (const format of [
    "dist/index.cjs",
    "dist/index.mjs",
    "icns.cjs",
    "icns.mjs",
    "heif.cjs",
    "heif.mjs",
    "jxl.cjs",
    "jxl.mjs",
  ]) {
    assert.match(patch, new RegExp(format.replace(/[./]/g, "\\$&")));
  }
  assert.match(patch, /Invalid ICNS entry length/);
  assert.match(patch, /Invalid HEIF ispe box size/);
  assert.match(patch, /Invalid JXL partial stream box size/);
});

test("release VEX is exact and can be applied only after built-image patch verification", async () => {
  const [vex, verifier, artifactContract] = await Promise.all([
    readFile(new URL("../security/vex/image-size-2.0.2.openvex.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../scripts/release/verify-image-size-patch.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/release/artifact-contract.mjs", import.meta.url), "utf8"),
  ]);
  assert.deepEqual(vex.statements.map(({ vulnerability }) => vulnerability.name).sort(), [
    "GHSA-5p2g-fcmc-qvqq",
    "GHSA-w3rx-r6r6-pgpr",
  ]);
  assert.ok(vex.statements.every(({ products, status, justification }) =>
    products.length === 1 && products[0]["@id"] === "pkg:npm/image-size@2.0.2" &&
    status === "not_affected" && justification === "inline_mitigations_already_exist"));
  for (const marker of ["Invalid ICNS entry length", "Invalid HEIF ispe box size", "Invalid JXL partial stream box size"]) {
    assert.match(verifier, new RegExp(marker));
  }
  assert.match(artifactContract, /suppresses an unapproved package/u);
  assert.match(artifactContract, /does not bind both approved image-size VEX statements/u);
});
