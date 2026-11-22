import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { readHostedInventory, verifyHostedImages } from "../release/installer-hosted-images.mjs";

const [hostedImages, candidateSha, candidateTree, cosign, hostedTrustedRoot, trustedRootSha256, mode] = process.argv.slice(2);
const catalog = JSON.parse(await readFile(new URL("../../release/installer-images.json", import.meta.url)));
const context = {
  hostedImages, candidateSha, candidateTree, catalog, hostedTrustedRoot,
  hostedImagesSha256: createHash("sha256").update(await readFile(hostedImages)).digest("hex"),
  plan: catalog.images,
  command: async (command, args) => {
    assert.equal(command, "cosign");
    return (await promisify(execFile)(cosign, args, { timeout: 30000 })).stdout;
  },
};
if (mode === "inventory") {
  await readHostedInventory(context);
} else {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(cosign)) hash.update(chunk);
  assert.equal(hash.digest("hex"), "424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa");
  assert.equal(createHash("sha256").update(await readFile(hostedTrustedRoot)).digest("hex"), trustedRootSha256);
  const verified = await verifyHostedImages(context, { verifyOnly: true });
  assert.equal(verified.trustedRootSha256, trustedRootSha256);
}
